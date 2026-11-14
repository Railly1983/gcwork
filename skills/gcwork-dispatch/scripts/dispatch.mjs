#!/usr/bin/env node
// 吉克搬砖 dispatch 2.0.1 — 把一份简报交给指定模型的外部 CLI，按档位自动选模型与强度。
// 用法：
//   node dispatch.mjs --tier <plan|hard|main|chore> --brief <path> [--cwd <dir>] [--env inherit|clean]
//   node dispatch.mjs --model <id> [--effort <level>] --brief <path> [--cwd <dir>]
//   node dispatch.mjs --check
// 设计约束：零依赖、零配置、无状态。超时写死，模型名严格解析，不静默换模。
// stdout 只输出「结果卡」（二十行内），完整结果落盘到 runDir/result.json。

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------- 常量

const TOOL_VERSION = '2.0.1';

// 内外层超时必须错开：外层到点会连脚本一起杀，来不及落盘和杀子进程树。
const TIMEOUT_MS = 540_000; // 内部 CLI 硬上限
const KILL_GRACE_MS = 8_000; // 杀树后留给收尾的时间
const OUTER_TIMEOUT_MS = 590_000; // 宿主 Bash 必须传的 timeout 值
const HOST_HARD_LIMIT_MS = 600_000; // 宿主 Bash 工具天花板

const MAX_STDOUT = 8 * 1024 * 1024;
const MAX_STDERR = 1024 * 1024;
const MAX_RAW = 8 * 1024 * 1024;
const MAX_CHANGED = 40; // result.json 最多列 40 条，全量写 changed.txt

const LOCK_STALE_MS = 15 * 60_000; // 超过 15 分钟视为死锁
const RUN_RETENTION_DAYS = 14;

// codex 与 claude 的公共档位词表
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// 八个模型。tier 决定默认强度，强度只在 TIERS 里维护一份。
const MODELS = {
  astra: { cli: 'codex', family: 'astra', fallback: 'gpt-6-astra', tier: 'plan' },
  sol: { cli: 'codex', family: 'sol', fallback: 'gpt-6.1-sol', tier: 'hard' },
  terra: { cli: 'codex', family: 'terra', fallback: 'gpt-6.1-terra', tier: 'main' },
  luna: { cli: 'codex', family: 'luna', fallback: 'gpt-6-luna', tier: 'chore' },
  fable: { cli: 'claude', alias: 'fable', tier: 'plan' },
  opus: { cli: 'claude', alias: 'opus', tier: 'hard' },
  sonnet: { cli: 'claude', alias: 'sonnet', tier: 'main' },
  haiku: { cli: 'claude', alias: 'haiku', tier: 'chore' },
};

// 四档路由。派单默认走 codex 侧；claude 侧用 --model 指定，或由降级触发。
const TIERS = {
  plan: { codex: 'astra', claude: 'fable', effort: 'high', usage: '架构 / 技术方案 / 复杂规划，只读' },
  hard: { codex: 'sol', claude: 'opus', effort: 'high', usage: '疑难问题 / 复杂改造 / 关键审核' },
  main: { codex: 'terra', claude: 'sonnet', effort: 'medium', usage: '日常开发 / 常规修复，主力执行' },
  chore: { codex: 'luna', claude: 'haiku', effort: 'medium', usage: '小改动 / 文件检查 / 测试整理' },
};

// plan 档是只读权限：文字约束不是权限边界，必须落到 CLI 参数上。
const CODEX_SANDBOX = { plan: 'read-only', hard: 'workspace-write', main: 'workspace-write', chore: 'workspace-write' };
const CLAUDE_PERMISSION = { plan: 'plan', hard: 'dontAsk', main: 'dontAsk', chore: 'dontAsk' };

// 只有这几类失败值得换边重试。TIMEOUT / FAILED 换边等于再烧一次。
const FALLBACK_CODES = new Set(['NOT_FOUND', 'AUTH', 'QUOTA', 'MODEL_UNAVAILABLE']);

// 会改变认证与计费路径的环境变量。只检测、只汇报，不静默改。
const BILLING_ENV = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'],
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL'],
};

// 属于宿主会话本身、对子进程无意义且可能误导 CLI 的变量，始终剔除。
const SESSION_ENV_DROP = ['CLAUDE_SESSION_ID', 'CLAUDE_PROJECT_DIR', 'CLAUDE_CODE_ENTRYPOINT'];

// ---------------------------------------------------------------- 工具

function gcRoot() {
  return join(homedir(), '.workbuddy', 'gcwork');
}

function nowStamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function newRunId() {
  return `${nowStamp()}-${randomUUID().slice(0, 8)}`;
}

function fail(code, detail, extra) {
  return {
    ok: false,
    code,
    detail: detail ? String(detail).slice(0, 2000) : null,
    ...(extra || {}),
  };
}

function truncate(s, max, label) {
  const t = String(s || '');
  if (t.length <= max) return t;
  const head = t.slice(0, Math.floor(max * 0.7));
  const tail = t.slice(-Math.floor(max * 0.2));
  return `${head}\n…[${label} 超长截断，原始 ${t.length} 字符]…\n${tail}`;
}

function normModel(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/^gcwork-/, '');
  return MODELS[s] ? s : null;
}

function normTier(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return TIERS[s] ? s : null;
}

/** 把 --tier / --model / --effort 收敛成一个确定目标。 */
function resolveTarget({ tier, model, effort }) {
  let name = null;
  let t = null;

  if (model) {
    name = normModel(model);
    if (!name) return { error: `未知模型：${model || '(空)'}；可用：${Object.keys(MODELS).join(', ')}` };
    t = MODELS[name].tier;
  } else if (tier) {
    t = normTier(tier);
    if (!t) return { error: `未知档位：${tier || '(空)'}；可用：${Object.keys(TIERS).join(', ')}` };
    name = TIERS[t].codex;
  } else {
    return { error: '缺 --tier 或 --model' };
  }

  const e = effort ? String(effort).trim().toLowerCase() : TIERS[t].effort;
  if (!EFFORTS.includes(e)) return { error: `未知强度：${effort || '(空)'}；可用：${EFFORTS.join(', ')}` };

  return { name, tier: t, effort: e, readOnly: t === 'plan' };
}

// ---------------------------------------------------------------- 入口探测

function findCodexEntry() {
  const cands = [join(dirname(process.execPath), 'node_modules', '@openai', 'codex', 'bin', 'codex.js')];
  const versions = join(homedir(), '.workbuddy', 'binaries', 'node', 'versions');
  try {
    for (const v of readdirSync(versions)) {
      cands.push(join(versions, v, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
    }
  } catch { /* 无该目录 */ }
  if (process.env.APPDATA) {
    cands.push(join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
  }
  return cands.find((p) => existsSync(p)) || null;
}

function findClaudeEntry() {
  const cands = [];
  if (process.env.APPDATA) {
    const base = join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin');
    cands.push(join(base, 'claude.exe'), join(base, 'claude.js'));
  }
  if (process.env.LOCALAPPDATA) {
    cands.push(join(process.env.LOCALAPPDATA, 'Programs', 'claude', 'claude.exe'));
  }
  for (const dir of String(process.env.PATH || '').split(';')) {
    if (!dir) continue;
    cands.push(join(dir, 'claude.exe'), join(dir, 'claude.cmd'));
  }
  return cands.find((p) => p && existsSync(p)) || null;
}

// ---------------------------------------------------------------- 模型解析

let CATALOG_CACHE = null;

function readCatalogs() {
  if (CATALOG_CACHE) return CATALOG_CACHE;
  const dir = process.env.CODEX_HOME || join(homedir(), '.codex');
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => /^models_cache.*\.json$/.test(n));
  } catch {
    CATALOG_CACHE = [];
    return CATALOG_CACHE;
  }
  const files = names
    .map((n) => {
      const p = join(dir, n);
      try {
        return { p, mtime: statSync(p).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);

  const out = [];
  for (const f of files) {
    try {
      const cat = JSON.parse(readFileSync(f.p, 'utf8'));
      const list = (cat.models || []).filter((m) => m && m.slug && m.visibility === 'list');
      if (list.length) out.push({ file: f.p, canonical: basename(f.p) === 'models_cache.json', models: list });
    } catch { /* 坏文件跳过 */ }
  }
  CATALOG_CACHE = out;
  return out;
}

/** slug 里的版本号，用于在同家族多个候选里取最新。 */
function versionOf(slug) {
  const m = String(slug).match(/(\d+(?:\.\d+)*)/);
  return m ? m[1].split('.').map(Number) : [0];
}

function cmpVersion(a, b) {
  const A = versionOf(a);
  const B = versionOf(b);
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i += 1) {
    const x = A[i] ?? 0;
    const y = B[i] ?? 0;
    if (x !== y) return y - x; // 高版本优先
  }
  return 0;
}

function listAvailable(catalogs) {
  const seen = new Set();
  for (const cat of catalogs) {
    for (const m of cat.models) seen.add(String(m.slug).toLowerCase());
  }
  return [...seen].sort().slice(0, 24);
}

/**
 * 严格解析：家族不存在就直接报 MODEL_UNAVAILABLE，绝不挑个别的模型顶上。
 * 只有连 models_cache 都读不到时，才用写死的名字，并标记 warning。
 */
function resolveCodexModel(family, fallback, catalogsIn) {
  const catalogs = catalogsIn || readCatalogs();
  if (!catalogs.length) {
    return {
      model: fallback,
      source: 'fallback',
      warning: `读不到 ${join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json')}，模型名 ${fallback} 未经核对`,
    };
  }

  const cands = [];
  for (const cat of catalogs) {
    for (const m of cat.models) {
      if (String(m.slug).toLowerCase().endsWith(`-${family}`)) {
        cands.push({
          slug: String(m.slug),
          priority: m.priority ?? 999,
          catalog: basename(cat.file),
          canonical: cat.canonical,
        });
      }
    }
  }

  if (!cands.length) {
    return {
      error: 'MODEL_UNAVAILABLE',
      detail: `Codex 侧没有 ${family} 家族的模型。可用：${listAvailable(catalogs).join(', ') || '(空)'}`,
      available: listAvailable(catalogs),
    };
  }

  // 去重后排序：版本高优先 → priority 小优先 → 规范目录优先
  const uniq = new Map();
  for (const c of cands) if (!uniq.has(c.slug.toLowerCase())) uniq.set(c.slug.toLowerCase(), c);
  const sorted = [...uniq.values()].sort((a, b) => cmpVersion(a.slug, b.slug)
    || a.priority - b.priority
    || (b.canonical ? 1 : 0) - (a.canonical ? 1 : 0));

  const best = sorted[0];
  const others = sorted.slice(1).map((c) => c.slug);
  return {
    model: best.slug,
    source: 'cache',
    priority: best.priority,
    catalog: best.catalog,
    alternatives: others.length ? others : null,
  };
}

function resolveModel(name) {
  const m = MODELS[name];
  if (m.cli === 'claude') return { model: m.alias, source: 'alias', priority: null, catalog: null };
  return resolveCodexModel(m.family, m.fallback);
}

// ---------------------------------------------------------------- 环境

function billingRisks(cli) {
  return (BILLING_ENV[cli] || []).filter((k) => process.env[k]);
}

function billingWarningFor(cli) {
  const hits = billingRisks(cli);
  if (!hits.length) return null;
  const apiKey = hits.some((k) => /API_KEY$/.test(k));
  const gateway = hits.some((k) => /BASE_URL$/.test(k) || /AUTH_TOKEN$/.test(k));
  const why = apiKey
    ? '可能按 API 计费，而不是你正在使用的订阅额度'
    : gateway
      ? '认证走环境变量指定的网关，不落在 CLI 自身的登录额度上'
      : '认证路径由环境变量指定';
  return `${cli} 侧检测到 ${hits.join(' / ')}：${why}。要用 CLI 自身登录，加 --env clean 或先清掉这些变量。`;
}

function childEnv(mode) {
  const env = { ...process.env };
  for (const k of SESSION_ENV_DROP) delete env[k];
  if (mode === 'clean') {
    for (const k of Object.keys(env)) {
      if (/^(ANTHROPIC|OPENAI|CODEX)_/.test(k) || /^CLAUDE_CODE_USE_/.test(k)) delete env[k];
    }
  }
  return env;
}

// ---------------------------------------------------------------- 命令构造

/** .js/.mjs 入口需要用 node 起；.exe / .cmd 直接起。 */
function launcher(entry) {
  return /\.(js|mjs|cjs)$/i.test(entry) ? [process.execPath, entry] : [entry];
}

function buildArgv(name, tier, effort, modelInfo, entry, runDir, { gitRepo = true } = {}) {
  const m = MODELS[name];
  const head = launcher(entry);
  if (m.cli === 'codex') {
    const argv = [
      ...head, 'exec', '--json', '--ephemeral', '--color', 'never',
      '-s', CODEX_SANDBOX[tier], '-m', modelInfo.model,
      '-c', `model_reasoning_effort="${effort}"`,
      '-o', join(runDir, 'last.md'),
    ];
    // 只在确实不是 git 仓库时才放行，别默认关掉这层保护
    if (!gitRepo) argv.push('--skip-git-repo-check');
    argv.push('-');
    return argv;
  }
  return [
    ...head, '-p', '--output-format', 'json',
    '--permission-mode', CLAUDE_PERMISSION[tier],
    '--no-session-persistence',
    '--model', modelInfo.model, '--effort', effort,
  ];
}

// ---------------------------------------------------------------- git 快照

function gitSnapshot(cwd) {
  const run = (args, enc = 'utf8') => spawnSync('git', args, {
    cwd, encoding: enc, timeout: 20_000, windowsHide: true,
  });

  const inside = run(['rev-parse', '--is-inside-work-tree']);
  if (!inside || inside.status !== 0 || String(inside.stdout).trim() !== 'true') return null;

  const headR = run(['rev-parse', 'HEAD']);
  const head = headR && headR.status === 0 ? String(headR.stdout).trim() : null;

  const files = new Map();
  const st = run(['status', '--porcelain=v1', '-z'], 'buffer');
  if (st && st.status === 0 && st.stdout) {
    const parts = st.stdout.toString('utf8').split('\0');
    for (let i = 0; i < parts.length; i += 1) {
      const s = parts[i];
      if (!s || s.length < 4) continue;
      const xy = s.slice(0, 2);
      files.set(s.slice(3), { xy, added: null, removed: null });
      if (xy[0] === 'R' || xy[0] === 'C') i += 1; // rename/copy 有第二个路径段
    }
  }

  // numstat 补内容级变化：文件「改前已修改、改后又被改」时 xy 不变，靠行数变化识别
  for (const flags of [[], ['--cached']]) {
    const ns = run(['diff', '--numstat', ...flags]);
    if (!ns || ns.status !== 0) continue;
    for (const line of String(ns.stdout).split(/\r?\n/)) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!m) continue;
      const e = files.get(m[3]);
      if (!e) continue;
      e.added = m[1];
      e.removed = m[2];
    }
  }

  return { head, files };
}

/** 纯函数，便于测试。返回本轮相对快照的变化与统计。 */
function gitDelta(before, after) {
  if (!before || !after) return null;
  const paths = new Set([...before.files.keys(), ...after.files.keys()]);
  const changed = [];
  const stats = { added: 0, modified: 0, deleted: 0 };

  for (const p of paths) {
    const b = before.files.get(p);
    const a = after.files.get(p);
    if (!b && a) {
      changed.push(p);
      stats.added += 1;
    } else if (b && !a) {
      changed.push(p);
      stats.deleted += 1;
    } else if (b && a && (b.xy !== a.xy || b.added !== a.added || b.removed !== a.removed)) {
      changed.push(p);
      stats.modified += 1;
    }
  }

  return {
    paths: changed.sort(),
    stats,
    headMoved: before.head !== after.head,
  };
}

// ---------------------------------------------------------------- 输出解析

function classifyError(text) {
  const t = String(text || '');
  if (/model.{0,30}(not found|unavailable|does not exist)|unknown model/i.test(t)) return 'MODEL_UNAVAILABLE';
  if (/hit your usage limit|usage limit|quota|insufficient|exceeded your|out of credits|余额|额度/i.test(t)) return 'QUOTA';
  if (/unauthorized|401|invalid api key|not logged in|authentication|please log ?in|credential/i.test(t)) return 'AUTH';
  if (/no such file|not recognized as an internal|command not found/i.test(t)) return 'NOT_FOUND';
  return 'FAILED';
}

/** 从 codex 的 JSON 事件流里捞真正的错误信息，别被 stderr 的无害 WARNING 抢占。 */
function codexError(stdout) {
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

function codexUsage(stdout) {
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

function claudeResult(stdout) {
  const s = String(stdout || '').trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch { /* 可能被截断 */ }
  const m = s.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch { /* 放弃 */ }
  }
  return null;
}

// ---------------------------------------------------------------- 并发锁

function lockPathFor(cwd) {
  const h = createHash('sha1').update(resolve(cwd).toLowerCase()).digest('hex').slice(0, 16);
  return join(gcRoot(), 'locks', `${h}.lock`);
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(cwd, runId, force) {
  const p = lockPathFor(cwd);
  mkdirSync(dirname(p), { recursive: true });
  const body = JSON.stringify({
    pid: process.pid, runId, cwd: resolve(cwd), startedAt: new Date().toISOString(),
  }, null, 2);

  for (let i = 0; i < 2; i += 1) {
    try {
      writeFileSync(p, body, { flag: 'wx' });
      return { ok: true, path: p };
    } catch (e) {
      if (e.code !== 'EEXIST') return { ok: false, code: 'FAILED', detail: `并发锁创建失败：${e.message}` };
      let holder = null;
      try { holder = JSON.parse(readFileSync(p, 'utf8')); } catch { holder = null; }
      const age = holder?.startedAt ? Date.now() - Date.parse(holder.startedAt) : Infinity;
      const stale = !holder || !pidAlive(holder.pid) || !(age < LOCK_STALE_MS);
      if (force || stale) {
        try { rmSync(p, { force: true }); } catch { /* 忽略 */ }
        continue;
      }
      return {
        ok: false,
        code: 'BUSY',
        detail: `同一目录已有写入任务：${holder?.runId || '?'}（pid ${holder?.pid}，${Math.round(age / 60000)} 分钟前启动）。等它结束，或确认死锁后加 --force`,
      };
    }
  }
  return { ok: false, code: 'BUSY', detail: '并发锁获取失败，重试后仍被占用' };
}

function releaseLock(p) {
  if (!p) return;
  try { rmSync(p, { force: true }); } catch { /* 忽略 */ }
}

function pruneRuns() {
  const root = join(gcRoot(), 'runs');
  let n = 0;
  try {
    for (const d of readdirSync(root)) {
      const p = join(root, d);
      try {
        if (Date.now() - statSync(p).mtimeMs > RUN_RETENTION_DAYS * 86400_000) {
          rmSync(p, { recursive: true, force: true });
          n += 1;
        }
      } catch { /* 单个失败不影响 */ }
    }
  } catch { /* 无目录 */ }
  return n;
}

// ---------------------------------------------------------------- 执行

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 15_000 });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch { /* 已退出 */ }
  }
}

function runCli({ argv, cwd, brief, envMode }) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: childEnv(envMode),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      resolvePromise({ code: 'SPAWN_FAILED', detail: e.message, stdout: '', stderr: '', timedOut: false });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(payload);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      // 兜底：即使 close 事件没来，也要在宽限期后交卷
      setTimeout(() => finish({ exitCode: null, stdout, stderr, timedOut: true }), KILL_GRACE_MS);
    }, TIMEOUT_MS);

    child.stdout.on('data', (c) => {
      if (stdout.length < MAX_STDOUT) stdout += c.toString();
    });
    child.stderr.on('data', (c) => {
      if (stderr.length < MAX_STDERR) stderr += c.toString();
    });

    child.on('error', (err) => finish({ code: 'SPAWN_FAILED', detail: err.message, stdout, stderr, timedOut: false }));
    child.on('close', (exitCode) => finish({ exitCode, stdout, stderr, timedOut }));

    // 子进程提前退出时写 stdin 会抛 EPIPE，必须自己吞掉
    child.stdin.on('error', () => { /* 忽略 */ });
    try {
      if (brief) child.stdin.write(brief);
      child.stdin.end();
    } catch { /* 子进程可能已退出 */ }
  });
}

function artifactNames(cli, hasChanged) {
  const base = ['brief.md', 'result.json', 'message.md', 'raw.log'];
  if (cli === 'codex') base.push('last.md');
  if (hasChanged) base.push('changed.txt');
  return base;
}

// ---------------------------------------------------------------- 单次尝试

function attempt({ name, tier, effort, briefPath, cwd, brief, codexEntry, claudeEntry, envMode }) {
  const runId = newRunId();
  const runDir = join(gcRoot(), 'runs', runId);

  const m = MODELS[name];
  const entry = m.cli === 'codex' ? codexEntry : claudeEntry;
  if (!entry) {
    const hint = m.cli === 'codex'
      ? '找不到 codex 入口，让用户跑一次 --check'
      : '找不到 claude 入口，让用户跑一次 --check';
    return Promise.resolve(fail('NOT_FOUND', hint));
  }

  const modelInfo = resolveModel(name);
  if (modelInfo.error) {
    return Promise.resolve(fail('MODEL_UNAVAILABLE', modelInfo.detail, { available: modelInfo.available }));
  }

  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'brief.md'), brief, 'utf8');

  const readOnly = tier === 'plan';
  const before = gitSnapshot(cwd);
  const gitRepo = before !== null;
  const argv = buildArgv(name, tier, effort, modelInfo, entry, runDir, { gitRepo });
  const billingWarning = billingWarningFor(m.cli);

  const startedAt = new Date().toISOString();
  process.stderr.write(
    `[gcwork] run ${runId} · ${tier}/${name} · ${modelInfo.model} · ${effort} · ${readOnly ? '只读' : '可写'}\n`
    + `[gcwork] ${argv.join(' ')}\n`,
  );

  return runCli({ argv, cwd, brief, envMode }).then((r) => {
    const endedAt = new Date().toISOString();
    const after = gitSnapshot(cwd);

    let message = '';
    let usage = null;

    if (m.cli === 'codex') {
      const lastPath = join(runDir, 'last.md');
      if (existsSync(lastPath)) {
        try { message = readFileSync(lastPath, 'utf8').trim(); } catch { /* 读不到 */ }
      }
      usage = codexUsage(r.stdout);
    } else {
      const res = claudeResult(r.stdout);
      if (res && typeof res.result === 'string') message = res.result.trim();
      if (res) usage = { ...(res.usage || {}), costUsd: res.total_cost_usd ?? null };
    }

    // 错误判定：优先用 CLI 自己报的错误事件，别让 stderr 的无害告警顶掉真因
    const combined = `${r.stderr || ''}\n${r.stdout || ''}`;
    let code = null;
    let detail = null;

    if (r.code === 'SPAWN_FAILED') {
      code = 'NOT_FOUND';
      detail = r.detail;
    } else if (r.timedOut) {
      code = 'TIMEOUT';
      detail = `超过 ${TIMEOUT_MS / 1000} 秒，已杀进程树`;
    } else if (r.exitCode !== 0) {
      const own = m.cli === 'codex' ? codexError(r.stdout) : String(claudeResult(r.stdout)?.result || '');
      const reason = own || combined;
      code = classifyError(reason);
      detail = String(reason).trim().slice(-2000) || `exit ${r.exitCode}`;
    } else if (m.cli === 'claude') {
      const res = claudeResult(r.stdout);
      if (res && res.is_error) {
        code = classifyError(String(res.result || ''));
        detail = String(res.result || '').slice(0, 2000);
      }
    }

    const hasMessage = Boolean(message);
    const delta = gitDelta(before, after);
    const gitWarnings = [];
    if (!gitRepo) gitWarnings.push('非 git 仓库：没有改动证据，也没有回滚保障');
    if (delta?.headMoved) gitWarnings.push('执行期间 HEAD 变了：CLI 可能提交过代码');

    const result = {
      runId,
      ok: code === null && hasMessage,
      code: code || (hasMessage ? null : 'FAILED'),
      detail,
      tier,
      model: name,
      cli: m.cli,
      resolvedModel: modelInfo.model,
      modelSource: modelInfo.source,
      modelAlternatives: modelInfo.alternatives || null,
      effort,
      readOnly,
      sandbox: m.cli === 'codex' ? CODEX_SANDBOX[tier] : null,
      permissionMode: m.cli === 'claude' ? CLAUDE_PERMISSION[tier] : null,
      envMode,
      billingWarning,
      changedCount: delta ? delta.paths.length : null,
      changedFiles: delta ? delta.paths.slice(0, MAX_CHANGED) : null,
      changedTruncated: delta ? delta.paths.length > MAX_CHANGED : false,
      changedStats: delta ? delta.stats : null,
      gitRepo,
      gitWarning: gitWarnings.length ? gitWarnings.join('；') : null,
      hasMessage,
      partial: Boolean(r.timedOut && hasMessage), // 仅表示「超时被杀但拿到了部分正文」
      timeoutMs: TIMEOUT_MS,
      outerTimeoutMs: OUTER_TIMEOUT_MS,
      usage,
      startedAt,
      endedAt,
      runDir,
      artifacts: artifactNames(m.cli, Boolean(delta && delta.paths.length)),
    };
    if (code) result.warning = modelInfo.warning || null;

    writeFileSync(join(runDir, 'message.md'), message ? `${message}\n` : '', 'utf8');
    writeFileSync(
      join(runDir, 'raw.log'),
      truncate(`${r.stdout || ''}\n--- stderr ---\n${r.stderr || ''}`, MAX_RAW, 'raw.log'),
      'utf8',
    );
    if (delta && delta.paths.length) writeFileSync(join(runDir, 'changed.txt'), `${delta.paths.join('\n')}\n`, 'utf8');
    writeFileSync(join(runDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    return result;
  });
}

// ---------------------------------------------------------------- 主流程

/** 参数校验：冲突组合直接拒绝，不做「谁优先」的猜测。 */
function validateArgs(args) {
  if (args.unknown && args.unknown.length) return `未知参数：${args.unknown.join(', ')}`;
  if (args.tier && args.model) {
    return '--tier 与 --model 互斥，只能传一个。要精确指定模型用 --model，要按档位调度用 --tier';
  }
  if (!['inherit', 'clean'].includes(args.env || 'inherit')) {
    return `--env 只支持 inherit / clean，收到 ${args.env}`;
  }
  return null;
}

async function runDispatch(args) {
  const argError = validateArgs(args);
  if (argError) return fail('BAD_ARGS', argError);

  const target = resolveTarget(args);
  if (target.error) return fail('BAD_ARGS', target.error);

  if (!args.brief) return fail('BAD_ARGS', '缺少 --brief <简报文件路径>');

  const briefPath = isAbsolute(args.brief) ? args.brief : resolve(args.brief);
  const cwd = args.cwd ? resolve(args.cwd) : process.cwd();

  if (!existsSync(briefPath)) return fail('BAD_ARGS', `简报文件不存在：${briefPath}`);
  if (!existsSync(cwd)) return fail('BAD_ARGS', `工作目录不存在：${cwd}`);
  const brief = readFileSync(briefPath, 'utf8');
  if (!brief.trim()) return fail('BAD_ARGS', '简报为空');

  const codexEntry = findCodexEntry();
  const claudeEntry = findClaudeEntry();

  pruneRuns();

  // 只读任务不抢写锁：多单并行审核是合法用法
  const needLock = !target.readOnly;
  const lock = needLock ? acquireLock(cwd, 'pending', Boolean(args.force)) : { ok: true, path: null };
  if (!lock.ok) return fail(lock.code, lock.detail);

  const envMode = args.env || 'inherit';
  const base = {
    briefPath, cwd, brief, codexEntry, claudeEntry, envMode,
  };

  try {
    const first = await attempt({ name: target.name, tier: target.tier, effort: target.effort, ...base });
    if (first.ok || !args.tier || !FALLBACK_CODES.has(first.code)) return first;

    // 只有 --tier 模式才自动跨侧降级：可用性优先，换的是「同一档」的另一个 CLI。
    // --model 是精确指定，永不替换。
    const secondary = TIERS[target.tier].claude;
    if (secondary === target.name) return first;

    const second = await attempt({ name: secondary, tier: target.tier, effort: target.effort, ...base });
    const merged = { ...second, fallback: { from: target.name, to: secondary, reason: first.code } };
    // 降级记录也要落盘，否则事后追溯只看得到最终那次
    if (merged.runDir) {
      try {
        writeFileSync(join(merged.runDir, 'result.json'), `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
      } catch { /* 落盘失败不影响主流程 */ }
    }
    return merged;
  } finally {
    releaseLock(lock.path);
  }
}

// ---------------------------------------------------------------- 体检

function probe(entry, args, viaNode) {
  const r = viaNode
    ? spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
    : spawnSync(entry, args, { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  if (!r || r.error) return { status: null, stdout: '', stderr: '', text: '' };
  const stdout = String(r.stdout || '');
  const stderr = String(r.stderr || '');
  return { status: r.status, stdout, stderr, text: `${stdout}\n${stderr}` };
}

function codexStatus(entry) {
  if (!entry) return { installed: false, login: null, method: null };
  const ver = probe(entry, ['--version'], true);
  const version = (ver.text.match(/codex-cli\s+([\d.]+)/i) || [])[1] || null;
  const st = probe(entry, ['login', 'status'], true);
  const t = st.text.toLowerCase();
  let login = null;
  if (/not logged in|no credentials|not authenticated|not signed in/.test(t)) login = false;
  else if (/logged in|signed in/.test(t)) login = true;
  if (login !== true && st.status !== 0) login = false;
  const method = (st.text.match(/logged in using\s+([^\r\n]+)/i) || [])[1]?.trim() || null;
  return { installed: true, version, login, method, exitCode: st.status };
}

function claudeStatus(entry) {
  if (!entry) return { installed: false, login: null, method: null };
  const ver = probe(entry, ['--version'], false);
  const version = (ver.text.match(/(\d+\.\d+\.\d+)/) || [])[1] || null;
  const st = probe(entry, ['auth', 'status'], false);
  let j = null;
  try {
    j = JSON.parse(st.stdout.trim());
  } catch {
    // stdout 不是纯 JSON 时，再从全文里捞第一个 JSON 对象
    const m = st.text.match(/\{[\s\S]*\}/);
    if (m) {
      try { j = JSON.parse(m[0]); } catch { j = null; }
    }
  }
  const login = j && typeof j.loggedIn === 'boolean' ? j.loggedIn : null;
  return {
    installed: true,
    version,
    login,
    method: j?.authMethod ?? null,
    provider: j?.apiProvider ?? null,
    exitCode: st.status,
    note: login === null ? 'auth status 未能返回 JSON，登录状态未知' : null,
  };
}

function cmdCheck(args = {}) {
  const codexEntry = findCodexEntry();
  const claudeEntry = findClaudeEntry();

  const codex = codexStatus(codexEntry);
  const claude = claudeStatus(claudeEntry);

  codex.ok = Boolean(codex.installed && codex.login === true);
  claude.ok = Boolean(claude.installed && claude.login === true);

  const tiers = Object.keys(TIERS).map((t) => {
    const c = TIERS[t].codex;
    const k = TIERS[t].claude;
    const cInfo = resolveModel(c);
    const kInfo = resolveModel(k);
    return {
      tier: t,
      effort: TIERS[t].effort,
      usage: TIERS[t].usage,
      readOnly: t === 'plan',
      codex: cInfo.error
        ? { model: c, error: 'MODEL_UNAVAILABLE', detail: cInfo.detail }
        : { model: c, resolved: cInfo.model, source: cInfo.source },
      claude: { model: k, resolved: kInfo.model, source: kInfo.source },
    };
  });

  const models = Object.keys(MODELS).map((name) => {
    const tier = MODELS[name].tier;
    const modelInfo = resolveModel(name);
    const entry = MODELS[name].cli === 'codex' ? codexEntry : claudeEntry;
    const effort = TIERS[tier].effort;
    const argv = entry && !modelInfo.error
      ? buildArgv(name, tier, effort, modelInfo, entry, '<runDir>', { gitRepo: true })
      : null;
    return {
      model: name,
      tier,
      effort,
      readOnly: tier === 'plan',
      cli: MODELS[name].cli,
      resolved: modelInfo.model || null,
      source: modelInfo.source || null,
      error: modelInfo.error || null,
      available: modelInfo.available || null,
      warning: modelInfo.warning || null,
      argv,
    };
  });

  const warnings = [];
  for (const side of ['codex', 'claude']) {
    const w = billingWarningFor(side);
    if (w) warnings.push(w);
  }
  for (const s of [codex, claude]) if (s.note) warnings.push(s.note);
  for (const m of models) if (m.error) warnings.push(`${m.model}：${m.error}`);
  if (!codex.installed) warnings.push('未找到 codex 入口');
  if (!claude.installed) warnings.push('未找到 claude 入口');
  if (codex.installed && codex.login === false) warnings.push('codex 未登录，需要用户自行登录');
  if (claude.installed && claude.login === false) warnings.push('claude 未登录，需要用户自行登录');

  return {
    ok: codex.ok || claude.ok, // 至少一侧可用即可
    version: TOOL_VERSION,
    envMode: args.env || 'inherit',
    timeoutMs: TIMEOUT_MS,
    outerTimeoutMs: OUTER_TIMEOUT_MS,
    hostHardLimitMs: HOST_HARD_LIMIT_MS,
    killGraceMs: KILL_GRACE_MS,
    retentionDays: RUN_RETENTION_DAYS,
    efforts: EFFORTS,
    readOnlyTiers: ['plan'],
    sides: {
      codex: { ...codex, billingEnv: billingRisks('codex') },
      claude: { ...claude, billingEnv: billingRisks('claude') },
    },
    warnings,
    tiers,
    models,
  };
}

// ---------------------------------------------------------------- 输出

/** stdout 只给这张卡。完整结果在 runDir/result.json。 */
function cardOf(r) {
  if (!r.runDir) return r; // 参数错/锁占用，没有产物目录，原样返回
  const card = {
    runId: r.runId,
    ok: r.ok,
    code: r.code,
    tier: r.tier,
    model: r.model,
    resolvedModel: r.resolvedModel,
    modelSource: r.modelSource,
    effort: r.effort,
    readOnly: r.readOnly,
    changedCount: r.changedCount,
    changedStats: r.changedStats,
    hasMessage: r.hasMessage,
    partial: r.partial,
    fallback: r.fallback || null,
    warning: r.warning || null,
    billingWarning: r.billingWarning || null,
    gitWarning: r.gitWarning || null,
    runDir: r.runDir,
    messagePath: join(r.runDir, 'message.md'),
    artifacts: r.artifacts,
  };
  if (!r.ok && r.detail) card.detail = r.detail;
  return card;
}

function emit(obj, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  process.exitCode = exitCode;
}

// ---------------------------------------------------------------- 入口

function parseArgs(argv) {
  const out = { check: false, help: false, version: false, force: false, env: 'inherit', unknown: [] };
  let i = 0;
  // 缺值时只记一笔，不消费下一个开关，避免把 --brief 的值吃掉
  const need = (name) => {
    const v = argv[i + 1];
    if (v === undefined || String(v).startsWith('--')) {
      out.unknown.push(`${name} 缺值`);
      return null;
    }
    i += 1;
    return v;
  };
  for (; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--check') out.check = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--version' || a === '-V') out.version = true;
    else if (a === '--force') out.force = true;
    else if (a === '--tier') out.tier = need(a);
    else if (a === '--model') out.model = need(a);
    else if (a === '--effort') out.effort = need(a);
    else if (a === '--brief') out.brief = need(a);
    else if (a === '--cwd') out.cwd = need(a);
    else if (a === '--env') out.env = need(a);
    else if (a.startsWith('--')) out.unknown.push(a);
  }
  return out;
}

function helpText() {
  return `gcwork dispatch ${TOOL_VERSION}\n`
    + '  node dispatch.mjs --tier <plan|hard|main|chore> --brief <path> [--cwd <dir>] [--env inherit|clean]\n'
    + '  node dispatch.mjs --model <id> [--effort <level>] --brief <path> [--cwd <dir>]\n'
    + '  node dispatch.mjs --check [--env inherit|clean]\n'
    + `tiers   : ${Object.keys(TIERS).join(', ')}   （plan 为只读）\n`
    + `models  : ${Object.keys(MODELS).join(', ')}\n`
    + `efforts : ${EFFORTS.join(', ')}\n`
    + `timeout : 内部 ${TIMEOUT_MS / 1000}s / 宿主须传 ${OUTER_TIMEOUT_MS}（硬上限 ${HOST_HARD_LIMIT_MS / 1000}s）\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(helpText());
    return;
  }
  if (args.version) {
    emit({ version: TOOL_VERSION });
    return;
  }
  if (args.check) {
    emit(cmdCheck(args));
    return;
  }

  const result = await runDispatch(args);
  emit(cardOf(result), result.ok ? 0 : 1);
}

function isEntryPoint() {
  const p = process.argv[1];
  if (!p) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(p)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((err) => {
    emit(fail('FAILED', err && err.stack ? err.stack : String(err)), 1);
  });
}

export {
  TOOL_VERSION,
  TIMEOUT_MS,
  OUTER_TIMEOUT_MS,
  HOST_HARD_LIMIT_MS,
  MAX_CHANGED,
  EFFORTS,
  MODELS,
  TIERS,
  CODEX_SANDBOX,
  CLAUDE_PERMISSION,
  FALLBACK_CODES,
  BILLING_ENV,
  parseArgs,
  validateArgs,
  resolveTarget,
  resolveCodexModel,
  resolveModel,
  buildArgv,
  gitDelta,
  cardOf,
  classifyError,
  billingRisks,
  billingWarningFor,
  lockPathFor,
  acquireLock,
  releaseLock,
  pidAlive,
  artifactNames,
  versionOf,
  cmpVersion,
  truncate,
};
