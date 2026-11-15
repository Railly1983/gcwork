#!/usr/bin/env node
// GCwork 引擎 MCP server：零依赖，JSON-RPC 2.0 over stdio。
// 传输遵循 MCP 标准：输出为逐行 JSON（newline-delimited）；输入兼容逐行 JSON 与
// Content-Length 帧两种写法（后者仅用于兼容自测客户端，标准客户端走逐行）。
// 启动即回收孤儿 job；按需提供 dispatch/status/resume/verify/health/list_jobs。
import { dispatch, status, resume, recoverOrphans, listJobsTool } from './src/dispatch.mjs';
import { verify } from './src/verify.mjs';
import { health } from './src/models.mjs';
import { TOOLS } from './src/schema.mjs';

const SERVER_INFO = { name: 'gcwork-engine', version: '2.1.1' };

// ---------------------------------------------------------------- 收发
// 输出：MCP 标准逐行 JSON（每条消息一行，UTF-8，以 \n 结尾）。
function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

// 用 Buffer 累积：Content-Length 是字节数，在字符串上切会把多字节中文切坏。
let buf = Buffer.alloc(0);
const HEADER_END = Buffer.from('\r\n\r\n');

// 输入解析：优先识别 Content-Length 帧；否则按行切分逐行 JSON。
// 标准 MCP 客户端发的是逐行 JSON，必须支持，否则握手无响应。
function extractMessages() {
  const out = [];
  while (true) {
    // 跳过前导 \r \n
    let skip = 0;
    while (skip < buf.length && (buf[skip] === 0x0a || buf[skip] === 0x0d)) skip += 1;
    if (skip) buf = buf.subarray(skip);
    if (!buf.length) break;

    // 头部是否已经收全（只有确认收到 \r\n\r\n 才解析，避免头分片时误判）
    const headerIdx = buf.indexOf(HEADER_END);
    const headerText = headerIdx === -1 ? buf.toString('utf8') : buf.subarray(0, headerIdx).toString('utf8');
    const headerMatch = /^Content-Length:\s*(\d+)\s*$/im.exec(headerText);

    if (headerMatch && headerIdx !== -1) {
      const len = Number(headerMatch[1]);
      const start = headerIdx + HEADER_END.length;
      if (buf.length < start + len) break; // 消息体还不完整
      const body = buf.subarray(start, start + len).toString('utf8');
      buf = buf.subarray(start + len);
      try { out.push(JSON.parse(body)); } catch { /* 坏帧跳过 */ }
      continue;
    }

    // 头看起来像 Content-Length 但还没收全 → 等下一批数据
    if (/^Content-Length:/i.test(headerText) && headerIdx === -1) break;

    // 逐行 JSON：按字节找 \n，再整体解码，避免中文截断
    const nl = buf.indexOf(0x0a);
    if (nl === -1) break; // 未收到完整行
    const line = buf.subarray(0, nl).toString('utf8').trim();
    buf = buf.subarray(nl + 1);
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* 非 JSON 行忽略 */ }
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
  const messages = extractMessages();
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
