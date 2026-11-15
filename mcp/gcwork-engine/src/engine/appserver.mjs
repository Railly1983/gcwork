// codex app-server 常驻客户端。
//
// 为什么不用 `codex exec`：每单起一个新进程，光启动就 2-5 秒，且拿不到中间进度。
// app-server 是一个常驻 JSON-RPC 服务，thread 建一次可反复用，turn/start 受理在毫秒级，
// 过程通过通知流（item/started、item/agentMessage/delta、turn/completed）实时可查。
//
// 实测（codex-cli 0.166.0，2026-11-16）：
//   initialize 1.0s / thread/start 2.7s（仅首次）/ turn/start 受理 0.01-0.04s
//
// 协议要点：initialize 响应后**必须**发 `initialized` 通知，否则后续请求可能不返回。
import { spawn } from 'node:child_process';
import { launcherFor } from '../models.mjs';

const READY_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 60_000;

/** @type {{child:any,status:'idle'|'starting'|'ready'|'broken',nextId:number,pending:Map<number,{resolve:Function,reject:Function,timer:any}>,stderrTail:string[],entry:string|null}|null} */
let conn = null;

// 订阅者放在模块级：连接可能在后订阅之后才建立，挂在 conn 上会丢订阅。
const listeners = new Set();

export function appServerStatus() {
  return {
    status: conn ? conn.status : 'idle',
    entry: conn ? conn.entry : null,
    pending: conn ? conn.pending.size : 0,
    stderrTail: conn ? conn.stderrTail.slice(-5) : [],
  };
}

function reset() {
  if (!conn) return;
  try { conn.child?.kill(); } catch { /* 忽略 */ }
  for (const [, p] of conn.pending) {
    clearTimeout(p.timer);
    try { p.reject(new Error('app-server 连接已断开')); } catch { /* 忽略 */ }
  }
  conn = null;
}

function sendRaw(obj) {
  if (!conn || !conn.child) throw new Error('app-server 未启动');
  conn.child.stdin.write(`${JSON.stringify(obj)}\n`);
}

function request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (!conn || conn.status === 'broken') {
      reject(new Error(`app-server 不可用（${conn ? conn.status : 'idle'}）`));
      return;
    }
    const id = conn.nextId++;
    const timer = setTimeout(() => {
      if (conn) conn.pending.delete(id);
      reject(new Error(`${method} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    conn.pending.set(id, { resolve, reject, timer });
    sendRaw({ jsonrpc: '2.0', id, method, params });
  });
}

function emit(event) {
  for (const fn of listeners) {
    try { fn(event); } catch { /* 单个订阅者出错不影响其它 */ }
  }
}

function handleLine(line) {
  const text = line.trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch { return; }

  // 响应
  if (msg.id !== undefined && conn) {
    const p = conn.pending.get(msg.id);
    if (!p) return;
    conn.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else p.resolve(msg.result);
    return;
  }

  // 通知 → 广播给订阅者
  if (msg.method) emit({ method: msg.method, params: msg.params || {} });

  // 服务端反向请求（审批等）：当前一律拒绝，避免任务挂死等一个没人处理的弹窗
  if (msg.method && msg.id !== undefined) {
    try {
      sendRaw({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'gcwork-engine 不支持交互式审批，请用沙箱策略规避' },
      });
    } catch { /* 忽略 */ }
  }
}

/**
 * 确保 app-server 已启动并完成握手。重复调用复用同一连接。
 * @param {{entry:string}} opts entry 为 codex 入口（.js 走 node，.cmd 走 cmd /c）
 */
export async function ensureAppServer({ entry } = {}) {
  if (conn && conn.status === 'ready' && conn.entry === entry) return appServerStatus();
  if (conn && conn.status === 'starting' && conn.entry === entry) {
    // 等它起来
    for (let i = 0; i < 300; i += 1) {
      if (!conn || conn.status !== 'starting') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (conn && conn.status === 'ready') return appServerStatus();
  }

  reset();

  // 统一用 launcherFor：.js 走 node、.cmd 走 cmd /c、.exe 直接起
  const argv = [...launcherFor(entry), 'app-server'];
  const child = spawn(argv[0], argv.slice(1), {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: false, // 与 MCP 进程同生共死，避免留下孤儿 app-server
  });

  conn = {
    child, status: 'starting', nextId: 1, pending: new Map(),
    stderrTail: [], entry,
  };

  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      handleLine(line);
    }
  });
  child.stderr.on('data', (d) => {
    const t = d.toString().trim();
    if (!t) return;
    if (/stale arg0|failed to clean up/i.test(t)) return; // 无害告警
    if (conn) {
      conn.stderrTail.push(t.slice(0, 300));
      if (conn.stderrTail.length > 20) conn.stderrTail.shift();
    }
  });
  child.on('error', (e) => {
    if (conn) { conn.status = 'broken'; conn.stderrTail.push(`spawn error: ${e && e.message}`); }
  });
  child.on('exit', (code) => {
    if (conn) {
      conn.status = 'broken';
      conn.stderrTail.push(`app-server 退出 code=${code}`);
      for (const [, p] of conn.pending) {
        clearTimeout(p.timer);
        try { p.reject(new Error(`app-server 意外退出（code=${code}）`)); } catch { /* 忽略 */ }
      }
      conn.pending.clear();
    }
  });

  // 握手：initialize → initialized
  const initResult = await Promise.race([
    request('initialize', { clientInfo: { name: 'gcwork-engine', version: '2.2.0' }, capabilities: {} }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('initialize 超时')), READY_TIMEOUT_MS)),
  ]).catch((e) => {
    const tail = conn ? conn.stderrTail.join(' | ') : '';
    reset();
    throw new Error(`app-server 握手失败：${e.message}${tail ? `（${tail}）` : ''}`);
  });

  sendRaw({ jsonrpc: '2.0', method: 'initialized', params: {} });
  conn.status = 'ready';
  conn.initResult = initResult;
  return appServerStatus();
}

/** 建一个会话。cwd/model/sandbox 都在这里定。 */
export async function startThread({ cwd, model, sandbox, approvalPolicy, ephemeral = true, config = null } = {}) {
  const params = { ephemeral };
  if (cwd) params.cwd = cwd;
  if (model) params.model = model;
  if (sandbox) params.sandbox = sandbox;
  if (approvalPolicy) params.approvalPolicy = approvalPolicy;
  if (config) params.config = config;
  const r = await request('thread/start', params);
  const threadId = r?.threadId || r?.thread?.id || r?.id || null;
  if (!threadId) throw new Error(`thread/start 未返回 threadId：${JSON.stringify(r).slice(0, 200)}`);
  return { threadId, raw: r };
}

/**
 * 发起一轮。立即返回 turnId，不等模型跑完。
 * @param {{threadId:string, text:string, effort?:string, model?:string, cwd?:string, sandboxPolicy?:any}} opts
 */
export async function startTurn({ threadId, text, effort, model, cwd, sandboxPolicy } = {}) {
  const params = {
    threadId,
    input: [{ type: 'text', text: String(text || '') }],
  };
  if (effort) params.effort = effort;
  if (model) params.model = model;
  if (cwd) params.cwd = cwd;
  if (sandboxPolicy) params.sandboxPolicy = sandboxPolicy;
  const r = await request('turn/start', params);
  const turnId = r?.turnId || r?.turn?.id || null;
  return { turnId, raw: r };
}

/** 往正在跑的一轮里插话。 */
export async function steerTurn({ threadId, turnId, text }) {
  return request('turn/steer', {
    threadId, turnId, input: [{ type: 'text', text: String(text || '') }],
  });
}

/** 中断正在跑的一轮。 */
export async function interruptTurn({ threadId, turnId }) {
  return request('turn/interrupt', { threadId, turnId });
}

/** 读会话（含各轮状态与消息），用于查询进度与最终结果。ephemeral 会话不支持带 turns，此时退回只读摘要。 */
export async function readThread({ threadId, includeTurns = true }) {
  try {
    return await request('thread/read', includeTurns ? { threadId, includeTurns: true } : { threadId });
  } catch (e) {
    if (!/includeTurns/i.test(String(e && e.message))) throw e;
    return request('thread/read', { threadId });
  }
}

/** 列出各轮状态。 */
export async function listTurns({ threadId }) {
  return request('thread/turns/list', { threadId });
}

/** 模型目录（替代读 models_cache.json）。 */
export async function listModels() {
  return request('model/list', {});
}

/** 订阅通知流。返回取消函数。可在连接建立前调用。 */
export function subscribe(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** 关闭连接（MCP 进程退出时调用）。 */
export function shutdownAppServer() {
  reset();
}

export const APP_SERVER_METHODS = [
  'initialize', 'thread/start', 'turn/start', 'turn/steer', 'turn/interrupt',
  'thread/read', 'thread/turns/list', 'model/list',
];
