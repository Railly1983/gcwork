#!/usr/bin/env node
// GCwork 引擎 MCP server：零依赖，JSON-RPC 2.0 over Content-Length 帧化的 stdio。
// 启动即回收孤儿 job；按需提供 dispatch/status/resume/verify/health/list_jobs。
import { dispatch, status, resume, recoverOrphans, listJobsTool } from './src/dispatch.mjs';
import { verify } from './src/verify.mjs';
import { health } from './src/models.mjs';
import { TOOLS } from './src/schema.mjs';

const SERVER_INFO = { name: 'gcwork-engine', version: '2.1.0' };

// ---------------------------------------------------------------- 帧化收发
function send(obj) {
  const payload = JSON.stringify(obj);
  const buf = Buffer.from(payload, 'utf8');
  process.stdout.write(`Content-Length: ${buf.length}\r\n\r\n`);
  process.stdout.write(buf);
}

let buf = Buffer.alloc(0);

function extractMessage() {
  // 从累积 buffer 里尽可能多地解出完整 JSON-RPC 消息
  const out = [];
  while (true) {
    const headerEnd = buf.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;
    const header = buf.slice(0, headerEnd).toString('utf8');
    const m = header.match(/Content-Length:\s*(\d+)/i);
    if (!m) { buf = buf.slice(headerEnd + 4); continue; }
    const len = Number(m[1]);
    const start = headerEnd + 4;
    if (buf.length < start + len) break; // 还不完整
    const body = buf.slice(start, start + len).toString('utf8');
    buf = buf.slice(start + len);
    try { out.push(JSON.parse(body)); } catch { /* 坏帧跳过 */ }
  }
  return out;
}

// ---------------------------------------------------------------- 处理
async function dispatchRpc(msg) {
  const id = msg.id;
  const method = msg.method;
  const params = msg.params || {};

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    };
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }

  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments || {};
    try {
      let result;
      switch (name) {
        case 'dispatch': result = await dispatch(args); break;
        case 'status': result = status(args.ref); break;
        case 'resume': result = await resume(args); break;
        case 'verify': result = verify(args.ref); break;
        case 'health': result = health(); break;
        case 'list_jobs': result = listJobsTool(args.limit || 20); break;
        default: throw new Error(`未知工具：${name}`);
      }
      return {
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: Boolean(result && result.status === 'rejected' && result.error) },
      };
    } catch (e) {
      return {
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: JSON.stringify({ status: 'rejected', error: 'ENGINE_ERROR', detail: String(e && e.stack || e) }) }], isError: true },
      };
    }
  }

  // 其它方法（如 notifications）忽略
  return null;
}

// ---------------------------------------------------------------- stdin 循环
let recovered = false;
function onData(chunk) {
  buf = Buffer.concat([buf, chunk]);
  if (!recovered) { recovered = true; try { recoverOrphans(); } catch { /* 忽略 */ } }
  const messages = extractMessage();
  for (const m of messages) {
    if (m.id === undefined && m.method && m.method.startsWith('notifications/')) continue;
    dispatchRpc(m).then((resp) => { if (resp) send(resp); }).catch(() => { /* 静默 */ });
  }
}

process.stdin.on('data', onData);
process.stdin.on('end', () => { /* 客户端断开 */ });
process.stdin.resume();

// 防止未捕获异常导致进程静默退出
process.on('uncaughtException', () => { /* 吞掉，保持 server 存活 */ });
process.on('unhandledRejection', () => { /* 吞掉 */ });
