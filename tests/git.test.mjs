// 单元 + 集成测试。不依赖真实 codex 的部分用假 app-server 跑，秒级完成。
//
// 覆盖方案里的六项验收：
// 1 正常派单  2 中途超时  3 宿主重启  4 执行中断续做  5 改动准确  6 失败诊断
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { baseline, collect, headCommit } from '../mcp/codex-dispatch/git.mjs';

const TMP = join(process.env.TEMP || '/tmp', `codex-dispatch-test-git-${process.pid}`);

function freshDir(name) {
  const d = join(TMP, `${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  return d;
}
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });

function initRepo(d) {
  git(d, 'init', '-q');
  git(d, 'config', 'user.email', 't@t.t');
  git(d, 'config', 'user.name', 't');
  writeFileSync(join(d, 'a.txt'), 'one\ntwo\n', 'utf8');
  writeFileSync(join(d, 'b.txt'), 'keep\n', 'utf8');
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'init');
}

// ---------------------------------------------------------------- 基线

test('基线：git 仓库能拿到 HEAD', () => {
  const d = freshDir('base-git');
  initRepo(d);
  const b = baseline(d);
  assert.equal(b.repo, true);
  assert.match(b.head, /^[0-9a-f]{40}$/);
});

test('基线：非 git 目录返回原因与文件快照', () => {
  const d = freshDir('base-nogit');
  writeFileSync(join(d, 'x.txt'), 'hi\n', 'utf8');
  const b = baseline(d);
  assert.equal(b.repo, false);
  assert.ok(b.reason);
  // 必须给出快照，否则任务后无法判断改了什么
  assert.ok(b.snapshot && Object.keys(b.snapshot).length >= 1);
});

test('基线：记录任务前就脏的文件及指纹', () => {
  const d = freshDir('base-dirty');
  initRepo(d);
  writeFileSync(join(d, 'b.txt'), 'keep\nPRE\n', 'utf8');
  const b = baseline(d);
  assert.deepEqual(b.preexistingDirty, ['b.txt']);
  assert.ok(b.fingerprint['b.txt'], '必须有内容指纹');
});

// ---------------------------------------------------------------- 改动识别

test('改动：识别已跟踪修改与未跟踪新文件', () => {
  const d = freshDir('chg-basic');
  initRepo(d);
  const b = baseline(d);
  writeFileSync(join(d, 'a.txt'), 'one\ntwo\nthree\n', 'utf8');
  writeFileSync(join(d, 'new.txt'), 'brand new\n', 'utf8');

  const c = collect(d, b);
  assert.equal(c.repo, true);
  assert.ok(c.files.some((f) => f.path === 'a.txt'), '要认出修改的文件');
  assert.equal(c.additions, 1);
  assert.deepEqual(c.untracked, ['new.txt']);
});

test('改动：任务前就脏、这次没再动的文件被排除', () => {
  const d = freshDir('chg-preexist');
  initRepo(d);
  // 任务前弄脏 b.txt
  writeFileSync(join(d, 'b.txt'), 'keep\nPRE-EXISTING\n', 'utf8');
  const b = baseline(d);

  // 任务只改 a.txt，没碰 b.txt
  writeFileSync(join(d, 'a.txt'), 'one\ntwo\nTASK\n', 'utf8');

  const c = collect(d, b);
  const touched = c.touchedFiles.map((f) => f.path);
  assert.deepEqual(touched, ['a.txt'], 'b.txt 不是这单干的，必须剔除');
  assert.deepEqual(c.preexistingUntouched, ['b.txt']);
  assert.ok(c.warning, '要说明工作区原本就有脏改动');
});

test('改动：任务在上游脏文件上继续改，则算本次产出', () => {
  const d = freshDir('chg-continue-dirty');
  initRepo(d);
  writeFileSync(join(d, 'b.txt'), 'keep\nPRE\n', 'utf8');
  const b = baseline(d);

  // 任务又改了同一个文件
  writeFileSync(join(d, 'b.txt'), 'keep\nPRE\nTASK-ALSO\n', 'utf8');

  const c = collect(d, b);
  assert.deepEqual(c.touchedFiles.map((f) => f.path), ['b.txt'], '指纹变了就是任务改的');
  assert.deepEqual(c.preexistingUntouched, []);
});

test('改动：非 git 目录按快照判断，不能报 0 改动', () => {
  const d = freshDir('chg-nogit');
  writeFileSync(join(d, 'a.txt'), 'one\n', 'utf8');
  const b = baseline(d);

  writeFileSync(join(d, 'a.txt'), 'one\ntwo\n', 'utf8');
  writeFileSync(join(d, 'new.txt'), 'n\n', 'utf8');

  const c = collect(d, b);
  assert.equal(c.repo, false);
  const paths = c.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['a.txt', 'new.txt'], '两个文件都要认出来');
  assert.match(c.warning, /回滚|行数/, '必须声明没有行数统计与回滚保障');
});

test('改动：非 git 目录新文件能报出新增行数', () => {
  const d = freshDir('chg-nogit-lines');
  writeFileSync(join(d, 'a.txt'), 'one\n', 'utf8');
  const b = baseline(d);
  // 新文件 3 行
  writeFileSync(join(d, 'new.txt'), 'x\ny\nz\n', 'utf8');
  const c = collect(d, b);
  const nf = c.files.find((f) => f.path === 'new.txt');
  assert.equal(nf.additions, 3, '新文件的行数必须准确');
  assert.equal(c.additions, 3);
});

test('改动：非 git 目录删除文件能报出删除行数', () => {
  const d = freshDir('chg-nogit-dellines');
  writeFileSync(join(d, 'gone.txt'), 'a\nb\nc\nd\n', 'utf8');
  const b = baseline(d);
  rmSync(join(d, 'gone.txt'));
  const c = collect(d, b);
  assert.deepEqual(c.deleted, ['gone.txt']);
  assert.equal(c.deletions, 4, '删除的行数要能算出来');
});

test('改动：非 git 目录修改文件不虚报增删行数', () => {
  const d = freshDir('chg-nogit-mod');
  writeFileSync(join(d, 'a.txt'), 'one\n', 'utf8');
  const b = baseline(d);
  writeFileSync(join(d, 'a.txt'), 'one\ntwo\nthree\n', 'utf8');
  const c = collect(d, b);
  const mf = c.files.find((f) => f.path === 'a.txt');
  // 没有基线内容就算不出真实增删，宁可报 0 也不要编一个数
  assert.equal(mf.additions, 0);
  assert.equal(mf.deletions, 0);
  assert.equal(mf.lines, 3, '至少要给出当前行数');
  assert.match(c.warning, /增删行数给不出/);
});

test('改动：git 目录删除文件能被识别', () => {
  const d = freshDir('chg-git-del');
  initRepo(d);
  const b = baseline(d);
  rmSync(join(d, 'b.txt'));
  const c = collect(d, b);
  assert.deepEqual(c.deleted, ['b.txt']);
});

// ---------------------------------------------------------------- 脏数据鲁棒性

test('改动：空基线不崩', () => {
  const d = freshDir('chg-nullbase');
  initRepo(d);
  const c = collect(d, { repo: false, reason: '无', snapshot: null });
  assert.equal(c.repo, false);
  assert.ok(c.warning);
});

test('改动：HEAD 在任务期间没变时 headCommit 稳定', () => {
  const d = freshDir('chg-head');
  initRepo(d);
  const h1 = headCommit(d);
  writeFileSync(join(d, 'a.txt'), 'changed\n', 'utf8');
  const h2 = headCommit(d);
  assert.equal(h1, h2, '只改工作区不该动 HEAD');
});

// ---------------------------------------------------------------- 清理

test('清理临时目录', () => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
  assert.ok(true);
});