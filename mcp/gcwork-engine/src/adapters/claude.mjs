// Claude CLI 适配：构造 argv（参数存在性探测 + 降级）+ 解析 JSON 结果。
import { claudePermissionOf, probeFlags, hasFlag } from '../models.mjs';

/** .js/.mjs 入口需要用 node 起；.exe/.cmd 直接起。 */
export function launcher(entry) {
  return /\.(js|mjs|cjs)$/i.test(entry || '') ? [process.execPath, entry] : [entry];
}

/**
 * 构造 claude -p 的 argv。
 * - 核心：`-p <prompt>`、`--output-format json`、`--model`、权限模式 始终带；
 * - 可选：`--no-session-persistence`、`--effort`、`--add-dir`、`--resume` 按 --help 探测降级。
 */
export function buildArgv(ctx) {
  const { prompt, effort, sandbox, modelInfo, entry, add_dir = null, resume = null } = ctx;
  const flags = probeFlags('claude', entry);
  const head = launcher(entry);

  const argv = [
    ...head, '-p', prompt,
    '--output-format', 'json',
    '--permission-mode', claudePermissionOf(sandbox),
    '--model', modelInfo.model,
  ];

  if (hasFlag(flags, '--no-session-persistence')) argv.push('--no-session-persistence');
  if (hasFlag(flags, '--effort')) argv.push('--effort', effort);
  if (add_dir && hasFlag(flags, '--add-dir')) argv.push('--add-dir', add_dir);
  if (resume && hasFlag(flags, '--resume')) argv.push('--resume', resume);

  return argv;
}

/** 解析 claude --output-format json 的输出。 */
export function readResult(stdout = '') {
  const s = String(stdout).trim();
  if (!s) return { message: '', usage: null, isError: false };
  let j = null;
  try {
    j = JSON.parse(s);
  } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) {
      try { j = JSON.parse(m[0]); } catch { j = null; }
    }
  }
  if (!j) return { message: '', usage: null, isError: false };
  const message = typeof j.result === 'string' ? j.result.trim() : '';
  const usage = { ...(j.usage || {}), costUsd: j.total_cost_usd ?? null };
  return { message, usage, isError: Boolean(j.is_error) };
}
