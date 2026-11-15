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
import { pidAlive, killJob, markTimedOut, wasTimedOut } from './engine/run.mjs';
import { acquireLock, releaseLock } from './engine/locks.mjs';
import { classifyError, parseResumeAfter } from './engine/errors.mjs';
import { readResult as codexRead } from './adapters/codex.mjs';
import { readResult as claudeRead } from './adapters/claude.mjs';

const DEFAULT_TIMEOUT_SEC = 1800; // 30 分钟安全上限，远高于宿主轮次上限
const MAX_PROMPT = 200_000; // 简报上限保护
const MAX_PARTIAL = 4000; // partialOutput 截断
const MAX_PROGRESS_ITEMS = 40; // 进度里保留的最近条目数
const HEARTBEAT_STALE_MS = 120_000; // 心跳超过这个时间没刷新，判定执行方已消失

// 进程内活跃任务（用于同目录写锁与状态查询；并发上限交给宿主，不再自己掐）
const activeJobs = new Set();

// 台账落盘节流：delta 是逐 token 的，每个都写盘会把派单拖慢几秒。
const PROGRESS_FLUSH_MS = 500;
const lastFlushAt = new Map(); // jobId → 上次写台账的时间戳

function nowStamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** job_id 只保留模型短名 + 短随机后缀，一眼看出用的什么模型，不堆时间戳。 */
function newJobId(modelName = null) {
  const tag = String(modelName || '')
    .replace(/^gpt-[\d.]+-/i, '')   // gpt-6.1-sol -> sol
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 12)
    .toLowerCase();
  const tail = randomUUID().slice(0, 6);
  return tag ? `${tag}-${tail}` : `job-${tail}`;
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

// ---------------------------------------------------------------- 派发

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
  const jobId = newJobId(target.name || modelInfo.model);
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

  const before = gitSnapshot(workdir);
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
  putJob(job);
  activeJobs.add(jobId);

  const spec = { jobId, runDir, cwd: workdir, prompt, model: modelInfo.model, effort: target.effort, sandbox: target.sandbox, timeoutSec, entry, executor: target.cli, gitRepo };
  const specPath = join(runDir, 'spec.json');
  writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf8');

  putJob({
    ...getJob(jobId),
    transport: target.cli === 'codex' ? 'appserver' : 'cli',
    workerStartedAt: new Date().toISOString(),
  });

  return { ...toContract(getJob(jobId)), _spec: spec, _specPath: specPath };
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

  const limit = Number(job.timeoutSec) || DEFAULT_TIMEOUT_SEC;
  const elapsedMs = job.startedAt ? Date.now() - Date.parse(job.startedAt) : 0;

  // 有独立进程的任务：优先按进程死活判。进程已退出就走 finalize，
  // 由产物与 mtime 决定真实终态——不能因为「查询得晚」就判超时。
  if (job.pid) {
    if (!pidAlive(job.pid)) return finalize(job);
    if (elapsedMs >= limit * 1000) {
      killJob(job.pid);
      markTimedOut(job.runDir);
      return finalize(job);
    }
    return job;
  }

  // 进程内任务（跑在常驻 MCP 里）：没有独立 pid，只能靠心跳。
  const lastBeat = job.heartbeatAt
    ? Date.parse(job.heartbeatAt)
    : (job.startedAt ? Date.parse(job.startedAt) : Date.now());
  const hbAge = Date.now() - lastBeat;

  if (elapsedMs >= limit * 1000) {
    // 超时只落标记，不动任何进程：执行方自己会在 deadline 发 turn/interrupt。
    markTimedOut(job.runDir);
    return finalize(job);
  }
  if (hbAge > HEARTBEAT_STALE_MS) return finalize(job);

  return job;
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
    // worker 已消失但仍记着 running：收尾成明确状态，避免永远挂在那里
    const hbAge = j.heartbeatAt ? Date.now() - Date.parse(j.heartbeatAt) : Infinity;
    if (hbAge > HEARTBEAT_STALE_MS) {
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
    transport: job.transport || null,
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
