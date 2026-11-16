// 目录写锁：同一个工作目录同时只允许一个写任务。
//
// 为什么需要：两个任务同时改同一批文件会互相覆盖，codex 各自都在「按自己看到的现状」改，
// 后完成的那个会把前一个的结果覆盖掉，而且两边都报 completed，看不出问题。
//
// 为什么用文件锁而不是内存锁：MCP 进程可能不止一个（多个 WorkBuddy 窗口各起一个），
// 内存锁跨进程无效，只有文件系统才是共同可见的。
//
// 实现只有一件事：openSync(path, 'wx')。O_EXCL 建文件是原子的，
// 存在即失败，不存在就成功，不需要 flock、不需要 pid 轮询、不需要等锁队列。
import { openSync, closeSync, writeSync, readFileSync, unlinkSync, mkdirSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

/**
 * 锁名只由工作目录决定，不带任何配置。
 *
 * 为什么：不同进程可以用不同的 CODEX_DISPATCH_HOME 甚至不同的插件副本，
 * 但它们争的是同一个目录，必须看到同一把锁。所以锁的位置和名字都不能跟着配置走。
 * 只要有一个「全局唯一且所有进程都可见」的东西就够了，这里用系统临时目录。
 */
function lockName(cwd) {
  const norm = resolve(cwd).replace(/\\/g, '/').toLowerCase();
  return `dir-${createHash('sha1').update(norm).digest('hex').slice(0, 16)}.lock`;
}

/**
 * 锁目录固定在系统临时目录，与 CODEX_DISPATCH_HOME 无关。
 *
 * 代价：系统清临时目录会把锁一起清掉。这个方向的失效是安全的 ——
 * 丢锁最多让两个任务同时跑（等于没有锁时的状态），不会反过来把目录永久锁死。
 */
function locksDir() {
  return join(tmpdir(), 'codex-dispatch-locks');
}

// 兜底：pid 会被系统复用，四小时后一律当僵尸。任务最长一小时，不会误杀在跑的任务。
const MAX_HOLD_MS = 4 * 3600_000;

/** 进程是否还活着。EPERM 说明进程存在但没权限探测，也算活着。 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * 读锁内容。
 *
 * 必须区分三件事，混在一起会出竞态（实测抓到过）：
 *   读到了      → 返回记录
 *   文件不存在  → null，可以抢
 *   文件在但读不出 → 有人正在 open 和 write 之间，**绝不能当僵尸删掉**
 *
 * 第三种如果不单独处理，就会出现「A 刚建好空文件、B 判定损坏后删掉并抢锁」，
 * 同一目录同时跑起两个任务。
 *
 * 真残留的空文件（进程在 open 与 write 之间崩了）也要能回收，
 * 所以用 mtime 兜底：超过 WRITING_GRACE 还读不出，就认定不是正在写。
 */
const WRITING_GRACE_MS = 5000;

function readLock(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    // 读不出内容：短时间内的当「正在写入」，超时才认定是残留
    try {
      const age = Date.now() - statSync(path).mtimeMs;
      return age < WRITING_GRACE_MS ? { __writing: true } : null;
    } catch {
      return null; // 连 stat 都不行，说明文件没了
    }
  }
}

function isStale(info) {
  if (!info) return true;
  if (info.__writing) return false; // 正在写，当活锁
  if (!pidAlive(info.pid)) return true;
  const age = Date.now() - Date.parse(info.acquiredAt || 0);
  return Number.isFinite(age) && age > MAX_HOLD_MS;
}

/**
 * 抢锁。成功返回 {ok:true, path, token}，被占返回 {ok:false, holder}。
 * 占锁的进程已经死了就清掉重抢 —— 否则一次崩溃会让那个目录永久锁死。
 */
export function acquire(home, cwd, info) {
  const dir = locksDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, lockName(cwd));
  const rec = {
    ...info,
    cwd: resolve(cwd),
    pid: process.pid,
    token: randomUUID(),
    acquiredAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(path, 'wx'); // 原子：已存在直接抛 EEXIST
      try {
        writeSync(fd, `${JSON.stringify(rec)}\n`);
      } finally {
        closeSync(fd);
      }
      return { ok: true, path, token: rec.token };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }

    const holder = readLock(path);
    if (!isStale(holder)) return { ok: false, holder };

    // 僵尸锁：删掉重试。删之前再确认一次没被别人抢先换成新锁。
    try {
      const again = readLock(path);
      if (again === null || isStale(again)) unlinkSync(path);
    } catch { /* 别人刚好删了，下一轮重试 */ }
  }
  return { ok: false, holder: readLock(path) };
}

/** 只删自己那把。token 不匹配说明锁已经被别人接管，不能动。 */
export function release(home, cwd, token) {
  const path = join(locksDir(), lockName(cwd));
  try {
    const info = readLock(path);
    if (info && token && info.token !== token) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/** 启动时清僵尸锁。节点崩溃后留下的锁不清理，下次派单会被莫名拒绝。 */
export function sweepLocks() {
  const dir = locksDir();
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.lock')) continue;
    const p = join(dir, f);
    if (!isStale(readLock(p))) continue;
    try {
      unlinkSync(p);
      removed += 1;
    } catch { /* 单个失败不影响 */ }
  }
  return removed;
}

/** 给回执用的可读描述：谁占着、占多久了。 */
export function describeHolder(holder) {
  if (!holder) return '另一个任务正占用这个目录';
  const sec = holder.acquiredAt
    ? Math.max(0, Math.round((Date.now() - Date.parse(holder.acquiredAt)) / 1000))
    : null;
  const who = holder.taskRef ? `任务 ${holder.taskRef}` : '另一个任务';
  const howLong = sec === null ? '' : sec < 60 ? `（已运行 ${sec} 秒）` : `（已运行 ${Math.round(sec / 60)} 分钟）`;
  return `${who} 正在这个目录里跑${howLong}`;
}