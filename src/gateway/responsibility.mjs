/**
 * Claude Desktop 通过 disclaimer 启动 MCP 时，macOS 将 bun 视为负责进程，
 * 即使已签名的 OpenAI 运行时继承了该身份，也无法读取其 App Group 批准。
 * 仅复用当前进程祖先中已验证的 Desktop helper，让原始运行时以自身身份
 * 启动；插件本身不读取批准文件，也不改变原生沙箱或授权判断。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ANTHROPIC_TEAM = 'Q6L2SF6YDW';
const MAX_ANCESTORS = 16;

function readAncestor(pid) {
  const result = spawnSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'ppid=', '-o', 'comm='],
    { encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0) return undefined;
  const match = result.stdout.match(/^\s*(\d+)\s+(.+?)\s*$/);
  if (!match) throw new Error('无法确定 Computer Use 启动进程的归属。');
  return { parent: Number(match[1]), executable: match[2] };
}

export function verifyDesktopHelper(executable, {
  realpath = fs.realpathSync, stat = fs.statSync, run = spawnSync,
} = {}) {
  if (!path.isAbsolute(executable)) throw new Error('Desktop 启动包装器路径无效。');
  const real = realpath(executable);
  const helpers = path.dirname(real), contents = path.dirname(helpers), app = path.dirname(contents);
  if (path.basename(real) !== 'disclaimer' || path.basename(helpers) !== 'Helpers' ||
      path.basename(contents) !== 'Contents' || !app.endsWith('.app') || !stat(real).isFile()) {
    throw new Error('Desktop 启动包装器不属于完整的应用目录。');
  }
  const check = args => {
    const result = run('/usr/bin/codesign', args, { encoding: 'utf8', timeout: 15000 });
    if (result.status !== 0) throw new Error('Desktop 启动包装器签名校验失败。');
    return `${result.stdout}\n${result.stderr}`.split('\n');
  };
  check(['--verify', '--strict', real]);
  const identity = check(['-dv', '--verbose=2', real]);
  if (!identity.includes('Identifier=disclaimer') || !identity.includes(`TeamIdentifier=${ANTHROPIC_TEAM}`)) {
    throw new Error('Desktop 启动包装器不是受信的 Anthropic 组件。');
  }
  return real;
}

/** 只选择当前启动链中的受信 helper，不从 PATH 或用户/模型参数选择可执行文件。 */
export function responsibilityLauncher({ pid = process.ppid, read = readAncestor, verify = verifyDesktopHelper } = {}) {
  const visited = new Set();
  for (let depth = 0; depth < MAX_ANCESTORS && Number.isSafeInteger(pid) && pid > 1 && !visited.has(pid); depth++) {
    visited.add(pid);
    const ancestor = read(pid);
    if (!ancestor) return undefined;
    if (path.basename(ancestor.executable) === 'disclaimer') return verify(ancestor.executable);
    pid = ancestor.parent;
  }
  return undefined;
}

export function nativeRuntimeCommand(node, entry, launcher) {
  return launcher ? { command: launcher, args: ['--exec', '--', node, entry] }
    : { command: node, args: [entry] };
}
