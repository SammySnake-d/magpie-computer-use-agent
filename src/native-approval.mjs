/**
 * 当 Agent 不支持 MCP 表单询问时，仅为原生应用授权提供 macOS 人工确认。
 * 不读取批准文件、不自动接受；取消、关闭或任何异常都按未授权处理。
 */
import { spawn } from 'node:child_process';

export const APP_APPROVAL_SCRIPT = `on run argv
  set targetName to item 1 of argv
  set targetId to item 2 of argv
  set offeredScopes to item 3 of argv
  set riskLevel to item 4 of argv
  set warningText to item 5 of argv
  set promptText to "当前 Agent 请求读取并操作：" & targetName & "（" & targetId & "）" & return & return & "允许后，它可以查看窗口内容并执行操作。请选择授权范围；拒绝不会授予访问权限。"
  if riskLevel is "high" then set promptText to promptText & return & return & "此请求被原生组件标记为高风险。"
  if warningText is not "" then set promptText to promptText & return & return & warningText
  if offeredScopes is "both" then
    set promptText to promptText & return & return & "始终允许由 Codex 原生组件保存，可在其设置中撤销。"
    set answer to display dialog promptText with title "Magpie Computer Use 授权" buttons {"拒绝", "本次会话", "始终允许"} default button "拒绝" with icon caution giving up after 600
  else if offeredScopes is "always" then
    set promptText to promptText & return & return & "始终允许由 Codex 原生组件保存，可在其设置中撤销。"
    set answer to display dialog promptText with title "Magpie Computer Use 授权" buttons {"拒绝", "始终允许"} default button "拒绝" with icon caution giving up after 600
  else
    set answer to display dialog promptText with title "Magpie Computer Use 授权" buttons {"拒绝", "本次会话"} default button "拒绝" with icon caution giving up after 600
  end if
  if gave up of answer then return "cancel"
  set selectedButton to button returned of answer
  if selectedButton is "拒绝" then return "decline"
  if selectedButton is "本次会话" then return "session"
  if selectedButton is "始终允许" then return "always"
  return "cancel"
end run`;

const cleanDisplay = value => typeof value === 'string'
  ? value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 160)
  : '';

/** 只接受原始组件的空表单应用授权，不替其他字段或浏览器授权生成答案。 */
export function parseAppApproval(params) {
  if (!params || (params.mode ?? 'form') !== 'form') return undefined;
  const schema = params.requestedSchema, meta = params._meta;
  if (!schema || schema.type !== 'object' || !schema.properties || Array.isArray(schema.properties) ||
      typeof schema.properties !== 'object' || Object.keys(schema.properties).length !== 0 ||
      (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length !== 0))) return undefined;
  const app = meta?.tool_params?.app;
  if (meta?.connector_id !== 'computer-use' || meta?.codex_approval_kind !== 'mcp_tool_call' ||
      typeof app !== 'string' || app.length > 255 ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)+$/.test(app)) return undefined;
  if (!Array.isArray(meta.persist)) return undefined;
  const scopes = ['session', 'always'].filter(scope => meta.persist.includes(scope));
  if (!scopes.length) return undefined;
  const display = Array.isArray(meta.tool_params_display)
    ? meta.tool_params_display.find(item => item?.name === 'app')?.value : undefined;
  return { app, name: cleanDisplay(display) || app, scopes,
    risk: ['low', 'high'].includes(meta.riskLevel) ? meta.riskLevel : 'unknown',
    subtitle: cleanDisplay(meta.subtitle) };
}

/** 每次只启动系统自带 osascript；用户取消、超时、进程错误或异常输出均不批准。 */
export function showMacApproval(request, { signal, spawnProcess = spawn, timeoutMs = 610_000, report = () => {} } = {}) {
  if (signal?.aborted) return Promise.resolve('cancel');
  const offered = request.scopes.length === 2 ? 'both' : request.scopes[0];
  return new Promise(resolve => {
    let child, timer, forceTimer, settled = false, canceled = false, output = '';
    const finish = value => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(forceTimer);
      signal?.removeEventListener('abort', stop);
      resolve(value);
    };
    const stop = () => {
      if (settled || canceled) return;
      canceled = true;
      try { child?.kill('SIGTERM'); } catch {}
      if (!settled) forceTimer = setTimeout(() => { try { child?.kill('SIGKILL'); } catch {} }, 2000);
    };
    try {
      child = spawnProcess('/usr/bin/osascript', ['-e', APP_APPROVAL_SCRIPT, '--', request.name,
        request.app, offered, request.risk, request.subtitle], { stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', data => { output += data; if (output.length > 128) stop(); });
      child.once('error', () => { report('系统授权窗口无法启动，已取消。'); finish('cancel'); });
      child.once('close', code => {
        const choice = output.trim();
        if (!canceled && code !== 0) report('系统授权窗口未完成，已取消。');
        finish(!canceled && code === 0 && ['session', 'always', 'decline', 'cancel'].includes(choice) ? choice : 'cancel');
      });
      timer = setTimeout(stop, timeoutMs);
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
    } catch { report('系统授权窗口无法启动，已取消。'); finish('cancel'); }
  });
}

/** 单条 MCP 连接内串行展示询问；等待中的请求可立即取消且不会稍后弹出。 */
export function createNativeApproval({ platform = process.platform, dialog = showMacApproval, report = () => {} } = {}) {
  let tail = Promise.resolve();
  return (params, { signal } = {}) => {
    const request = parseAppApproval(params);
    if (platform !== 'darwin' || !request || signal?.aborted) return Promise.resolve({ action: 'cancel' });
    const work = tail.then(async () => {
      if (signal?.aborted) return { action: 'cancel' };
      const choice = await dialog(request, { signal, report });
      if (signal?.aborted) return { action: 'cancel' };
      if (choice === 'decline') return { action: 'decline' };
      if (request.scopes.includes(choice)) return { action: 'accept', content: {}, _meta: { persist: choice } };
      return { action: 'cancel' };
    }).catch(() => ({ action: 'cancel' }));
    tail = work.then(() => {}, () => {});
    if (!signal) return work;
    return new Promise(resolve => {
      let done = false;
      const finish = value => { if (done) return; done = true; signal.removeEventListener('abort', abort); resolve(value); };
      const abort = () => finish({ action: 'cancel' });
      signal.addEventListener('abort', abort, { once: true });
      work.then(finish, () => finish({ action: 'cancel' }));
      if (signal.aborted) abort();
    });
  };
}
