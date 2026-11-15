// 派发编排：dispatch / status / resume / 验收封装 / listJobs / recoverOrphans。
// 核心职责：统一契约、detached 执行抗宿主超时、半自动续跑、产物解析、并发与写锁。
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, renameSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  pickTarget, resolveModel, findCodexEntry, findClaudeEntry, billingWarningFor, childEnv, MODELS,
} from './models.mjs';
import { gitSnapshot, gitDelta, snapshotToJSON, snapshotFromJSON, gitDiffText } from './engine/git.mjs';
import { putJob, getJob, getJobStatus, getLatestByTask, resolveRef, listJobs, pruneRuns, runsDir, locksDir, ensureDirs } from './engine/ledger.mjs';
import {
  spawnDetached, pidAlive, killJob, waitTerminal, monitor, markTimedOut, wasTimedOut,
} from './engine/run.mjs';
import { classifyError, parseResumeAfter } from './engine/errors.mjs';
import { buildArgv as codexArgv, readResult as codexRead } from './adapters/codex.mjs';
import { buildArgv as claudeArgv, readResult as claudeRead } from './adapters/claude.mjs';
import {
  ensureAppServer, startThread, startTurn, steerTurn, interruptTurn, subscribe,
  appServerStatus, shutdownAppServer,
} from './engine/appserver.mjs';

const DEFAULT_TIMEOUT_SEC = 1800; // 30 分钟安全上限，远高于宿主轮次上限
const MAX_PROMPT = 200_000; // 简报上限保护
const MAX_PARTIAL = 4000; // partialOutput 截断
const MAX_PROGRESS_ITEMS = 40; // 进度里保留的最近条目数

// 进程内活跃任务（用于同目录写锁与状态查询；并发上限交给宿主，不再自己掐）
const activeJobs = new Set();

// app-server 会话 → job 的路由表。threadId 是主键，事件到达时据此归位。
const threadRoutes = new Map(); // threadId → { jobId, turnId, messageBuf, items, status, error }
// 台账落盘节流：delta 是逐 token 的，每个都写盘会把派单拖慢几秒。
const PROGRESS_FLUSH_MS = 500;
const lastFlushAt = new Map(); // jobId → 上次写台账的时间戳

function nowStamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function newJobId() {
  return `${nowStamp()}-${randomUUID().slice(0, 8)}`;
}

function truncate(s, max) {
  const t = String(s || '');
  if (t.length <= max) return t;
  return `${t.slice(0, Math.floor(max * 0.7))}\n…[超长截断，原始 ${t.length} 字符]…\n${t.slice(-Math.floor(max * 0.2))}`;
}

// ---------------------------------------------------------------- 校验

function validateDispatch(task) {
  if (!task || typeof task !== 'object') return 'task 必须是对象';
  if (!task.task_id || typeof task.task_id !== 'string') return '缺少 task_id';
  if (!task.prompt || !String(task.prompt).trim()) return '缺少 prompt';
  if (!task.workdir || !String(task.workdir).trim()) return '缺少 workdir（绝对路径）';
  if (!isAbsolute(task.workdir)) return `workdir 必须是绝对路径：${task.workdir}`;
  if (!existsSync(task.workdir)) return `工作目录不存在：${task.workdir}`;
  if (task.sandbox && !['read-only', 'workspace-write'].includes(task.sandbox)) {
    return `sandbox 只支持 read-only / workspace-write，收到 ${task.sandbox}`;
  }
  if (task.timeout_sec != null) {
    const n = Number(task.timeout_sec);
    if (!Number.isFinite(n) || n <= 0) return 'timeout_sec 必须为正数';
    if (n > 14400) return 'timeout_sec 不得超过 14400（4 小时）';
  }
  if (task.output_mode && !['text', 'json'].includes(task.output_mode)) {
    return `output_mode 只支持 text / json，收到 ${task.output_mode}`;
  }
  if (task.model && !MODELS[String(task.model).toLowerCase().replace(/^gcwork-/, '')]) {
    return `未知 model：${task.model}；可用：${Object.keys(MODELS).join(', ')}`;
  }
  if (task.role && !['planner', 'implementer', 'reviewer'].includes(task.role)) {
    return `未知 role：${task.role}；可用 planner / implementer / reviewer`;
  }
  return null;
}

// ---------------------------------------------------------------- app-server 事件路由

/**
 * 通知流 → job。事件带 threadId，据此找到对应任务，累积消息与进度。
 * 只做累积与落台账，不做业务判断（终态仍由 turn/completed 决定）。
 */
function handleAppServerEvent({ method, params }) {
  const threadId = params?.threadId || params?.thread?.id || null;
  if (!threadId) return;
  const route = threadRoutes.get(threadId);
  if (!route) return;

  const pushItem = (label) => {
    route.items.push({ at: new Date().toISOString(), label });
    if (route.items.length > MAX_PROGRESS_ITEMS) route.items.shift();
  };

  if (method === 'turn/started') {
    if (params.turnId || params.turn?.id) route.turnId = params.turnId || params.turn.id;
    pushItem('开始执行');
  } else if (method === 'item/started') {
    const t = params.item?.type;
    if (t) pushItem(`执行中：${t}`);
  } else if (method === 'item/agentMessage/delta') {
    if (params.delta) route.messageBuf += String(params.delta);
  } else if (method === 'item/completed') {
    const it = params.item || {};
    if (it.type === 'agentMessage' && it.text && !route.messageBuf) route.messageBuf = String(it.text);
    if (it.type === 'commandExecution' && it.command) {
      pushItem(`命令：${String(it.command).slice(0, 80)}（exit ${it.exitCode ?? '?'}）`);
    }
  } else if (method === 'turn/completed') {
    route.status = 'completed';
    if (params.usage) route.usage = params.usage;
    pushItem('执行结束');
  } else if (method === 'turn/failed' || method === 'error') {
    route.status = 'failed';
    route.error = params?.error?.message || params?.message || 'turn 失败';
    pushItem(`失败：${String(route.error).slice(0, 100)}`);
  } else if (method === 'turn/interrupted') {
    route.status = 'interrupted';
    pushItem('已中断');
  } else if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
    // 只读/沙箱内不该出现审批请求；出现说明策略没生效，记录但不阻塞
    pushItem('收到审批请求（已自动拒绝，请检查沙箱策略）');
  }

  // 关键事件立即落盘；普通 delta 节流，避免逐 token 写文件把 IO 打满。
  const critical = method === 'turn/started' || method === 'turn/completed'
    || method === 'turn/failed' || method === 'turn/interrupted' || method === 'item/started';
  const now = Date.now();
  const last = lastFlushAt.get(route.jobId) || 0;
  if (!critical && now - last < PROGRESS_FLUSH_MS) return;
  lastFlushAt.set(route.jobId, now);

  const job = getJob(route.jobId);
  if (job && job.status === 'running') {
    putJob({
      ...job,
      turnId: route.turnId || job.turnId || null,
      progress: {
        items: route.items.slice(-MAX_PROGRESS_ITEMS),
        messageLength: route.messageBuf.length,
        turnStatus: route.status || 'running',
        updatedAt: new Date(now).toISOString(),
      },
    });
  }
}

let appServerSubscribed = false;
function ensureSubscribed() {
  if (appServerSubscribed) return;
  subscribe(handleAppServerEvent);
  appServerSubscribed = true;
}

// ---------------------------------------------------------------- 写锁（同目录同时仅一个可写任务）

function lockPathFor(cwd) {
  const h = createHash('sha1').update(resolve(cwd).toLowerCase()).digest('hex').slice(0, 16);
  return join(locksDir(), `${h}.lock`);
}

function acquireLock(cwd, force) {
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
      // 判锁是否失效：优先查台账里对应 job 是否真的还在跑（taskkill 后 pid 可能复用/宿主 pid 常驻）。
      // 台账读坏了不代表任务死了 —— 那种情况一律按「占用中」处理，宁可让用户重试。
      const rec = holder?.jobId ? getJobStatus(holder.jobId) : { state: 'missing', job: null };
      const held = rec.job;
      let stale;
      if (!holder) {
        stale = true;
      } else if (rec.state === 'corrupt') {
        stale = false; // 台账损坏：无法证明任务已死，禁止抢锁
      } else if (held) {
        // 两种情况锁必须保留：
        // 1) 任务仍 running 且子进程活着；
        // 2) 收尾时进程没杀掉、显式标了 lockHeld（状态可能是 timeout，但锁必须还在）。
        const stillRunning = held.status === 'running' && held.pid && pidAlive(held.pid);
        const undead = held.lockHeld === true && held.pid && pidAlive(held.pid);
        stale = !(stillRunning || undead);
      } else {
        // 台账里没有对应 job（锁是残留）→ 用 pid + 时间兜底
        const age = holder.startedAt ? Date.now() - Date.parse(holder.startedAt) : Infinity;
        stale = !pidAlive(holder.pid) || age > 15 * 60_000;
      }
      // force 只允许清理「确认已死」的锁，不能抢活着的任务——
      // 那等于主动制造同目录并发写。活锁只能等它结束。
      const holderAlive = Boolean(holder && holder.pid && pidAlive(holder.pid));
      const forceable = force && stale && !(held && held.pid && pidAlive(held.pid));
      if (forceable || stale) {
        // 删除前再确认一次持有者仍是同一个，缩小读-删之间的竞争窗口
        let same = true;
        try {
          const now = JSON.parse(readFileSync(p, 'utf8'));
          same = !holder || !now || now.jobId === holder.jobId;
        } catch { same = false; }
        if (same) { try { rmSync(p, { force: true }); } catch { /* 忽略 */ } }
        continue;
      }
      const whyAlive = holderAlive ? '进程仍在运行' : '锁仍有效';
      return { ok: false, code: 'busy', detail: `同一目录已有写入任务（${holder?.jobId || '?'}，${whyAlive}），等它结束后再试` };
    }
  }
  return { ok: false, code: 'busy', detail: '并发锁获取失败，重试后仍被占用' };
}

/**
 * 释放写锁。传入 jobId 时校验归属：只有锁文件里记的还是自己才删。
 *
 * 用 rename 到临时名再删，而不是「读 → 判断 → 删」：
 * rename 在同一个目录内是原子的，抢到改名权的那一方才真正持有删除资格，
 * 避免旧 finalizer 在别人刚接手锁之后把新锁删掉。
 */
function releaseLock(p, jobId = null) {
  if (!p) return;
  const tmp = `${p}.release-${process.pid}-${Date.now()}`;
  try {
    renameSync(p, tmp);
  } catch {
    return; // 已被别人移走/不存在
  }
  if (jobId) {
    let owner = null;
    try { owner = JSON.parse(readFileSync(tmp, 'utf8')); } catch { owner = null; }
    if (owner && owner.jobId && owner.jobId !== jobId) {
      // 移走的是别人的锁：尽力放回原位，避免误伤
      try { renameSync(tmp, p); } catch { /* 放不回就只能删，不阻塞 */ }
      return;
    }
  }
  try { rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
}

// ---------------------------------------------------------------- 派发

/**
 * 预热：先把 app-server 拉起来并完成握手，省掉用户第一次派单时的冷启动。
 * 不建 thread（thread 与 cwd 绑定，预热建的未必用得上），只做握手。
 */
export async function warmUpAppServer() {
  try {
    const entry = findCodexEntry();
    if (!entry) return { ok: false, detail: '找不到 codex 入口' };
    ensureSubscribed();
    await ensureAppServer({ entry });
    return { ok: true, ...appServerStatus() };
  } catch (e) {
    return { ok: false, detail: String((e && e.message) || e) };
  }
}

export async function dispatch(taskInput = {}) {
  ensureDirs();
  pruneRuns();

  const task = { ...taskInput };
  const verr = validateDispatch(task);
  if (verr) return { status: 'rejected', error: 'BAD_ARGS', detail: verr, task_id: task.task_id || null };

  const target = pickTarget(task);
  if (target.error) return { status: 'rejected', error: 'BAD_TARGET', detail: target.error, task_id: task.task_id };

  const modelInfo = resolveModel(target.name);
  if (modelInfo.error) {
    return {
      status: 'rejected',
      error: 'MODEL_UNAVAILABLE',
      detail: modelInfo.detail,
      available: modelInfo.available || null,
      model: target.name,
      task_id: task.task_id,
    };
  }

  const entry = target.cli === 'codex' ? findCodexEntry() : findClaudeEntry();
  if (!entry) {
    const side = target.cli === 'codex' ? 'Codex' : 'Claude';
    return { status: 'rejected', error: 'NOT_FOUND', detail: `找不到 ${side} 入口，请先安装并登录`, task_id: task.task_id };
  }

  const workdir = resolve(task.workdir);
  const readOnly = target.readOnly;

  // 同目录写锁：只保护「同一目录不被两个写任务同时改」，这是文件安全底线。
  // 并发总量不在这里限制——交给宿主与系统资源调度，自己再设一道只会添麻烦。
  if (!readOnly) {
    const lock = acquireLock(workdir, Boolean(task.force));
    if (!lock.ok) return { status: lock.code, detail: lock.detail, task_id: task.task_id };
    task._lockPath = lock.path;
  }

  // jobId 要在 acquireLock 之后才能生成，这里提前生成以便写进锁文件
  const jobId = newJobId();
  if (task._lockPath) {
    try {
      writeFileSync(task._lockPath, JSON.stringify({
        pid: process.pid, jobId, cwd: resolve(workdir), startedAt: new Date().toISOString(),
      }));
    } catch { /* 锁文件更新失败不影响主流程，status 判定时按残留处理 */ }
  }

  const runDir = join(runsDir(), jobId);
  mkdirSync(runDir, { recursive: true });

  const prompt = String(task.prompt).slice(0, MAX_PROMPT);
  writeFileSync(join(runDir, 'brief.md'), prompt, 'utf8');

  const startedAt = new Date().toISOString();
  const timeoutSec = Math.min(Number(task.timeout_sec) || DEFAULT_TIMEOUT_SEC, 14400);

  // ---- 通道选择：codex 优先走常驻 app-server（派单毫秒级、进度实时可见），
  // 起不来就退回 exec（每单新进程）。claude 没有 app-server，仍走 exec。
  let transport = 'exec';
  let appThread = null;
  let transportWarning = null;
  let before = null;

  if (target.cli === 'codex' && task.transport !== 'exec') {
    // 先发起握手（app-server 在独立进程里启动），趁这段时间做 git 快照
    const appReady = (async () => {
      ensureSubscribed();
      await ensureAppServer({ entry });
      return startThread({ cwd: workdir, model: modelInfo.model });
    })();
    before = gitSnapshot(workdir); // 同步，但与上面的进程启动重叠
    try {
      appThread = await appReady;
      transport = 'appserver';
    } catch (e) {
      appThread = null;
      transport = 'exec';
      transportWarning = `app-server 不可用，已降级到 exec：${e && e.message}`;
    }
  } else {
    before = gitSnapshot(workdir);
  }

  const gitRepo = before !== null;
  const stdoutPath = join(runDir, 'stdout.log');
  const stderrPath = join(runDir, 'stderr.log');

  const job = {
    job_id: jobId,
    task_id: task.task_id,
    executor: target.cli,
    name: target.name,
    model: target.name,
    resolvedModel: modelInfo.model,
    modelSource: modelInfo.source || null,
    modelWarning: modelInfo.warning || null,
    effort: target.effort,
    sandbox: target.sandbox,
    readOnly,
    role: task.role || null,
    workdir,
    runDir,
    prompt,
    status: 'running',
    transport,
    transportWarning,
    threadId: appThread ? appThread.threadId : null,
    turnId: null,
    progress: { items: [], messageLength: 0, turnStatus: 'pending', updatedAt: startedAt },
    pid: null,
    startedAt,
    timeoutSec,
    envMode: task.env || 'inherit',
    blocking: Boolean(task.blocking),
    billingWarning: billingWarningFor(target.cli),
    before_snapshot: snapshotToJSON(before),
    git_warning: gitRepo ? null : '非 git 仓库：没有改动证据，也没有回滚保障',
    lockPath: task._lockPath || null,
  };
  putJob(job);
  activeJobs.add(jobId);

  // ---- 分支 A：app-server。先落 job 再发 turn，保证事件到达时查得到任务。
  if (transport === 'appserver') {
    const route = {
      jobId, turnId: null, messageBuf: '', items: [], status: 'running', error: null, usage: null,
    };
    threadRoutes.set(job.threadId, route);

    try {
      const { turnId } = await startTurn({
        threadId: job.threadId, text: prompt, effort: target.effort, model: modelInfo.model,
        cwd: workdir,
      });
      route.turnId = turnId;
      putJob({ ...getJob(jobId), turnId });

      // 超时管理：到点 interrupt，不杀进程（app-server 是共享的）
      const deadline = setTimeout(() => {
        if (route.status === 'running' && route.turnId) {
          try { interruptTurn({ threadId: job.threadId, turnId: route.turnId }); } catch { /* 忽略 */ }
          markTimedOut(runDir);
        }
      }, timeoutSec * 1000);

      if (task.blocking) {
        const done = await waitAppTurn(route, timeoutSec * 1000);
        clearTimeout(deadline);
        if (!done) markTimedOut(runDir);
        return toContract(finalizeAppJob(jobId, route, runDir));
      }

      // 非阻塞：后台等终态，完成后收尾落台账（调用方先用 status 看进度）
      deadline.unref?.();
      waitAppTurn(route, timeoutSec * 1000).then(() => {
        finalizeAppJob(jobId, route, runDir);
      }).catch(() => { /* 收尾失败由 recoverOrphans 兜 */ });

      return toContract({ ...getJob(jobId), status: 'running' });
    } catch (e) {
      // turn 发不出去：当作启动失败，明确终态并释放锁
      threadRoutes.delete(job.threadId);
      const failed = {
        ...getJob(jobId), status: 'failed',
        summary: `启动失败：${e && e.message}`,
        partialOutput: String(e && e.message || e),
        endedAt: new Date().toISOString(),
      };
      putJob(failed);
      activeJobs.delete(jobId);
      releaseLock(job.lockPath, jobId);
      return toContract(failed);
    }
  }

  // ---- 分支 B：exec（原路径，也是 app-server 失败时的降级）
  let argv;
  let stdinText = null;
  const common = {
    effort: target.effort, sandbox: target.sandbox, modelInfo, entry, runDir, gitRepo,
  };
  if (target.cli === 'codex') {
    argv = codexArgv({ ...common });
    stdinText = prompt; // codex 的 `-` 从 stdin 读提示
  } else {
    argv = claudeArgv({ ...common, prompt });
  }

  const spawned = spawnDetached(argv, {
    cwd: workdir, env: childEnv(task.env || 'inherit'), stdoutPath, stderrPath, stdinText,
  });
  const { pid, spawnError } = spawned;
  putJob({ ...getJob(jobId), pid: pid || null });

  // 启动就失败（找不到 CLI 可执行文件等）：立即形成明确终态，不进入等待。
  if (!pid && spawnError) {
    try { writeFileSync(stderrPath, `[spawn failed] ${spawnError}\n`, 'utf8'); } catch { /* 忽略 */ }
    return toContract(finalize(getJob(jobId)));
  }

  try {
    if (task.blocking) {
      const { timedOut } = await waitTerminal(pid, { timeoutMs: timeoutSec * 1000 });
      if (timedOut) {
        killJob(pid);
        markTimedOut(runDir);
      }
      return toContract(finalizeFromJob(jobId));
    }
    // 非阻塞：起后台 monitor 兜底超时（pid 存活超 timeoutSec 则杀树 + 落标记）。
    // 即使宿主杀掉定时器，status() 里的惰性检查还会再兜一层。
    if (pid) {
      monitor(pid, {
        timeoutMs: timeoutSec * 1000,
        pollMs: 1000,
        onTimeout: () => {
          markTimedOut(runDir);
          const cur = getJob(jobId);
          if (cur && cur.status === 'running') finalize(cur);
        },
        onExit: () => {
          const cur = getJob(jobId);
          if (cur && cur.status === 'running') finalize(cur);
        },
      });
    }
    return toContract(job);
  } catch (e) {
    // 派发过程抛错也要有明确终态，不能留下永远 running 的台账
    const cur = getJob(jobId);
    if (cur && cur.status === 'running') finalize(cur);
    throw e;
  }
}

// ---------------------------------------------------------------- app-server 收尾

/** 等一轮跑到终态；超时返回 false。 */
function waitAppTurn(route, timeoutMs, pollMs = 400) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (route.status !== 'running') { resolve(true); return; }
      if (Date.now() - start >= timeoutMs) { resolve(false); return; }
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

/**
 * app-server 任务的收尾：把内存里累积的消息与进度落成终态。
 * 与 exec 路径共享 git 快照、写锁、台账这套约束。
 */
function finalizeAppJob(jobId, route, runDir) {
  const job = getJob(jobId);
  if (!job) return null;
  if (isTerminal(job.status)) return job;

  const message = (route.messageBuf || '').trim();
  let status;
  if (wasTimedOut(runDir) || route.status === 'interrupted') status = 'timeout';
  else if (route.status === 'failed') status = mapRuntimeError(String(route.error || ''));
  else if (route.status === 'completed') status = message ? 'ok' : 'crashed';
  else status = 'crashed'; // 既非完成也非失败，进程可能没了

  const before = snapshotFromJSON(job.before_snapshot);
  const after = gitSnapshot(job.workdir);
  const delta = gitDelta(before, after);
  const changedFiles = delta ? delta.paths : [];
  let headMoved = Boolean(delta?.headMoved);

  const gitWarnings = [];
  if (job.git_warning) gitWarnings.push(job.git_warning);
  if (headMoved) gitWarnings.push('执行期间 HEAD 变了：CLI 可能提交过代码');

  writeFileSync(join(runDir, 'message.md'), message ? `${message}\n` : '', 'utf8');
  if (changedFiles.length) writeFileSync(join(runDir, 'changed.txt'), `${changedFiles.join('\n')}\n`, 'utf8');
  const diff = gitDiffText(job.workdir);
  if (diff) writeFileSync(join(runDir, 'diff.txt'), `${diff}\n`, 'utf8');

  const endedAt = new Date().toISOString();
  const updated = {
    ...job,
    status,
    summary: truncate(message ? (message.split(/\r?\n/).find((l) => l.trim()) || '(空行)') : status, 500),
    partialOutput: truncate(message || route.error || '（无输出）', MAX_PARTIAL),
    changed_files: changedFiles,
    changed_stats: delta ? delta.stats : null,
    headMoved,
    usage: route.usage || null,
    endedAt,
    durationSec: Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(job.startedAt)) / 1000)),
    git_warning: gitWarnings.length ? gitWarnings.join('；') : null,
    progress: {
      items: route.items.slice(-MAX_PROGRESS_ITEMS),
      messageLength: message.length,
      turnStatus: route.status,
      updatedAt: endedAt,
    },
    artifacts: {
      changed_files: join(runDir, 'changed.txt'),
      diff_path: diff ? join(runDir, 'diff.txt') : null,
      message_path: join(runDir, 'message.md'),
    },
  };

  // app-server 与 MCP 同生共死，不存在「子进程还活着但任务已终态」的情况，
  // 因此这里可以安全释放写锁。
  updated.lockHeld = false;
  putJob(updated);
  activeJobs.delete(jobId);
  threadRoutes.delete(job.threadId);
  releaseLock(job.lockPath, jobId);
  return updated;
}

// ---------------------------------------------------------------- 收尾 / 解析

/** 读 runDir 下的产物文件。 */
function readArtifact(runDir, name) {
  const p = join(runDir, name);
  if (!existsSync(p)) return null;
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

/** 根据 job_id 读取最新 job 并 finalize（若 pid 已死）。 */
export function finalizeFromJob(jobId) {
  const job = getJob(jobId);
  if (!job) return null;
  if (isTerminal(job.status)) return job;

  // app-server 任务没有独立子进程（pid 为空），不能按「进程已死」判。
  // 它是否跑完，看事件流推过来的 turn 状态。
  if (job.transport === 'appserver') {
    const route = job.threadId ? threadRoutes.get(job.threadId) : null;
    if (route && route.status === 'running') {
      // 还在跑：检查是否超期
      const limit = Number(job.timeoutSec) || DEFAULT_TIMEOUT_SEC;
      const elapsed = job.startedAt ? Date.now() - Date.parse(job.startedAt) : 0;
      if (elapsed < limit * 1000) return job;
      try { if (route.turnId) interruptTurn({ threadId: job.threadId, turnId: route.turnId }); } catch { /* 忽略 */ }
      markTimedOut(job.runDir);
      return finalizeAppJob(jobId, route, job.runDir);
    }
    if (route) return finalizeAppJob(jobId, route, job.runDir);
    // 路由表丢了（MCP 重启过）：无法判定真实状态，标成 crashed 并说明原因
    const orphaned = {
      ...job,
      status: 'crashed',
      summary: 'MCP 重启后丢失了该任务的连接，无法确认最终结果',
      partialOutput: job.progress?.items?.map((i) => i.label).join('\n') || '（无进度记录）',
      endedAt: new Date().toISOString(),
    };
    putJob(orphaned);
    activeJobs.delete(jobId);
    releaseLock(job.lockPath, jobId);
    return orphaned;
  }

  // 先看进程死活：已经结束的任务按产物判定，不能因为「查询得晚」就判超时。
  const alive = Boolean(job.pid && pidAlive(job.pid));
  if (!alive) return finalize(job);

  // 进程还活着，再看是否超过 timeoutSec → 杀树 + 落超时标记。
  const limit = Number(job.timeoutSec) || DEFAULT_TIMEOUT_SEC;
  const elapsedMs = job.startedAt ? Date.now() - Date.parse(job.startedAt) : 0;
  if (elapsedMs >= limit * 1000) {
    killJob(job.pid);
    markTimedOut(job.runDir);
    return finalize(job);
  }

  return job; // 仍在跑且未超时
}

/** pid 已死或超时 → 解析产物、定状态、落盘。 */
export function finalize(job) {
  const runDir = job.runDir;
  const stdout = readArtifact(runDir, 'stdout.log') || '';
  const stderr = readArtifact(runDir, 'stderr.log') || '';
  const last = readArtifact(runDir, 'last.md') || '';
  const before = snapshotFromJSON(job.before_snapshot);
  const after = gitSnapshot(job.workdir);
  const delta = gitDelta(before, after);

  let message = '';
  let usage = null;
  let cliError = null;

  if (job.executor === 'codex') {
    const r = codexRead({ stdout, last });
    message = r.message;
    usage = r.usage;
    cliError = r.error;
  } else {
    const r = claudeRead(stdout);
    message = r.message;
    usage = r.usage;
    cliError = r.isError ? String(message || '') : null;
  }

  let timedOut = wasTimedOut(runDir);
  // monitor 丢失（宿主被杀）时没有超时标记。用产物最后写入时刻推断真实完成时间：
  // 若从启动到产出结束已超过 timeoutSec，就是超期完成，不能算成功。
  if (!timedOut && job.startedAt && job.timeoutSec) {
    const limit = Number(job.timeoutSec) * 1000;
    const outPath = join(runDir, 'stdout.log');
    try {
      const finishedAt = existsSync(outPath) ? statSync(outPath).mtimeMs : null;
      if (finishedAt && finishedAt - Date.parse(job.startedAt) > limit) {
        timedOut = true;
      }
    } catch { /* 读不到 mtime 就不判 */ }
  }
  const combined = `${stderr}\n${stdout}`;
  const hasMessage = Boolean(message && message.trim());

  // 判定顺序：失败信号优先于「有回答文字」。
  // CLI 报错时往往也会输出一段说明文字，若先看 hasMessage 就会把失败误判成 ok。
  let status;
  if (timedOut) {
    status = 'timeout';
  } else if (cliError) {
    // Claude is_error / Codex turn.failed 都归到这里；错误文本进 partialOutput。
    status = mapRuntimeError(cliError);
  } else if (hasMessage) {
    status = 'ok';
  } else if (!stdout.trim() && !stderr.trim()) {
    status = 'crashed'; // 进程死了、什么都没留下
  } else {
    status = mapRuntimeError(combined);
  }

  // partialOutput：失败也非空，给专家/用户续跑的抓手
  let partialOutput = hasMessage ? message : '';
  if (!partialOutput) {
    partialOutput = (cliError || '').trim() || truncate(stdout, MAX_PARTIAL);
  }
  if (!partialOutput) partialOutput = '（无输出）';

  const changedFiles = delta ? delta.paths : [];
  const changedStats = delta ? delta.stats : null;
  let headMoved = Boolean(delta?.headMoved);
  const gitWarnings = [];
  if (job.git_warning) gitWarnings.push(job.git_warning);
  if (headMoved) gitWarnings.push('执行期间 HEAD 变了：CLI 可能提交过代码');

  const resumeAfter = status === 'quota_exhausted' ? parseResumeAfter(combined) : null;

  const summary = hasMessage
    ? message.split(/\r?\n/).find((l) => l.trim()) || '(空行)'
    : status;

  // 落盘产物
  writeFileSync(join(runDir, 'message.md'), message ? `${message}\n` : '', 'utf8');
  if (changedFiles.length) writeFileSync(join(runDir, 'changed.txt'), `${changedFiles.join('\n')}\n`, 'utf8');
  const diff = gitDiffText(job.workdir);
  if (diff) writeFileSync(join(runDir, 'diff.txt'), `${diff}\n`, 'utf8');

  const endedAt = new Date().toISOString();
  const durationSec = Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(job.startedAt)) / 1000));

  const updated = {
    ...job,
    status,
    summary: truncate(summary, 500),
    partialOutput: truncate(partialOutput, MAX_PARTIAL),
    changed_files: changedFiles,
    changed_stats: changedStats,
    headMoved,
    usage,
    resumeAfter,
    endedAt,
    durationSec,
    git_warning: gitWarnings.length ? gitWarnings.join('；') : null,
    exit_code: null, // detached 跨进程难可靠取退出码，状态以产物推断为准
    degraded: job.modelWarning ? { reason: job.modelWarning } : null,
    artifacts: {
      changed_files: join(runDir, 'changed.txt'),
      diff_path: diff ? join(runDir, 'diff.txt') : null,
      stdout_path: join(runDir, 'stdout.log'),
      stderr_path: join(runDir, 'stderr.log'),
      message_path: join(runDir, 'message.md'),
      result_path: join(runDir, 'result.json'),
    },
  };

  // 写锁去留必须在写入台账之前算好，一次性发布终态。
  // 分两次写（先终态、后补 lockHeld）会留出抢锁窗口：新任务看到「timeout 且未持锁」就进来了。
  const stillAlive = Boolean(job.pid && pidAlive(job.pid));
  if (stillAlive) {
    updated.lockHeld = true;
    updated.git_warning = [updated.git_warning, '子进程未能终止，写锁保留，勿在相同目录派新写任务']
      .filter(Boolean).join('；');
  } else {
    updated.lockHeld = false;
  }

  putJob(updated);
  activeJobs.delete(job.job_id);

  // 只有确认进程已退出才释放锁；还活着就留着，防止同目录并发写。
  if (!stillAlive) {
    releaseLock(job.lockPath, job.job_id); // 带 jobId 校验归属，防误删新任务的锁
  }
  return updated;
}

function mapRuntimeError(text) {
  const c = classifyError(text);
  if (c === 'QUOTA') return 'quota_exhausted';
  if (c === 'AUTH') return 'rejected';
  if (c === 'NOT_FOUND') return 'rejected';
  if (c === 'MODEL_UNAVAILABLE') return 'rejected';
  return 'failed';
}

function isTerminal(s) {
  return ['ok', 'timeout', 'failed', 'rejected', 'quota_exhausted', 'crashed', 'busy'].includes(s);
}

// ---------------------------------------------------------------- 状态 / 续跑

export function status(ref) {
  const job = resolveRef(ref);
  if (!job) return { status: 'rejected', error: 'JOB_NOT_FOUND', ref };
  const done = finalizeFromJob(job.job_id);
  return toContract(done || job);
}

export function listJobsTool(limit = 20) {
  return listJobs(limit);
}

/**
 * 半自动续跑：对最近一次同 task_id 的失败任务，追加「续跑上下文」后开新 job 重派。
 * 仅当上次为终态失败（非 ok）时重派；busy/running 直接返回当前，不重派。
 */
export async function resume(taskInput = {}) {
  const { task_id, blocking = false, timeout_sec = null, env = null, force = false } = taskInput;
  if (!task_id) return { status: 'rejected', error: 'BAD_ARGS', detail: '缺少 task_id' };

  const raw = getLatestByTask(task_id);
  if (!raw) return { status: 'rejected', error: 'NO_JOB_TO_RESUME', detail: `没有可续跑的 task_id=${task_id}` };

  // 先刷新状态：台账可能还记着 running，但进程其实早就死了。
  // 不刷新会把「已失败的旧任务」当成还在跑，直接原样返回，续跑永远发不出去。
  const latest = finalizeFromJob(raw.job_id) || raw;

  if (latest.status === 'ok') return { status: 'ok', detail: '上次已成功，无需续跑', task_id };
  if (latest.status === 'running' || latest.status === 'busy') {
    return toContract(latest); // 确实还在跑，别重复派
  }

  // 重建原始任务配置 + 追加续跑上下文
  const changed = (latest.changed_files || []).join('、') || '（无文件改动）';
  const why = latest.status
    ? `上一轮状态：${latest.status}${latest.summary ? `（${latest.summary}）` : ''}`
    : '上一轮状态未知';
  const partial = latest.partialOutput
    ? `\n上一轮部分结果（供参考，可能不完整）：\n${String(latest.partialOutput).slice(0, 1000)}`
    : '';
  const handoff = `\n\n[续跑上下文] ${why}；已改动文件：${changed}。${partial}\n请接着做，不要重复已完成的部分。`;
  const prompt = String(latest.prompt || '') + handoff;

  const resumedTask = {
    task_id,
    role: latest.role || null,
    executor: latest.executor,
    model: latest.model,
    sandbox: latest.sandbox,
    effort: latest.effort,
    workdir: latest.workdir,
    prompt,
    blocking,
    // 未显式传时继承上一轮的约束，否则会悄悄变成默认 30 分钟 / inherit
    timeout_sec: timeout_sec ?? latest.timeoutSec ?? null,
    env: env ?? (latest.envMode || 'inherit'),
    force,
  };
  return dispatch(resumedTask);
}

/**
 * 启动/孤儿回收：把所有 pid 已死却仍记 running 的 job 收尾。
 */
export function recoverOrphans() {
  ensureDirs();
  const all = listJobs(1000).map((x) => x.job_id);
  let recovered = 0;
  for (const id of all) {
    const j = getJob(id);
    if (!j || j.status !== 'running') continue;
    // app-server 任务没有 pid，不能按「进程死了」判；交给 finalizeFromJob 统一处理
    // （它区分 exec 与 app-server，并对丢了连接的 app-server 任务标 crashed 说明原因）
    if (j.transport === 'appserver' || !j.pid || !pidAlive(j.pid)) {
      const before = j.status;
      const after = finalizeFromJob(id);
      if (after && after.status !== before) recovered += 1;
    }
  }
  return recovered;
}

// ---------------------------------------------------------------- 契约输出

export function toContract(job) {
  if (!job) return { status: 'rejected', error: 'NO_JOB' };
  const artifacts = job.artifacts || null;
  return {
    task_id: job.task_id || null,
    job_id: job.job_id,
    executor: job.executor,
    status: job.status,
    summary: job.summary || null,
    model: job.model || null,
    resolvedModel: job.resolvedModel || null,
    effort: job.effort || null,
    sandbox: job.sandbox || null,
    readOnly: job.readOnly ?? null,
    blocking: job.blocking ?? null,
    duration_sec: job.durationSec ?? null,
    exit_code: job.exit_code ?? null,
    changedFiles: job.changed_files || null,
    changed_stats: job.changed_stats || null,
    headMoved: job.headMoved ?? null,
    // 实时进度：用户问「跑哪了」时直接看这个，不用干等
    transport: job.transport || 'exec',
    transportWarning: job.transportWarning || null,
    progress: job.progress
      ? {
        turnStatus: job.progress.turnStatus,
        messageLength: job.progress.messageLength,
        recent: (job.progress.items || []).slice(-8).map((i) => i.label),
        updatedAt: job.progress.updatedAt,
      }
      : null,
    partialOutput: job.partialOutput || null,
    claims: [], // 引擎不采信 CLI 自报，验收只看 artifacts
    resumeAfter: job.resumeAfter || null,
    degraded: job.degraded || null,
    billingWarning: job.billingWarning || null,
    gitWarning: job.git_warning || null,
    usage: job.usage || null,
    startedAt: job.startedAt || null,
    endedAt: job.endedAt || null,
    artifacts,
  };
}
