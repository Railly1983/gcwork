// 连接状态查询。只做只读探测，不建 thread、不占目录锁、不花额度。
//
// 为什么单独一个工具：模型名和强度档位由账号与套餐决定，写死在描述里会过期。
// 让模型自己查一次，比猜参数可靠。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { AppServer } from './appserver.mjs';
import { findCodex } from './entry.mjs';

// 查一次约 5 秒（要起 app-server 握手）。短时间内重复问不该反复起进程。
const CACHE_MS = 60_000;
let cache = null;

/** 从包内 package.json 读版本；读不到再退回 `--version`，两者都不行就不给版本。 */
function versionOf(entry) {
  // entry 形如 .../@openai/codex/bin/codex.js，包根在上两级
  for (const p of [join(dirname(entry), '..', 'package.json'), join(dirname(entry), 'package.json')]) {
    try {
      if (existsSync(p)) {
        const pkg = JSON.parse(readFileSync(p, 'utf8'));
        if (pkg.version) return pkg.version;
      }
    } catch { /* 换个位置再试 */ }
  }
  return null;
}

function versionBySpawn(entry) {
  return new Promise((resolve) => {
    const cmd = /\.(js|mjs|cjs)$/i.test(entry) ? process.execPath : entry;
    const args = cmd === entry ? ['--version'] : [entry, '--version'];
    let out = '';
    let child;
    try { child = spawn(cmd, args, { windowsHide: true, env: process.env }); } catch { resolve(null); return; }
    const done = (v) => { try { child.kill(); } catch { /* 忽略 */ } resolve(v); };
    const t = setTimeout(() => done(null), 5000);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('error', () => { clearTimeout(t); resolve(null); });
    child.on('exit', () => {
      clearTimeout(t);
      const m = out.match(/\d+\.\d+\.\d+/);
      resolve(m ? m[0] : null);
    });
  });
}

/** 账号与套餐。只取判断要不要重登所需的部分，不搬 token。 */
function accountInfo(raw) {
  const a = raw?.account || null;
  if (!a) return { logged_in: false, plan: null };
  return {
    logged_in: true,
    type: a.type || null,
    email: a.email || null,
    plan: a.planType || null,
  };
}

/** 模型清单：只留可见的，带出每个模型自己的强度档位与默认值。 */
function modelInfo(list) {
  const rows = (list?.data || []).filter((m) => !m.hidden);
  return rows.map((m) => ({
    id: m.id,
    name: m.displayName || m.id,
    default: Boolean(m.isDefault),
    default_effort: m.defaultReasoningEffort || null,
    efforts: (m.supportedReasoningEfforts || []).map((e) => e.reasoningEffort),
  }));
}

async function probe() {
  const entry = findCodex();
  if (!entry) {
    return {
      status: 'codex_not_found',
      codex: { found: false },
      hint: '本机没找到 codex。安装并登录：npm i -g @openai/codex && codex login',
    };
  }

  const version = versionOf(entry) || (await versionBySpawn(entry));
  const conn = new AppServer({ entry });
  try {
    await conn.start();

    // 三项互不依赖，任一失败都不该让整个查询失败
    const [acc, models, caps] = await Promise.all([
      conn.request('account/read', {}, 20_000).catch(() => null),
      conn.request('model/list', {}, 20_000).catch(() => null),
      conn.request('modelProvider/capabilities/read', {}, 20_000).catch(() => null),
    ]);

    const account = accountInfo(acc);
    const list = modelInfo(models);

    const out = {
      status: account.logged_in && list.length ? 'ready' : 'not_ready',
      codex: { found: true, version, entry },
      account,
      models: list,
      // 只读模式能不能联网搜索，取决于这一项；查询里直接告诉调用方
      capabilities: {
        web_search: caps?.webSearch ?? null,
        image_generation: caps?.imageGeneration ?? null,
      },
      // 参数怎么写，直接给可复制的用法，省得模型自己拼
      usage: {
        model: list.map((m) => m.id),
        effort: '每个模型的档位见 models[].efforts；不传用 default_effort',
        read_only: '只读模式传 read_only=true，不改文件，只读任务不占目录锁',
      },
    };

    if (!account.logged_in) {
      out.hint = 'codex 没登录。终端运行 codex login，登录后再查一次。';
    } else if (!list.length) {
      out.hint = '读不到模型清单。可能是网络或账号权限问题，重试一次；仍为空就在终端跑 codex 看看。';
    }
    return out;
  } finally {
    try { await conn.close(); } catch { /* 查询结束就关，关不掉不影响结果 */ }
  }
}

/** 对外入口。带一分钟缓存：同一轮对话里连问两次不必再起一次 app-server。 */
export async function status() {
  if (cache && Date.now() - cache.at < CACHE_MS) {
    return { ...cache.value, cached: true };
  }
  const value = await probe();
  cache = { at: Date.now(), value };
  return value;
}