// MCP stdio 服务端。逐行 JSON-RPC（不是 Content-Length 帧）。
//
// 为什么必须常驻：任务跑在这个进程里，不受宿主单次工具调用与 Bash 超时限制。
// 宿主默认给 MCP 工具 1 小时（MCP_TOOL_TIMEOUT），足够跑完绝大多数任务。
import { dispatch, continueTask, sweep, shutdown } from './dispatch.mjs';

const VERSION = '3.0.0';
const PROTOCOL = '2024-11-05';

const TOOLS = [
  {
    name: 'dispatch',
    description: [
      '把任务派给本机已登录的 Codex，同步等结果。',
      '',
      '返回：status（completed / pending / failed / interrupted）、summary（回答开头 800 字）、',
      'changes（改了哪些文件，从文件系统实测得出，不采信 Codex 自述）、',
      'line_stats（git 仓库给真实增删行数；非 git 目录只统计新增文件）、',
      'artifacts（全文与 diff 的路径）。',
      '',
      'status=pending 表示任务仍在跑：带同一 task_ref 调 continue 接着等，不会重复执行。',
      'status 非 completed 时返回 diagnosis，里面写明失败阶段与错误，直接转告用户。',
      '',
      '要点：',
      '- 一单能干完的别拆成多单，每单都有启动开销。',
      '- 任务描述要自足：把背景、路径、验收标准都写进 prompt，Codex 看不到当前对话。',
      '- 默认可写。只有用户明确要求只读时才传 read_only=true。',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      required: ['prompt', 'cwd'],
      properties: {
        prompt: { type: 'string', description: '任务描述全文。要自足，含背景与验收标准。' },
        cwd: { type: 'string', description: '工作目录绝对路径。' },
        task_ref: { type: 'string', description: '任务标识，续跑时复用。不传则自动生成。' },
        model: { type: 'string', description: '模型名，不传用 Codex 默认。' },
        effort: { type: 'string', description: '推理强度，如 low / medium / high。不传用模型默认。' },
        read_only: { type: 'boolean', description: '只读模式。默认 false。' },
        timeout_sec: {
          type: 'integer',
          description: '软超时秒数，默认 600。到点返回 pending，任务继续在后台跑。',
        },
      },
    },
  },
  {
    name: 'continue',
    description: [
      '接着等一个任务的最终结果，或在上次中断后继续做。',
      '',
      '四种情况自动区分，不需要判断：',
      '- 任务还在跑 → 接着等，不新起一轮',
      '- 任务其实已经完成 → 直接取回结果，不重复执行',
      '- 任务被中断或失败 → 在同一 Codex 会话上下文里继续做，不会从头再来',
      '- 宿主重启过 → 自动恢复原会话',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      required: ['task_ref'],
      properties: {
        task_ref: { type: 'string', description: 'dispatch 返回的 task_ref。' },
        prompt: { type: 'string', description: '续做时的补充要求，可选。' },
        timeout_sec: { type: 'integer', description: '软超时秒数，默认 600。' },
      },
    },
  },
];

let buf = '';
let swept = false;

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handle(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'gcwork', version: VERSION },
      },
    });
    return;
  }
  if (method === 'initialized' || method === 'notifications/initialized') return;
  if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
  if (method === 'tools/list') { send({ jsonrpc: '2.0', id, result: { tools: TOOLS } }); return; }

  if (method === 'tools/call') {
    const name = params?.name;
    const a = params?.arguments || {};
    try {
      let out;
      if (name === 'dispatch') out = await dispatch(a);
      else if (name === 'continue') out = await continueTask(a);
      else throw new Error(`未知工具：${name}`);
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: false },
      });
    } catch (e) {
      // 工具内部异常也要结构化返回，让模型能读、能转告，而不是一个裸错误
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify({ status: 'failed', error: String((e && e.message) || e) }, null, 2),
          }],
          isError: true,
        },
      });
    }
    return;
  }

  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `不支持的方法：${method}` } });
  }
}

function onData(chunk) {
  buf += chunk.toString('utf8');
  if (!swept) {
    swept = true;
    try { sweep(); } catch { /* 回收失败不影响服务 */ }
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
      if (msg && msg.id !== undefined) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String((e && e.message) || e) } });
      }
    });
  }
}

async function bye() {
  try { await shutdown(); } catch { /* 忽略 */ }
  process.exit(0);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', onData);
process.stdin.on('end', bye);
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
process.stdin.resume();