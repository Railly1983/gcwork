// gcwork-engine 单元测试 + e2e（fake CLI）。运行：node --test tests/engine.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
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
  assert.equal(models.claudePermissionOf('workspace-write'), 'dontAsk');
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

// ---------------------------------------------------------------- e2e：codex 成功
test('e2e codex 成功：status=ok 且带 message/changedFiles', async () => {
  const home = setupEnv();
  process.env.GCWORK_CODEX_ENTRY = CODEX_OK;
  const wd = makeGitWorkdir();
  const r = await dispatch.dispatch({
    task_id: 'e2e-ok-' + Date.now(), prompt: 'write a file', workdir: wd, role: 'implementer', blocking: true,
  });
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.ok(r.partialOutput && r.partialOutput.includes('codex done'), '应含成功信息');
  assert.ok(Array.isArray(r.changedFiles) && r.changedFiles.length >= 1, '应有改动文件');
  rmSync(home, { recursive: true, force: true });
  rmSync(wd, { recursive: true, force: true });
});

// ---------------------------------------------------------------- e2e：codex 失败（partialOutput 非空）
test('e2e codex 失败：status 终态且 partialOutput 非空', async () => {
  const home = setupEnv();
  process.env.GCWORK_CODEX_ENTRY = CODEX_FAIL;
  const wd = makeGitWorkdir();
  const r = await dispatch.dispatch({
    task_id: 'e2e-fail-' + Date.now(), prompt: 'do it', workdir: wd, role: 'implementer', blocking: true,
  });
  assert.notEqual(r.status, 'ok');
  assert.notEqual(r.status, 'running');
  assert.ok(r.partialOutput && r.partialOutput.length > 0, '失败也必须带 partialOutput');
  rmSync(home, { recursive: true, force: true });
  rmSync(wd, { recursive: true, force: true });
});

// ---------------------------------------------------------------- e2e：半自动续跑
test('e2e resume：failed 后同 task_id 续跑成功', async () => {
  const home = setupEnv();
  process.env.GCWORK_CODEX_ENTRY = CODEX_RESUME;
  const wd = makeGitWorkdir();
  const task_id = 'e2e-resume-' + Date.now();
  const first = await dispatch.dispatch({
    task_id, prompt: 'do the thing', workdir: wd, role: 'implementer', blocking: true,
  });
  assert.notEqual(first.status, 'ok', '首次应失败');
  assert.notEqual(first.status, 'running');

  const resumed = await dispatch.resume({ task_id, blocking: true });
  assert.equal(resumed.status, 'ok', JSON.stringify(resumed));
  assert.equal(resumed.task_id, task_id);
  assert.notEqual(resumed.job_id, first.job_id, '续跑应开新 job');
  rmSync(home, { recursive: true, force: true });
  rmSync(wd, { recursive: true, force: true });
});

// ---------------------------------------------------------------- e2e：claude 成功
test('e2e claude 成功：executor=claude 走 claude 适配', async () => {
  const home = setupEnv();
  process.env.GCWORK_CLAUDE_ENTRY = CLAUDE_OK;
  const wd = makeGitWorkdir();
  const r = await dispatch.dispatch({
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
  assert.equal(h.version, '2.1.0');
});

// ---------------------------------------------------------------- 契约
test('schema：6 个工具且含契约字段', () => {
  assert.equal(TOOLS.length, 6);
  const dispatchTool = TOOLS.find((t) => t.name === 'dispatch');
  assert.ok(dispatchTool.inputSchema.required.includes('task_id'));
  assert.ok(dispatchTool.inputSchema.required.includes('prompt'));
  assert.ok(dispatchTool.inputSchema.required.includes('workdir'));
});
