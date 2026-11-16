// 子进程管理：detached 脱离宿主/Agent 轮次上限独立运行；pid 轮询判断生死（Windows 下
// unref 的 detached 子进程不一定回调 exit，故用 pid-poll）。超时杀树 + 落 timeout 标记。
import { spawn, spawnSync } from 'node:child_process';
import { openSync, closeSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';


/** pid 是否还活着（用于跨进程存活判断）。 */
export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 杀掉整个进程树（Windows 用 taskkill /T /F；*nix 用负数 pid 发 SIGKILL）。 */
export function killJob(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 15_000 });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch { /* 已退出 */ }
  }
}



/** 在 runDir 里写 timeout 标记，finalize 据此判定 status=timeout。 */
export function markTimedOut(runDir) {
  try {
    writeFileSync(join(runDir, 'timedout.flag'), new Date().toISOString(), 'utf8');
  } catch { /* 忽略 */ }
}

export function wasTimedOut(runDir) {
  return existsSync(join(runDir, 'timedout.flag'));
}
