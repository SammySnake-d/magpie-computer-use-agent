/**
 * 工作流 ③：连接 Agent 和官方运行时的桥接层。
 * 对外：stdio MCP Server，发布十个操作。对内：MCP Client，把操作交给原始 js 工具执行。
 * 同时负责新授权询问往返、会话归属、图片/错误/进度转发以及取消和退出清理。
 */
import { randomUUID } from 'node:crypto';
import { VERSION, PLUGIN_NAME } from './config.mjs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { NATIVE_TOOLS, NATIVE_TOOL_NAMES, NATIVE_INSTRUCTIONS, nativeCall } from './native-tools.mjs';
import { declineAgentHostApp } from '../vendor/lcu-client/host-guard.mjs';
import { createNativeApproval } from './native-approval.mjs';

const TURN_META = 'x-codex-turn-metadata';
const PUBLIC_TOOLS = new Set(['js', 'js_reset']);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const identityKey = value => JSON.stringify([value.sessionId, value.turnId]);

/** 身份只来自宿主请求元数据；模型提供的工具参数不能指定会话或轮次。 */
export function hostIdentity(metadata, connectionIdentity) {
  const source = metadata?.[TURN_META];
  // 只有完全缺少宿主轮次元数据时才退回连接上下文；存在但无效的元数据必须报错。
  if (source === undefined) return { ...connectionIdentity, scope: 'connection' };
  let identity = source;
  if (typeof identity === 'string') {
    try { identity = JSON.parse(identity); } catch { throw new Error('Invalid host turn metadata'); }
  }
  if (!identity || typeof identity !== 'object' || Array.isArray(identity) ||
      !nonempty(identity.session_id) || !nonempty(identity.turn_id)) {
    throw new Error('Host turn metadata requires nonempty session_id and turn_id');
  }
  return { sessionId: identity.session_id, turnId: identity.turn_id,
    ...(nonempty(identity.call_id) ? { toolCallId: identity.call_id } : {}), scope: 'host' };
}

const blockedApproval = params => params?._meta?.connector_id === 'computer-use' &&
  String(params?._meta?.tool_params?.app ?? '').toLowerCase() === 'com.yetone.magpie';

/**
 * 通过标准 stdio MCP 对接内置网关。宿主未提供真实轮次元数据时，整条连接共用一个上下文，
 * 直到 EOF、取消或退出时清理；单次工具调用不被当作完整用户轮次。
 * 没有会话状态时可以回收空闲的内部运行时，但对外 MCP 连接必须保持打开。
 */
export async function runBridge({
  runtimeCommand, clientModulePath, toolSurface = 'native', requestTimeoutMs = 120_000, idleTimeoutMs = 300_000,
  input = process.stdin, output = process.stdout, errorOutput = process.stderr, createClient,
  nativeApproval,
} = {}) {
  if (!Array.isArray(runtimeCommand) || !runtimeCommand.length || runtimeCommand.some(part => !nonempty(part))) {
    throw new TypeError('runtimeCommand must be a nonempty argv array');
  }
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0 ||
      !Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 0) {
    throw new TypeError('Timeouts must be finite; request timeout positive and idle timeout nonnegative');
  }
  if (!createClient) {
    if (!nonempty(clientModulePath) || !isAbsolute(clientModulePath)) {
      throw new TypeError('An absolute gateway clientModulePath is required');
    }
    ({ createCuaClient: createClient } = await import(pathToFileURL(clientModulePath).href));
  }
  if (typeof createClient !== 'function') throw new TypeError('Gateway createCuaClient is unavailable');

  if (!['native', 'javascript'].includes(toolSurface)) throw new Error('Unknown Computer Use tool surface');
  const connectionId = `magpie-mcp-${randomUUID()}`;
  let connectionIdentity = { sessionId: connectionId, turnId: `${connectionId}-connection` };
  let server, client, idleTimer, closePromise, opening, openingClient, eviction, evictionError, failedRuntime, upstreamContract;
  let closing = false;
  let approvals = 0;
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const active = new Set();
  const contexts = new Map();
  const ending = new Map();
  const endedHostContexts = new Set();
  const budgetListeners = new Set();
  const runtimeClosings = new WeakMap();
  const report = message => { try { errorOutput.write(`magpie-computer-use: ${message}\n`); } catch {} };
  const requestNativeApproval = nativeApproval ?? createNativeApproval({ report });
  const noteApprovalChange = () => { for (const listener of [...budgetListeners]) listener(); };

  function closeRuntime(runtime) {
    if (!runtimeClosings.has(runtime)) {
      const pending = Promise.resolve().then(() => runtime.close());
      runtimeClosings.set(runtime, pending);
      pending.catch(() => { if (runtimeClosings.get(runtime) === pending) runtimeClosings.delete(runtime); });
    }
    return runtimeClosings.get(runtime);
  }

  function scheduleIdle() {
    clearTimeout(idleTimer);
    if (!closing && idleTimeoutMs && client && !opening && !eviction && !active.size && !approvals && !contexts.size) {
      idleTimer = setTimeout(() => { void evictIdleRuntime(); }, idleTimeoutMs);
      idleTimer.unref?.();
    }
  }

  // 只回收从未建立（或已明确清理完）的上下文。运行时中的应用对象和 REPL 状态
  // 无法安全序列化；已有上下文时留到宿主断开，避免后续动作落到过期目标上。
  function evictIdleRuntime() {
    if (closing || !client || opening || eviction || active.size || approvals || contexts.size) return;
    const old = client;
    client = undefined;
    eviction = closeRuntime(old).catch(error => {
      evictionError = error;
      failedRuntime = old;
      report(`Idle runtime cleanup failed: ${error?.message ?? error}`);
    }).finally(() => { eviction = undefined; });
  }

  async function openRuntime() {
    const next = await createClient({ command: runtimeCommand, onElicitation: elicit });
    openingClient = next;
    let connectTimer;
    try {
      if (closing) throw new Error('Computer Use connection is closing');
      await Promise.race([next.connect(), new Promise((_, reject) => {
        connectTimer = setTimeout(() => reject(new Error('Runtime connection timed out')), requestTimeoutMs);
      })]);
      const originalTools = next.publicTools().filter(tool => PUBLIC_TOOLS.has(tool.name));
      if (originalTools.length !== PUBLIC_TOOLS.size || ![...PUBLIC_TOOLS].every(name => originalTools.some(tool => tool.name === name))) {
        throw new Error('Runtime must provide the original js and js_reset tools');
      }
      const contract = { instructions: next.instructions, tools: originalTools };
      const sorted = tools => [...tools].sort((a, b) => a.name.localeCompare(b.name));
      if (upstreamContract && (upstreamContract.instructions !== contract.instructions ||
          !isDeepStrictEqual(sorted(upstreamContract.tools), sorted(contract.tools)))) {
        throw new Error('Computer Use runtime changed while idle; reconnect the MCP client');
      }
      if (closing) throw new Error('Computer Use connection is closing');
      upstreamContract ??= contract;
      client = next;
      return next;
    } catch (error) {
      try { await closeRuntime(next); } catch (closeError) {
        evictionError = closeError;
        failedRuntime = next;
        report(`Runtime cleanup failed: ${closeError?.message ?? closeError}`);
      }
      throw error;
    } finally {
      clearTimeout(connectTimer);
      if (openingClient === next) openingClient = undefined;
    }
  }

  function ensureRuntime() {
    if (client) return Promise.resolve(client);
    if (!opening) {
      opening = (async () => {
        if (eviction) await eviction;
        if (evictionError) throw new Error('Previous runtime cleanup failed; reconnect the MCP client');
        if (closing) throw new Error('Computer Use connection is closing');
        return openRuntime();
      })().finally(() => { opening = undefined; scheduleIdle(); });
    }
    return opening;
  }

  // 某个调用取消不应中止其他调用共享的重启，但该调用自身必须立即结束。
  function waitForRuntime(signal) {
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason ?? new Error('Computer Use request cancelled'));
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
      ensureRuntime().then(value => { signal.removeEventListener('abort', abort); resolve(value); },
        error => { signal.removeEventListener('abort', abort); reject(error); });
    });
  }

  // 先拒绝 magpie 本身及其他代理宿主，再把原始授权请求交回客户端，避免代理自行批准。
  // 只有原始运行时仍需询问宿主的批准才会到这里；已有持久批准由原始组件处理。
  async function elicit(params, { signal } = {}) {
    if (blockedApproval(params)) return { action: 'decline' };
    // 即便继承环境包含 LCU 仅供测试的绕过配置，也强制执行正常使用时的授权守卫。
    // 模型参数和外部环境都不能使代理获得控制自身宿主的授权。
    const refused = declineAgentHostApp(params, { env: {}, report });
    if (refused) return refused;
    if (closing || signal?.aborted) return { action: 'cancel' };
    const capabilities = server?.getClientCapabilities()?.elicitation;
    const mode = params?.mode ?? 'form';
    const canForward = mode === 'form' ? !!capabilities?.form : mode === 'url' ? !!capabilities?.url : false;
    if (!canForward && mode !== 'form') return { action: 'cancel' };
    // 在此回调之前，上游宿主守卫也会执行；其授权判断逻辑保持不变。
    approvals++;
    clearTimeout(idleTimer);
    noteApprovalChange();
    try {
      let answer;
      if (canForward) {
        try { answer = await server.elicitInput(params, { signal, timeout: 2 ** 31 - 1 }); }
        catch (error) {
          // 仅在宿主明确返回“方法不存在”时降级；用户取消、拒绝和其他错误不重复询问。
          if (mode !== 'form' || error?.code !== ErrorCode.MethodNotFound || closing || signal?.aborted) throw error;
          answer = await requestNativeApproval(params, { signal });
        }
      } else answer = await requestNativeApproval(params, { signal });
      return ['accept', 'decline', 'cancel'].includes(answer?.action) ? answer : { action: 'cancel' };
    } catch { return { action: 'cancel' }; }
    finally { approvals--; noteApprovalChange(); scheduleIdle(); }
  }

  // 超时只计算实际运行时间；连接内有授权等待时暂停计时，答复后继续剩余预算。
  function deadline(signal, timeoutMs) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    let remaining = timeoutMs, started, timer;
    const sync = () => {
      if (approvals) {
        if (timer !== undefined) { clearTimeout(timer); timer = undefined; remaining -= Date.now() - started; }
      } else if (timer === undefined && !controller.signal.aborted) {
        started = Date.now();
        timer = setTimeout(() => controller.abort(new Error('Computer Use request timed out')), Math.max(0, remaining));
      }
    };
    budgetListeners.add(sync);
    sync();
    return { controller, dispose() {
      clearTimeout(timer); budgetListeners.delete(sync);
      signal?.removeEventListener('abort', abort);
    } };
  }

  function cleanup(identity) {
    const key = identityKey(identity);
    if (ending.has(key)) return ending.get(key);
    // 等待前先捕获当前上下文的并发调用，避免在其他调用仍使用该上下文时通知轮次结束。
    const peers = [...active].filter(call => call.key === key).map(call => call.done);
    const pending = (async () => {
      await Promise.allSettled(peers);
      try {
        await client.turnEnded({ sessionId: identity.sessionId, turnId: identity.turnId, event: 'Interrupt' });
        contexts.delete(key);
        if (identity.scope === 'host') endedHostContexts.add(key);
      } catch (error) {
        report(`Turn cleanup failed: ${error?.message ?? error}`);
        throw error;
      }
    })();
    ending.set(key, pending);
    pending.finally(() => { ending.delete(key); }).catch(() => {});
    return pending;
  }

  // 统一处理 EOF、信号和失败退出；重复关闭复用同一 Promise，先停止调用再清理轮次与传输。
  async function close(reason = 'shutdown') {
    if (closing) return closePromise;
    closing = true;
    closePromise = (async () => {
      clearTimeout(idleTimer);
      input.off('end', onEnd); input.off('error', onInputError);
      process.off('SIGTERM', onSignal); process.off('SIGINT', onSignal);
      for (const call of active) call.controller.abort(new Error(`MCP connection closed (${reason})`));
      try { await server?.close(); } catch (error) { report(`Downstream close failed: ${error?.message ?? error}`); }
      if (openingClient) { try { await closeRuntime(openingClient); } catch (error) { report(`Runtime close failed: ${error?.message ?? error}`); } }
      await Promise.allSettled([...active].map(call => call.done));
      await Promise.allSettled([...contexts.values()].map(cleanup));
      if (opening) await opening.catch(() => {});
      if (eviction) await eviction;
      if (client) { try { await closeRuntime(client); } catch (error) { report(`Runtime close failed: ${error?.message ?? error}`); } }
      if (failedRuntime && failedRuntime !== client) {
        try { await closeRuntime(failedRuntime); } catch (error) { report(`Runtime close retry failed: ${error?.message ?? error}`); }
      }
      resolveClosed({ reason });
    })();
    return closePromise;
  }
  const onEnd = () => { void close('eof'); };
  const onInputError = () => { void close('input-error'); };
  const onSignal = signal => { void close(signal || 'signal'); };

  try {
    // 第一条 MCP 连接朝向内部网关/官方运行时；它会启动子进程并发现 js、js_reset。
    await openRuntime();
    const originalTools = upstreamContract.tools;
    // 对 Agent 发布十工具 schema；内部原始运行时仍接收 js/js_reset，不要求模型写脚本。
    const tools = toolSurface === 'native' ? NATIVE_TOOLS : originalTools;
    const exposed = toolSurface === 'native' ? NATIVE_TOOL_NAMES : PUBLIC_TOOLS;
    server = new Server({ name: PLUGIN_NAME, version: VERSION }, {
      capabilities: { tools: {} }, instructions: toolSurface === 'native' ? `${client.instructions}\n\n${NATIVE_INSTRUCTIONS}` : client.instructions,
    });
    server.onerror = error => report(`MCP server error: ${error?.message ?? error}`);
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args = {}, _meta: metadata } = request.params;
      if (closing) throw new Error('Computer Use connection is closing');
      if (!exposed.has(name)) throw new Error(`Unknown Computer Use tool: ${name}`);
      // 先确定调用归属，再生成脚本；模型参数不能选择其他会话或已结束的上下文。
      const identity = hostIdentity(metadata, connectionIdentity);
      const key = identityKey(identity);
      if (ending.has(key) || endedHostContexts.has(key)) throw new Error('Computer Use context has ended or is being cleaned up');
      // 例如 click({app, element_index}) 被 nativeCall() 转为固定的 target.click(...) 脚本。
      const invocation = toolSurface === 'native' ? { name: 'js', args: nativeCall(name, args, identity) } : { name, args };
      clearTimeout(idleTimer);
      // 模型在 JavaScript 参数中声明更长超时，也不能扩大用户配置的实际运行时间预算。
      const runTimeout = requestTimeoutMs;
      const budget = deadline(extra.signal, runTimeout);
      const record = { key, controller: budget.controller, done: undefined, started: false };
      const progressToken = metadata?.progressToken;
      // 仅向请求中原有的 progressToken 回传进度；连接关闭或调用取消后不再发送。
      const onprogress = progress => {
        if (closing || record.controller.signal.aborted || !['string', 'number'].includes(typeof progressToken)) return;
        void server.notification({ method: 'notifications/progress', params: { ...progress, progressToken } })
          .catch(error => report(`Progress forwarding failed: ${error?.message ?? error}`));
      };
      active.add(record);
      record.done = Promise.resolve().then(async () => {
        try {
          const runtime = await waitForRuntime(record.controller.signal);
          if (record.controller.signal.aborted) throw record.controller.signal.reason;
          contexts.set(key, identity);
          record.started = true;
          return await runtime.call(invocation.name, invocation.args, { ...identity, metadata, signal: record.controller.signal, onprogress });
        }
        finally { budget.dispose(); }
      });
      // MCP content/image/isError 原样返回；不把图片变成文字，也不把工具错误包装成成功。
      try { return await record.done; }
      finally {
        active.delete(record);
        // 取消后先清理整个上下文；连接作用域只有清理成功才换新轮次 ID，避免继续复用已结束身份。
        if (record.started && record.controller.signal.aborted && !closing) {
          const cleaned = await cleanup(identity).then(() => true, () => false);
          if (!cleaned) void close('cleanup-failed');
          else if (identity.scope === 'connection') connectionIdentity = { ...connectionIdentity, turnId: `${connectionId}-${randomUUID()}` };
        }
        scheduleIdle();
      }
    });
    server.onclose = () => { void close('transport-close'); };
    input.once('end', onEnd); input.once('error', onInputError);
    process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal);
    // 第二条 MCP 连接朝向 Agent，使用当前进程的 stdin/stdout 接收 tools/list、tools/call。
    await server.connect(new StdioServerTransport(input, output));
    scheduleIdle();
    return { server, client, close, closed, get connectionIdentity() { return { ...connectionIdentity }; } };
  } catch (error) { await close('startup-error'); throw error; }
}
