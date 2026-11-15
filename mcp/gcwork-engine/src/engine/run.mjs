// 子进程管理：detached 脱离宿主/Agent 轮次上限独立运行；pid 轮询判断生死（Windows 下
// unref 的 detached 子进程不一定回调 exit，故用 pid-poll）。超时杀树 + 落 timeout 标记。
import { spawn, spawnSync } from 'node:child_process';
import { openSync, closeSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 以 detached 方式启动子进程，stdout/stderr 重定向到文件，unref 脱离本进程。
 * 这样即使宿主/Agent 轮次到点，长任务也能继续跑完。
 *
 * 启动失败（ENOENT 等）不在这里抛出，而是通过返回的 spawnError 交给调用方处理：
 * 监听 child 的 error 事件，否则会成为未捕获异常并泄漏 fd。
 * @returns {{pid:number|null, spawnError:string|null}}
 */
export function spawnDetached(argv, { cwd, env, stdoutPath, stderrPath, stdinText = null }) {
  let out = null;
  let err = null;
  try {
    out = openSync(stdoutPath, 'w');
    err = openSync(stderrPath, 'w');
  } catch (e) {
    if (out !== null) { try { closeSync(out); } catch { /* 忽略 */ } }
    if (err !== null) { try { closeSync(err); } catch { /* 忽略 */ } }
    return { pid: null, spawnError: `打开输出文件失败：${e && e.message}` };
  }

  let child;
  let spawnError = null;
  try {
    child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      stdio: ['pipe', out, err],
      detached: true,
      windowsHide: true,
    });
  } catch (e) {
    spawnError = String(e && e.message || e);
  } finally {
    // 父进程侧句柄用完即关：子进程已复制自己的 fd，不关会一直泄漏。
    try { closeSync(out); } catch { /* 忽略 */ }
    try { closeSync(err); } catch { /* 忽略 */ }
  }

  if (!child) return { pid: null, spawnError: spawnError || '子进程创建失败' };

  // 异步启动失败（ENOENT/EACCES）走 error 事件，必须接管，否则进程会崩。
  child.on('error', (e) => {
    spawnError = String(e && e.message || e);
    try {
      writeFileSync(stderrPath, `[spawn failed] ${spawnError}\n`, 'utf8');
    } catch { /* 忽略 */ }
  });

  // 若有 stdin（codex 的 `-` 提示），写入后关闭
  if (stdinText != null) {
    try {
      child.stdin.write(stdinText);
      child.stdin.end();
    } catch { /* 子进程可能已退出 */ }
  } else if (child.stdin) {
    try { child.stdin.end(); } catch { /* 忽略 */ }
  }
  child.unref();

  return { pid: child.pid || null, spawnError };
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
