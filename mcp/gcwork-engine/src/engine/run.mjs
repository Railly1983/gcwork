// 子进程管理：detached 脱离宿主/Agent 轮次上限独立运行；pid 轮询判断生死（Windows 下
// unref 的 detached 子进程不一定回调 exit，故用 pid-poll）。超时杀树 + 落 timeout 标记。
import { spawn, spawnSync } from 'node:child_process';
import { openSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 以 detached 方式启动子进程，stdout/stderr 重定向到文件，unref 脱离本进程。
 * 这样即使宿主/Agent 轮次到点，长任务也能继续跑完。
 * @returns {{pid:number|null}}
 */
export function spawnDetached(argv, { cwd, env, stdoutPath, stderrPath, stdinText = null }) {
  const out = openSync(stdoutPath, 'w');
  const err = openSync(stderrPath, 'w');
  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    env,
    stdio: ['pipe', out, err],
    detached: true,
    windowsHide: true,
  });
  // 若有 stdin（codex 的 `-` 提示），写入后关闭
  if (stdinText != null) {
    try {
      child.stdin.write(stdinText);
      child.stdin.end();
    } catch { /* 子进程可能已退出 */ }
  } else if (child.stdin) {
    child.stdin.end();
  }
  child.unref();
  return { pid: child.pid };
}

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

/**
 * pid 轮询等待子进程结束（用于 blocking 模式）。
 * @returns {Promise<{timedOut:boolean, waitedMs:number}>}
 */
export function waitTerminal(pid, { timeoutMs = 1800_000, pollMs = 500 } = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (!pidAlive(pid)) {
        resolve({ timedOut: false, waitedMs: Date.now() - start });
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        resolve({ timedOut: true, waitedMs: Date.now() - start });
        return;
      }
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

/**
 * 监控器：后台轮询 pid，死亡时回调 onExit；超时则杀树并回调 onTimeout。
 * 返回一个 stop()（非阻塞模式下其实不需要常驻，status() 会主动 reaping，这里主要服务 blocking）。
 */
export function monitor(pid, { timeoutMs = 1800_000, pollMs = 1000, onExit, onTimeout } = {}) {
  const start = Date.now();
  let stopped = false;
  const stop = () => { stopped = true; };
  const tick = () => {
    if (stopped) return;
    if (!pidAlive(pid)) {
      onExit && onExit();
      return;
    }
    if (Date.now() - start >= timeoutMs) {
      killJob(pid);
      // 标记超时，供 finalize 判定
      onTimeout && onTimeout();
      return;
    }
    setTimeout(tick, pollMs);
  };
  tick();
  return stop;
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
