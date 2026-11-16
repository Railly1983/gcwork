// 目录写锁：最轻的那条路能不能扛住真实竞争。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { acquire, release, sweepLocks, describeHolder } from '../mcp/codex-dispatch/lock.mjs';

const MOD = pathToFileURL(join(import.meta.dirname, '../mcp/codex-dispatch/lock.mjs')).href;
const ROOT = join(process.env.TEMP || '/tmp', `codex-dispatch-test-lock-${process.pid}`);
const LOCKS = join(process.env.TEMP || '/tmp', 'codex-dispatch-locks');

function clearLocks() {
  try { rmSync(LOCKS, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

function freshHome(tag) {
  const d = join(ROOT, `${tag}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(d, { recursive: true });
  return d;
}
// 锁目录现在固定在系统临时目录（与 home 无关），测试直接看那里
function lockFiles() {
  const d = join(process.env.TEMP || '/tmp', 'codex-dispatch-locks');
  return existsSync(d) ? readdirSync(d) : [];
}

test('抢锁：第一次成功，第二次被同一个持有者挡住', () => {
  clearLocks();
  const home = freshHome('basic');
  const ws = join(ROOT, 'ws-basic');

  const a = acquire(home, ws, { taskRef: 't-aaa11111' });
  assert.equal(a.ok, true);
  assert.ok(a.token);

  const b = acquire(home, ws, { taskRef: 't-bbb22222' });
  assert.equal(b.ok, false);
  // 回执要能说清是谁占着，否则用户不知道等什么
  assert.match(describeHolder(b.holder), /t-aaa11111/);
  assert.match(describeHolder(b.holder), /正在这个目录里跑/);

  release(home, ws, a.token);
  const c = acquire(home, ws, { taskRef: 't-bbb22222' });
  assert.equal(c.ok, true);
  release(home, ws, c.token);
});

test('释放只能由持有人做：token 不匹配时不许删别人的锁', () => {
  clearLocks();
  const home = freshHome('token');
  const ws = join(ROOT, 'ws-token');

  const a = acquire(home, ws, { taskRef: 't-aaa11111' });
  assert.equal(a.ok, true);

  // 别人拿着错的 token 来放锁，必须失败，且锁还在
  assert.equal(release(home, ws, 'not-my-token'), false);
  assert.equal(acquire(home, join(ROOT, 'ws-token'), { taskRef: 'x' }).ok, false);

  assert.equal(release(home, ws, a.token), true);
});

test('路径写法不同但指向同一目录，算同一把锁', () => {
  clearLocks();
  const home = freshHome('norm');
  const ws = join(ROOT, 'ws-norm');

  const a = acquire(home, ws, { taskRef: 't-aaa11111' });
  assert.equal(a.ok, true);

  // Windows 路径大小写不敏感；带尾斜杠、用正斜杠都是同一个目录
  const variants = [ws.toUpperCase(), `${ws}/`, ws.replace(/\\/g, '/')];
  for (const v of variants) {
    const got = acquire(home, v, { taskRef: 't-other000' });
    assert.equal(got.ok, false, `应被挡住：${v}`);
  }
  release(home, ws, a.token);
});

test('不同目录互不影响，可以同时跑', () => {
  clearLocks();
  const home = freshHome('multi');
  const a = acquire(home, join(ROOT, 'ws-a'), { taskRef: 't-aaa11111' });
  const b = acquire(home, join(ROOT, 'ws-b'), { taskRef: 't-bbb22222' });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(lockFiles().length, 2);
  release(home, join(ROOT, 'ws-a'), a.token);
  release(home, join(ROOT, 'ws-b'), b.token);
  assert.equal(lockFiles().length, 0);
});

test('持有进程已死：锁当僵尸清掉，下一个能抢到', () => {
  clearLocks();
  const home = freshHome('stale');
  const ws = join(ROOT, 'ws-stale');
  mkdirSync(LOCKS, { recursive: true });

  // 直接伪造一把锁，pid 用一个绝不可能存在的值
  const name = `dir-${createHash('sha1').update(ws.replace(/\\/g, '/').toLowerCase()).digest('hex').slice(0, 16)}.lock`;
  writeFileSync(join(LOCKS, name), JSON.stringify({
    taskRef: 't-dead0000',
    cwd: ws,
    pid: 999999999,
    token: 'dead',
    acquiredAt: new Date().toISOString(),
  }), 'utf8');

  const got = acquire(home, ws, { taskRef: 't-new00000' });
  assert.equal(got.ok, true, '僵尸锁应该被清掉，不能把目录永久锁死');
  release(home, ws, got.token);
});

test('锁文件刚建还没写完：当「正在写入」，不许抢', () => {
  clearLocks();
  const home = freshHome('writing');
  const ws = join(ROOT, 'ws-writing');
  mkdirSync(LOCKS, { recursive: true });
  const name = `dir-${createHash('sha1').update(ws.replace(/\\/g, '/').toLowerCase()).digest('hex').slice(0, 16)}.lock`;
  // 模拟「A 已 open 建好文件、还没 write」的那一瞬
  writeFileSync(join(LOCKS, name), '', 'utf8');

  const got = acquire(home, ws, { taskRef: 't-new00000' });
  assert.equal(got.ok, false, '空文件必须当活锁：否则同一目录会跑起两个任务');
  clearLocks();
});

test('锁文件是残留空文件：超过宽限期后可以回收', () => {
  clearLocks();
  const home = freshHome('residue');
  const ws = join(ROOT, 'ws-residue');
  mkdirSync(LOCKS, { recursive: true });
  const name = `dir-${createHash('sha1').update(ws.replace(/\\/g, '/').toLowerCase()).digest('hex').slice(0, 16)}.lock`;
  const p = join(LOCKS, name);
  writeFileSync(p, '', 'utf8');
  // 把 mtime 改到很久以前，模拟「进程在 open 与 write 之间崩了」
  const old = new Date(Date.now() - 3600_000);
  utimesSync(p, old, old);

  const got = acquire(home, ws, { taskRef: 't-new00000' });
  assert.equal(got.ok, true, '残留空文件不能把目录永久锁死');
  release(home, ws, got.token);
  clearLocks();
});

test('跨进程竞争：六个进程同时抢，只有一个成功', async () => {
  clearLocks();
  const home = freshHome('race');
  const ws = join(ROOT, 'ws-race');
  mkdirSync(ws, { recursive: true });

  // 关键：赢家不能靠「等固定时长」来持有 —— 机器一慢，别的子进程还没启动完它就退出了，
  // 锁随即变僵尸被下一个抢走，看起来像「有 5 个赢家」。
  // 所以赢家改为等一个 sentinel 文件：父进程收齐所有报告、断完言后才让它放手。
  const sentinel = join(ROOT, 'race-sentinel');
  const CHILD = `
const { existsSync } = await import('node:fs');
const { acquire } = await import(process.env.MOD);
const r = acquire(process.env.HOME_DIR, process.env.WS, { taskRef: process.env.REF });
process.stdout.write('###' + JSON.stringify({ ok: r.ok }) + '###');
if (r.ok) {
  const until = Date.now() + 15000;
  while (!existsSync(process.env.SENTINEL) && Date.now() < until) {
    await new Promise((res) => setTimeout(res, 50));
  }
}
process.exit(0);
`;

  const children = [];
  function race(ref) {
    return new Promise((resolve) => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', CHILD], {
        env: { ...process.env, MOD, HOME_DIR: home, WS: ws, REF: ref, SENTINEL: sentinel },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      children.push(c);
      let out = '';
      let reported = false;
      c.stdout.on('data', (d) => {
        out += d.toString();
        if (reported) return;
        const m = out.match(/###(.*?)###/s);
        if (m) {
          reported = true;
          // 拿到报告就 resolve，不等子进程退出：赢家还要继续持有锁
          resolve(JSON.parse(m[1]));
        }
      });
      c.stderr.on('data', () => {});
      c.on('close', () => {
        if (!reported) resolve({ ok: null, raw: out.slice(0, 200) });
      });
    });
  }

  const results = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => race(`t-race000${i}`)));
  const winners = results.filter((r) => r.ok === true).length;
  assert.equal(winners, 1, `只应有一个赢家，实际 ${winners} 个：${JSON.stringify(results)}`);

  // 输家给出的是「谁占着」，不是空手而归
  const losers = results.filter((r) => r.ok === false);
  assert.equal(losers.length, 5);

  // 放行，等全部退出
  writeFileSync(sentinel, 'go', 'utf8');
  await Promise.all(children.map((c) => new Promise((res) => {
    if (c.exitCode !== null) { res(); return; }
    c.once('close', res);
    setTimeout(res, 3000);
  })));

  // 赢家退出后锁成僵尸，sweep 应该能清掉
  assert.equal(sweepLocks(), 1);
  clearLocks();
});

test('清理僵尸锁：活进程的锁不动', () => {
  clearLocks();
  const home = freshHome('sweep');
  const ws = join(ROOT, 'ws-sweep');

  const mine = acquire(home, ws, { taskRef: 't-alive000' });
  assert.equal(mine.ok, true);

  // 再伪造一把死进程的
  mkdirSync(join(home, 'locks'), { recursive: true });
  const name = `dir-${createHash('sha1').update('d:/other/ws').digest('hex').slice(0, 16)}.lock`;
  writeFileSync(join(LOCKS, name), JSON.stringify({
    taskRef: 't-dead0000', pid: 999999999, token: 'dead', acquiredAt: new Date().toISOString(),
  }), 'utf8');

  assert.equal(sweepLocks(), 1, '只清死的那把');
  assert.equal(lockFiles().length, 1, '活的那把必须留着');
  release(home, ws, mine.token);
});