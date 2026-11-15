// 单个任务的执行器。由 CLI 以 detached 方式拉起，跑完即退出。
//
// 为什么单独一个进程：CLI 每次调用都是短命进程，如果任务跑在 CLI 里，
// CLI 一退出任务就断了。detached worker 独立存活，CLI 只管派单和查状态。
//
// 一个 worker 对应一个 job：起 app-server → thread/start → turn/start →
// 收通知流写台账 → 终态落盘 → 退出。
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { ensureAppServer, startThread, startTurn, subscribe, interruptTurn, shutdownAppServer } from './appserver.mjs';
import { getJob, putJob } from './ledger.mjs';
import { gitSnapshot, gitDelta, snapshotFromJSON, gitDiffText } from './git.mjs';
import { classifyError } from './errors.mjs';
import { releaseLock } from './locks.mjs';
import { buildArgv as claudeArgv, readResult as claudeRead } from '../adapters/claude.mjs';

const FLUSH_MS = 500;
const MAX_ITEMS = 40;

function truncate(s, max) {
  const t = String(s || '');
  if (t.length <= max) return t;
  return `${t.slice(0, Math.floor(max * 0.7))}\n…[超长截断，原始 ${t.length} 字符]…\n${t.slice(-Math.floor(max * 0.2))}`;
}

async function main() {
  const specPath = process.argv[2];
  if (!specPath) throw new Error('缺少任务描述文件参数');
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  return runJob(spec);
}

/**
 * 在当前进程内跑完一个任务。
 * CLI 直接调用它（阻塞到任务结束），不再依赖单独的 worker 进程——
 * Windows 沙箱的 Job Object 会在父进程退出时连带杀掉整棵进程树，
 * 独立 worker 在这种环境下活不下来。
 */
export async function runJob(spec) {
  const { jobId, runDir, cwd, prompt, model, effort, timeoutSec, entry, executor } = spec;

  const startedAt = Date.now();
  const route = { messageBuf: '', items: [], status: 'running', error: null, usage: null };
  let lastFlush = 0;
  const logPath = join(runDir, 'stderr.log');
  const log = (msg) => {
    // start /B 启动时没有 stdio，日志只能自己落文件，否则出问题完全看不见
    try { appendFileSync(logPath, `[worker] ${new Date().toISOString()} ${msg}\n`); } catch { /* 忽略 */ }
  };

  // 立刻上报 pid：派单方据此判断 worker 是否活着
  const j0 = getJob(jobId);
  if (j0) putJob({ ...j0, workerPid: process.pid, workerAliveAt: new Date().toISOString() });
  log(`worker 启动 pid=${process.pid} executor=${executor}`);

  const flush = (force = false) => {
    const now = Date.now();
    if (!force && now - lastFlush < FLUSH_MS) return;
    lastFlush = now;
    const job = getJob(jobId);
    if (!job || job.status !== 'running') return;
    putJob({
      ...job,
      progress: {
        items: route.items.slice(-MAX_ITEMS),
        messageLength: route.messageBuf.length,
        turnStatus: route.status,
        updatedAt: new Date(now).toISOString(),
      },
    });
  };

  const pushItem = (label) => {
    route.items.push({ at: new Date().toISOString(), label });
    if (route.items.length > MAX_ITEMS) route.items.shift();
  };

  // 心跳：让 status 知道 worker 还活着
  const heartbeat = setInterval(() => {
    const job = getJob(jobId);
    if (job && job.status === 'running') {
      putJob({ ...job, workerPid: process.pid, workerAliveAt: new Date().toISOString() });
    }
  }, 5000);

  try {
    if (executor === 'claude') {
      await runClaude(spec, route, pushItem, flush, startedAt);
    } else {
      await runCodex(spec, route, pushItem, flush, startedAt);
    }
  } catch (e) {
    route.status = 'failed';
    route.error = String((e && e.message) || e);
    log(`执行异常：${e && e.stack || e}`);
    pushItem(`启动失败：${route.error.slice(0, 100)}`);
  } finally {
    clearInterval(heartbeat);
    log(`收尾 status=${route.status} 消息长度=${route.messageBuf.length}`);
    finish(spec, route, runDir);
    shutdownAppServer();
  }
}

/** codex：走常驻 app-server，进度靠通知流。 */
async function runCodex(spec, route, pushItem, flush, startedAt) {
  const { jobId, cwd, prompt, model, effort, timeoutSec, entry } = spec;

  let myThread = null;
  let myTurn = null;
  subscribe(({ method, params }) => {
    const tid = params?.threadId || params?.thread?.id || null;
    if (myThread && tid && tid !== myThread) return;

    if (method === 'turn/started') {
      if (params.turnId || params.turn?.id) myTurn = myTurn || params.turnId || params.turn.id;
      pushItem('开始执行');
      flush(true);
    } else if (method === 'item/started') {
      const t = params.item?.type;
      if (t) pushItem(`执行中：${t}`);
      flush(true);
    } else if (method === 'item/agentMessage/delta') {
      if (params.delta) route.messageBuf += String(params.delta);
      flush();
    } else if (method === 'item/completed') {
      const it = params.item || {};
      if (it.type === 'agentMessage' && it.text && !route.messageBuf) route.messageBuf = String(it.text);
      if (it.type === 'commandExecution' && it.command) {
        pushItem(`命令：${String(it.command).slice(0, 80)}（exit ${it.exitCode ?? '?'}）`);
      }
      flush();
    } else if (method === 'turn/completed') {
      route.status = 'completed';
      if (params.usage) route.usage = params.usage;
      pushItem('执行结束');
      flush(true);
    } else if (method === 'turn/failed' || method === 'error') {
      route.status = 'failed';
      route.error = params?.error?.message || params?.message || 'turn 失败';
      pushItem(`失败：${String(route.error).slice(0, 100)}`);
      flush(true);
    } else if (method === 'turn/interrupted') {
      route.status = 'interrupted';
      pushItem('已中断');
      flush(true);
    }
  });

  await ensureAppServer({ entry });
  const th = await startThread({ cwd, model });
  myThread = th.threadId;
  putJob({ ...getJob(jobId), threadId: myThread });

  const { turnId } = await startTurn({ threadId: myThread, text: prompt, effort, model, cwd });
  myTurn = turnId;
  putJob({ ...getJob(jobId), turnId });
  flush(true);

  const limit = Number(timeoutSec) * 1000;
  const deadline = setTimeout(() => {
    if (route.status === 'running') {
      try { interruptTurn({ threadId: myThread, turnId: myTurn }); } catch { /* 忽略 */ }
      route.status = 'interrupted';
      pushItem('超时中断');
      flush(true);
    }
  }, limit);
  deadline.unref?.();

  await new Promise((resolve) => {
    const tick = () => {
      if (route.status !== 'running') { resolve(); return; }
      if (Date.now() - startedAt > limit + 30_000) { resolve(); return; }
      setTimeout(tick, 400);
    };
    tick();
  });
  clearTimeout(deadline);
}

/** claude：没有 app-server，走一次性子进程；进度靠 stdout 流式累积。 */
async function runClaude(spec, route, pushItem, flush) {
  const { jobId, cwd, prompt, model, effort, entry, runDir, gitRepo } = spec;
  const argv = claudeArgv({
    prompt, effort, sandbox: spec.sandbox, modelInfo: { model }, entry, runDir, gitRepo,
  });
  pushItem('启动 claude');
  flush(true);

  const child = spawn(argv[0], argv.slice(1), {
    cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  putJob({ ...getJob(jobId), pid: child.pid || null });

  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d.toString('utf8'); flush(); });
  child.stderr.on('data', (d) => { err += d.toString('utf8'); });
  child.on('error', (e) => {
    route.status = 'failed';
    route.error = `spawn 失败：${e && e.message}`;
    pushItem('启动失败');
    flush(true);
  });

  await new Promise((resolve) => {
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });

  if (route.status === 'running') {
    const r = claudeRead(out);
    route.messageBuf = r.message || '';
    route.usage = r.usage || null;
    if (r.isError) {
      route.status = 'failed';
      route.error = String(r.message || 'Claude 报错');
    } else if (route.messageBuf.trim()) {
      route.status = 'completed';
    } else {
      route.status = 'failed';
      route.error = err.trim() || 'claude 没有输出';
    }
    pushItem(route.status === 'completed' ? '执行结束' : '执行失败');
    flush(true);
  }
}

function finish(spec, route, runDir) {
  const { jobId } = spec;
  const job = getJob(jobId);
  if (!job) return;
  if (job.status !== 'running') return; // 已被其它路径收尾

  const message = (route.messageBuf || '').trim();
  let status;
  if (route.status === 'interrupted') status = 'timeout';
  else if (route.status === 'failed') status = route.error ? mapError(route.error) : 'failed';
  else if (route.status === 'completed') status = message ? 'ok' : 'crashed';
  else status = 'crashed';

  const before = snapshotFromJSON(job.before_snapshot);
  const after = gitSnapshot(job.workdir);
  const delta = gitDelta(before, after);
  const changedFiles = delta ? delta.paths : [];
  const headMoved = Boolean(delta?.headMoved);

  const warnings = [];
  if (job.git_warning) warnings.push(job.git_warning);
  if (headMoved) warnings.push('执行期间 HEAD 变了：CLI 可能提交过代码');

  writeFileSync(join(runDir, 'message.md'), message ? `${message}\n` : '', 'utf8');
  if (changedFiles.length) writeFileSync(join(runDir, 'changed.txt'), `${changedFiles.join('\n')}\n`, 'utf8');
  const diff = gitDiffText(job.workdir);
  if (diff) writeFileSync(join(runDir, 'diff.txt'), `${diff}\n`, 'utf8');

  const endedAt = new Date().toISOString();
  putJob({
    ...job,
    status,
    summary: truncate(message ? (message.split(/\r?\n/).find((l) => l.trim()) || '(空行)') : status, 500),
    partialOutput: truncate(message || route.error || '（无输出）', 4000),
    changed_files: changedFiles,
    changed_stats: delta ? delta.stats : null,
    headMoved,
    usage: route.usage || null,
    endedAt,
    durationSec: Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(job.startedAt)) / 1000)),
    git_warning: warnings.length ? warnings.join('；') : null,
    progress: {
      items: route.items.slice(-MAX_ITEMS),
      messageLength: message.length,
      turnStatus: route.status,
      updatedAt: endedAt,
    },
    lockHeld: false,
    workerPid: process.pid,
    workerAliveAt: endedAt,
  });

  releaseLock(job.lockPath, jobId);
}

function mapError(text) {
  const c = classifyError(text);
  if (c === 'QUOTA') return 'quota_exhausted';
  if (c === 'AUTH' || c === 'NOT_FOUND' || c === 'MODEL_UNAVAILABLE') return 'rejected';
  return 'failed';
}

// 只在被当作脚本直接运行时才自动执行；被 cli.mjs import 时不应跑 main。
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) main().catch((e) => {
  try { appendFileSync(join(JSON.parse(readFileSync(process.argv[2], 'utf8')).runDir, 'stderr.log'), `[worker] FATAL ${e && e.stack || e}\n`); } catch { /* 忽略 */ }
  try {
    const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    const job = getJob(spec.jobId);
    if (job && job.status === 'running') {
      putJob({
        ...job,
        status: 'failed',
        summary: truncate(`worker 异常：${e && e.message}`, 500),
        partialOutput: String(e && e.stack || e).slice(0, 4000),
        endedAt: new Date().toISOString(),
      });
    }
  } catch { /* 兜底失败就算了 */ }
  process.exit(1);
});
