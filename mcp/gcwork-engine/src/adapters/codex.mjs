// Codex CLI 适配：构造 argv（参数存在性探测 + 降级）+ 解析结果。
import { join } from 'node:path';
import { codexSandboxOf, probeFlags, hasFlag, launcherFor } from '../models.mjs';


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
