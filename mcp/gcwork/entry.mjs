// codex 入口探测。只做这一件事，越简单越不容易坏。
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * 找 codex 的 CLI 入口 js。
 * 顺序：环境变量 → 当前 node 同级 → 各 node 版本目录 → APPDATA 全局 npm。
 * 找不到返回 null，由调用方给出人话提示。
 */
export function findCodex(env = process.env) {
  if (env.GCWORK_CODEX_ENTRY && existsSync(env.GCWORK_CODEX_ENTRY)) return env.GCWORK_CODEX_ENTRY;

  const rel = join('node_modules', '@openai', 'codex', 'bin', 'codex.js');
  const cands = [join(dirname(process.execPath), rel)];

  // WorkBuddy 自己托管的 node 版本目录，codex 常装在这里
  try {
    for (const v of readdirSync(join(homedir(), '.workbuddy', 'binaries', 'node', 'versions'))) {
      cands.push(join(homedir(), '.workbuddy', 'binaries', 'node', 'versions', v, rel));
    }
  } catch { /* 没有该目录 */ }

  if (env.APPDATA) cands.push(join(env.APPDATA, 'npm', rel));
  if (env.LOCALAPPDATA) cands.push(join(env.LOCALAPPDATA, 'Programs', 'codex', 'codex.exe'));

  return cands.find((p) => p && existsSync(p)) || null;
}