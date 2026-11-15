// 吉克搬砖 2.0.2 单元测试 —— node --test，零依赖、不联网、不烧额度。
// 覆盖：参数解析、冲突拒绝、模型严格解析、权限参数、超时关系、git 差集、结果卡。
// 用法：node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  TOOL_VERSION,
  TIMEOUT_MS,
  OUTER_TIMEOUT_MS,
  HOST_HARD_LIMIT_MS,
  MAX_CHANGED,
  EFFORTS,
  MODELS,
  TIERS,
  CODEX_SANDBOX,
  CLAUDE_PERMISSION,
  parseArgs,
  validateArgs,
  resolveTarget,
  resolveCodexModel,
  buildArgv,
  gitDelta,
  cardOf,
  classifyError,
  artifactNames,
  lockPathFor,
  acquireLock,
  releaseLock,
  pidAlive,
  versionOf,
  cmpVersion,
  truncate,
} from '../skills/gcwork-dispatch/scripts/dispatch.mjs';

// ---------------------------------------------------------------- 参数

test('parseArgs 解析完整命令', () => {
  const a = parseArgs(['--tier', 'plan', '--brief', 'C:/x/b.md', '--cwd', 'C:/x', '--env', 'clean']);
  assert.equal(a.tier, 'plan');
  assert.equal(a.brief, 'C:/x/b.md');
  assert.equal(a.cwd, 'C:/x');
  assert.equal(a.env, 'clean');
  assert.deepEqual(a.unknown, []);
});

test('parseArgs 缺值记入 unknown 而不是吞掉下一个开关', () => {
  const a = parseArgs(['--tier', '--brief', 'b.md']);
  assert.equal(a.tier, null);
  assert.equal(a.brief, 'b.md');
  assert.ok(a.unknown.some((x) => x.includes('--tier 缺值')));
});

test('parseArgs 未知开关被记录', () => {
  const a = parseArgs(['--tier', 'main', '--member', 'astra']);
  assert.deepEqual(a.unknown, ['--member']);
});

test('parseArgs 支持 --check / --version / --force', () => {
  const a = parseArgs(['--check', '--force', '--version']);
  assert.equal(a.check, true);
  assert.equal(a.force, true);
  assert.equal(a.version, true);
});

test('validateArgs 拒绝 --tier 与 --model 同传', () => {
  const msg = validateArgs({ tier: 'main', model: 'sol', env: 'inherit', unknown: [] });
  assert.match(msg, /互斥/);
});

test('validateArgs 拒绝非法 env', () => {
  assert.match(validateArgs({ tier: 'main', env: 'foo', unknown: [] }), /--env/);
});

test('validateArgs 放行合法组合', () => {
  assert.equal(validateArgs({ tier: 'main', env: 'inherit', unknown: [] }), null);
  assert.equal(validateArgs({ model: 'sol', env: 'clean', unknown: [] }), null);
});

// ---------------------------------------------------------------- 目标收敛

test('--tier 映射到 codex 侧模型与默认强度', () => {
  for (const [tier, spec] of Object.entries(TIERS)) {
    const t = resolveTarget({ tier });
    assert.equal(t.name, spec.codex);
    assert.equal(t.tier, tier);
    assert.equal(t.effort, spec.effort);
  }
});

test('--model 取自身档位，强度可覆盖', () => {
  const t = resolveTarget({ model: 'sonnet' });
  assert.equal(t.tier, 'main');
  assert.equal(t.effort, TIERS.main.effort);

  const o = resolveTarget({ model: 'sonnet', effort: 'low' });
  assert.equal(o.effort, 'low');
});

test('plan 档标记为只读', () => {
  assert.equal(resolveTarget({ tier: 'plan' }).readOnly, true);
  assert.equal(resolveTarget({ model: 'astra' }).readOnly, true);
  assert.equal(resolveTarget({ model: 'fable' }).readOnly, true);
  assert.equal(resolveTarget({ tier: 'main' }).readOnly, false);
  assert.equal(resolveTarget({ model: 'haiku' }).readOnly, false);
});

test('未知模型 / 档位 / 强度给出可用清单', () => {
  assert.match(resolveTarget({ model: 'gpt5' }).error, /未知模型/);
  assert.match(resolveTarget({ model: 'gpt5' }).error, /astra/);
  assert.match(resolveTarget({ tier: 'ultra' }).error, /未知档位/);
  assert.match(resolveTarget({ tier: 'main', effort: 'ultra' }).error, /未知强度/);
  assert.match(resolveTarget({}).error, /缺/);
});

test('模型名允许 gcwork- 前缀与大小写', () => {
  assert.equal(resolveTarget({ model: 'GCWORK-Opus' }).name, 'opus');
});

// ---------------------------------------------------------------- 权限

test('plan 档 Codex 用 read-only 沙箱', () => {
  assert.equal(CODEX_SANDBOX.plan, 'read-only');
  for (const t of ['hard', 'main', 'chore']) assert.equal(CODEX_SANDBOX[t], 'workspace-write');
});

test('plan 档 Claude 用 plan 权限模式', () => {
  assert.equal(CLAUDE_PERMISSION.plan, 'plan');
  for (const t of ['hard', 'main', 'chore']) assert.equal(CLAUDE_PERMISSION[t], 'dontAsk');
});

test('buildArgv: codex plan 档带 -s read-only', () => {
  const argv = buildArgv('astra', 'plan', 'high', { model: 'gpt-6-astra' }, 'C:/n/node.exe', 'C:/run', { gitRepo: true });
  assert.ok(argv.includes('-s'));
  assert.equal(argv[argv.indexOf('-s') + 1], 'read-only');
  assert.ok(argv.includes('--ephemeral'));
  assert.ok(!argv.includes('--skip-git-repo-check'), 'git 仓库内不应跳过检查');
  assert.ok(argv.includes('gpt-6-astra'));
  assert.ok(argv.join(' ').includes('model_reasoning_effort="high"'));
});

test('buildArgv: codex main 档可写且沿用同一入口', () => {
  const argv = buildArgv('terra', 'main', 'medium', { model: 'gpt-6.1-terra' }, 'C:/n/node.exe', 'C:/run', { gitRepo: true });
  assert.equal(argv[argv.indexOf('-s') + 1], 'workspace-write');
  assert.ok(argv.includes('--json'));
  assert.equal(argv[argv.length - 1], '-', '简报走 stdin');
});

test('buildArgv: 非 git 目录才追加 --skip-git-repo-check', () => {
  const argv = buildArgv('luna', 'chore', 'medium', { model: 'gpt-6-luna' }, 'C:/n/node.exe', 'C:/run', { gitRepo: false });
  assert.ok(argv.includes('--skip-git-repo-check'));
  assert.equal(argv[argv.length - 1], '-');
});

test('buildArgv: claude plan 档用 --permission-mode plan', () => {
  const argv = buildArgv('fable', 'plan', 'high', { model: 'fable' }, 'C:/c/claude.exe', 'C:/run');
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(argv[argv.indexOf('--model') + 1], 'fable');
  assert.equal(argv[argv.indexOf('--effort') + 1], 'high');
  assert.ok(argv.includes('--no-session-persistence'));
});

test('buildArgv: claude 执行档用 dontAsk', () => {
  const argv = buildArgv('haiku', 'chore', 'low', { model: 'haiku' }, 'C:/c/claude.exe', 'C:/run');
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'dontAsk');
});

test('xhigh / max 强度能进 argv 两侧', () => {
  for (const effort of ['xhigh', 'max']) {
    const cx = buildArgv('sol', 'hard', effort, { model: 'gpt-6.1-sol' }, 'C:/n/node.exe', 'C:/run');
    assert.ok(cx.join(' ').includes(`model_reasoning_effort="${effort}"`), `codex ${effort}`);
    const cl = buildArgv('opus', 'hard', effort, { model: 'opus' }, 'C:/c/claude.exe', 'C:/run');
    assert.equal(cl[cl.indexOf('--effort') + 1], effort, `claude ${effort}`);
  }
});

// ---------------------------------------------------------------- 模型解析

function catalog(models, canonical = true) {
  return [{ file: canonical ? 'models_cache.json' : 'models_cache.x.json', canonical, models }];
}

test('同家族多候选取最高版本，而不是按文件时间', () => {
  const cats = catalog([
    { slug: 'gpt-5.6-terra', priority: 3, visibility: 'list' },
    { slug: 'gpt-6.1-terra', priority: 8, visibility: 'list' },
    { slug: 'gpt-6-terra', priority: 2, visibility: 'list' },
  ]);
  const r = resolveCodexModel('terra', 'gpt-6.1-terra', cats);
  assert.equal(r.model, 'gpt-6.1-terra');
  assert.equal(r.source, 'cache');
  assert.deepEqual(r.alternatives.sort(), ['gpt-5.6-terra', 'gpt-6-terra'].sort());
});

test('家族不存在时返回 MODEL_UNAVAILABLE，绝不换模', () => {
  const cats = catalog([
    { slug: 'gpt-6-luna', priority: 1, visibility: 'list' },
    { slug: 'gpt-6.1-terra', priority: 2, visibility: 'list' },
  ]);
  const r = resolveCodexModel('astra', 'gpt-6-astra', cats);
  assert.equal(r.error, 'MODEL_UNAVAILABLE');
  assert.equal(r.model, undefined, '不能返回任何替代模型');
  assert.ok(r.available.includes('gpt-6-luna'));
  assert.match(r.detail, /astra/);
});

test('读不到任何 catalog 时用写死名字并标记 warning', () => {
  const r = resolveCodexModel('astra', 'gpt-6-astra', []);
  assert.equal(r.model, 'gpt-6-astra');
  assert.equal(r.source, 'fallback');
  assert.match(r.warning, /未经核对/);
});

test('版本比较按数值而非字符串', () => {
  assert.deepEqual(versionOf('gpt-6.1-terra'), [6, 1]);
  assert.deepEqual(versionOf('gpt-reserve'), [0]);
  assert.ok(cmpVersion('gpt-6.10-x', 'gpt-6.9-x') < 0, '6.10 > 6.9');
  assert.ok(cmpVersion('gpt-5.6-x', 'gpt-6-x') > 0, '6 > 5.6');
});

// ---------------------------------------------------------------- 超时

test('超时三层严格递增且外层不超过宿主硬上限', () => {
  assert.ok(TIMEOUT_MS < OUTER_TIMEOUT_MS, '内层必须小于外层');
  assert.ok(OUTER_TIMEOUT_MS < HOST_HARD_LIMIT_MS, '外层必须小于硬上限');
  assert.equal(TIMEOUT_MS, 540_000);
  assert.equal(OUTER_TIMEOUT_MS, 590_000);
  assert.ok(HOST_HARD_LIMIT_MS - OUTER_TIMEOUT_MS >= 10_000, '留给宿主编排的余量');
});

// ---------------------------------------------------------------- git 差集

function snap(head, entries) {
  return { head, files: new Map(Object.entries(entries)) };
}

test('gitDelta 识别新增 / 修改 / 删除', () => {
  const before = snap('a', { 'a.txt': { xy: ' M', added: '1', removed: '0' } });
  const after = snap('a', {
    'a.txt': { xy: ' M', added: '3', removed: '1' },
    'b.txt': { xy: '??', added: null, removed: null },
  });
  const d = gitDelta(before, after);
  assert.deepEqual(d.paths, ['a.txt', 'b.txt']);
  assert.equal(d.stats.modified, 1);
  assert.equal(d.stats.added, 1);
  assert.equal(d.stats.deleted, 0);
});

test('gitDelta 识别「改前已修改、改后又被改」：xy 不变但行数变了', () => {
  const before = snap('a', { 'x.js': { xy: ' M', added: '2', removed: '0' } });
  const after = snap('a', { 'x.js': { xy: ' M', added: '9', removed: '4' } });
  const d = gitDelta(before, after);
  assert.deepEqual(d.paths, ['x.js'], '这种变化旧实现会漏掉');
});

test('gitDelta 识别执行期间 HEAD 移动', () => {
  const d = gitDelta(snap('aaa', {}), snap('bbb', {}));
  assert.equal(d.headMoved, true);
});

test('gitDelta 两侧任一为 null 时返回 null', () => {
  assert.equal(gitDelta(null, snap('a', {})), null);
  assert.equal(gitDelta(snap('a', {}), null), null);
});

test('gitDelta 无变化时为空', () => {
  const s = snap('a', { 'k': { xy: ' M', added: '1', removed: '1' } });
  const d = gitDelta(s, s);
  assert.deepEqual(d.paths, []);
  assert.equal(d.headMoved, false);
});

// ---------------------------------------------------------------- 结果卡

test('cardOf 无 runDir 时原样返回（参数错 / 锁占用）', () => {
  const r = { ok: false, code: 'BAD_ARGS', detail: 'x' };
  assert.equal(cardOf(r), r);
});

test('cardOf 带 runDir 时收敛字段并补 artifacts', () => {
  const full = {
    runId: '20260101-000000-abcd1234',
    ok: true,
    code: null,
    tier: 'main',
    model: 'terra',
    resolvedModel: 'gpt-6.1-terra',
    modelSource: 'cache',
    effort: 'medium',
    readOnly: false,
    changedCount: 1,
    changedStats: { added: 1, modified: 0, deleted: 0 },
    hasMessage: true,
    partial: false,
    billingWarning: 'claude 侧检测到 X',
    gitWarning: null,
    runDir: 'C:/runs/x',
    artifacts: ['brief.md', 'result.json', 'message.md', 'raw.log'],
    detail: null,
    usage: { input_tokens: 1 },
  };
  const c = cardOf(full);
  assert.equal(c.messagePath, join('C:/runs/x', 'message.md'));
  assert.equal(c.billingWarning, 'claude 侧检测到 X');
  assert.ok('artifacts' in c);
  assert.ok(!('usage' in c), '用量不进卡片，落 result.json');
  assert.ok(!('detail' in c), '成功时不输出 detail');
});

test('产物清单按 CLI 与是否改文件变化', () => {
  assert.deepEqual(artifactNames('claude', false), ['brief.md', 'result.json', 'message.md', 'raw.log']);
  assert.deepEqual(artifactNames('codex', false), ['brief.md', 'result.json', 'message.md', 'raw.log', 'last.md']);
  assert.ok(artifactNames('codex', true).includes('changed.txt'));
  assert.ok(!artifactNames('claude', false).includes('changed.txt'));
});

test('MAX_CHANGED 与文档一致', () => {
  assert.equal(MAX_CHANGED, 40);
});

// ---------------------------------------------------------------- 其它

test('classifyError 归类', () => {
  assert.equal(classifyError('You have hit your usage limit'), 'QUOTA');
  assert.equal(classifyError('401 Unauthorized'), 'AUTH');
  assert.equal(classifyError('model gpt-9 not found'), 'MODEL_UNAVAILABLE');
  assert.equal(classifyError('spawn codex ENOENT'), 'FAILED');
  assert.equal(classifyError(''), 'FAILED');
});

test('lockPathFor 同目录同锁、大小写无关、不同目录不同锁', () => {
  const a = lockPathFor('C:/Work/X');
  const b = lockPathFor('c:/work/x');
  const c = lockPathFor('C:/Work/Y');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /locks[\\/][0-9a-f]{16}\.lock$/);
});

test('并发锁：活进程持锁时第二单被拒为 BUSY，释放后可再取', () => {
  const cwd = `C:/__gcwork_test__/${Date.now()}`;
  const first = acquireLock(cwd, 'run-A', false);
  assert.equal(first.ok, true);

  const second = acquireLock(cwd, 'run-B', false);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'BUSY');
  assert.match(second.detail, /run-A/);

  releaseLock(first.path);
  const third = acquireLock(cwd, 'run-C', false);
  assert.equal(third.ok, true);
  releaseLock(third.path);
});

test('并发锁：--force 可强抢', () => {
  const cwd = `C:/__gcwork_test__/${Date.now()}-force`;
  const first = acquireLock(cwd, 'run-A', false);
  const forced = acquireLock(cwd, 'run-B', true);
  assert.equal(forced.ok, true);
  releaseLock(first.path);
  releaseLock(forced.path);
});

test('并发锁：死 pid 的锁视为过期', () => {
  const cwd = `C:/__gcwork_test__/${Date.now()}-stale`;
  const first = acquireLock(cwd, 'run-A', false);
  // 手改成一个不存在的 pid
  writeFileSync(first.path, JSON.stringify({ pid: 999999, runId: 'dead', cwd, startedAt: new Date().toISOString() }));
  const again = acquireLock(cwd, 'run-B', false);
  assert.equal(again.ok, true);
  rmSync(again.path, { force: true });
});

test('pidAlive: 自己一定活着，0 一定不活', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(null), false);
});

test('truncate 控长并保留头尾', () => {
  const s = 'A'.repeat(100) + 'B'.repeat(100);
  const t = truncate(s, 50, 'raw.log');
  assert.ok(t.length < 120);
  assert.ok(t.includes('截断'));
  assert.ok(t.startsWith('A'));
  assert.ok(t.endsWith('B'));
});

test('EFFORTS 五档齐全且顺序固定', () => {
  assert.deepEqual(EFFORTS, ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('八个模型与四档互相对应', () => {
  assert.equal(Object.keys(MODELS).length, 8);
  for (const [tier, spec] of Object.entries(TIERS)) {
    assert.equal(MODELS[spec.codex].tier, tier);
    assert.equal(MODELS[spec.claude].tier, tier);
    assert.equal(MODELS[spec.codex].cli, 'codex');
    assert.equal(MODELS[spec.claude].cli, 'claude');
  }
});

test('版本号已推进到 2.0.2', () => {
  assert.equal(TOOL_VERSION, '2.0.2');
});
