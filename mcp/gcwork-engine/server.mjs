#!/usr/bin/env node
// MCP stdio server：逐行 JSON-RPC。
//
// 为什么用 MCP 而不是让模型直接调 CLI：MCP 进程由宿主常驻管理，
// 任务跑在这个进程里，不受 Bash 工具单次调用超时（最长 10 分钟）的限制。
// 这是长任务能跑完的唯一可靠办法。
//
// 协议要点：逐行 JSON（不是 Content-Length 帧）。宿主健康检查会发 ping，必须回。
import { dispatch, status, resume, recoverOrphans, listJobsTool } from './src/dispatch.mjs';
import { verify } from './src/verify.mjs';
import { health } from './src/models.mjs';
import { TOOLS } from './src/schema.mjs';
import { runJob } from './src/engine/worker.mjs';

process.stdout.setDefaultEncoding?.('utf8');

const SERVER_INFO = { name: 'gcwork-engine', version: '2.2.0' };
const PROTOCOL_VERSION = '2024-11-05';

let buf = '';
let recovered = false;

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

/** 任务在后台跑：MCP 进程常驻，不 await，任务照样跑完。 */
function runInBackground(spec) {
  setImmediate(() => {
    runJob(spec).catch((e) => {
      process.stderr.write(`[gcwork] 任务异常：${(e && e.stack) || e}\n`);
    });
  });
}

const handlers = {
  async dispatch(args = {}) {
    const r = await dispatch({
      task_id: args.task_id,
      prompt: args.prompt,
      workdir: args.workdir,
      executor: args.executor || 'auto',
      model: args.model,
      effort: args.effort,
      role: args.role,
      sandbox: args.sandbox,
      timeout_sec: args.timeout_sec,
      env: args.env || 'inherit',
      force: args.force,
    });
    const { _spec, _specPath, ...pub } = r;
    if (_spec) runInBackground(_spec);
    return pub;
  },
  async status(args = {}) {
    const r = status(args.ref);
    if (!r) throw new Error(`找不到任务：${args.ref}`);
    return r;
  },
  async verify(args = {}) {
    const r = verify(args.ref);
    if (!r) throw new Error(`找不到任务：${args.ref}`);
    return r;
  },
  async resume(args = {}) {
    return resume({
      task_id: args.task_id,
      timeout_sec: args.timeout_sec,
    });
  },
  async health() {
    return health();
  },
  async list_jobs(args = {}) {
    return { jobs: listJobsTool(args.limit || 20) };
  },
};

async function handle(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    ok(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
    return;
  }
  if (method === 'initialized' || method === 'notifications/initialized') return;
  if (method === 'ping') { ok(id, {}); return; }
  if (method === 'tools/list') { ok(id, { tools: TOOLS }); return; }

  if (method === 'tools/call') {
    const name = params?.name;
    const fn = handlers[name];
    if (!fn) { fail(id, -32602, `未知工具：${name}`); return; }
    try {
      const result = await fn(params.arguments || {});
      ok(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false });
    } catch (e) {
      ok(id, {
        content: [{ type: 'text', text: JSON.stringify({ error: String((e && e.message) || e) }) }],
        isError: true,
      });
    }
    return;
  }

  if (id !== undefined) fail(id, -32601, `不支持的方法：${method}`);
}

function onData(chunk) {
  buf += chunk.toString('utf8');
  if (!recovered) {
    recovered = true;
    try { recoverOrphans(); } catch { /* 忽略 */ }
  }
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).catch((e) => {
      process.stderr.write(`[gcwork] 处理失败：${(e && e.stack) || e}\n`);
      if (msg && msg.id !== undefined) fail(msg.id, -32603, String((e && e.message) || e));
    });
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', onData);
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
