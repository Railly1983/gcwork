// 续跑与故障恢复测试。用假 codex，可控且秒级。
//
// 对应方案验收项：
// 2 中途超时 → pending + task_ref
// 3 宿主重启 → 找回原 thread
// 4 执行中断 → 同一会话续做，不重复
// 6 失败诊断 → 区分失败/中断，给出原因
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const FIX = join(import.meta.dirname, 'fixtures', 'fake-codex.mjs');
const TMP = join(process.env.TEMP || '/tmp', `gcwork-test-run-${process.pid}`);

let HOME;
let WS;
let n = 0;

before(() => {
  HOME = join(TMP, `home-${Date.now()}`);
  WS = join(TMP, `ws-${Date.now()}`);
  mkdirSync(HOME, { recursive: true });
  mkdirSync(WS, { recursive: true });
  writeFileSync(join(WS, 'a.txt'), 'one\n', 'utf8');
  process.env.GCWORK_HOME = HOME;
  process.env.GCWORK_CODEX_ENTRY = FIX;

});

after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

/** 每个用例独立的 home + 工作区，避免互相污染。 */
function fresh(minSoft = 6000) {
  n += 1;
  // 正常用例给足余量（fake 建 thread ~1s + 一轮对话）；
  // 需要测 pending 的用例传更小的值主动触发。
  process.env.GCWORK_MIN_SOFT_MS = String(minSoft);
  const home = join(HOME, `h${n}`);
  const ws = join(WS, `w${n}`);
  mkdirSync(home, { recursive: true });
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, 'a.txt'), 'one\n', 'utf8');
  process.env.GCWORK_HOME = home;
  return { home, ws, state: join(home, 'state.log') };
}

// 每次 import 都要清缓存，因为 dispatch 的 active 是模块级状态
async function load(mode, state) {
  process.env.FAKE_MODE = mode;
  process.env.FAKE_STATE = state || '';
  // Windows 下动态 import 必须是 file:// URL，直接给盘符路径会被 ESM 拒绝
  const p = join(import.meta.dirname, '..', 'mcp', 'gcwork', 'dispatch.mjs');
  const url = pathToFileURL(p).href;
  return import(`${url}?m=${mode}-${Math.random()}`);
}

test('正常派单：同步返回 completed 与改动', async () => {
  const { ws, state } = fresh();
  const d = await load('complete', state);
  const r = await d.dispatch({ prompt: '改 a.txt', cwd: ws, timeout_sec: 30 });
  assert.equal(r.status, 'completed');
  assert.ok(r.task_ref);
  assert.ok(r.thread_id);
  assert.match(r.summary, /已完成/);
  await d.shutdown();
});

test('软超时：返回 pending，任务仍在跑', async () => {
  const { ws, state } = fresh(1200);
  const d = await load('slow', state);
  // 软超时最小 30 秒，这里用 1 秒参数验证转 pending 的路径
  const r = await d.dispatch({ prompt: '慢任务', cwd: ws, timeout_sec: 1 });
  assert.equal(r.status, 'pending');
  assert.ok(r.task_ref, 'pending 必须带 task_ref，否则没法接着问');
  assert.match(r.hint, /continue/);
  await d.shutdown();
});

test('幂等：同 task_ref 重复派单不会重复执行', async () => {
  const { ws, state } = fresh(1200);
  const d = await load('slow', state);
  const r1 = await d.dispatch({ prompt: '慢任务', cwd: ws, timeout_sec: 1, task_ref: 'fixed-1' });
  assert.equal(r1.status, 'pending');
  const r2 = await d.dispatch({ prompt: '慢任务', cwd: ws, timeout_sec: 1, task_ref: 'fixed-1' });
  assert.equal(r2.status, 'pending');
  // 只应该有一次 turn/start
  const log = existsSync(state) ? readFileSync(state, 'utf8') : '';
  const starts = (log.match(/turn slow/g) || []).length;
  assert.equal(starts, 1, `只应执行一次，实际 ${starts} 次`);
  await d.shutdown();
});

test('失败：给出诊断，错误信息可见', async () => {
  const { ws, state } = fresh();
  const d = await load('fail', state);
  const r = await d.dispatch({ prompt: '会失败', cwd: ws, timeout_sec: 30 });
  assert.equal(r.status, 'failed');
  assert.ok(r.diagnosis, '失败必须有诊断');
  assert.match(r.diagnosis.error, /QUOTA|失败/);
  assert.ok(r.diagnosis.hint);
  await d.shutdown();
});

test('中断：状态如实反映 interrupted，不谎报成功', async () => {
  const { ws, state } = fresh();
  const d = await load('interrupt', state);
  const r = await d.dispatch({ prompt: '会被中断', cwd: ws, timeout_sec: 30 });
  assert.equal(r.status, 'interrupted');
  assert.ok(r.diagnosis, '中断也要有诊断');
});

test('失败诊断：区分「跑到一半」和「根本没起来」', async () => {
  const { ws, state } = fresh();
  const d = await load('fail', state);
  const r = await d.dispatch({ prompt: 'x', cwd: ws, timeout_sec: 30 });
  // 失败阶段必须明确，不能只说 failed
  assert.ok(r.diagnosis.stage, '要写明失败发生在哪个阶段');
  await d.shutdown();
});

test('任务记录落盘：threadId 可用于后续恢复', async () => {
  const { home, ws, state } = fresh();
  const d = await load('complete', state);
  const r = await d.dispatch({ prompt: 'x', cwd: ws, timeout_sec: 30 });
  const p = join(home, 'tasks', `${r.task_ref}.json`);
  assert.ok(existsSync(p), '任务记录必须落盘，否则宿主重启后找不回 threadId');
  const rec = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(rec.threadId, r.thread_id);
  assert.equal(rec.cwd, ws);
  assert.ok(rec.startedAt);
  // 基线信息也要在，续跑才能算清改动
  assert.ok('baseHead' in rec || 'baseSnapshot' in rec);
  await d.shutdown();
});

test('无 task_ref 时自动生成且格式可读', async () => {
  const { ws, state } = fresh();
  const d = await load('complete', state);
  const r = await d.dispatch({ prompt: 'x', cwd: ws, timeout_sec: 30 });
  assert.match(r.task_ref, /^t-[0-9a-f]{8}$/);
  await d.shutdown();
});

test('清理：删掉过期记录，不留空文件；能数出待恢复任务', async () => {
  const { home, ws, state } = fresh();
  const d = await load('complete', state);
  const r = await d.dispatch({ prompt: 'x', cwd: ws, timeout_sec: 30 });

  const dir = join(home, 'tasks');
  // 造一条过期记录（20 天前）和一条「有 thread 但状态停在 running」的记录
  writeFileSync(join(dir, 'old.json'), JSON.stringify({
    taskRef: 'old', threadId: 'thr-old', status: 'completed',
    startedAt: new Date(Date.now() - 20 * 86400_000).toISOString(),
  }), 'utf8');
  writeFileSync(join(dir, 'stuck.json'), JSON.stringify({
    taskRef: 'stuck', threadId: 'thr-stuck', status: 'running', cwd: ws,
    startedAt: new Date().toISOString(),
  }), 'utf8');

  const s = d.sweep();
  assert.equal(s.pruned, 1, '过期记录要被删掉');
  assert.ok(s.pendingRecovery >= 1, '要能数出停在 running 的任务');
  // 过期文件应该真的没了，不能留个空 JSON 让下次解析失败
  assert.ok(!existsSync(join(dir, 'old.json')), '过期记录应删除而非清空');
  assert.ok(existsSync(join(dir, `${r.task_ref}.json`)), '正常记录不该被删');

  await d.shutdown();
});

test('回执结构：字段齐全，行数统计有明确说明', async () => {
  const { ws, state } = fresh();
  const d = await load('complete', state);
  const r = await d.dispatch({ prompt: 'x', cwd: ws, timeout_sec: 30 });

  // 契约字段不能少：模型就是靠这些字段判断结果的
  for (const k of ['status', 'task_ref', 'thread_id', 'summary', 'changes', 'line_stats', 'artifacts']) {
    assert.ok(k in r, `回执缺少字段 ${k}`);
  }
  assert.ok(Array.isArray(r.changes.paths));
  // 非 git 目录必须说明行数统计的局限，不能拿 0 冒充「没改」
  if (!r.line_stats.note) {
    assert.equal(typeof r.line_stats.additions, 'number');
  } else {
    assert.match(r.line_stats.note, /非 git/);
  }
  await d.shutdown();
});

test('缺少必填参数时明确拒绝，不抛裸异常', async () => {
  const { ws, state } = fresh();
  const d = await load('complete', state);
  const r1 = await d.dispatch({ cwd: ws });
  assert.equal(r1.status, 'rejected');
  assert.match(r1.error, /prompt/);

  const r2 = await d.dispatch({ prompt: 'x' });
  assert.equal(r2.status, 'rejected');
  assert.match(r2.error, /cwd/);

  const r3 = await d.dispatch({ prompt: 'x', cwd: join(ws, 'not-exist-xyz') });
  assert.equal(r3.status, 'rejected');
  await d.shutdown();
});