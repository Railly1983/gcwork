// 同目录写锁：同一目录同时只允许一个写任务，防止两个 CLI 改同一批文件。
// 并发总量不在这里管——交给宿主与系统调度。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getJobStatus, locksDir } from './ledger.mjs';
import { pidAlive } from './run.mjs';

export const HEARTBEAT_STALE_MS = 120_000; // 与 dispatch 判活阈值保持一致 // 心跳超过这个时间算任务已死

export function lockPathFor(cwd) {
  const h = createHash('sha1').update(resolve(cwd).toLowerCase()).digest('hex').slice(0, 16);
  return join(locksDir(), `${h}.lock`);
}

/**
 * 获取写锁。
 * @param {string} cwd 目标目录
 * @param {boolean} force 只清理「确认已死」的锁，绝不抢活着的任务
 */
export function acquireLock(cwd, force = false) {
  const p = lockPathFor(cwd);
  mkdirSync(locksDir(), { recursive: true });
  const body = JSON.stringify({
    pid: process.pid, jobId: 'pending', cwd: resolve(cwd), startedAt: new Date().toISOString(),
  });
  for (let i = 0; i < 2; i += 1) {
    try {
      writeFileSync(p, body, { flag: 'wx' });
      return { ok: true, path: p };
    } catch (e) {
      if (e.code !== 'EEXIST') return { ok: false, code: 'rejected', detail: `并发锁创建失败：${e.message}` };
      let holder = null;
      try { holder = JSON.parse(readFileSync(p, 'utf8')); } catch { holder = null; }

      const rec = holder?.jobId ? getJobStatus(holder.jobId) : { state: 'missing', job: null };
      const held = rec.job;
      let stale;
      if (!holder) {
        stale = true;
      } else if (rec.state === 'corrupt') {
        // 台账损坏不代表任务已死，宁可让用户重试
        stale = false;
      } else if (held) {
        // 任务可能跑在独立进程里，也可能跑在常驻 MCP 进程内（没有自己的 pid）。
        // 所以判活有三条线索：进程还在、心跳还新鲜、收尾时显式声明仍持锁。
        const running = held.status === 'running' || held.status === 'pending';
        // 两处 pid 都要看：锁文件里的 pid 是「派单时写入的执行进程」，
        // job 里的 pid 是「任务实际执行进程」。只查后者会在派单到首次心跳之间
        // 把活锁判成死锁，两个写任务就会同时改同一批文件。
        const alive = Boolean(
          (holder.pid && pidAlive(holder.pid)) || (held.pid && pidAlive(held.pid)),
        );
        const hbAge = held.heartbeatAt ? Date.now() - Date.parse(held.heartbeatAt) : Infinity;
        const fresh = hbAge < HEARTBEAT_STALE_MS;
        const undead = held.lockHeld === true;
        stale = !(running && (alive || fresh || undead));
      } else {
        const age = holder.startedAt ? Date.now() - Date.parse(holder.startedAt) : Infinity;
        stale = !pidAlive(holder.pid) || age > 15 * 60_000;
      }

      const forceable = force && stale && !(held && (held.pid && pidAlive(held.pid)));
      if (forceable || stale) {
        let same = true;
        try {
          const now = JSON.parse(readFileSync(p, 'utf8'));
          same = !holder || !now || now.jobId === holder.jobId;
        } catch { same = false; }
        if (same) { try { rmSync(p, { force: true }); } catch { /* 忽略 */ } }
        continue;
      }
      const why = holder?.pid && pidAlive(holder.pid) ? '进程仍在运行' : '锁仍有效';
      return { ok: false, code: 'busy', detail: `同一目录已有写入任务（${holder?.jobId || '?'}，${why}），等它结束后再试` };
    }
  }
  return { ok: false, code: 'busy', detail: '并发锁获取失败，重试后仍被占用' };
}

/**
 * 释放写锁。传入 jobId 时校验归属。
 *
 * 用 rename 到临时名再删，而不是「读 → 判断 → 删」：
 * rename 在同目录内原子，抢到改名权的一方才真正持有删除资格。
 */
export function releaseLock(p, jobId = null) {
  if (!p) return;
  if (!existsSync(p)) return;
  const tmp = `${p}.release-${process.pid}-${Date.now()}`;
  try {
    renameSync(p, tmp);
  } catch {
    return;
  }
  if (jobId) {
    let owner = null;
    try { owner = JSON.parse(readFileSync(tmp, 'utf8')); } catch { owner = null; }
    if (owner && owner.jobId && owner.jobId !== jobId) {
      try { renameSync(tmp, p); } catch { /* 放不回只能作罢 */ }
      return;
    }
  }
  try { rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
}
