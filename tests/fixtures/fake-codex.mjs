// 假 codex app-server：按脚本模拟各种故障，用于验证续跑逻辑。
// 行为由 FAKE_MODE 环境变量控制：
//   slow      —— turn 卡在 inProgress，用于测软超时转 pending
//   complete  —— 正常完成
//   interrupt —— turn 立刻变 interrupted（模拟进程被杀）
//   fail      —— turn 失败并带错误信息
//   restart   —— 首次运行时卡住，resume 后返回 completed（模拟宿主重启后取回结果）
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const MODE = process.env.FAKE_MODE || 'complete';
const STATE = process.env.FAKE_STATE || ''; // 跨进程记录「是否已经跑过一轮」
const STORE = process.env.FAKE_STORE || ''; // thread 持久化文件，模拟 codex 落盘的会话

// thread 状态必须跨进程持久化，否则「宿主重启后 resume 能读回历史」没法验证。
// 真实 codex 把会话写在自己的 rollout 目录里，这里用一个小 JSON 模拟。
function loadStore() {
  if (!STORE || !existsSync(STORE)) return {};
  try { return JSON.parse(readFileSync(STORE, 'utf8')); } catch { return {}; }
}
function saveStore(s) {
  if (!STORE) return;
  try { writeFileSync(STORE, JSON.stringify(s, null, 1), 'utf8'); } catch { /* 忽略 */ }
}

const store = loadStore();
const threads = new Map(); // threadId -> { turns: [] }
for (const [tid, t] of Object.entries(store)) threads.set(tid, t);

function persist() {
  saveStore(Object.fromEntries(threads));
}

let seq = 1;
const newId = (p) => `${p}${String(seq++).padStart(6, '0')}`;

let buf = '';
function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}
function log(s) {
  if (STATE) { try { appendFileSync(STATE, `${s}\n`); } catch { /* 忽略 */ } }
}

function makeTurn(status, text, err) {
  return {
    id: newId('turn-'),
    status,
    items: [
      { id: newId('item-'), type: 'userMessage', content: [{ type: 'text', text: 'x' }] },
      ...(text ? [{ id: newId('item-'), type: 'agentMessage', text }] : []),
    ],
    ...(err ? { error: { message: err } } : {}),
  };
}

function handle(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { userAgent: 'fake', platformFamily: 'test', platformOs: 'test' } });
    return;
  }
  if (method === 'initialized') return;

  if (method === 'thread/start') {
    const tid = newId('thr-');
    threads.set(tid, { turns: [] });
    persist();
    log(`start ${tid}`);
    send({
      jsonrpc: '2.0', id,
      result: { thread: { id: tid, turns: [] }, model: 'fake-model', modelProvider: 'fake', cwd: params?.cwd },
    });
    return;
  }

  if (method === 'thread/resume') {
    const tid = params?.threadId;
    const t = threads.get(tid) || { turns: [] };
    threads.set(tid, t);
    log(`resume ${tid} turns=${t.turns.length}`);
    send({ jsonrpc: '2.0', id, result: { thread: { id: tid, turns: t.turns }, model: 'fake-model', modelProvider: 'fake' } });
    return;
  }

  if (method === 'turn/start') {
    const tid = params?.threadId;
    const t = threads.get(tid) || { turns: [] };
    threads.set(tid, t);
    const text = String(params?.input?.[0]?.text || '');

    if (MODE === 'slow') {
      const turn = makeTurn('inProgress', '');
      t.turns.push(turn);
      persist();
      log(`turn slow ${turn.id}`);
      send({ jsonrpc: '2.0', id, result: { turn: { id: turn.id } } });
      return; // 永远不完成
    }
    if (MODE === 'fail') {
      const turn = makeTurn('failed', '', '模型调用失败：QUOTA_EXHAUSTED');
      t.turns.push(turn);
      persist();
      log(`turn fail ${turn.id}`);
      send({ jsonrpc: '2.0', id, result: { turn: { id: turn.id } } });
      return;
    }
    if (MODE === 'interrupt') {
      const turn = makeTurn('interrupted', '做了一半');
      t.turns.push(turn);
      persist();
      log(`turn interrupt ${turn.id}`);
      send({ jsonrpc: '2.0', id, result: { turn: { id: turn.id } } });
      return;
    }
    if (MODE === 'restart') {
      // 已跑过一轮 → 这次 resume 回来直接给 completed，用于验证「已完成不重复执行」
      const already = t.turns.some((x) => x.status === 'completed');
      const turn = already
        ? makeTurn('completed', '已完成的回答')
        : makeTurn('inProgress', '');
      t.turns.push(turn);
      persist();
      log(`turn restart ${turn.id} status=${turn.status}`);
      send({ jsonrpc: '2.0', id, result: { turn: { id: turn.id } } });
      return;
    }

    const turn = makeTurn('completed', `已完成：${text.slice(0, 20)}`);
    t.turns.push(turn);
    persist();
    log(`turn complete ${turn.id}`);
    send({ jsonrpc: '2.0', id, result: { turn: { id: turn.id } } });
    return;
  }

  if (method === 'thread/read') {
    const tid = params?.threadId;
    const t = threads.get(tid) || { turns: [] };
    send({ jsonrpc: '2.0', id, result: { thread: { id: tid, turns: t.turns } } });
    return;
  }

  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `fake 不支持 ${method}` } });
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    handle(m);
  }
});
process.stdin.on('end', () => process.exit(0));