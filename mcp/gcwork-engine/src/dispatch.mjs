// 派发编排：dispatch / status / resume / 验收封装 / listJobs / recoverOrphans。
// 核心职责：统一契约、任务在常驻服务内执行、半自动续跑、产物解析、写锁。
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
// 输出截断上限。工具返回的每个字都会进会话上下文，长会话里被反复重放；
// 完整内容始终在 runDir 的 message.md，需要时再单独读。
const MAX_PARTIAL = 1500;
const MAX_PROGRESS_ITEMS = 40; // 进度里保留的最近条目数
import { HEARTBEAT_STALE_MS } from './engine/locks.mjs'; // 与锁判活共用同一阈值，避免两处不一致


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
  return `${t.slice(0, Math.floor(max * 0.8))}\n…[已截断，原文 ${t.length} 字符，完整内容见 artifacts.message_path]…`;
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
    pid: process.pid, // 执行该任务的进程；锁判活与超时处理都依赖它
    startedAt,
    timeoutSec,
    envMode: task.env || 'inherit',
    blocking: Boolean(task.blocking),
    // 记下用户显式指定了什么：额度用尽时不允许擅自换执行器/模型，
    // 这个标记让返回值能明确提醒调用方先征求同意。
    userSpecified: {
      executor: Boolean(task.executor && task.executor !== 'auto'),
      model: Boolean(task.model),
      effort: Boolean(task.effort),
    },
    billingWarning: billingWarningFor(target.cli),
    before_snapshot: snapshotToJSON(before),
    git_warning: gitRepo ? null : '非 git 仓库：没有改动证据，也没有回滚保障',
    lockPath: task._lockPath || null,
  };
  putJob(job);
  putJob(job);

  // env 必须带进 spec：不带的话执行层拿不到 clean 模式，schema 承诺就成了空话
  const spec = {
    jobId, runDir, cwd: workdir, prompt,
    model: modelInfo.model, effort: target.effort, sandbox: target.sandbox,
    timeoutSec, entry, executor: target.cli, gitRepo,
    env: task.env || 'inherit',
  };
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

  // 判活靠心跳，绝不按 pid 杀进程：任务跑在常驻 MCP 进程里，job.pid
  // 就是服务自身的 pid，杀了等于把引擎和所有并行任务一起干掉。
  // pid 只用来判断「执行进程是否已经结束」——结束就按产物定终态，
  // 不能因为查询得晚就把按时完成的任务判成超时。
  if (job.pid && !pidAlive(job.pid)) return finalize(job);
  const lastBeat = job.heartbeatAt
    ? Date.parse(job.heartbeatAt)
    : (job.startedAt ? Date.parse(job.startedAt) : Date.now());
  const hbAge = Date.now() - lastBeat;

  if (elapsedMs >= limit * 1000) {
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
  // 先收尾再列：否则已经死掉的任务会一直显示 running，看着像挂了几个小时。
  try { recoverOrphans(); } catch { /* 收尾失败也要能列出 */ }
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
    // 没有 startedAt 的记录（历史垃圾数据）收不了尾，直接判 crashed，
    // 否则它会永远显示 running。
    if (!j.startedAt) {
      try {
        putJob({ ...j, status: 'crashed', summary: '台账记录缺少 startedAt，无法判定执行状态', endedAt: new Date().toISOString() });
        recovered += 1;
      } catch { /* 落盘失败就算了 */ }
      continue;
    }
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

/**
 * 额度用尽时，如果用户本来就指定了执行器/模型/强度，换任何一项都要先问。
 * 返回一句人话提示，调用方看到就该停下来征询，而不是自己换条路重试。
 */
function switchNote(job) {
  if (!job || job.status !== 'quota_exhausted') return null;
  const spec = job.userSpecified || {};
  const picked = [];
  if (spec.executor) picked.push('执行器');
  if (spec.model) picked.push('模型');
  if (spec.effort) picked.push('强度');
  if (!picked.length) return null;
  return `用户已指定${picked.join('、')}，额度用尽时不要自行换执行器或模型重试，先问用户是否同意更换。`;
}

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
    switchRequiresConsent: switchNote(job),
    degraded: job.degraded || null,
    billingWarning: job.billingWarning || null,
    gitWarning: job.git_warning || null,
    usage: job.usage || null,
    startedAt: job.startedAt || null,
    endedAt: job.endedAt || null,
    artifacts,
  };
}
