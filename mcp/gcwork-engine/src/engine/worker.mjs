// 单个任务的执行器。由 CLI 或 MCP 服务端在进程内调用，跑完返回。
//
// MCP 模式下任务跑在宿主常驻的服务进程里，不受宿主轮次与 Bash 超时影响。
//
// 一个 worker 对应一个 job：起 app-server → thread/start → turn/start →
// 收通知流写台账 → 终态落盘 → 退出。
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { ensureAppServer, startThread, startTurn, subscribe, interruptTurn } from './appserver.mjs';
import { getJob, putJob, appendSessionNote } from './ledger.mjs';
import { gitSnapshot, gitDelta, snapshotFromJSON, gitDiffText } from './git.mjs';
import { classifyError } from './errors.mjs';
import { releaseLock } from './locks.mjs';
import { buildArgv as claudeArgv, readResult as claudeRead } from '../adapters/claude.mjs';
import { childEnv } from '../models.mjs';

const FLUSH_MS = 500;
const MAX_ITEMS = 40;

function truncate(s, max) {
  const t = String(s || '');
  if (t.length <= max) return t;
  return `${t.slice(0, Math.floor(max * 0.7))}\n…[超长截断，原始 ${t.length} 字符]…\n${t.slice(-Math.floor(max * 0.2))}`;
}

async function main() {
  const specPath = process.argv[2];
  if (!specPath) throw new Error('缺少任务描述文件参数');
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  return runJob(spec);
}

/**
 * 在当前进程内跑完一个任务。
 * CLI 直接调用它（阻塞到任务结束），不再依赖单独的 worker 进程——
 * Windows 沙箱的 Job Object 会在父进程退出时连带杀掉整棵进程树，
 * 独立 worker 在这种环境下活不下来。
 */
export async function runJob(spec) {
  const { jobId, runDir, cwd, prompt, model, effort, timeoutSec, entry, executor } = spec;

  const startedAt = Date.now();
  const route = { messageBuf: '', items: [], status: 'running', error: null, usage: null };
  let lastFlush = 0;
  const logPath = join(runDir, 'stderr.log');
  const log = (msg) => {
    // start /B 启动时没有 stdio，日志只能自己落文件，否则出问题完全看不见
    try { appendFileSync(logPath, `[worker] ${new Date().toISOString()} ${msg}\n`); } catch { /* 忽略 */ }
  };

  // 兜住异步回调里的异常：app-server 管道断开、JSON 解析失败这类错误发生在
  // 事件回调里，不会走 main 的 catch，会直接把进程带走且不留任何痕迹。
  // 钩子只处理「自己这个任务」：常驻进程里同时可能跑多单，
  // 旧任务的 handler 若不摘掉，会把别人的失败记到自己头上并释放别人的写锁。
  const onCrash = (label) => (e) => {
    if (route.status !== 'running') return;
    log(`${label}：${(e && e.stack) || e}`);
    route.status = 'failed';
    route.error = `${label}：${(e && e.message) || e}`;
    pushItem(`异常：${String((e && e.message) || e).slice(0, 100)}`);
    finish(spec, route, runDir);
    // 绝不 process.exit：任务跑在常驻 MCP 进程里，退出会把整个服务和
    // 其他正在跑的任务一起带走。这里只收尾当前任务，进程继续服务。
  };
  const crashHandler = onCrash('uncaughtException');
  const rejectHandler = onCrash('unhandledRejection');
  process.on('uncaughtException', crashHandler);
  process.on('unhandledRejection', rejectHandler);

  // 不写 workerPid：任务可能跑在常驻 MCP 进程里，那个 pid 属于服务本身，
  // 记成 workerPid 会让超时处理误杀整个服务。用心跳时间判活就够了。
  const j0 = getJob(jobId);
  if (j0) putJob({ ...j0, heartbeatAt: new Date().toISOString() });
  else log('台账里找不到该 job，可能已被清理');
  log(`worker 启动 pid=${process.pid} executor=${executor}`);

  const flush = (force = false) => {
    const now = Date.now();
    if (!force && now - lastFlush < FLUSH_MS) return;
    lastFlush = now;
    const job = getJob(jobId);
    if (!job || job.status !== 'running') return;
    putJob({
      ...job,
      heartbeatAt: new Date(now).toISOString(),
      progress: {
        items: route.items.slice(-MAX_ITEMS),
        messageLength: route.messageBuf.length,
        turnStatus: route.status,
        updatedAt: new Date(now).toISOString(),
      },
    });
  };

  const pushItem = (label) => {
    route.items.push({ at: new Date().toISOString(), label });
    if (route.items.length > MAX_ITEMS) route.items.shift();
  };

  // 心跳：让 status 知道 worker 还活着
  const heartbeat = setInterval(() => {
    const job = getJob(jobId);
    if (job && job.status === 'running') {
      putJob({ ...job, heartbeatAt: new Date().toISOString() });
    }
  }, 5000);

  try {
    if (executor === 'claude') {
      await runClaude(spec, route, pushItem, flush, startedAt);
    } else {
      await runCodex(spec, route, pushItem, flush, startedAt);
    }
  } catch (e) {
    route.status = 'failed';
    route.error = String((e && e.message) || e);
    log(`执行异常：${e && e.stack || e}`);
    pushItem(`启动失败：${route.error.slice(0, 100)}`);
  } finally {
    clearInterval(heartbeat);
    process.off('uncaughtException', crashHandler);
    process.off('unhandledRejection', rejectHandler);
    log(`收尾 status=${route.status} 消息长度=${route.messageBuf.length}`);
    finish(spec, route, runDir);
    // 不在这里关 app-server：连接是进程级共享的，关掉会打断同进程里其他任务。
    // 由进程退出时的钩子统一清理（见 server.mjs）。
  }
}

/** codex：走常驻 app-server，进度靠通知流。 */
async function runCodex(spec, route, pushItem, flush, startedAt) {
  const { jobId, cwd, prompt, model, effort, timeoutSec, entry, runDir } = spec;

  let myThread = null;
  let myTurn = null;

  // app-server 不产生 stdout，finalize 读 stdout.log 永远是空——
  // 失败时只能靠这里把事件流落盘，否则诊断信息全丢（现象：failed + error=null）。
  const evLog = (obj) => {
    try {
      appendFileSync(join(runDir, 'events.jsonl'), `${JSON.stringify(obj)}\n`, 'utf8');
    } catch { /* 落盘失败不影响执行 */ }
  };

  const origPushItem = pushItem;
  pushItem = (label) => { origPushItem(label); evLog({ type: 'progress', at: new Date().toISOString(), label }); };
  // 严格路由：自己的 thread 还没确定之前不收任何事件，否则别的任务的
  // 消息会混进来，导致提前判完成或串内容。
  subscribe(({ method, params }) => {
    const tid = params?.threadId || params?.thread?.id || null;
    const tTurn = params?.turnId || params?.turn?.id || null;
    // 归属判定：thread 或 turn 任一能对上才算自己的。
    // 两个都没有说明无法归属，丢掉——宁可少记进度，也不要把别人的内容混进来。
    if (tid && myThread && tid !== myThread) return;
    if (tTurn && myTurn && tTurn !== myTurn) return;
    if (!tid && !tTurn) return;
    if (myThread && !tid && myTurn && !tTurn) return;

    // 原始事件留档：只记关键几类，避免把 delta 的每个字都写进磁盘
    if (!/delta$/.test(method)) {
      evLog({ type: 'event', at: new Date().toISOString(), method, params });
    }

    if (method === 'turn/started') {
      if (params.turnId || params.turn?.id) myTurn = myTurn || params.turnId || params.turn.id;
      pushItem('开始执行');
      flush(true);
    } else if (method === 'item/started') {
      const t = params.item?.type;
      if (t) pushItem(`执行中：${t}`);
      flush(true);
    } else if (method === 'item/agentMessage/delta') {
      if (params.delta) route.messageBuf += String(params.delta);
      flush();
    } else if (method === 'item/completed') {
      const it = params.item || {};
      if (it.type === 'agentMessage' && it.text && !route.messageBuf) route.messageBuf = String(it.text);
      if (it.type === 'commandExecution' && it.command) {
        pushItem(`命令：${String(it.command).slice(0, 80)}（exit ${it.exitCode ?? '?'}）`);
      }
      flush();
    } else if (method === 'turn/completed') {
      // turn 结束不等于成功：被中断或失败的 turn 也会发 completed，
      // 不看 status 会把失败判成 ok，用户就会拿到一个假成功。
      const st = params.turn?.status || params.status || null;
      if (params.usage) route.usage = params.usage;
      if (st && st !== 'completed') {
        route.status = st === 'interrupted' ? 'interrupted' : 'failed';
        route.error = params.turn?.error?.message || params.error?.message || `turn 状态：${st}`;
        pushItem(`未成功：${st}`);
      } else {
        route.status = 'completed';
        pushItem('执行结束');
      }
      flush(true);
    } else if (method === 'turn/failed' || method === 'error') {
      route.status = 'failed';
      route.error = params?.error?.message || params?.message || 'turn 失败';
      pushItem(`失败：${String(route.error).slice(0, 100)}`);
      flush(true);
    } else if (method === 'turn/interrupted') {
      route.status = 'interrupted';
      pushItem('已中断');
      flush(true);
    }
  });

  await ensureAppServer({ entry, envMode: spec.env || 'inherit' });
  // sandbox 必须显式传下去：不传就完全取决于 codex 的本机默认配置，
  // 只读任务可能在可写环境里跑，写任务也可能被拒。
  // 不在 thread 层传 sandbox 字符串（枚举值未确认，传错整个会话起不来）；
  // 权限统一由 turn 的 sandboxPolicy 表达，结构已对过官方 schema。
  const th = await startThread({ cwd, model });
  myThread = th.threadId;
  putJob({ ...getJob(jobId), threadId: myThread });

  const { turnId } = await startTurn({
    threadId: myThread, text: prompt, effort, model, cwd,
    sandboxPolicy: sandboxPolicyOf(spec.sandbox),
  });
  myTurn = turnId;
  putJob({ ...getJob(jobId), turnId });
  flush(true);

  const limit = Number(timeoutSec) * 1000;
  const deadline = setTimeout(() => {
    if (route.status === 'running') {
      try { interruptTurn({ threadId: myThread, turnId: myTurn }); } catch { /* 忽略 */ }
      route.status = 'interrupted';
      pushItem('超时中断');
      flush(true);
    }
  }, limit);
  deadline.unref?.();

  await new Promise((resolve) => {
    const tick = () => {
      if (route.status !== 'running') { resolve(); return; }
      if (Date.now() - startedAt > limit + 30_000) { resolve(); return; }
      setTimeout(tick, 400);
    };
    tick();
  });
  clearTimeout(deadline);
}

/** claude：没有 app-server，走一次性子进程；进度靠 stdout 流式累积。 */
async function runClaude(spec, route, pushItem, flush) {
  const { jobId, cwd, prompt, model, effort, entry, runDir, gitRepo } = spec;
  const argv = claudeArgv({
    prompt, effort, sandbox: spec.sandbox, modelInfo: { model }, entry, runDir, gitRepo,
  });
  pushItem('启动 claude');
  flush(true);

  const child = spawn(argv[0], argv.slice(1), {
    cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: childEnv(spec.env || 'inherit'), // clean 模式剥离计费相关环境变量
  });
  { const cur = getJob(jobId); if (cur) putJob({ ...cur, pid: child.pid || null }); }

  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d.toString('utf8'); flush(); });
  child.stderr.on('data', (d) => { err += d.toString('utf8'); });
  child.on('error', (e) => {
    route.status = 'failed';
    route.error = `spawn 失败：${e && e.message}`;
    pushItem('启动失败');
    flush(true);
  });

  const exitCode = await new Promise((resolve) => {
    child.on('close', (code) => resolve(code));
    child.on('error', () => resolve(null));
  });

  if (route.status === 'running') {
    const r = claudeRead(out);
    route.messageBuf = r.message || '';
    route.usage = r.usage || null;
    // 判失败要看三件事：JSON 里 is_error、进程退出码、有没有只剩 stderr 的错误。
    // 只看 is_error 会漏掉「非零退出但无 stdout」这种最常见的情况。
    if (r.isError) {
      route.status = 'failed';
      route.error = String(r.message || 'Claude 报错');
    } else if (typeof exitCode === 'number' && exitCode !== 0) {
      route.status = 'failed';
      route.error = `claude 退出码 ${exitCode}${err.trim() ? `：${err.trim().slice(-500)}` : ''}`;
    } else {
      // 没有文字输出不代表失败：只改文件、不做总结是正常行为。
      route.status = 'completed';
    }
    pushItem(route.status === 'completed' ? '执行结束' : '执行失败');
    flush(true);
  }
}

function finish(spec, route, runDir) {
  const { jobId } = spec;
  const job = getJob(jobId);
  if (!job) return;
  if (job.status !== 'running') return; // 已被其它路径收尾

  const message = (route.messageBuf || '').trim();
  let status;
  if (route.status === 'interrupted') status = 'timeout';
  else if (route.status === 'failed') status = route.error ? mapError(route.error) : 'failed';
  // 完成但没有文字输出是正常的（只改文件、不做总结），不能判成崩溃
  else if (route.status === 'completed') status = 'ok';
  else status = 'crashed';

  const before = snapshotFromJSON(job.before_snapshot);
  const after = gitSnapshot(job.workdir);
  const delta = gitDelta(before, after);
  const changedFiles = delta ? delta.paths : [];
  const headMoved = Boolean(delta?.headMoved);

  const warnings = [];
  if (job.git_warning) warnings.push(job.git_warning);
  if (headMoved) warnings.push('执行期间 HEAD 变了：CLI 可能提交过代码');

  writeFileSync(join(runDir, 'message.md'), message ? `${message}\n` : '', 'utf8');
  if (changedFiles.length) writeFileSync(join(runDir, 'changed.txt'), `${changedFiles.join('\n')}\n`, 'utf8');
  const diff = gitDiffText(job.workdir);
  if (diff) writeFileSync(join(runDir, 'diff.txt'), `${diff}\n`, 'utf8');

  const endedAt = new Date().toISOString();
  const finalSummary = truncate(message ? (message.split(/\r?\n/).find((l) => l.trim()) || '(空行)') : status, 500);
  putJob({
    ...job,
    status,
    summary: finalSummary,
    // 成功时回显开头，失败时保留诊断篇幅；全文在 message.md
    // 失败时错误优先：message 可能只是失败前的半截进度，拿它当诊断依据会误导
    partialOutput: truncate(
      status === 'ok' ? (message || '（无输出）') : (route.error || message || '（无输出）'),
      status === 'ok' ? 800 : 3000,
    ),
    changed_files: changedFiles,
    changed_stats: delta ? delta.stats : null,
    headMoved,
    usage: route.usage || null,
    endedAt,
    durationSec: Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(job.startedAt)) / 1000)),
    git_warning: warnings.length ? warnings.join('；') : null,
    progress: {
      items: route.items.slice(-MAX_ITEMS),
      messageLength: message.length,
      turnStatus: route.status,
      updatedAt: endedAt,
    },
    lockHeld: false,
    heartbeatAt: endedAt,
    // 产物路径必须落进台账，否则正常完成的任务 artifacts 恒为 null，
    // 调用方拿不到 message/diff 的位置
    artifacts: {
      changed_files: changedFiles.length ? join(runDir, 'changed.txt') : null,
      diff_path: diff ? join(runDir, 'diff.txt') : null,
      stdout_path: join(runDir, 'stdout.log'),
      stderr_path: join(runDir, 'stderr.log'),
      message_path: join(runDir, 'message.md'),
      result_path: join(runDir, 'result.json'),
    },
  });

  // 收尾也落一行会话日志：下个会话看到结果与失败原因，就知道该不该续跑
  appendSessionNote(
    `${jobId} · ${status}${finalSummary && finalSummary !== status ? `（${truncate(finalSummary, 60)}）` : ''}`,
  );

  releaseLock(job.lockPath, jobId);
}

/**
 * 沙箱语义 → app-server 的 sandboxPolicy 结构。
 *
 * 按官方语义：network_access 只在 workspace-write 下生效，
 * read-only 模式本来就会拦网络请求，传 networkAccess 也没用。
 * 但 web_search 是 codex 自己的工具（默认 cached 索引、服务端执行），
 * 不受沙箱网络限制——所以只读任务照样能搜索。
 */
function sandboxPolicyOf(sandbox) {
  return sandbox === 'read-only'
    ? { type: 'readOnly' }
    : { type: 'workspaceWrite', writableRoots: [], networkAccess: true };
}

function mapError(text) {
  const c = classifyError(text);
  if (c === 'QUOTA') return 'quota_exhausted';
  if (c === 'AUTH' || c === 'NOT_FOUND' || c === 'MODEL_UNAVAILABLE') return 'rejected';
  return 'failed';
}

// 只在被当作脚本直接运行时才自动执行；被 cli.mjs import 时不应跑 main。
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) main().catch((e) => {
  try { appendFileSync(join(JSON.parse(readFileSync(process.argv[2], 'utf8')).runDir, 'stderr.log'), `[worker] FATAL ${e && e.stack || e}\n`); } catch { /* 忽略 */ }
  try {
    const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    const job = getJob(spec.jobId);
    if (job && job.status === 'running') {
      putJob({
        ...job,
        status: 'failed',
        summary: truncate(`worker 异常：${e && e.message}`, 500),
        partialOutput: String(e && e.stack || e).slice(0, 4000),
        endedAt: new Date().toISOString(),
      });
    }
  } catch { /* 兜底失败就算了 */ }
  process.exit(1);
});
