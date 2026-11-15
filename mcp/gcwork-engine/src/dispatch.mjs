// 派发编排：dispatch / status / resume / 验收封装 / listJobs / recoverOrphans。
// 核心职责：统一契约、detached 执行抗宿主超时、半自动续跑、产物解析、并发与写锁。
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, basename } from 'node:path';
import {
  pickTarget, resolveModel, findCodexEntry, findClaudeEntry, billingWarningFor, childEnv, TOOL_VERSION, MODELS,
} from './models.mjs';
import { gitSnapshot, gitDelta, snapshotToJSON, snapshotFromJSON, gitDiffText } from './engine/git.mjs';
import { putJob, getJob, getLatestByTask, resolveRef, listJobs, pruneRuns, runsDir, locksDir, ensureDirs } from './engine/ledger.mjs';
import {
  spawnDetached, pidAlive, killJob, waitTerminal, markTimedOut, wasTimedOut,
} from './engine/run.mjs';
import { classifyError, parseResumeAfter } from './engine/errors.mjs';
import { buildArgv as codexArgv, readResult as codexRead } from './adapters/codex.mjs';
import { buildArgv as claudeArgv, readResult as claudeRead } from './adapters/claude.mjs';

const MAX_CONCURRENCY = 4; // 全局并发上限（只读任务不计入）
const DEFAULT_TIMEOUT_SEC = 1800; // 30 分钟安全上限，远高于宿主轮次上限
const MAX_PROMPT = 200_000; // 简报上限保护
const MAX_PARTIAL = 4000; // partialOutput 截断

// 进程内并发追踪 + 写锁（单进程 server 足够；多实例场景以文件锁兜底写冲突）
const activeJobs = new Set();

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
      const age = holder?.startedAt ? Date.now() - Date.parse(holder.startedAt) : Infinity;
      const stale = !holder || !pidAlive(holder.pid) || age > 15 * 60_000;
      if (force || stale) {
        try { rmSync(p, { force: true }); } catch { /* 忽略 */ }
        continue;
      }
      return { ok: false, code: 'busy', detail: `同一目录已有写入任务（${holder?.jobId || '?'}），等它结束或确认死锁后重试` };
    }
  }
  return { ok: false, code: 'busy', detail: '并发锁获取失败，重试后仍被占用' };
}

function releaseLock(p) {
  if (!p) return;
  try { rmSync(p, { force: true }); } catch { /* 忽略 */ }
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

  // 并发上限（只读不计入）+ 同目录写锁
  if (!readOnly) {
    if (activeJobs.size >= MAX_CONCURRENCY) {
      return { status: 'busy', detail: `全局并发已达上限（${MAX_CONCURRENCY}），稍后再派`, task_id: task.task_id };
    }
    const lock = acquireLock(workdir, Boolean(task.force));
    if (!lock.ok) return { status: lock.code, detail: lock.detail, task_id: task.task_id };
    task._lockPath = lock.path;
  }

  const jobId = newJobId();
  const runDir = join(runsDir(), jobId);
  mkdirSync(runDir, { recursive: true });

  const prompt = String(task.prompt).slice(0, MAX_PROMPT);
  writeFileSync(join(runDir, 'brief.md'), prompt, 'utf8');

  const before = gitSnapshot(workdir);
  const gitRepo = before !== null;

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

  const stdoutPath = join(runDir, 'stdout.log');
  const stderrPath = join(runDir, 'stderr.log');
  const { pid } = spawnDetached(argv, {
    cwd: workdir, env: childEnv(task.env || 'inherit'), stdoutPath, stderrPath, stdinText,
  });

  const startedAt = new Date().toISOString();
  const timeoutSec = Math.min(Number(task.timeout_sec) || DEFAULT_TIMEOUT_SEC, 14400);

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
    pid: pid || null,
    startedAt,
    timeoutSec,
    blocking: Boolean(task.blocking),
    billingWarning: billingWarningFor(target.cli),
    before_snapshot: snapshotToJSON(before),
    git_warning: gitRepo ? null : '非 git 仓库：没有改动证据，也没有回滚保障',
    lockPath: task._lockPath || null,
  };
  putJob(job);
  activeJobs.add(jobId);

  try {
    if (task.blocking) {
      const { timedOut } = await waitTerminal(pid, { timeoutMs: timeoutSec * 1000 });
      if (timedOut) {
        killJob(pid);
        markTimedOut(runDir);
      }
      return toContract(finalizeFromJob(jobId));
    }
    return toContract(job);
  } finally {
    if (!task.blocking) { /* 非阻塞：保留 activeJobs，待 reaping 时释放 */ }
  }
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
  if (job.pid && pidAlive(job.pid)) return job; // 仍在跑
  return finalize(job);
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

  const timedOut = wasTimedOut(runDir);
  const combined = `${stderr}\n${stdout}`;
  const hasMessage = Boolean(message && message.trim());

  let status;
  if (timedOut) {
    status = 'timeout';
  } else if (hasMessage) {
    status = 'ok';
  } else if (job.executor === 'codex' && cliError) {
    status = mapRuntimeError(cliError);
  } else if (job.executor === 'claude' && cliError) {
    status = mapRuntimeError(cliError);
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
  putJob(updated);
  activeJobs.delete(job.job_id);
  releaseLock(job.lockPath);
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
  const { task_id, blocking = false, timeout_sec = null, env = 'inherit', force = false } = taskInput;
  if (!task_id) return { status: 'rejected', error: 'BAD_ARGS', detail: '缺少 task_id' };

  const latest = getLatestByTask(task_id);
  if (!latest) return { status: 'rejected', error: 'NO_JOB_TO_RESUME', detail: `没有可续跑的 task_id=${task_id}` };
  if (latest.status === 'ok') return { status: 'ok', detail: '上次已成功，无需续跑', task_id };
  if (latest.status === 'running' || latest.status === 'busy') {
    return toContract(latest); // 还在跑，别重复派
  }

  // 重建原始任务配置 + 追加续跑上下文
  const changed = (latest.changed_files || []).join('、') || '（无文件改动）';
  const handoff = `\n\n[续跑上下文] 上一轮状态：${latest.status}；已改动文件：${changed}。请接着做，不要重复已完成的部分。`;
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
    timeout_sec,
    env,
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
    if (j && j.status === 'running' && (!j.pid || !pidAlive(j.pid))) {
      finalize(j);
      recovered += 1;
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
