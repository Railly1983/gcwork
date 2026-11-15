// 配置 + 确定性路由 + 模型解析 + CLI 入口探测 + 参数存在性探测 + 健康自检。
// 这一层不碰 ledger / 子进程生命周期，便于纯函数测试。
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';

export const TOOL_VERSION = '2.1.0';

// 思考强度词表（与 CLI 对齐）。
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// 八个具体模型名。tier 只是语义标签，用于取默认强度与权限。
export const MODELS = {
  astra: { cli: 'codex', family: 'astra', fallback: 'gpt-6-astra', tier: 'plan' },
  sol: { cli: 'codex', family: 'sol', fallback: 'gpt-6.1-sol', tier: 'hard' },
  terra: { cli: 'codex', family: 'terra', fallback: 'gpt-6.1-terra', tier: 'main' },
  luna: { cli: 'codex', family: 'luna', fallback: 'gpt-6-luna', tier: 'chore' },
  fable: { cli: 'claude', alias: 'fable', tier: 'plan' },
  opus: { cli: 'claude', alias: 'opus', tier: 'hard' },
  sonnet: { cli: 'claude', alias: 'sonnet', tier: 'main' },
  haiku: { cli: 'claude', alias: 'haiku', tier: 'chore' },
};

const TIER_EFFORT = { plan: 'high', hard: 'high', main: 'medium', chore: 'medium' };

// 角色 → 默认画像（任务类型、是否写、默认强度、沙箱、codex/claude 默认模型）。
export const ROLE_PROFILE = {
  planner: { task_type: 'review', need_write: false, defaultEffort: 'high', sandbox: 'read-only', codex: 'astra', claude: 'fable' },
  implementer: { task_type: 'implement', need_write: true, defaultEffort: 'medium', sandbox: 'workspace-write', codex: 'terra', claude: 'sonnet' },
  reviewer: { task_type: 'review', need_write: false, defaultEffort: 'medium', sandbox: 'read-only', codex: 'astra', claude: 'fable' },
};

// 只有这几类失败值得换边重试（tier 模式下）。TIMEOUT / FAILED 换边等于再烧一次。
export const FALLBACK_CODES = new Set(['NOT_FOUND', 'AUTH', 'QUOTA', 'MODEL_UNAVAILABLE']);

const BILLING_ENV = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'],
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL'],
};

// 属于宿主会话本身、对子进程无意义且可能误导 CLI 的变量，始终剔除。
const SESSION_ENV_DROP = ['CLAUDE_SESSION_ID', 'CLAUDE_PROJECT_DIR', 'CLAUDE_CODE_ENTRYPOINT'];

// ---------------------------------------------------------------- 归一化

export function normModel(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/^gcwork-/, '');
  return MODELS[s] ? s : null;
}

export function normEffort(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return EFFORTS.includes(s) ? s : null;
}

export function normRole(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return ROLE_PROFILE[s] ? s : null;
}

// ---------------------------------------------------------------- 路由

/**
 * 确定性路由：给出执行器（codex/claude）。
 * - 显式指定 executor(claude|codex) → 直接采用，绝不替换。
 * - review / 只读 → codex。
 * - refactor/implement 且文件数 > 3 → claude（大改更稳）。
 * - fix / generate_tests → codex（低风险好验证）。
 * - high 风险 → claude。
 * - 其余 → codex。
 */
export function route(task = {}) {
  const exec = task.executor || 'auto';
  if (exec === 'claude' || exec === 'codex') return exec;
  if (task.task_type === 'review' || task.need_write === false) return 'codex';
  if ((task.task_type === 'refactor' || task.task_type === 'implement') && (task.file_count || 0) > 3) return 'claude';
  if (task.task_type === 'fix' || task.task_type === 'generate_tests') return 'codex';
  if (task.risk_level === 'high') return 'claude';
  return 'codex';
}

/**
 * 把 dispatch 输入收敛成一个确定目标。支持：
 * - 显式 model 名（精确，永不替换，类似 2.0.2 --model）。
 * - role + executor 自动选边（类似 2.0.2 --tier）。
 * @returns {{cli,name,effort,sandbox,readOnly}|{error:string}}
 */
export function pickTarget(task = {}) {
  // 精确模型名优先
  if (task.model) {
    const name = normModel(task.model);
    if (!name) return { error: `未知模型：${task.model}；可用：${Object.keys(MODELS).join(', ')}` };
    const m = MODELS[name];
    const sandbox = task.sandbox || (m.tier === 'plan' ? 'read-only' : 'workspace-write');
    const effort = normEffort(task.effort) || TIER_EFFORT[m.tier];
    return { cli: m.cli, name, effort, sandbox, readOnly: sandbox === 'read-only' };
  }

  const roleKey = normRole(task.role) || 'implementer';
  const role = ROLE_PROFILE[roleKey];
  const task_type = task.task_type || role.task_type;
  const need_write = task.need_write === undefined ? role.need_write : task.need_write;
  const cli = route({
    executor: task.executor,
    task_type,
    need_write,
    risk_level: task.risk_level,
    file_count: task.file_count,
  });
  const name = cli === 'codex' ? role.codex : role.claude;
  const sandbox = task.sandbox || role.sandbox;
  const effort = normEffort(task.effort) || role.defaultEffort;
  return { cli, name, effort, sandbox, readOnly: sandbox === 'read-only' };
}

// ---------------------------------------------------------------- 沙箱/权限

export function codexSandboxOf(sandbox) {
  return sandbox === 'read-only' ? 'read-only' : 'workspace-write';
}

export function claudePermissionOf(sandbox) {
  return sandbox === 'read-only' ? 'plan' : 'dontAsk';
}

// ---------------------------------------------------------------- 模型解析

let CATALOG_CACHE = null;

function readCatalogs() {
  if (CATALOG_CACHE) return CATALOG_CACHE;
  const dir = process.env.CODEX_HOME || join(homedir(), '.codex');
  let list = [];
  try {
    list = readdirSync(dir).filter((n) => /^models_cache.*\.json$/.test(n));
  } catch {
    CATALOG_CACHE = [];
    return CATALOG_CACHE;
  }
  const files = list
    .map((n) => {
      const p = join(dir, n);
      try {
        return { p, mtime: fs.statSync(p).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);

  const out = [];
  for (const f of files) {
    try {
      const cat = JSON.parse(fs.readFileSync(f.p, 'utf8'));
      const mlist = (cat.models || []).filter((m) => m && m.slug && m.visibility === 'list');
      if (mlist.length) out.push({ file: f.p, canonical: basename(f.p) === 'models_cache.json', models: mlist });
    } catch { /* 坏文件跳过 */ }
  }
  CATALOG_CACHE = out;
  return out;
}

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
    if (x !== y) return y - x;
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
 * 严格解析：家族不存在就直接报 MODEL_UNAVAILABLE，绝不挑别的模型顶上。
 * 只有连 models_cache 都读不到时，才用写死名字并标 warning。
 */
export function resolveCodexModel(family, fallback, catalogsIn) {
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

  const uniq = new Map();
  for (const c of cands) if (!uniq.has(c.slug.toLowerCase())) uniq.set(c.slug.toLowerCase(), c);
  const sorted = [...uniq.values()].sort(
    (a, b) => cmpVersion(a.slug, b.slug) || a.priority - b.priority || (b.canonical ? 1 : 0) - (a.canonical ? 1 : 0),
  );

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

/** 把 8 个模型名解析成具体 slug（codex 走目录严格解析，claude 用别名）。 */
export function resolveModel(name) {
  const m = MODELS[name];
  if (!m) return { error: 'BAD_MODEL', detail: `未知模型名：${name}` };
  if (m.cli === 'claude') return { model: m.alias, source: 'alias', priority: null, catalog: null };
  return resolveCodexModel(m.family, m.fallback);
}

// ---------------------------------------------------------------- 环境

export function billingRisks(cli) {
  return (BILLING_ENV[cli] || []).filter((k) => process.env[k]);
}

export function billingWarningFor(cli) {
  const hits = billingRisks(cli);
  if (!hits.length) return null;
  const apiKey = hits.some((k) => /API_KEY$/.test(k));
  const gateway = hits.some((k) => /BASE_URL$/.test(k) || /AUTH_TOKEN$/.test(k));
  const why = apiKey
    ? '可能按 API 计费，而不是你正在使用的订阅额度'
    : gateway
      ? '认证走环境变量指定的网关，不落在 CLI 自身的登录额度上'
      : '认证路径由环境变量指定';
  return `${cli} 侧检测到 ${hits.join(' / ')}：${why}。要用 CLI 自身登录，清掉这些变量。`;
}

/** 构造子进程环境：剔除宿主会话变量；clean 模式再剥离计费相关变量。 */
export function childEnv(mode) {
  const env = { ...process.env };
  for (const k of SESSION_ENV_DROP) delete env[k];
  if (mode === 'clean') {
    for (const k of Object.keys(env)) {
      if (/^(ANTHROPIC|OPENAI|CODEX)_/.test(k) || /^CLAUDE_CODE_USE_/.test(k)) delete env[k];
    }
  }
  return env;
}

// ---------------------------------------------------------------- 入口探测

export function findCodexEntry() {
  if (process.env.GCWORK_CODEX_ENTRY) return process.env.GCWORK_CODEX_ENTRY;
  const cands = [join(dirname(process.execPath), 'node_modules', '@openai', 'codex', 'bin', 'codex.js')];
  const versions = join(homedir(), '.workbuddy', 'binaries', 'node', 'versions');
  try {
    const fs = require('node:fs');
    for (const v of fs.readdirSync(versions)) {
      cands.push(join(versions, v, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
    }
  } catch { /* 无该目录 */ }
  if (process.env.APPDATA) {
    cands.push(join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
  }
  return cands.find((p) => existsSync(p)) || null;
}

export function findClaudeEntry() {
  if (process.env.GCWORK_CLAUDE_ENTRY) return process.env.GCWORK_CLAUDE_ENTRY;
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

// ---------------------------------------------------------------- 参数存在性探测

const FLAG_CACHE = new Map();

/**
 * 解析 `CLI --help` 文本，得到支持的 flag 集合（含长短形式）。带缓存，按 entry 区分。
 * 用于在 CLI 版本变更后优雅降级（缺哪个参数就不传哪个）。
 */
export function probeFlags(cli, entry) {
  const key = `${cli}:${entry}`;
  if (FLAG_CACHE.has(key)) return FLAG_CACHE.get(key);

  let text = '';
  try {
    const viaNode = /\.(js|mjs|cjs)$/i.test(entry || '');
    const r = viaNode
      ? spawnSync(process.execPath, [entry, '--help'], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
      : spawnSync(entry, ['--help'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    if (r) text = `${r.stdout || ''}\n${r.stderr || ''}`;
  } catch { /* 探测失败则空集合，适配器降级 */ }

  const set = new Set();
  const re = /(?:^|\s)(--?[a-zA-Z][\w-]*)/g;
  let m;
  while ((m = re.exec(text)) !== null) set.add(m[1]);
  FLAG_CACHE.set(key, set);
  return set;
}

export function hasFlag(flags, name) {
  return flags instanceof Set && flags.has(name);
}

// ---------------------------------------------------------------- 健康自检

function probe(entry, args, viaNode) {
  let r = null;
  try {
    r = viaNode
      ? spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
      : spawnSync(entry, args, { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  } catch { /* 入口不存在 */ }
  if (!r || r.error) return { status: null, stdout: '', stderr: '', text: '' };
  return {
    status: r.status,
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
    text: `${r.stdout || ''}\n${r.stderr || ''}`,
  };
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

/** 健康自检：两侧安装/登录状态 + 模型解析 + 计费风险。供 health 工具调用。 */
export function health() {
  const codexEntry = findCodexEntry();
  const claudeEntry = findClaudeEntry();
  const codex = codexStatus(codexEntry);
  const claude = claudeStatus(claudeEntry);
  codex.ok = Boolean(codex.installed && codex.login === true);
  claude.ok = Boolean(claude.installed && claude.login === true);

  const roles = Object.keys(ROLE_PROFILE).map((role) => {
    const rp = ROLE_PROFILE[role];
    const cInfo = resolveModel(rp.codex);
    const kInfo = resolveModel(rp.claude);
    return {
      role,
      task_type: rp.task_type,
      need_write: rp.need_write,
      defaultEffort: rp.defaultEffort,
      sandbox: rp.sandbox,
      codex: cInfo.error
        ? { name: rp.codex, error: 'MODEL_UNAVAILABLE', detail: cInfo.detail }
        : { name: rp.codex, resolved: cInfo.model, source: cInfo.source },
      claude: { name: rp.claude, resolved: kInfo.model, source: kInfo.source },
    };
  });

  const models = Object.keys(MODELS).map((name) => {
    const m = MODELS[name];
    const info = resolveModel(name);
    const entry = m.cli === 'codex' ? codexEntry : claudeEntry;
    return {
      name,
      cli: m.cli,
      tier: m.tier,
      resolved: info.model || null,
      source: info.source || null,
      error: info.error || null,
      available: info.available || null,
      warning: info.warning || null,
      entryOk: Boolean(entry),
    };
  });

  const warnings = [];
  for (const side of ['codex', 'claude']) {
    const w = billingWarningFor(side);
    if (w) warnings.push(w);
  }
  for (const s of [codex, claude]) if (s.note) warnings.push(s.note);
  for (const m of models) if (m.error) warnings.push(`${m.name}：${m.error}`);
  if (!codex.installed) warnings.push('未找到 codex 入口');
  if (!claude.installed) warnings.push('未找到 claude 入口');
  if (codex.installed && codex.login === false) warnings.push('codex 未登录，需要用户自行登录');
  if (claude.installed && claude.login === false) warnings.push('claude 未登录，需要用户自行登录');

  return {
    ok: codex.ok || claude.ok,
    version: TOOL_VERSION,
    sides: {
      codex: { ...codex, billingEnv: billingRisks('codex') },
      claude: { ...claude, billingEnv: billingRisks('claude') },
    },
    warnings,
    roles,
    models,
  };
}
