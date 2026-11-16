// 改动证据：只认工作区实际状态，不认 codex 自述。
//
// 两条铁律（对应方案里的 Git 陷阱）：
// 1. 用 baseCommit 做基准，不把工作区原本就有的未提交修改算成这次任务的产出。
// 2. 必须显式看未跟踪文件 —— git diff 不含未跟踪，漏掉会得出「什么都没改」的假结论。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** 文件内容指纹。用 sha1 就够——只比是否相同，不做安全用途。 */
function hashFile(p) {
  return createHash('sha1').update(readFileSync(p)).digest('hex').slice(0, 16);
}

function git(cwd, args, { input = null, timeout = 30_000 } = {}) {
  const r = spawnSync('git', args, {
    cwd, encoding: 'utf8', timeout, windowsHide: true,
    input: input ?? undefined,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error) return { ok: false, out: '', err: String(r.error.message || r.error) };
  return { ok: r.status === 0, out: r.stdout || '', err: r.stderr || '', code: r.status };
}

/** 是否 git 仓库；是则返回 HEAD commit，不是返回 null。 */
export function headCommit(cwd) {
  const r = git(cwd, ['rev-parse', '--verify', 'HEAD']);
  return r.ok ? r.out.trim() : null;
}

/** 文件行数。读不到就当 0，不影响主流程。 */
function countLines(p) {
  try {
    const t = readFileSync(p, 'utf8');
    if (!t) return 0;
    return t.split('\n').length - (t.endsWith('\n') ? 1 : 0);
  } catch { return 0; }
}

/**
 * 任务开始时的基线。非 git 目录返回 {repo:false}，此时无法给出可靠证据，
 * 只能退回全量文件快照对比，且必须向调用方声明「无回滚保障」。
 */
export function baseline(cwd) {
  const head = headCommit(cwd);
  if (!head) {
    const tracked = git(cwd, ['rev-parse', '--is-inside-work-tree']);
    return {
      repo: false,
      reason: tracked.ok ? '仓库还没有提交' : '不是 git 仓库',
      head: null,
      // 没有 git 就只能靠文件快照：至少要说清「改了几个文件」，不能返回 0 骗人
      snapshot: Object.fromEntries(scanTree(cwd)),
    };
  }
  // 已跟踪文件在基线时刻的状态，用于区分「任务改的」和「任务前就有的」
  const dirty = git(cwd, ['status', '--porcelain', '--untracked-files=no']).out;
  // 逐行取路径，不能整段 trim：porcelain 的列宽是固定的（" M path"），
  // 开头那个空格是状态位，trim 掉会让 slice(3) 切到文件名中间。
  const paths = dirty.split('\n')
    .filter((l) => l.trim())
    .map((l) => l.slice(3).trim())
    .filter(Boolean);

  // 只记路径不够：任务结束后无法判断「这个脏文件后来又被改过没有」。
  // 记下内容指纹，任务后指纹没变 = 任务没碰它，可以干净地排除出本次产出。
  const fingerprint = {};
  for (const p of paths) {
    try { fingerprint[p] = hashFile(join(cwd, p)); } catch { fingerprint[p] = null; }
  }
  return { repo: true, head, preexistingDirty: paths, fingerprint };
}

// 快照上限：超过就不扫，避免在大仓库上卡住几十秒。宁可少给证据，不能拖死任务。
const SCAN_MAX_FILES = 20_000;
const SCAN_SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', 'target']);

/** 扫文件树的 {相对路径 → 大小+mtime}。用于非 git 目录的改动识别。 */
function scanTree(root) {
  const out = new Map();
  let count = 0;
  const walk = (dir) => {
    if (count > SCAN_MAX_FILES) return;
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (count > SCAN_MAX_FILES) return;
      if (e.name.startsWith('.') && e.name !== '.env') continue;
      if (SCAN_SKIP.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile()) continue;
      try {
        const s = statSync(p);
        // 同时记行数：非 git 目录的任务结束后要靠它算「删了几行」
        const lines = s.size < 2 * 1024 * 1024 ? countLines(p) : 0;
        out.set(relative(root, p), { size: s.size, mtime: s.mtimeMs, lines });
        count += 1;
      } catch { /* 读不到就跳过 */ }
    }
  };
  walk(root);
  return out;
}

/**
 * 相对 baseline 算出这次任务的真实改动。
 * 返回三组：已跟踪文件的 diffstat、未跟踪的新文件、以及完整 patch。
 */
export function collect(cwd, base) {
  if (!base || !base.repo) {
    // 非 git 目录：用前后快照对比，至少说清改了哪些文件。
    // 不能说「0 改动」——那和事实相反，会让主控以为任务什么都没做。
    const after = scanTree(cwd);
    // 基线可能来自落盘的 JSON（宿主重启后），统一成 Map 再比
    const before = base?.snapshot ? new Map(Object.entries(base.snapshot)) : new Map();
    const changed = [];
    let totalNow = 0;

    for (const [p, s] of after) {
      const b = before.get(p);
      if (!b) {
        // 新文件：它的全部行数都是这次新增的
        const n = countLines(join(cwd, p));
        totalNow += n;
        changed.push({ path: p, additions: n, deletions: 0, untracked: true });
      } else if (b.size !== s.size || Math.abs(b.mtime - s.mtime) > 1) {
        // 改过的文件：只能给当前行数，真实增删得存基线内容才有，
        // 这里不虚报，明确标成「改了但不知道增删多少」
        const n = countLines(join(cwd, p));
        totalNow += n;
        changed.push({ path: p, additions: 0, deletions: 0, untracked: false, lines: n });
      } else {
        totalNow += b.lines || 0;
      }
    }

    // 被删掉的文件也要报：任务把文件删了是重要事实，漏掉会得出错误结论
    const deleted = [];
    for (const [p, b] of before) {
      if (after.has(p)) continue;
      deleted.push(p);
      changed.push({ path: p, additions: 0, deletions: b.lines || 0, untracked: false, deleted: true });
    }

    // 非 git 目录没有 diff，但至少要能说清「新增了多少行」
    const additions = changed.filter((c) => c.untracked).reduce((a, c) => a + (c.additions || 0), 0);
    const deletions = changed.filter((c) => c.deleted).reduce((a, c) => a + (c.deletions || 0), 0);

    return {
      repo: false,
      files: changed,
      touchedFiles: changed,
      additions,
      deletions,
      untracked: changed.filter((c) => c.untracked).map((c) => c.path),
      deleted,
      patch: '',
      // 说清局限：没有 git 就没有精确的增删行统计和回滚能力
      warning: `${base?.reason || '无 git 基线'}：只按文件修改时间判断改动；新增文件的行数准确，修改文件的增删行数给不出；没有回滚保障`,
    };
  }

  // 已跟踪文件的改动（相对任务开始时的 HEAD）
  const stat = git(cwd, ['diff', '--numstat', base.head, '--']);
  const files = [];
  let additions = 0;
  let deletions = 0;
  for (const line of stat.out.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const [a, d, p] = t.split('\t');
    // 二进制文件是 "-\t-\tpath"
    const add = a === '-' ? 0 : Number(a) || 0;
    const del = d === '-' ? 0 : Number(d) || 0;
    additions += add;
    deletions += del;
    files.push({ path: p, additions: add, deletions: del, binary: a === '-' });
  }

  // 未跟踪的新文件：git diff 不含它们，必须单独取
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard']).out
    .split('\n').map((s) => s.trim()).filter(Boolean);

  // 被删除的文件：numstat 里会体现，但单独列出来更清楚
  const deleted = git(cwd, ['diff', '--diff-filter=D', '--name-only', base.head, '--']).out
    .split('\n').map((s) => s.trim()).filter(Boolean);

  // 完整 patch：已跟踪改动 + 未跟踪文件全文（用 --no-index 逐个小文件成本高，
  // 这里只给未跟踪文件路径，正文让调用方按需读，避免把整个新文件塞进 patch）
  const patch = git(cwd, ['diff', base.head, '--']).out;

  // 任务前就存在的脏文件：指纹没变 = 任务没碰它，从产出里剔除；
  // 指纹变了 = 任务在上面继续改过，保留但标注「原本就有未提交改动」。
  const pre = new Set((base.preexistingDirty || []).map((s) => String(s).trim()));
  const fpBefore = base.fingerprint || {};
  const preexistingUntouched = [];
  for (const f of files) {
    if (!pre.has(f.path)) { f.preexisting = false; continue; }
    const before = fpBefore[f.path];
    let now = null;
    try { now = hashFile(join(cwd, f.path)); } catch { now = null; }
    f.preexisting = true;
    // 没有基线指纹（老记录）时保守处理：算任务没碰它，宁可少报也不虚报
    if (!before || !now || before === now) {
      f.untouchedByTask = true;
      preexistingUntouched.push(f.path);
    }
  }
  const touched = files.filter((f) => !f.untouchedByTask);

  return {
    repo: true,
    files,
    touchedFiles: touched,
    additions,
    deletions,
    untracked,
    deleted,
    patch,
    preexisting: [...pre],
    preexistingUntouched,
    warning: pre.size
      ? `工作区在任务开始前已有 ${pre.size} 个未提交改动（${[...pre].slice(0, 5).join('、')}${pre.size > 5 ? ' 等' : ''}），其中 ${preexistingUntouched.length} 个本次未再改动，已从本次产出中排除`
      : null,
  };
}