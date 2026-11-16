// status 工具测试：只读探测，不建会话、不占锁、不花额度。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const FIX = join(import.meta.dirname, 'fixtures', 'fake-codex.mjs');
const TMP = join(process.env.TEMP || '/tmp', `codex-dispatch-test-status-${process.pid}`);
let n = 0;

before(() => { mkdirSync(TMP, { recursive: true }); });
after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } });

/** 每次 import 都要换模块实例：status 的缓存是模块级的。 */
async function load(name) {
  n += 1;
  const home = join(TMP, `h${n}-${name}`);
  mkdirSync(home, { recursive: true });
  process.env.CODEX_DISPATCH_HOME = home;
  const p = join(import.meta.dirname, '..', 'mcp', 'codex-dispatch', 'status.mjs');
  return import(`${pathToFileURL(p).href}?s=${name}-${Math.random()}`);
}

test('status：登录正常时给出账号、模型与档位', async () => {
  process.env.CODEX_DISPATCH_CODEX_ENTRY = FIX;
  const m = await load('ready');
  const r = await m.status();

  assert.equal(r.status, 'ready');
  assert.equal(r.codex.found, true);
  assert.equal(r.account.logged_in, true);
  assert.equal(r.account.plan, 'plus');

  const ids = r.models.map((x) => x.id);
  assert.deepEqual(ids, ['fake-sol', 'fake-lite']);
  // 每个模型自带档位，模型不能靠猜
  const sol = r.models.find((x) => x.id === 'fake-sol');
  assert.deepEqual(sol.efforts, ['low', 'medium', 'high']);
  assert.equal(sol.default_effort, 'medium');
  assert.equal(sol.default, true);

  // 只读能不能联网，取决于这一项
  assert.equal(r.capabilities.web_search, true);
});

test('status：找不到 codex 时给安装提示，不抛异常', async () => {
  process.env.CODEX_DISPATCH_CODEX_ENTRY = join(TMP, 'no-such-codex.js');
  // 入口探测会回退去常规位置找，这里把可能存在的都排除掉不现实，
  // 所以只断言：返回结构合法，且状态是三种之一
  const m = await load('missing');
  const r = await m.status();
  assert.ok(['ready', 'not_ready', 'codex_not_found'].includes(r.status));
  if (r.status === 'codex_not_found') {
    assert.equal(r.codex.found, false);
    assert.match(r.hint, /npm i -g/);
  }
});

test('status：一分钟内重复查走缓存，不重复起进程', async () => {
  process.env.CODEX_DISPATCH_CODEX_ENTRY = FIX;
  const m = await load('cache');
  const a = await m.status();
  const t0 = Date.now();
  const b = await m.status();
  const ms = Date.now() - t0;

  assert.equal(b.cached, true);
  assert.deepEqual(b.models, a.models);
  // 命中缓存应当近乎瞬时；真起 app-server 至少几百毫秒
  assert.ok(ms < 50, `命中缓存却有 ${ms}ms，说明又起了一次进程`);
});
