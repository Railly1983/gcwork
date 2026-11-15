// 验收：只看产物（artifacts），不轻信 CLI 自称「已完成」。git 范围审查 + 敏感文件标记 +
// 跑测试（无 test 脚本则降级为 needsHuman，不硬判失败）。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRef } from './engine/ledger.mjs';
import { gitSnapshot, gitDelta, snapshotFromJSON } from './engine/git.mjs';
import { findNpmCli } from './models.mjs';

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

  // 先判任务终态：没成功跑完的任务，产物再干净也不能验收通过。
  // 这条必须在其它检查之前——否则 failed/timeout/running 会因「HEAD 未动 + 测试过」被误判 accepted。
  const jobStatus = job.status;
  if (jobStatus === 'running') {
    accepted = false;
    reasons.push('任务仍在运行（running），不能验收');
  } else if (jobStatus !== 'ok') {
    accepted = false;
    reasons.push(`任务未成功完成（status=${jobStatus || 'unknown'}），不能验收`);
  }

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

  // 任务没成功跑完时直接返回，不再跑 npm test ——
  // 结果已定是 rejected，再花五分钟跑测试没有意义，还白占机器。
  if (jobStatus !== 'ok') {
    return {
      ok: true,
      job_id: job.job_id,
      task_id: job.task_id,
      jobStatus,
      accepted: false,
      rejected: true,
      needsHuman: false,
      scopeOk,
      testsRan: false,
      testsPassed: null,
      changedFiles,
      changedStats: delta ? delta.stats : null,
      sensitiveFiles,
      reasons,
      gitRepo: after !== null,
      gitWarning: job.git_warning || null,
    };
  }

  // 测试：仅在存在 test 脚本时跑；否则降级为 needsHuman，不硬判失败。
  let testsPassed = null;
  let testRan = false;
  // package.json 可能不在仓库根目录：先看根，再往下找一层（monorepo 常见结构）。
  // 只看根目录会把有测试的项目误判成「无法自动验证」。
  let pkgDir = null;
  const rootPkg = join(workdir, 'package.json');
  if (existsSync(rootPkg)) {
    pkgDir = workdir;
  } else {
    try {
      for (const ent of readdirSync(workdir, { withFileTypes: true })) {
        if (!ent.isDirectory() || ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
        const cand = join(workdir, ent.name, 'package.json');
        if (existsSync(cand)) { pkgDir = join(workdir, ent.name); break; }
      }
    } catch { /* 目录读不了就按非 Node 项目处理 */ }
  }

  if (pkgDir) {
    const pkgPath = join(pkgDir, 'package.json');
    let scripts = {};
    try {
      scripts = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts || {};
    } catch { /* 坏 json */ }
    if (scripts.test) {
      testRan = true;
      // Windows 上 npm 是 .cmd，不能直接 spawn（Node 18.20+ 禁止无 shell 启动批处理）。
      // 优先用 node + npm-cli.js；实在找不到才退回裸 npm。
      const npmCli = findNpmCli();
      const [cmd, args] = npmCli
        ? [process.execPath, [npmCli, 'test']]
        : ['npm', ['test']];
      const r = spawnSync(cmd, args, { cwd: pkgDir, encoding: 'utf8', timeout: 300_000, windowsHide: true });
      testsPassed = r.status === 0;
      if (!testsPassed) {
        accepted = false;
        const why = r.error ? `${r.error.code}: ${r.error.message}` : `exit ${r.status}`;
        reasons.push(`测试未通过（${why}）`);
      }
    } else {
      needsHuman = true;
      reasons.push('无 test 脚本，无法自动验证，需人工确认');
    }
  } else {
    needsHuman = true;
    reasons.push('未找到 package.json，无法自动测试，需人工确认');
  }

  // 明确拒绝（HEAD 移动 / 测试失败）时不再算「待人工」
  if (!accepted) needsHuman = false;

  return {
    ok: true,
    job_id: job.job_id,
    task_id: job.task_id,
    jobStatus,
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
