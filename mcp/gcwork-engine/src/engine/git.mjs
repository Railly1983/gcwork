// git 快照与变更计算（纯函数为主，便于测试）。从 2.0.2 移植。
import { spawnSync } from 'node:child_process';

/**
 * 对 cwd 做一次 git 快照：是否 git 仓库、HEAD、工作区文件状态与 numstat。
 * 非 git 仓库返回 null。
 */
export function gitSnapshot(cwd) {
  const run = (args, enc = 'utf8') =>
    spawnSync('git', args, { cwd, encoding: enc, timeout: 20_000, windowsHide: true });

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

/** 把快照序列化成可 JSON 存储的形式（Map 不能直接落盘）。 */
export function snapshotToJSON(snap) {
  if (!snap) return null;
  return {
    head: snap.head,
    files: [...snap.files.entries()],
  };
}

/** 从 JSON 还原快照。 */
export function snapshotFromJSON(j) {
  if (!j) return null;
  const files = new Map(j.files || []);
  return { head: j.head, files };
}

/**
 * 纯函数：返回本轮相对快照的变化与统计。before/after 为 gitSnapshot 结果或 null。
 */
export function gitDelta(before, after) {
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

/**
 * 生成 diff 文本，用于产物留存。返回字符串或 null（非 git 仓库）。
 */
export function gitDiffText(cwd, base = 'HEAD') {
  const r = spawnSync('git', ['diff', '--stat', base], {
    cwd, encoding: 'utf8', timeout: 20_000, windowsHide: true,
  });
  if (!r || r.status !== 0) return null;
  return String(r.stdout || '').trim();
}
