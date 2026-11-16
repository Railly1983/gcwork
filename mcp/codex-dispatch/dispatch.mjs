// 派单编排：同步等待 + 可续跑。
//
// 三条实测得来的铁律（改代码前先读）：
// 1. thread/resume 能恢复会话历史与上下文，但**不能恢复已被杀掉的执行进程**。
//    进程死了 turn 会变成 interrupted，续做必须开新 turn，不能指望原 turn 复活。
// 2. 一个 thread 同时只允许一个 writer。旧连接没断开就 resume 会报
//    `already has an active writer`，所以续跑前必须先关旧连接。
// 3. turn/diff/updated 在 codex-cli 0.166.0 上实测不发（发了 0 次），
//    改动证据只能自己用 git 算，不能依赖这个事件。
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { AppServer } from './appserver.mjs';
import { findCodex } from './entry.mjs';
import { baseline, collect } from './git.mjs';
import { acquire, release, sweepLocks, describeHolder } from './lock.mjs';

// 内存中的活动任务：MCP 进程常驻，跨工具调用共享，这是「同步转 pending」的基础。
const active = new Map();

// 软超时：必须在宿主硬超时之前返回，否则调用被硬杀、taskRef 都来不及给。
// 宿主默认 MCP_TOOL_TIMEOUT 是 1 小时；留 60 秒余量，且不超过参数上限。
const HOST_HARD_MS = Number(process.env.MCP_TOOL_TIMEOUT) > 0
  ? Number(process.env.MCP_TOOL_TIMEOUT)
  : 3600_000;
const SAFETY_MS = 60_000;
const DEFAULT_SOFT_MS = 600_000; // 10 分钟
// 下限：太短会把正常任务频繁打断成 pending。测试需要注入更小的值。
const MIN_SOFT_MS = Number(process.env.CODEX_DISPATCH_MIN_SOFT_MS) > 0
  ? Number(process.env.CODEX_DISPATCH_MIN_SOFT_MS)
  : 5000;
// 观察僵尸 turn 的窗口：记录说在跑、但长时间没有任何进展，就判定是死进程留下的
const ZOMBIE_WAIT_MS = Number(process.env.CODEX_DISPATCH_ZOMBIE_MS) > 0
  ? Number(process.env.CODEX_DISPATCH_ZOMBIE_MS)
  : 60_000;

function softLimitMs(requestedSec) {
  const want = Number(requestedSec) > 0 ? Number(requestedSec) * 1000 : DEFAULT_SOFT_MS;
  return Math.max(MIN_SOFT_MS, Math.min(want, HOST_HARD_MS - SAFETY_MS));
}

/**
 * 数据目录。用独立目录而不是复用 2.x 的 ~/.workbuddy/gcwork（2.x 的旧目录）：
 * 两版的记录格式完全不同，混在一起会被当成损坏文件，还可能让旧任务显示成新任务。
 */
export function homeDir() {
  return process.env.CODEX_DISPATCH_HOME || join(homedir(), '.codex-dispatch');
}
function tasksDir() { return join(homeDir(), 'tasks'); }
function taskFile(ref) { return join(tasksDir(), `${ref}.json`); }

function saveTask(rec) {
  mkdirSync(tasksDir(), { recursive: true });
  writeFileSync(taskFile(rec.taskRef), `${JSON.stringify(rec, null, 2)}\n`, 'utf8');
}
function loadTask(ref) {
  const p = taskFile(ref);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

/** 任务编号：可读前缀 + 短随机，便于人工在文件里认出来。 */
function newRef() {
  return `t-${randomUUID().slice(0, 8)}`;
}

function sandboxPolicy(readOnly) {
  return readOnly
    ? { type: 'readOnly' }
    : { type: 'workspaceWrite', writableRoots: [], networkAccess: true };
}

/** 从 turn 的 items 里取最终回答。只认 agentMessage，别的类型不参与。 */
function finalMessage(turn) {
  const msgs = (turn?.items || [])
    .filter((i) => i.type === 'agentMessage' && i.text)
    .map((i) => String(i.text));
  return msgs.join('').trim();
}

/**
 * 跑一轮并等它结束。返回 {status, message, usage, turnId, error}。
 * 不用 turn/completed 事件兜底：事件可能在 await 之前就错过，直接轮询更稳。
 */
async function runTurnAndWait(conn, threadId, text, opts) {
  const r = await conn.request('turn/start', {
    threadId,
    input: [{ type: 'text', text }],
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    sandboxPolicy: sandboxPolicy(opts.readOnly),
    // 绝不留需要人点确认的审批：任务在沙箱里跑，弹窗只会让 turn 永久挂起
    approvalPolicy: 'never',
  });
  const turnId = r.turn?.id || r.turnId || null;

  const deadline = Date.now() + opts.runDeadlineMs;
  for (;;) {
    if (conn.dead) return { status: 'failed', error: conn.dead, turnId, message: '' };
    if (opts.isCancelled?.()) return { status: 'cancelled', turnId, message: '', error: '服务正在退出' };

    // thread/read 拿当前 turn 状态；比订阅事件可靠，不依赖时序
    let turns = [];
    try {
      const rd = await conn.request('thread/read', { threadId, includeTurns: true }, 15_000);
      turns = rd.thread?.turns || rd.turns || [];
    } catch { /* 读失败就继续等，不因一次失败放弃 */ }

    const cur = turns.find((t) => t.id === turnId) || turns[turns.length - 1];
    const st = cur?.status;
    if (st && st !== 'inProgress') {
      return {
        status: st === 'completed' ? 'completed' : st,
        message: finalMessage(cur),
        usage: cur?.usage || null,
        turnId,
        error: cur?.error?.message || null,
        completedAt: cur?.completedAt || null,
      };
    }
    if (Date.now() > deadline) {
      return { status: 'running', turnId, message: finalMessage(cur), error: null };
    }
    await new Promise((res) => setTimeout(res, 800));
  }
}

/**
 * 收尾：算改动、落产物、写台账、出回执。四条路径共用，避免每处各写一遍容易漏字段。
 */
function settle(rec, turnResult, cwd, base) {
  rec.lastTurnId = turnResult.turnId || rec.lastTurnId;
  // cancelled 不是失败：服务主动退出，任务本身没出错，不该记成 failed
  rec.status = turnResult.status === 'cancelled' ? 'interrupted' : turnResult.status;
  const changes = collect(cwd, base);
  rec.artifacts = writeArtifacts(rec, turnResult, changes);
  saveTask(rec);
  return receipt(rec, turnResult, changes);
}

/** 把结果整理成给主控的回执。成功省着给，失败给足诊断。 */
function receipt(rec, turnResult, changes) {
  const ok = turnResult.status === 'completed';
  // 只把「这次真的改了」的算进产出。任务前就脏、这次指纹未变的已由 collect 标好。
  const touched = changes?.touchedFiles || changes?.files || [];
  const files = touched.map((f) => f.path);
  const untracked = changes?.untracked || [];

  const r = {
    status: ok ? 'completed' : turnResult.status,
    task_ref: rec.taskRef,
    thread_id: rec.threadId,
    turn_id: turnResult.turnId || rec.lastTurnId || null,
    // 成功只给开头：够判断有没有跑偏。全文在 artifacts 里，需要时再读。
    summary: ok
      ? String(turnResult.message || '').slice(0, 800)
      : null,
    changes: {
      files: files.length + untracked.length,
      paths: [...files, ...untracked].slice(0, 40),
      untracked: untracked.slice(0, 40),
      // 删掉的文件也是改动的一部分，漏报会让人以为只是新增
      deleted: (changes?.deleted || []).slice(0, 40),
      // 任务开始前就存在的脏改动，单独报出来，不混进本次产出
      preexisting: (changes?.preexisting || []).slice(0, 20),
    },
    // 行数只在能准确统计时才给：git 仓库给真实增删，非 git 只给新文件的新增行数。
    // 给不准的时候明确说明，不要拿 0 冒充「没改」。
    ...(changes?.repo
      ? { line_stats: { additions: changes.additions, deletions: changes.deletions } }
      : {
        line_stats: {
          additions: changes?.additions || 0,
          deletions: changes?.deletions || 0,
          note: '非 git 目录：只统计新增文件的行数，修改文件的增删行数算不出来',
        },
      }),
    artifacts: {
      diff: rec.artifacts?.diff || null,
      full_output: rec.artifacts?.message || null,
      log: rec.artifacts?.log || null,
    },
    duration_sec: rec.startedAt
      ? Math.max(0, Math.round((Date.now() - Date.parse(rec.startedAt)) / 1000))
      : null,
  };

  if (!ok) {
    // 失败时不省 token：你要知道为什么。区分「执行失败」和「改了但没验证」。
    r.diagnosis = {
      stage: turnResult.status === 'running' ? '仍在运行（已到软超时）' : '执行阶段',
      turn_status: turnResult.status,
      error: turnResult.error || null,
      partial_output: String(turnResult.message || '').slice(0, 2000) || null,
      files_changed_before_failure: [...files, ...untracked].slice(0, 40),
      hint: turnResult.status === 'running'
        ? '任务还在跑。用 continue 带同一 task_ref 接着等，不会重复执行。'
        : '失败前已改的文件保留在工作区。用 continue 可在同一会话上下文里续做。',
    };
  }
  if (changes?.warning) r.git_warning = changes.warning;
  return r;
}

/**
 * 派单。同步等结果，超软时限就先返回 pending（任务仍在后台跑）。
 * 同一 task_ref 重复调用是幂等的：不会重复起一轮。
 */
export async function dispatch(args = {}) {
  const taskRef = String(args.task_ref || newRef());
  const prompt = String(args.prompt || '').trim();
  const cwd = String(args.cwd || '').trim();

  if (!prompt) return { status: 'rejected', error: '缺少 prompt' };
  if (!cwd) return { status: 'rejected', error: '缺少 cwd（工作目录绝对路径）' };
  if (!existsSync(cwd)) return { status: 'rejected', error: `工作目录不存在：${cwd}` };

  // 幂等：同 ref 已存在就跑原来那个，绝不重复执行
  const existing = active.get(taskRef);
  if (existing) return joinExisting(existing, args);

  // 内存里没有但盘上有：说明宿主重启过，转去 resume 流程
  const onDisk = loadTask(taskRef);
  if (onDisk && onDisk.threadId) return continueTask({ ...args, task_ref: taskRef });

  const entry = findCodex();
  if (!entry) {
    return {
      status: 'rejected',
      error: '找不到 codex，请先安装并登录：npm i -g @openai/codex，然后运行 codex login',
    };
  }

  const base = baseline(cwd);
  const conn = new AppServer({ entry });

  // 同一目录只允许一个写任务。只读任务不动文件，不需要锁。
  // 锁在 job.promise 的 finally 里释放：即使工具调用已返回 pending、任务还在后台跑，
  // 锁也必须一直握着，否则第二个任务会趁这段时间进来改同一批文件。
  let lockToken = null;
  if (!args.read_only) {
    const got = acquire(homeDir(), cwd, { taskRef });
    if (!got.ok) {
      return {
        status: 'rejected',
        error: `${cwd} 正被另一个任务占用：${describeHolder(got.holder)}。`,
        hint: '等它结束再派单。要并行就换一个独立目录（例如 git worktree）。',
      };
    }
    lockToken = got.token;
  }

  const rec = {
    taskRef,
    prompt,
    cwd,
    threadId: null,
    lastTurnId: null,
    status: 'starting',
    startedAt: new Date().toISOString(),
    codexHome: process.env.CODEX_HOME || null,
    model: args.model || null,
    effort: args.effort || null,
    readOnly: Boolean(args.read_only),
    gitRepo: Boolean(base.repo),
    baseHead: base.head || null,
    // 基线要落盘：宿主重启后靠它区分「这次改的」和「本来就有的」
    preexistingDirty: base.preexistingDirty || [],
    // 任务前就已脏的文件内容指纹：续跑/收尾时用它判断「任务到底动没动这个文件」
    baseFingerprint: base.fingerprint || null,
    // 非 git 目录只能靠快照对比，也要落盘，否则重启后完全没法判断改动
    baseSnapshot: base.snapshot || null,
    baseReason: base.reason || null,
  };
  // 先落盘再执行：否则进程崩了会有「任务已跑但找不到 threadId」的黑洞
  saveTask(rec);

  const job = {
    rec,
    conn,
    promise: null,
    done: false,
    result: null,
    // thread 是否已建好。只有建好之后，软超时才有意义 ——
    // 否则会返回一个 thread_id=null 的 pending，续跑直接断（实测踩过）。
    ready: false,
    lockToken, // 交给 shutdown 兜底放锁
  };

  job.promise = (async () => {
    try {
      await conn.start();
      // thread/start 的预算是独立的：必须在转 pending 之前拿到 threadId。
      const th = await conn.request('thread/start', {
        cwd,
        ephemeral: false, // 必须持久化，否则 resume 找不到
        ...(args.model ? { model: args.model } : {}),
      }, 45_000);

      const threadId = th.thread?.id || th.threadId;
      if (!threadId) throw new Error(`thread/start 未返回 threadId：${JSON.stringify(th).slice(0, 200)}`);

      rec.threadId = threadId;
      rec.modelProvider = th.modelProvider || null;
      rec.resolvedModel = th.model || null;
      rec.status = 'running';
      saveTask(rec); // 拿到 threadId 立刻落盘，这是续跑的锚点
      job.ready = true; // 从此开始才允许按软超时返回 pending

      const turnResult = await runTurnAndWait(conn, threadId, prompt, {
        ...args,
        readOnly: rec.readOnly,
        runDeadlineMs: softLimitMs(args.timeout_sec) + 30_000,
        isCancelled: () => job.cancelled,
      });

      return settle(rec, turnResult, cwd, base);
    } catch (e) {
      rec.status = 'failed';
      rec.error = String((e && e.message) || e);
      saveTask(rec);
      return {
        status: 'failed',
        task_ref: taskRef,
        thread_id: rec.threadId,
        diagnosis: {
          stage: '启动或握手',
          error: rec.error,
          hint: '检查 codex 是否已登录：在终端运行 codex login。',
        },
      };
    } finally {
      job.done = true;
      // 锁在这里放，不是工具调用返回时：pending 之后任务还在后台跑，那段必须继续占着。
      if (lockToken) release(homeDir(), cwd, lockToken);
    }
  })();

  active.set(taskRef, job);
  return joinExisting(job, args);
}

/** 等一个已在跑的任务，超过软时限就返回 pending（任务继续在后台跑）。 */
async function joinExisting(job, args) {
  // 关键：不要用 job.result 做短路判断。done 在 finally 里先置位、result 由外部赋值，
  // 两者之间有竞态窗口，会返回 null（实测导致随机失败）。
  // promise 本身就是结果来源，直接 race 它就行。
  if (job.done && job.promise) {
    // 已经结束：promise 已完成，await 立刻返回，不会等
    return job.promise;
  }

  // 建 thread 是确定的一次性开销（实测 1-3 秒），不该占用「等任务」的预算。
  // 先等 ready：此时 threadId 已落盘，返回 pending 才能续得上。
  // 建 thread 本身失败会走 job.promise 的 catch，这里不会空等。
  const READY_LIMIT = 60_000;
  const r0 = await Promise.race([
    (async () => { while (!job.ready && !job.done) await new Promise((r) => setTimeout(r, 100)); return 'ready'; })(),
    new Promise((res) => setTimeout(() => res('timeout'), READY_LIMIT)),
  ]);
  // done 之后 promise 一定已 settle，await 立即返回真实结果
  if (job.done) return job.promise;

  const waited = await Promise.race([
    job.promise,
    new Promise((res) => setTimeout(() => res(PENDING), softLimitMs(args.timeout_sec))),
  ]);

  if (waited !== PENDING) return waited;

  // 没等到：给 task_ref 让调用方接着问。
  // threadId 从盘上重读，确保拿到的是真实值而不是内存里的中间态。
  const latest = loadTask(job.rec.taskRef) || job.rec;
  if (!latest.threadId) {
    // 还没建出 thread 就超了：这是启动阶段的问题，不能假装任务在跑
    return {
      status: 'failed',
      task_ref: job.rec.taskRef,
      diagnosis: {
        stage: '建立会话',
        error: `会话在 ${Math.round(READY_LIMIT / 1000)} 秒内没有建起来（r0=${r0}）`,
        hint: 'codex 可能卡在启动。检查 codex 是否已登录（终端运行 codex login），以及是否有残留的 codex 进程。',
      },
    };
  }
  return {
    status: 'pending',
    task_ref: job.rec.taskRef,
    thread_id: latest.threadId,
    hint: '任务仍在执行。带同一 task_ref 再调 continue 接着等结果，不会重复执行。',
    elapsed_sec: job.rec.startedAt
      ? Math.round((Date.now() - Date.parse(job.rec.startedAt)) / 1000)
      : null,
  };
}

const PENDING = Symbol('pending');

/**
 * 续跑。四种情况分别处理（对应方案里的幂等判断）：
 * - 内存里还在跑 → 接着等，不新起一轮
 * - 内存里已完成 → 直接给结果
 * - 盘上有、内存没有（宿主重启过）→ resume thread，看最后 turn 状态再决定
 */
export async function continueTask(args = {}) {
  const taskRef = String(args.task_ref || '').trim();
  if (!taskRef) return { status: 'rejected', error: '缺少 task_ref' };

  const inMemory = active.get(taskRef);
  if (inMemory) return joinExisting(inMemory, args);

  const rec = loadTask(taskRef);
  if (!rec) return { status: 'rejected', error: `没有这个任务：${taskRef}` };
  if (!rec.threadId) {
    return { status: 'rejected', error: `任务 ${taskRef} 没有记录 threadId，无法续跑。请重新派单。` };
  }

  const entry = findCodex();
  if (!entry) return { status: 'rejected', error: '找不到 codex' };

  const conn = new AppServer({ entry });
  // 续跑的基线必须从落盘记录里恢复，不能重新采集 —— 重采会把已改的文件当成基线
  const base = {
    repo: Boolean(rec.gitRepo),
    head: rec.baseHead,
    preexistingDirty: rec.preexistingDirty || [],
    fingerprint: rec.baseFingerprint || null,
    snapshot: rec.baseSnapshot || null,
    reason: rec.baseReason || null,
  };

  // 续跑也要占目录锁：宿主重启后原锁可能是死进程留下的，acquire 会清掉重抢。
  // 如果锁还被一个活进程握着，说明别的窗口正在跑同一个目录，这时候续跑只会互相踩。
  let lockToken = null;
  if (!rec.readOnly) {
    const got = acquire(homeDir(), rec.cwd, { taskRef });
    if (!got.ok) {
      return {
        status: 'rejected',
        error: `${rec.cwd} 正被另一个任务占用：${describeHolder(got.holder)}。`,
        hint: '等它结束再续跑。',
      };
    }
    lockToken = got.token;
  }

  // continue 的 threadId 已经在盘上，不存在「建不出来」的问题，直接算就绪
  const job = { rec, conn, done: false, result: null, promise: null, ready: true, lockToken };
  job.promise = (async () => {
    try {
      await conn.start();

      // 关键：resume 前旧连接必须已死，否则报 active writer。
      // 宿主重启场景下旧进程已经没了，这里不会撞；同进程内重复调用会走内存分支。
      const rs = await conn.request('thread/resume', { threadId: rec.threadId }, 120_000);
      const turns = rs.thread?.turns || [];
      const last = turns[turns.length - 1] || null;

      if (last && last.status === 'completed') {
        // 已经跑完了，只是上次没把结果交出去 —— 直接取，绝不再跑一遍
        return settle(rec, {
          status: 'completed',
          message: finalMessage(last),
          turnId: last.id,
          error: null,
        }, rec.cwd, base);
      }

      if (last && last.status === 'inProgress') {
        // 有 turn 记着在跑。两种情况必须分辨：
        // a) 真有一个活着的 writer 在跑 → 接着等
        // b) 是已经死掉的进程留下的僵尸 turn → 等下去没有意义，得重新发起
        // 分辨不了就给它一个较短的观察窗口：真有进度会体现在 turns 里，
        // 一直不变就说明是僵尸。这样既不会抢活的任务，也不会永远挂着。
        const turnResult = await waitCurrentTurn(
          conn, rec.threadId, last.id,
          Math.min(softLimitMs(args.timeout_sec), ZOMBIE_WAIT_MS) + 30_000,
        );
        if (turnResult.status === 'running') {
          // 观察窗口内没有进展：按僵尸 turn 处理，重新发起续做
          // （thread 历史还在，上下文不会丢）
          const handoff = buildHandoff(rec, { ...last, status: 'interrupted' }, args);
          const retry = await runTurnAndWait(conn, rec.threadId, handoff, {
            readOnly: rec.readOnly,
            model: rec.model,
            effort: rec.effort,
            runDeadlineMs: softLimitMs(args.timeout_sec) + 30_000,
            isCancelled: () => job.cancelled,
          });
          return settle(rec, retry, rec.cwd, base);
        }
        return settle(rec, turnResult, rec.cwd, base);
      }

      // interrupted / failed / 没有 turn：开新的一轮接着做。
      // 这是「恢复会话上下文」而非「恢复被杀的进程」——实测确认过，进程死了无法复活。
      const handoff = buildHandoff(rec, last, args);
      const turnResult = await runTurnAndWait(conn, rec.threadId, handoff, {
        readOnly: rec.readOnly,
        model: rec.model,
        effort: rec.effort,
        runDeadlineMs: softLimitMs(args.timeout_sec) + 30_000,
        isCancelled: () => job.cancelled,
      });

      return settle(rec, turnResult, rec.cwd, base);
    } catch (e) {
      rec.status = 'failed';
      rec.error = String((e && e.message) || e);
      saveTask(rec);
      return {
        status: 'failed',
        task_ref: taskRef,
        thread_id: rec.threadId,
        diagnosis: {
          stage: '续跑',
          error: rec.error,
          hint: /active writer/i.test(rec.error)
            ? '原会话仍被另一个进程占用。确认没有其他 WorkBuddy 窗口或 codex 进程在跑同一任务后重试。'
            : '会话恢复失败。已完成的工作保留在工作区，可重新派单继续。',
        },
      };
    } finally {
      job.done = true;
      if (lockToken) release(homeDir(), rec.cwd, lockToken);
    }
  })();

  active.set(taskRef, job);
  return joinExisting(job, args);
}

/** 等一个已存在的 turn 结束（别的 writer 在跑时用）。 */
async function waitCurrentTurn(conn, threadId, turnId, maxMs) {
  const deadline = Date.now() + maxMs;
  for (;;) {
    if (conn.dead) return { status: 'failed', error: conn.dead, turnId, message: '' };
    let turns = [];
    try {
      const rd = await conn.request('thread/read', { threadId, includeTurns: true }, 30_000);
      turns = rd.thread?.turns || [];
    } catch { /* 继续等 */ }
    const cur = turns.find((t) => t.id === turnId) || turns[turns.length - 1];
    if (cur && cur.status && cur.status !== 'inProgress') {
      return {
        status: cur.status,
        message: finalMessage(cur),
        turnId,
        error: cur.error?.message || null,
      };
    }
    if (Date.now() > deadline) return { status: 'running', turnId, message: finalMessage(cur), error: null };
    await new Promise((r) => setTimeout(r, 800));
  }
}

/**
 * 续做指令。必须说清三件事，否则 codex 会从头再做一遍：
 * 上一轮怎么结束的、已经改了什么、别重复哪些部分。
 */
function buildHandoff(rec, last, args) {
  const changes = collect(rec.cwd, {
    repo: Boolean(rec.gitRepo),
    head: rec.baseHead,
    preexistingDirty: rec.preexistingDirty || [],
    fingerprint: rec.baseFingerprint || null,
    snapshot: rec.baseSnapshot || null,
    reason: rec.baseReason || null,
  });
  const done = [...(changes.files || []).map((f) => f.path), ...(changes.untracked || [])];
  const why = last
    ? `上一轮状态：${last.status}${last.error?.message ? `（${last.error.message}）` : ''}`
    : '上一轮没有产生 turn 记录（执行进程在开始前就退出了）';

  const lines = [
    '继续完成下面这个任务，不要从头再做一遍。',
    '',
    `[原始任务]`,
    rec.prompt,
    '',
    `[当前情况] ${why}。`,
    done.length
      ? `[已经改动的文件] ${done.slice(0, 30).join('、')}${done.length > 30 ? ` 等 ${done.length} 个` : ''}`
      : '[已经改动的文件] 暂无',
    '',
    '请先检查这些文件的当前内容，判断哪些工作已经完成，然后只做剩下的部分。',
  ];
  if (args.prompt) lines.push('', `[补充要求] ${args.prompt}`);
  return lines.join('\n');
}

/** 全文、diff、日志全部落盘；上下文里只留路径。 */
function writeArtifacts(rec, turnResult, changes) {
  const dir = join(homeDir(), 'runs', rec.taskRef);
  mkdirSync(dir, { recursive: true });

  const messagePath = join(dir, 'message.md');
  const diffPath = join(dir, 'diff.patch');
  const logPath = join(dir, 'run.log');

  try {
    writeFileSync(messagePath, `${turnResult.message || ''}\n`, 'utf8');
    if (changes?.patch) writeFileSync(diffPath, changes.patch, 'utf8');
    const log = [
      `task_ref: ${rec.taskRef}`,
      `thread: ${rec.threadId}`,
      `turn: ${turnResult.turnId || ''}`,
      `status: ${turnResult.status}`,
      `error: ${turnResult.error || ''}`,
      `cwd: ${rec.cwd}`,
      `model: ${rec.resolvedModel || rec.model || ''}`,
      `effort: ${rec.effort || ''}`,
      `started: ${rec.startedAt}`,
      `ended: ${new Date().toISOString()}`,
      `changed: ${(changes?.files || []).length} tracked, ${(changes?.untracked || []).length} untracked`,
    ].join('\n');
    writeFileSync(logPath, `${log}\n`, 'utf8');
  } catch { /* 落盘失败不改变任务结论 */ }

  return {
    message: messagePath,
    diff: existsSync(diffPath) ? diffPath : null,
    log: logPath,
  };
}

/**
 * 启动时清理。只做两件事：数一下有多少任务上次停在「running」（可能有结果没交出去），
 * 删掉过期记录。不在这里自动续跑 —— 那需要用户明确要，不能偷偷替他花额度。
 */
export function sweep() {
  const dir = tasksDir();
  // 僵尸锁必须先清：上一次进程崩溃留下的锁不清，那个目录以后每次派单都会被拒。
  let locksCleared = 0;
  try { locksCleared = sweepLocks(homeDir()); } catch { /* 锁目录不可写不该拦住启动 */ }
  if (!existsSync(dir)) return { pendingRecovery: 0, pruned: 0, locksCleared };
  let pendingRecovery = 0;
  let pruned = 0;
  const keepMs = 14 * 86400_000;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const p = join(dir, f);
    try {
      const rec = JSON.parse(readFileSync(p, 'utf8'));
      if (Date.now() - Date.parse(rec.startedAt || 0) > keepMs) {
        // 删掉而不是清空：留一个空文件下次解析会失败，pollute 列表
        try { rmSync(p, { force: true }); } catch { /* 单个失败不影响 */ }
        pruned += 1;
        continue;
      }
      // 上次没走完的：状态是 running 但当前进程里没有这个任务
      if ((rec.status === 'running' || rec.status === 'starting') && rec.threadId && !active.has(rec.taskRef)) {
        pendingRecovery += 1;
      }
    } catch { /* 坏文件跳过 */ }
  }
  return { pendingRecovery, pruned, locksCleared };
}

/** 进程退出时关掉所有连接，不留孤儿 app-server，也不留写到一半的任务。 */
export async function shutdown() {
  const jobs = [...active.values()];
  active.clear();
  // 先标记取消，让还在轮询的任务尽快退出循环，再关连接。
  // 否则 runTurnAndWait 会一直等到 deadline，服务退出被拖住。
  for (const j of jobs) j.cancelled = true;
  await Promise.allSettled(jobs.map((j) => j.conn?.close()));
  // 等 promise 收尾，但必须设上限：某个任务可能正卡在请求超时里，
  // 服务退出不能被它拖住（进程都退出了，等待毫无意义）。
  await Promise.race([
    Promise.allSettled(jobs.map((j) => j.promise)),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
  // 兜底放锁。正常情况下 finally 已经放了；这里处理「任务卡在超时里没走到 finally」
  // 就被叫停的情况 —— 不放的话那个目录会锁到下一个进程启动才被 sweep 清掉。
  for (const j of jobs) {
    if (!j.lockToken) continue;
    const cwd = j.rec?.cwd;
    if (cwd) { try { release(homeDir(), cwd, j.lockToken); } catch { /* 忽略 */ } }
  }
}