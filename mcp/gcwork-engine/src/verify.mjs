// 验收：只看产物（artifacts），不轻信 CLI 自称「已完成」。git 范围审查 + 敏感文件标记 +
// 跑测试（无 test 脚本则降级为 needsHuman，不硬判失败）。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRef } from './engine/ledger.mjs';
import { gitSnapshot, gitDelta, snapshotFromJSON } from './engine/git.mjs';

// 锁文件 / CI / 依赖 / 密钥 —— 改动这些必须人工复核，不能自动放行。
const SENSITIVE = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)bun\.lockb?$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)go\.sum$/,
  /(^|\/)\.github\/workflows\//,
  /(^|\/)compose\.ya?ml$/,
  /(^|\/)Dockerfile(\.|$)/,
  /(^|\/)\.env($|\.)/,
];

export function isSensitive(p) {
  return SENSITIVE.some((re) => re.test(p));
}

/**
 * 验收一条 job（按 job_id 或 task_id）。
 */
export function verify(ref) {
  const job = resolveRef(ref);
  if (!job) return { ok: false, error: 'JOB_NOT_FOUND', ref };

  const workdir = job.workdir;
  const after = gitSnapshot(workdir);
  const before = snapshotFromJSON(job.before_snapshot);
  const delta = gitDelta(before, after);

  const reasons = [];
  let accepted = true;
  let needsHuman = false;
  let scopeOk = true;

  if (delta?.headMoved) {
    scopeOk = false;
    accepted = false;
    reasons.push('执行期间 HEAD 被移动：CLI 可能提交过代码，需人工确认');
  }

  const changedFiles = delta ? delta.paths : job.changed_files || [];
  const sensitiveFiles = changedFiles.filter(isSensitive);
  if (sensitiveFiles.length) {
    needsHuman = true;
    reasons.push(`触碰敏感文件（锁文件/CI/依赖/密钥），需人工复核：${sensitiveFiles.join(', ')}`);
  }

  // 测试：仅在存在 test 脚本时跑；否则降级为 needsHuman，不硬判失败。
  let testsPassed = null;
  let testRan = false;
  const pkgPath = join(workdir, 'package.json');
  if (existsSync(pkgPath)) {
    let scripts = {};
    try {
      scripts = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts || {};
    } catch { /* 坏 json */ }
    if (scripts.test) {
      testRan = true;
      const r = spawnSync('npm', ['test'], { cwd: workdir, encoding: 'utf8', timeout: 300_000, windowsHide: true });
      testsPassed = r.status === 0;
      if (!testsPassed) {
        accepted = false;
        reasons.push(`测试未通过（exit ${r.status}）`);
      }
    } else {
      needsHuman = true;
      reasons.push('无 test 脚本，无法自动验证，需人工确认');
    }
  } else {
    needsHuman = true;
    reasons.push('非 Node 项目或无 package.json，无法自动测试，需人工确认');
  }

  // 明确拒绝（HEAD 移动 / 测试失败）时不再算「待人工」
  if (!accepted) needsHuman = false;

  return {
    ok: true,
    job_id: job.job_id,
    task_id: job.task_id,
    accepted,
    rejected: !accepted,
    needsHuman,
    scopeOk,
    testsRan: testRan,
    testsPassed,
    changedFiles,
    changedStats: delta ? delta.stats : null,
    sensitiveFiles,
    reasons,
    gitRepo: after !== null,
    gitWarning: job.git_warning || null,
  };
}
