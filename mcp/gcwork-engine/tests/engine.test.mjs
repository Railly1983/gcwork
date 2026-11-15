// gcwork-engine 单元测试 + e2e（fake CLI）。运行：node --test tests/engine.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync, utimesSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

import * as models from '../src/models.mjs';
import * as dispatch from '../src/dispatch.mjs';
import * as ledger from '../src/engine/ledger.mjs';
import { gitDelta, gitSnapshot, snapshotToJSON, snapshotFromJSON } from '../src/engine/git.mjs';
import { classifyError, parseResumeAfter } from '../src/engine/errors.mjs';
import * as codexAdapter from '../src/adapters/codex.mjs';
import * as claudeAdapter from '../src/adapters/claude.mjs';
import { TOOLS } from '../src/schema.mjs';
import { verify as verifyJob, isSensitive } from '../src/verify.mjs';

const FIX = resolve(join(import.meta.dirname, 'fixtures'));
const CODEX_OK = join(FIX, 'fake_codex_full.mjs');
const CODEX_DEGRADE = join(FIX, 'fake_codex_degrade.mjs');
const CODEX_FAIL = join(FIX, 'fake_codex_fail.mjs');
const CODEX_RESUME = join(FIX, 'fake_codex_resume.mjs');
const CLAUDE_OK = join(FIX, 'fake_claude.mjs');

function setupEnv() {
  const home = mkdtempSync(join(tmpdir(), 'gcw-test-'));
  process.env.GCWORK_HOME = home;
  process.env.GCWORK_CODEX_ENTRY = CODEX_OK;
  process.env.GCWORK_CLAUDE_ENTRY = CLAUDE_OK;
  return home;
}

function makeGitWorkdir() {
  const d = mkdtempSync(join(tmpdir(), 'gcw-work-'));
  execSync('git init -q', { cwd: d, stdio: 'ignore' });
  execSync('git config user.email t@t.com', { cwd: d, stdio: 'ignore' });
  execSync('git config user.name t', { cwd: d, stdio: 'ignore' });
  writeFileSync(join(d, 'README.md'), 'init\n');
  execSync('git add -A && git commit -q -m init', { cwd: d, stdio: 'ignore' });
  return d;
}

// ---------------------------------------------------------------- 路由
test('route: review 走 codex', () => {
  assert.equal(models.route({ task_type: 'review' }), 'codex');
});
test('route: 只读 need_write=false 走 codex', () => {
  assert.equal(models.route({ need_write: false }), 'codex');
});
test('route: implement 且文件>3 走 claude', () => {
  assert.equal(models.route({ task_type: 'implement', file_count: 9 }), 'claude');
});
test('route: implement 文件少 走 codex', () => {
  assert.equal(models.route({ task_type: 'implement', file_count: 1 }), 'codex');
});
test('route: fix / generate_tests 走 codex', () => {
  assert.equal(models.route({ task_type: 'fix' }), 'codex');
  assert.equal(models.route({ task_type: 'generate_tests' }), 'codex');
});
test('route: high 风险 走 claude', () => {
  assert.equal(models.route({ risk_level: 'high' }), 'claude');
});
test('route: 显式 executor 不被替换', () => {
  assert.equal(models.route({ executor: 'claude' }), 'claude');
  assert.equal(models.route({ executor: 'codex', risk_level: 'high' }), 'codex');
});

// ---------------------------------------------------------------- pickTarget
test('pickTarget: planner → codex/astra 只读 high', () => {
  const t = models.pickTarget({ role: 'planner' });
  assert.equal(t.cli, 'codex');
  assert.equal(t.name, 'astra');
  assert.equal(t.readOnly, true);
  assert.equal(t.effort, 'high');
});
test('pickTarget: implementer + executor claude → claude/sonnet 可写', () => {
  const t = models.pickTarget({ role: 'implementer', executor: 'claude' });
  assert.equal(t.cli, 'claude');
  assert.equal(t.name, 'sonnet');
  assert.equal(t.readOnly, false);
});
test('pickTarget: 显式 model 优先且严格', () => {
  assert.equal(models.pickTarget({ model: 'opus' }).name, 'opus');
  assert.equal(models.pickTarget({ model: 'opus' }).cli, 'claude');
});
test('pickTarget: 未知 model 报错', () => {
  assert.ok(models.pickTarget({ model: 'nope' }).error);
});

// ---------------------------------------------------------------- 沙箱/权限
test('codexSandboxOf / claudePermissionOf', () => {
  assert.equal(models.codexSandboxOf('read-only'), 'read-only');
  assert.equal(models.codexSandboxOf('workspace-write'), 'workspace-write');
  assert.equal(models.claudePermissionOf('read-only'), 'plan');
  // dontAsk 只放行预先授权的工具，不等于允许写；可写任务必须用 acceptEdits
  assert.equal(models.claudePermissionOf('workspace-write'), 'acceptEdits');
});

// ---------------------------------------------------------------- 适配器 argv + 探测降级
test('codex buildArgv：完整 help 含 -c', () => {
  const argv = codexAdapter.buildArgv({ effort: 'high', sandbox: 'read-only', modelInfo: { model: 'x' }, entry: CODEX_OK, runDir: '/tmp/x' });
  assert.ok(argv.includes('-c'), '应包含 -c');
  assert.ok(argv.includes('-s'), '应包含 -s');
  assert.ok(argv.includes('-m'), '应包含 -m');
  assert.ok(argv.includes('-o'), '应包含 -o');
  assert.ok(argv.includes('-'), '应以 - 收尾（从 stdin 读提示）');
});
test('codex buildArgv：降级 help 省略 -c', () => {
  const argv = codexAdapter.buildArgv({ effort: 'high', sandbox: 'read-only', modelInfo: { model: 'x' }, entry: CODEX_DEGRADE, runDir: '/tmp/x' });
  assert.ok(!argv.includes('-c'), '降级不应含 -c');
  assert.ok(argv.includes('-o'), '仍应包含 -o');
});
test('claude buildArgv：构造核心参数', () => {
  const argv = claudeAdapter.buildArgv({ prompt: 'hi', effort: 'medium', sandbox: 'workspace-write', modelInfo: { model: 'sonnet' }, entry: CLAUDE_OK });
  assert.ok(argv.includes('-p'), '应包含 -p');
  assert.ok(argv.includes('hi'), '应包含 prompt');
  assert.ok(argv.includes('--output-format'), '应包含 --output-format');
  assert.ok(argv.includes('--model'), '应包含 --model');
  assert.ok(argv.includes('--effort'), '完整 help 应含 --effort');
  assert.ok(argv.includes('--no-session-persistence'), '完整 help 应含 --no-session-persistence');
});

// ---------------------------------------------------------------- 结果解析
test('codex readResult：优先 last 文件', () => {
  const r = codexAdapter.readResult({ stdout: '', last: 'hello from last' });
  assert.equal(r.message, 'hello from last');
});
test('codex readResult：turn.failed 兜底错误', () => {
  const stdout = JSON.stringify({ type: 'turn.failed', error: { message: 'boom' } });
  const r = codexAdapter.readResult({ stdout });
  assert.equal(r.error, 'boom');
});
test('claude readResult：解析 JSON result', () => {
  const r = claudeAdapter.readResult(JSON.stringify({ result: 'did it', is_error: false }));
  assert.equal(r.message, 'did it');
  assert.equal(r.isError, false);
});
test('claude readResult：is_error=true', () => {
  const r = claudeAdapter.readResult(JSON.stringify({ result: '', is_error: true }));
  assert.equal(r.isError, true);
  assert.equal(r.message, '');
});

// ---------------------------------------------------------------- 错误分类
test('classifyError：各类别', () => {
  assert.equal(classifyError('model not found'), 'MODEL_UNAVAILABLE');
  assert.equal(classifyError('you have hit your usage limit'), 'QUOTA');
  assert.equal(classifyError('unauthorized'), 'AUTH');
  assert.equal(classifyError('command not found'), 'NOT_FOUND');
  assert.equal(classifyError('weird thing happened'), 'FAILED');
});
test('parseResumeAfter：解析相对时间', () => {
  const ra = parseResumeAfter('quota exceeded, resets in 2 hours');
  assert.ok(ra, '应解析出恢复时间');
});

// ---------------------------------------------------------------- gitDelta 纯函数
test('gitDelta：新增/修改/删除 + HEAD 移动', () => {
  const before = { head: 'aaa', files: new Map([['a.js', { xy: ' M', added: '1', removed: '0' }]]) };
  const after = {
    head: 'bbb',
    files: new Map([
      ['a.js', { xy: ' M', added: '3', removed: '0' }],
      ['b.js', { xy: '??', added: null, removed: null }],
    ]),
  };
  const d = gitDelta(before, after);
  assert.deepEqual(d.paths, ['a.js', 'b.js']);
  assert.equal(d.stats.modified, 1);
  assert.equal(d.stats.added, 1);
  assert.equal(d.headMoved, true);
});
test('gitDelta：非 git（null）返回 null', () => {
  assert.equal(gitDelta(null, null), null);
});
test('snapshot 序列化往返', () => {
  const snap = { head: 'h', files: new Map([['x', { xy: ' M', added: '1', removed: '0' }]]) };
  const j = snapshotToJSON(snap);
  const back = snapshotFromJSON(j);
  assert.equal(back.head, 'h');
  assert.equal(back.files.get('x').added, '1');
});

// ---------------------------------------------------------------- ledger
test('ledger：put/get/latest/resolve/list', () => {
  const home = setupEnv();
  const j1 = { job_id: 'j1', task_id: 't1', status: 'ok', startedAt: '2026-01-01T00:00:00Z' };
  const j2 = { job_id: 'j2', task_id: 't1', status: 'failed', startedAt: '2026-01-02T00:00:00Z' };
  ledger.putJob(j1);
  ledger.putJob(j2);
  assert.equal(ledger.getJob('j1').status, 'ok');
  assert.equal(ledger.getLatestByTask('t1').job_id, 'j2');
  assert.equal(ledger.resolveRef('j1').job_id, 'j1');
  assert.equal(ledger.resolveRef('t1').job_id, 'j2');
  const list = ledger.listJobs(10);
  assert.ok(list.length >= 2);
  rmSync(home, { recursive: true, force: true });
});


/** 派单 + 在本进程内执行（模拟 cli.mjs 的行为）。 */
async function dispatchAndRun(args) {
  const r = await dispatch.dispatch(args);
  if (r && r._spec) {
    const { runJob } = await import('../src/engine/worker.mjs');
    await runJob(r._spec);
    return dispatch.status(r._spec.jobId);
  }
  return r;
}

// ---------------------------------------------------------------- 校验
test('dispatch 校验：缺字段被拒', async () => {
  setupEnv();
  const r = await dispatch.dispatch({ task_id: 'x' }); // 缺 prompt/workdir
  assert.equal(r.status, 'rejected');
  assert.equal(r.error, 'BAD_ARGS');
});
test('dispatch 校验：workdir 不存在被拒', async () => {
  setupEnv();
  const r = await dispatch.dispatch({ task_id: 'x', prompt: 'p', workdir: '/no/such/dir/here' });
  assert.equal(r.status, 'rejected');
});



test('e2e claude 成功：executor=claude 走 claude 适配', async () => {
  const home = setupEnv();
  process.env.GCWORK_CLAUDE_ENTRY = CLAUDE_OK;
  const wd = makeGitWorkdir();
  const r = await dispatchAndRun({
    task_id: 'e2e-claude-' + Date.now(), prompt: 'claude do it', workdir: wd,
    role: 'implementer', executor: 'claude', blocking: true,
  });
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.ok(r.partialOutput && r.partialOutput.includes('claude done'), '应含 claude 成功信息');
  rmSync(home, { recursive: true, force: true });
  rmSync(wd, { recursive: true, force: true });
});

// ---------------------------------------------------------------- status / list_jobs / health / verify
test('status：未知 ref 返回 JOB_NOT_FOUND', () => {
  setupEnv();
  const r = dispatch.status('does-not-exist');
  assert.equal(r.status, 'rejected');
  assert.equal(r.error, 'JOB_NOT_FOUND');
});
test('list_jobs / health 返回结构', () => {
  setupEnv();
  const list = dispatch.listJobsTool(5);
  assert.ok(Array.isArray(list));
  const h = models.health();
  assert.ok(h.sides && h.sides.codex && h.sides.claude);
  assert.equal(h.version, '2.2.0');
});

// ---------------------------------------------------------------- 回归：外部审计发现的 4 个 bug
test('BUG1 回归：verify 对 failed/running 任务必须 rejected', async () => {
  setupEnv();
  const wd = makeGitWorkdir();
  const after = gitSnapshot(wd);
  for (const badStatus of ['failed', 'timeout', 'crashed', 'running', 'rejected', 'quota_exhausted']) {
    ledger.putJob({
      job_id: `bad-${badStatus}`, task_id: `task-${badStatus}`,
      workdir: wd, status: badStatus, pid: null,
      before_snapshot: snapshotToJSON(after), startedAt: new Date().toISOString(),
    });
    const r = await verifyJob(`bad-${badStatus}`);
    assert.equal(r.accepted, false, `${badStatus} 不应验收通过`);
    assert.equal(r.rejected, true, `${badStatus} 应判 rejected`);
    assert.equal(r.jobStatus, badStatus);
  }
});

test('BUG1 回归：verify 对 ok 任务仍可 accepted', async () => {
  setupEnv();
  const wd = makeGitWorkdir();
  const after = gitSnapshot(wd);
  ledger.putJob({
    job_id: 'good-ok', task_id: 'task-ok', workdir: wd, status: 'ok', pid: null,
    before_snapshot: snapshotToJSON(after), startedAt: new Date().toISOString(),
  });
  const r = await verifyJob('good-ok');
  // 无 test 脚本 → needsHuman，但不能被 rejected
  assert.equal(r.rejected, false, 'ok 任务不应被 rejected');
  assert.equal(r.jobStatus, 'ok');
});

test('沙箱策略：默认放开可写，只有 planner 或显式要求才只读', () => {
  // 默认不砍能力：reviewer 也能跑测试、必要时修——只读会白白削弱模型
  const reviewer = models.pickTarget({ role: 'reviewer', model: 'sol' });
  assert.equal(reviewer.sandbox, 'workspace-write', 'reviewer 默认可写');
  assert.equal(reviewer.readOnly, false);

  const impl = models.pickTarget({ role: 'implementer', model: 'terra' });
  assert.equal(impl.sandbox, 'workspace-write');

  // 不带 role 时也默认可写
  const plain = models.pickTarget({ model: 'sol' });
  assert.equal(plain.sandbox, 'workspace-write');

  // 计划模式（planner）才进只读
  const planner = models.pickTarget({ role: 'planner', model: 'astra' });
  assert.equal(planner.sandbox, 'read-only', 'planner 是计划模式，只读');
  assert.equal(planner.readOnly, true);

  // 显式 sandbox 永远最高优先级
  assert.equal(models.pickTarget({ role: 'planner', model: 'astra', sandbox: 'workspace-write' }).sandbox, 'workspace-write');
  assert.equal(models.pickTarget({ role: 'implementer', model: 'terra', sandbox: 'read-only' }).sandbox, 'read-only');
});

test('BUG3 回归：进程仍存活 + 已超时 → 惰性判 timeout', async () => {
  setupEnv();
  const wd = makeGitWorkdir();
  const after = gitSnapshot(wd);
  // 起一个真实存活的长睡眠进程当替身
  const { spawn } = await import('node:child_process');
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{},600000)'], { stdio: 'ignore' });
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  ledger.putJob({
    job_id: 'stale-alive', task_id: 'task-alive', workdir: wd, status: 'running',
    pid: sleeper.pid, workerPid: sleeper.pid, startedAt: old, timeoutSec: 60,
    runDir: mkdtempSync(join(tmpdir(), 'gcw-run-')),
    before_snapshot: snapshotToJSON(after),
  });
  const r = dispatch.status('stale-alive');
  assert.equal(r.status, 'timeout', '存活进程超时后应判 timeout');
  try { sleeper.kill(); } catch {}
});

test('BUG3b 回归：进程已结束但查询得晚，不能被误判 timeout', () => {
  setupEnv();
  const wd = makeGitWorkdir();
  const after = gitSnapshot(wd);
  const runDir = mkdtempSync(join(tmpdir(), 'gcw-run-'));
  // 模拟：任务早已跑完，产物齐全，只是很久之后才来查询
  writeFileSync(join(runDir, 'stdout.log'),
    '{"type":"turn.completed","message":"做完了"}\n');
  // 真实场景：2 小时前启动，30 秒就跑完了，之后一直没人查。
  // 产物 mtime 必须是「完成时刻」而不是「现在」，否则会被误判成超期完成。
  const startedMs = Date.now() - 2 * 60 * 60 * 1000;
  const finishedMs = startedMs + 30_000;
  utimesSync(join(runDir, 'stdout.log'), new Date(finishedMs), new Date(finishedMs));
  ledger.putJob({
    job_id: 'done-late-query', task_id: 'task-late', workdir: wd, status: 'running',
    pid: 999999, startedAt: new Date(startedMs).toISOString(), timeoutSec: 60, runDir, executor: 'codex',
    before_snapshot: snapshotToJSON(after),
  });
  const r = dispatch.status('done-late-query');
  assert.notEqual(r.status, 'timeout', '按时完成的任务不能因查询得晚被判超时');
  assert.equal(r.status, 'ok', '有产物应按 ok 收尾');
});

test('BUG3c 回归：子进程杀不掉时写锁不释放', async () => {
  setupEnv();
  const wd = makeGitWorkdir();
  const after = gitSnapshot(wd);
  const { spawn } = await import('node:child_process');
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{},600000)'], { stdio: 'ignore' });
  const { createHash } = await import('node:crypto');
  const { mkdirSync: mk } = await import('node:fs');
  const home = process.env.GCWORK_HOME;
  const h = createHash('sha1').update(wd.toLowerCase()).digest('hex').slice(0, 16);
  const lockFile = join(home, 'locks', `${h}.lock`);
  mk(join(home, 'locks'), { recursive: true });
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, jobId: 'undead', cwd: wd, startedAt: new Date().toISOString() }));
  const job = {
    job_id: 'undead', task_id: 'task-undead', workdir: wd, status: 'running',
    pid: sleeper.pid, startedAt: new Date(Date.now() - 3600_000).toISOString(),
    runDir: mkdtempSync(join(tmpdir(), 'gcw-run-')), lockPath: lockFile,
    before_snapshot: snapshotToJSON(after),
  };
  ledger.putJob(job);
  // 直接 finalize 一个 pid 仍存活的 job（模拟 kill 失败）
  const out = dispatch.finalize(job);
  assert.equal(out.lockHeld, true, '进程未死时必须保留锁');
  assert.ok(existsSync(lockFile), '锁文件应仍在');
  try { sleeper.kill(); } catch {}
});

test('BUG4 回归：存活 job 的写锁超 15 分钟也不被抢', async () => {
  const home = setupEnv();
  const wd = makeGitWorkdir();
  const lockId = 'live-job-lock';
  ledger.putJob({
    job_id: lockId, task_id: 'task-live', workdir: wd, status: 'running',
    pid: process.pid, startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  });
  // 造一个「2 小时前创建」的锁文件，jobId 指向上面那个仍存活的 job
  const { createHash } = await import('node:crypto');
  const { join: pjoin } = await import('node:path');
  const h = createHash('sha1').update(wd.toLowerCase()).digest('hex').slice(0, 16);
  const lockFile = pjoin(home, 'locks', `${h}.lock`);
  const { mkdirSync: mk } = await import('node:fs');
  mk(pjoin(home, 'locks'), { recursive: true });
  writeFileSync(lockFile, JSON.stringify({
    pid: process.pid, jobId: lockId, cwd: wd,
    startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  }));
  const r = await dispatch.dispatch({
    task_id: 'should-be-busy', prompt: 'test', workdir: wd,
    role: 'implementer', // 写任务才会抢锁
  });
  assert.equal(r.status, 'busy', '存活 job 的锁不能被超时抢走');
});

test('BUG-A 回归：任务非 ok 时 verify 不再跑 npm test', async () => {
  setupEnv();
  const wd = makeGitWorkdir();
  // 放一个会写标记的 test 脚本，若被执行就能看出来
  writeFileSync(join(wd, 'package.json'), JSON.stringify({
    name: 'x', version: '1.0.0',
    scripts: { test: 'node -e "require(\'fs\').writeFileSync(\'ran_test\',\'1\')"' },
  }));
  const after = gitSnapshot(wd);
  ledger.putJob({
    job_id: 'failed-with-test', task_id: 'tf', workdir: wd, status: 'failed',
    pid: null, startedAt: new Date().toISOString(), before_snapshot: snapshotToJSON(after),
  });
  const r = await verifyJob('failed-with-test');
  assert.equal(r.rejected, true);
  assert.equal(r.testsRan, false, '非 ok 任务不应执行测试脚本');
  assert.ok(!existsSync(join(wd, 'ran_test')), '测试脚本不应被执行');
});

test('BUG-B 回归：超期完成（产物晚于期限写入）判 timeout，不判 ok', () => {
  setupEnv();
  const wd = makeGitWorkdir();
  const after = gitSnapshot(wd);
  const runDir = mkdtempSync(join(tmpdir(), 'gcw-run-'));
  writeFileSync(join(runDir, 'stdout.log'), '{"type":"turn.completed","message":"超期才做完"}\n');
  // 把产物 mtime 改成 2 小时前，startedAt 设为 2.5 小时前，timeoutSec=60 → 超期完成
  const outPath = join(runDir, 'stdout.log');
  const started = Date.now() - 9000_000;   // 150 分钟前启动
  const finished = Date.now() - 7200_000;  // 120 分钟前写完
  utimesSync(outPath, new Date(finished), new Date(finished));
  ledger.putJob({
    job_id: 'late-finish', task_id: 'tlf', workdir: wd, status: 'running',
    pid: 999999, executor: 'codex', startedAt: new Date(started).toISOString(),
    timeoutSec: 60, runDir, before_snapshot: snapshotToJSON(after),
  });
  const r = dispatch.status('late-finish');
  assert.equal(r.status, 'timeout', '超期完成的任务应判 timeout，不能当 ok');
});

test('BUG-C 回归：Claude is_error=true 带文字时判失败，不是 ok', () => {
  setupEnv();
  const wd = makeGitWorkdir();
  const after = gitSnapshot(wd);
  const runDir = mkdtempSync(join(tmpdir(), 'gcw-run-'));
  writeFileSync(join(runDir, 'stdout.log'), JSON.stringify({
    result: 'authentication failed', is_error: true, usage: {},
  }));
  ledger.putJob({
    job_id: 'claude-err', task_id: 'tce', workdir: wd, status: 'running',
    pid: 999999, executor: 'claude', startedAt: new Date().toISOString(),
    timeoutSec: 600, runDir, before_snapshot: snapshotToJSON(after),
  });
  const r = dispatch.finalize(ledger.getJob('claude-err'));
  assert.notEqual(r.status, 'ok', 'Claude 报错带文字不能判成功');
  assert.ok(['rejected', 'failed', 'quota_exhausted'].includes(r.status), `实际 ${r.status}`);
});

test('BUG-D 回归：Codex turn.failed 带部分回答时判失败', () => {
  setupEnv();
  const wd = makeGitWorkdir();
  const after = gitSnapshot(wd);
  const runDir = mkdtempSync(join(tmpdir(), 'gcw-run-'));
  writeFileSync(join(runDir, 'stdout.log'), [
    '{"type":"item.completed","item":{"type":"agent_message","text":"我先看了一下代码"}}',
    '{"type":"turn.failed","error":{"message":"quota exceeded"}}',
  ].join('\n') + '\n');
  ledger.putJob({
    job_id: 'codex-partial-fail', task_id: 'tcp', workdir: wd, status: 'running',
    pid: 999999, executor: 'codex', startedAt: new Date().toISOString(),
    timeoutSec: 600, runDir, before_snapshot: snapshotToJSON(after),
  });
  const r = dispatch.finalize(ledger.getJob('codex-partial-fail'));
  assert.notEqual(r.status, 'ok', 'Codex 失败带部分回答不能判成功');
  assert.ok(r.partialOutput && r.partialOutput.length > 0, '失败也要给 partialOutput');
});

test('BUG-F 回归：force 也不能抢活着的任务锁', async () => {
  const home = setupEnv();
  const wd = makeGitWorkdir();
  const { spawn } = await import('node:child_process');
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{},600000)'], { stdio: 'ignore' });
  const { createHash } = await import('node:crypto');
  const { mkdirSync: mk } = await import('node:fs');
  const h = createHash('sha1').update(wd.toLowerCase()).digest('hex').slice(0, 16);
  mk(join(home, 'locks'), { recursive: true });
  const lockFile = join(home, 'locks', `${h}.lock`);
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, jobId: 'alive-job', cwd: wd, startedAt: new Date().toISOString() }));
  ledger.putJob({
    job_id: 'alive-job', task_id: 'ta', workdir: wd, status: 'running',
    pid: sleeper.pid, startedAt: new Date().toISOString(),
  });
  // 即使 force:true，也不许抢活着的任务
  const r = await dispatch.dispatch({
    task_id: 'force-attempt', prompt: 'x', workdir: wd, role: 'implementer', force: true,
  });
  assert.equal(r.status, 'busy', 'force 不能抢活锁');
  try { sleeper.kill(); } catch {}
});

test('BUG-G 回归：finalize 终态与 lockHeld 一次性发布（无中间窗口）', () => {
  setupEnv();
  const wd = makeGitWorkdir();
  const after = gitSnapshot(wd);
  const { spawn } = import('node:child_process');
  const runDir = mkdtempSync(join(tmpdir(), 'gcw-run-'));
  const job = {
    job_id: 'atomic-final', task_id: 'taf', workdir: wd, status: 'running',
    pid: null, startedAt: new Date().toISOString(), timeoutSec: 600, runDir,
    executor: 'codex', lockPath: null, before_snapshot: snapshotToJSON(after),
  };
  ledger.putJob(job);
  const out = dispatch.finalize(job);
  assert.equal(out.lockHeld, false, '进程已退出时 lockHeld 应为 false');
  // 台账里必须已经是最终形态，不存在「终态但缺 lockHeld」的中间版本
  const persisted = ledger.getJob('atomic-final');
  assert.equal(persisted.status, out.status);
  assert.equal(persisted.lockHeld, false, '台账终态必须同时含 lockHeld');
});

test('BUG-H 回归：内容变了但行数不变，也要检出（密钥被换行数相同）', () => {
  const wd = makeGitWorkdir();
  const f = join(wd, '.env');
  writeFileSync(f, 'API_KEY=old\n');
  const before = gitSnapshot(wd);
  writeFileSync(f, 'API_KEY=new\n'); // 行数、状态、numstat 全不变
  const after = gitSnapshot(wd);
  const d = gitDelta(before, after);
  assert.ok(d.paths.includes('.env'), '换掉同长度密钥必须被检出');
  assert.equal(d.stats.modified, 1);
});

test('BUG-I 回归：未跟踪目录要展开到文件级（.github/workflows 不能漏）', () => {
  const wd = makeGitWorkdir();
  const before = gitSnapshot(wd);
  const dir = join(wd, '.github', 'workflows');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ci.yml'), 'on: push\n');
  const after = gitSnapshot(wd);
  const d = gitDelta(before, after);
  assert.ok(
    d.paths.some((p) => p.replace(/\\/g, '/').includes('.github/workflows/ci.yml')),
    `应展开到文件级，实际：${JSON.stringify(d.paths)}`,
  );
  assert.ok(isSensitive(d.paths.find((p) => p.includes('ci.yml'))), '应命中敏感规则');
});

test('BUG-J 回归：台账写入是原子的（不产生半截 JSON）', () => {
  setupEnv();
  const job = { job_id: 'atomic-w', task_id: 'tw', status: 'running', workdir: '/tmp' };
  ledger.putJob(job);
  const rec = ledger.getJobStatus('atomic-w');
  assert.equal(rec.state, 'ok');
  assert.equal(rec.job.task_id, 'tw');
  // 覆盖写同样要原子
  ledger.putJob({ ...job, status: 'ok' });
  assert.equal(ledger.getJobStatus('atomic-w').job.status, 'ok');
  // 不存在的要能区分出来
  assert.equal(ledger.getJobStatus('nope').state, 'missing');
});

test('BUG-K 回归：台账损坏时不判 stale（不能凭坏文件抢锁）', async () => {
  const home = setupEnv();
  const wd = makeGitWorkdir();
  const { createHash } = await import('node:crypto');
  const h = createHash('sha1').update(wd.toLowerCase()).digest('hex').slice(0, 16);
  mkdirSync(join(home, 'locks'), { recursive: true });
  const lockFile = join(home, 'locks', `${h}.lock`);
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, jobId: 'corrupt-job', cwd: wd, startedAt: new Date().toISOString() }));
  // 造一个损坏的台账文件
  mkdirSync(join(home, 'ledger'), { recursive: true });
  writeFileSync(join(home, 'ledger', 'corrupt-job.json'), '{ 这不是合法 JSON ');
  assert.equal(ledger.getJobStatus('corrupt-job').state, 'corrupt');
  const r = await dispatch.dispatch({ task_id: 'x', prompt: 'p', workdir: wd, role: 'implementer' });
  assert.equal(r.status, 'busy', '台账损坏时不能抢锁');
});

test('BUG-L 回归：Claude 可写任务用 acceptEdits，不是 dontAsk', () => {
  // dontAsk 只放行预先授权的工具，不等于允许写工作区
  assert.equal(models.claudePermissionOf('workspace-write'), 'acceptEdits');
  assert.equal(models.claudePermissionOf('read-only'), 'plan');
});

test('BUG-M 回归：npm 通过 npm-cli.js 启动，不裸 spawn npm', () => {
  const cli = models.findNpmCli();
  // 本机应能定位到 npm-cli.js；定位不到时 verify 会退回裸 npm（不报错）
  assert.ok(cli === null || cli.endsWith('npm-cli.js'), `实际 ${cli}`);
  if (cli) assert.ok(existsSync(cli), '定位到的 npm-cli.js 必须存在');
});

test('BUG-N 回归：launcherFor 正确处理 .js / .exe / .cmd', () => {
  const js = models.launcherFor('C:/x/codex.js');
  assert.equal(js[0], process.execPath, '.js 应用 node 起');
  assert.equal(js[1], 'C:/x/codex.js');

  const exe = models.launcherFor('C:/x/claude.exe');
  assert.deepEqual(exe, ['C:/x/claude.exe'], '.exe 直接起');

  if (process.platform === 'win32') {
    const cmd = models.launcherFor('C:/x/npm.cmd');
    assert.equal(cmd.length, 3, '.cmd 在 Windows 需走 cmd /c');
    assert.equal(cmd[1], '/c');
  }
});

// ---------------------------------------------------------------- 契约
test('schema：6 个工具且含契约字段', () => {
  assert.equal(TOOLS.length, 6);
  const dispatchTool = TOOLS.find((t) => t.name === 'dispatch');
  assert.ok(dispatchTool.inputSchema.required.includes('task_id'));
  assert.ok(dispatchTool.inputSchema.required.includes('prompt'));
  assert.ok(dispatchTool.inputSchema.required.includes('workdir'));
});
