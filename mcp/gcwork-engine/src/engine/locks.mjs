// 同目录写锁：同一目录同时只允许一个写任务，防止两个 CLI 改同一批文件。
// 并发总量不在这里管——交给宿主与系统调度。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getJobStatus, locksDir } from './ledger.mjs';
import { pidAlive } from './run.mjs';

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
        const stillRunning = held.status === 'running' && held.pid && pidAlive(held.pid);
        const undead = held.lockHeld === true && held.pid && pidAlive(held.pid);
        // worker 模式：worker 进程自己活着也算占用
        const workerAlive = held.status === 'running' && held.workerPid && pidAlive(held.workerPid);
        stale = !(stillRunning || undead || workerAlive);
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
