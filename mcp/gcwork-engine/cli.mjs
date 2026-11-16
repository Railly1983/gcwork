#!/usr/bin/env node
// gcwork 命令行入口。
//
// 为什么不用 MCP：插件装在用户机器上时，宿主不替换 ${CODEBUDDY_PLUGIN_ROOT}，
// cwd 变成字面量路径，spawn 直接 ENOENT，连接器永远连不上。
// 改用 Bash 直接调这个 CLI，不依赖任何宿主配置，也不会因为连不上而失效。
//
// 用法：
//   node cli.mjs dispatch --workdir <dir> --prompt <text> [--task <id>] [--executor codex|claude]
//                                [--model <name>] [--effort low|medium|high] [--role planner|implementer|reviewer]
//                                [--sandbox read-only|workspace-write] [--timeout 1800] [--env inherit|clean]
//   node cli.mjs status  --ref <job_id|task_id>
//   node cli.mjs verify  --ref <job_id|task_id>
//   node cli.mjs resume  --task <id>
//   node cli.mjs health
//   node cli.mjs list    [--limit 20]
//
// 所有命令输出 JSON（便于模型直接读），失败时 exit code 非 0。
import { dispatch, status, resume, listWithSession, recoverOrphans } from './src/dispatch.mjs';
import { verify } from './src/verify.mjs';
import { health } from './src/models.mjs';
import { runJob } from './src/engine/worker.mjs';


function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[key] = true; continue; }
    out[key] = next;
    i += 1;
  }
  return out;
}

function num(v) {
  if (v === undefined || v === null || v === true) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = parseArgs(rest);

  if (!cmd || cmd === 'help' || a.help) {
    process.stdout.write(`gcwork CLI

  dispatch --workdir <dir> --prompt <text> [--task <id>] [--executor codex|claude]
           [--model <name>] [--effort low|medium|high] [--role planner|implementer|reviewer]
           [--sandbox read-only|workspace-write] [--timeout 1800] [--env inherit|clean]
  status   --ref <job_id|task_id>
  verify   --ref <job_id|task_id>
  resume   --task <id> [--env inherit|clean] [--force]
  health
  list     [--limit 20]

输出均为 JSON。dispatch 先打印 job 信息，然后在本进程内把任务跑完。
日常使用走 MCP 工具（常驻进程，不受 Bash 超时限制），CLI 用于排查和手工验证。
`);
    return 0;
  }

  if (cmd === 'health') {
    process.stdout.write(`${JSON.stringify(health(), null, 2)}\n`);
    return 0;
  }

  if (cmd === 'list') {
    process.stdout.write(`${JSON.stringify(listWithSession(num(a.limit) || 20), null, 2)}\n`);
    return 0;
  }

  if (cmd === 'status') {
    if (!a.ref) throw new Error('status 需要 --ref <job_id|task_id>');
    const r = status(a.ref);
    if (!r) throw new Error(`找不到任务：${a.ref}`);
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    return 0;
  }

  if (cmd === 'verify') {
    if (!a.ref) throw new Error('verify 需要 --ref <job_id|task_id>');
    const r = await verify(a.ref);
    if (!r) throw new Error(`找不到任务：${a.ref}`);
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    return 0;
  }

  if (cmd === 'resume') {
    if (!a.task) throw new Error('resume 需要 --task <task_id>');
    const r = await resume({
      task_id: a.task,
      timeout_sec: num(a.timeout),
      env: a.env,
      force: Boolean(a.force),
    });
    const { _spec, _specPath, ...pub } = r;
    process.stdout.write(`${JSON.stringify(pub, null, 2)}\n`);
    if (!_spec) return pub.status === 'rejected' ? 2 : 0;
    try {
      await runJob(_spec);
    } catch (e) {
      process.stderr.write(`[gcwork] 续跑异常：${(e && e.stack) || e}\n`);
      return 1;
    }
    const final = status(pub.job_id) || status(pub.task_id);
    process.stdout.write(`${JSON.stringify({ final }, null, 2)}\n`);
    return 0;
  }

  if (cmd === 'dispatch') {
    if (!a.workdir) throw new Error('dispatch 需要 --workdir <绝对路径>');
    if (!a.prompt) throw new Error('dispatch 需要 --prompt <任务描述>');
    try { recoverOrphans(); } catch { /* 清理失败不影响派单 */ }

    const r = await dispatch({
      task_id: a.task || undefined,
      prompt: a.prompt,
      workdir: a.workdir,
      executor: a.executor || 'auto',
      model: a.model || undefined,
      effort: a.effort || undefined,
      role: a.role || undefined,
      sandbox: a.sandbox || undefined,
      timeout_sec: num(a.timeout),
      blocking: false,
      env: a.env || 'inherit',
      force: Boolean(a.force),
    });

    // 台账已写入，job 立即可见。先把回执打出来，调用方马上拿到 job_id。
    const { _spec, _specPath, ...pub } = r;
    process.stdout.write(`${JSON.stringify(pub, null, 2)}\n`);
    if (pub.status === 'rejected' || pub.status === 'busy') return 2;

    // 在本进程内跑完（MCP 模式下由常驻进程承担，不受 Bash 超时限制）
    try {
      await runJob(_spec);
    } catch (e) {
      process.stderr.write(`[gcwork] 执行异常：${(e && e.stack) || e}\n`);
      return 1;
    }
    const final = status(pub.job_id) || status(pub.task_id);
    process.stdout.write(`${JSON.stringify({ final }, null, 2)}\n`);
    return 0;
  }

  throw new Error(`未知命令：${cmd}`);
}

main()
  // 不能直接 process.exit：stdout 是异步刷盘的，会丢掉还没写完的输出
  .then((code) => { process.exitCode = code || 0; })
  .catch((e) => {
    process.stdout.write(`${JSON.stringify({ status: 'error', error: String((e && e.message) || e) }, null, 2)}\n`);
    process.exitCode = 1;
  });
