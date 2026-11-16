// 任务台账持久化：task_id → job 记录（含状态/产物路径/已改文件/partialOutput）。落盘 JSON。
// GCWORK_HOME 可被覆盖，便于测试隔离。
import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync, renameSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// GCWORK_HOME 惰性读取：每次调用都读 process.env，便于测试隔离（每个用例设独立临时目录）。
function homeDir() {
  return process.env.GCWORK_HOME || join(homedir(), '.workbuddy', 'gcwork');
}
export function ledgerDir() { return join(homeDir(), 'ledger'); }
export function runsDir() { return join(homeDir(), 'runs'); }
export function locksDir() { return join(homeDir(), 'locks'); }

export function ensureDirs() {
  for (const d of [ledgerDir(), runsDir(), locksDir(), sessionsDir()]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

/** 会话工作日志目录：按天一个文件，记录当天派了哪些单。 */
export function sessionsDir() {
  return join(homeDir(), 'sessions');
}

/**
 * 追加一行工作日志。零成本（引擎内写文件，不经模型），
 * 目的是让「下个会话」或「同一会话稍后」不必翻历史就能知道做过什么。
 */
export function appendSessionNote(line) {
  ensureDirs();
  const day = new Date().toISOString().slice(0, 10);
  const p = join(sessionsDir(), `${day}.md`);
  try {
    if (!existsSync(p)) writeFileSync(p, `# ${day} gcwork 工作日志\n\n`, 'utf8');
    appendFileSync(p, `- ${line}\n`, 'utf8');
    return p;
  } catch {
    return null;
  }
}

/** 读当天（或指定日期）的工作日志行；用于会话开场了解上下文。 */
export function readSessionNotes(day = null) {
  const d = day || new Date().toISOString().slice(0, 10);
  const p = join(sessionsDir(), `${d}.md`);
  if (!existsSync(p)) return { day: d, lines: [], path: p };
  let text = '';
  try { text = readFileSync(p, 'utf8'); } catch { return { day: d, lines: [], path: p }; }
  const lines = text.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
  return { day: d, lines, path: p };
}

function ledgerPath(jobId) {
  return join(ledgerDir(), `${jobId}.json`);
}

/**
 * 写入（或覆盖）一条 job 记录。
 * 先写临时文件再 rename 覆盖：直接覆盖时如果进程在写一半被中断，
 * 会留下半截 JSON，后续读取失败就会被当成「任务不存在」，进而误判可抢锁。
 */
export function putJob(job) {
  // 没有 job_id 就写盘会产生 undefined.json 这种垃圾记录，
  // 它会永远停在 running，出现在任务列表里误导用户。
  if (!job || !job.job_id) {
    throw new Error('putJob 需要 job_id（{...null} 或空对象不得落盘）');
  }
  ensureDirs();
  const target = ledgerPath(job.job_id);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(job, null, 2)}\n`, 'utf8');
  renameSync(tmp, target);
  return job;
}

/** 读取一条 job；不存在返回 null。 */
export function getJob(jobId) {
  const p = ledgerPath(jobId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    // 文件在但读坏了：这跟「不存在」不是一回事。调用方不能据此判定任务已死。
    // 这里仍返回 null（接口兼容），但另提供 getJobStatus 供需要区分的地方使用。
    return null;
  }
}

/**
 * 区分「记录不存在」与「记录损坏」。
 * @returns {{state:'missing'|'corrupt'|'ok', job:object|null}}
 */
export function getJobStatus(jobId) {
  const p = ledgerPath(jobId);
  if (!existsSync(p)) return { state: 'missing', job: null };
  try {
    return { state: 'ok', job: JSON.parse(readFileSync(p, 'utf8')) };
  } catch {
    return { state: 'corrupt', job: null };
  }
}

/** 取某 task_id 最近一次 job（按 startedAt 倒序）。 */
export function getLatestByTask(taskId) {
  const all = listJobsRaw();
  const matched = all
    .filter((j) => j.task_id === taskId)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  return matched[0] || null;
}

/**
 * 把 ref 解析成具体 job：优先当 job_id；否则当 task_id 取最近一次。
 */
export function resolveRef(ref) {
  if (!ref) return null;
  const direct = getJob(ref);
  if (direct) return direct;
  return getLatestByTask(ref);
}

function listJobsRaw() {
  const ld = ledgerDir();
  if (!existsSync(ld)) return [];
  const out = [];
  for (const f of readdirSync(ld)) {
    if (!f.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(readFileSync(join(ld, f), 'utf8')));
    } catch { /* 坏文件跳过 */ }
  }
  return out;
}

/** 列出最近的 job（按 startedAt 倒序，最多 limit 条）。 */
export function listJobs(limit = 20) {
  return listJobsRaw()
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, limit)
    .map((j) => ({
      job_id: j.job_id,
      task_id: j.task_id,
      executor: j.executor,
      status: j.status,
      startedAt: j.startedAt,
      endedAt: j.endedAt || null,
      model: j.resolvedModel || j.model || null,
    }));
}

const RUN_RETENTION_DAYS = 14;

/** 清理过期 run 目录；返回清理数量。 */
export function pruneRuns() {
  const rd = runsDir();
  if (!existsSync(rd)) return 0;
  let n = 0;
  for (const d of readdirSync(rd)) {
    const p = join(rd, d);
    try {
      if (Date.now() - statSync(p).mtimeMs > RUN_RETENTION_DAYS * 86400_000) {
        rmSync(p, { recursive: true, force: true });
        n += 1;
      }
    } catch { /* 单个失败不影响 */ }
  }
  return n;
}
