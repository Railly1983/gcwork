// 任务台账持久化：task_id → job 记录（含状态/产物路径/已改文件/partialOutput）。落盘 JSON。
// GCWORK_HOME 可被覆盖，便于测试隔离。
import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
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
  for (const d of [ledgerDir(), runsDir(), locksDir()]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

function ledgerPath(jobId) {
  return join(ledgerDir(), `${jobId}.json`);
}

/** 写入（或覆盖）一条 job 记录。 */
export function putJob(job) {
  ensureDirs();
  writeFileSync(ledgerPath(job.job_id), `${JSON.stringify(job, null, 2)}\n`, 'utf8');
  return job;
}

/** 读取一条 job；不存在返回 null。 */
export function getJob(jobId) {
  const p = ledgerPath(jobId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
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
