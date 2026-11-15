// Codex CLI 适配：构造 argv（参数存在性探测 + 降级）+ 解析结果。
import { join } from 'node:path';
import { codexSandboxOf, probeFlags, hasFlag } from '../models.mjs';

/** .js/.mjs 入口需要用 node 起；.exe/.cmd 直接起。 */
export function launcher(entry) {
  return /\.(js|mjs|cjs)$/i.test(entry || '') ? [process.execPath, entry] : [entry];
}

/**
 * 构造 codex exec 的 argv。
 * - 核心参数（exec/--json/--ephemeral/-s/-m/-o）始终带上；
 * - 可选参数（-c 推理强度、--skip-git-repo-check）按 CLI --help 探测结果降级：不支持就省。
 * prompt 通过 stdin 传入（最后的 `-`），不进 argv。
 */
export function buildArgv(ctx) {
  const { effort, sandbox, modelInfo, entry, runDir, gitRepo = true } = ctx;
  const flags = probeFlags('codex', entry);
  const head = launcher(entry);

  const argv = [
    ...head, 'exec', '--json', '--ephemeral', '--color', 'never',
    '-s', codexSandboxOf(sandbox),
    '-m', modelInfo.model,
  ];

  // 推理强度：探测到 -c/--config 才传，否则降级省略
  if (hasFlag(flags, '-c') || hasFlag(flags, '--config')) {
    argv.push('-c', `model_reasoning_effort="${effort}"`);
  }

  // 结果输出文件
  argv.push('-o', join(runDir, 'last.md'));

  // 非 git 仓库才放行跳过仓库检查，默认保留这层保护
  if (!gitRepo && hasFlag(flags, '--skip-git-repo-check')) {
    argv.push('--skip-git-repo-check');
  }

  argv.push('-');
  return argv;
}

/** 从 codex JSON 事件流里捞真正的错误信息，别被 stderr 的无害 WARNING 抢占。 */
export function codexError(stdout) {
  let msg = null;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try {
      const ev = JSON.parse(s);
      if (ev.type === 'error' && ev.message) msg = ev.message;
      else if (ev.type === 'turn.failed') msg = ev.error?.message || ev.message || JSON.stringify(ev).slice(0, 500);
    } catch { /* 非 JSON 行 */ }
  }
  return msg;
}

/** 从 codex JSON 事件流取 token 用量。 */
export function codexUsage(stdout) {
  let usage = null;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try {
      const ev = JSON.parse(s);
      if (ev.type === 'turn.completed' && ev.usage) usage = ev.usage;
    } catch { /* 非 JSON 行 */ }
  }
  return usage;
}

/**
 * 解析 codex 一次执行的结果。
 * @param {{stdout?:string, last?:string}} ctx last 为 -o 输出文件内容。
 */
export function readResult({ stdout = '', last = '' } = {}) {
  let message = '';
  if (last && String(last).trim()) message = String(last).trim();
  // 降级：没有 -o 产物时，从 JSON 流里捞最后一条 assistant 消息
  if (!message) {
    for (const line of String(stdout).split(/\r?\n/)) {
      const s = line.trim();
      if (!s.startsWith('{')) continue;
      try {
        const ev = JSON.parse(s);
        if (ev.type === 'turn.completed' && ev.message) message = ev.message;
      } catch { /* 非 JSON 行 */ }
    }
  }
  return { message, usage: codexUsage(stdout), error: codexError(stdout) };
}
