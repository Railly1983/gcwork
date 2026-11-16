#!/usr/bin/env node
/**
 * 安装后修一次 MCP 路径。
 *
 * 为什么需要这个：
 * WorkBuddy 会把插件的 .mcp.json 复制成「自定义连接器」，但这个通道
 * 不展开 ${CODEBUDDY_PLUGIN_ROOT}，变量会原样留在配置里，导致
 * spawn 找不到可执行文件（报 Connection closed，connectMs 只有几毫秒）。
 * 内置插件走的是另一条通道，所以它们用变量没问题——第三方插件不行。
 *
 * 这里做的事：把变量写法换成这台机器上的真实绝对路径。
 * 幂等，重复跑没关系。
 *
 * 用法：
 *   node install.mjs
 * 跑完重启 WorkBuddy，或者到「连接器 → 自定义连接器」点重连。
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const WIN = platform() === 'win32';
const launcher = join(HERE, 'bin', WIN ? 'run-node.cmd' : 'run-node');
const server = join(HERE, 'mcp', 'gcwork-engine', 'server.mjs');

function say(msg) {
  process.stdout.write(`${msg}\n`);
}

if (!existsSync(launcher)) {
  say(`✗ 找不到启动脚本：${launcher}`);
  say('  包可能没解压完整，重新解压一次。');
  process.exit(1);
}
if (!existsSync(server)) {
  say(`✗ 找不到 MCP 服务端：${server}`);
  process.exit(1);
}

const config = {
  mcpServers: {
    'gcwork-engine': {
      command: launcher,
      args: [server],
    },
  },
};
const configText = `${JSON.stringify(config, null, 2)}\n`;

// 1) 插件自己的 .mcp.json —— 平台会从这里复制，所以必须改这里
const pluginMcp = join(HERE, '.mcp.json');
if (existsSync(pluginMcp)) {
  copyFileSync(pluginMcp, `${pluginMcp}.bak`);
}
writeFileSync(pluginMcp, configText, 'utf8');
say(`✓ 已写入 ${pluginMcp}`);

// 2) 缓存目录（如果平台已经复制过一份到版本化缓存）
const cacheRoot = join(homedir(), '.workbuddy', 'plugins', 'cache');
if (existsSync(cacheRoot)) {
  try {
    const name = 'gcwork';
    const markets = readdirSync(cacheRoot);
    let touched = 0;
    for (const m of markets) {
      const dir = join(cacheRoot, m, name);
      if (!existsSync(dir)) continue;
      for (const version of readdirSync(dir)) {
        const f = join(dir, version, '.mcp.json');
        if (existsSync(f)) {
          writeFileSync(f, configText, 'utf8');
          touched += 1;
        }
      }
    }
    if (touched) say(`✓ 已更新 ${touched} 份缓存配置`);
  } catch { /* 缓存不存在或读不了，跳过 */ }
}

// 3) 用户级 mcp.json —— 平台把自定义连接器存在这里
const userMcp = join(homedir(), '.workbuddy', 'mcp.json');
if (existsSync(userMcp)) {
  try {
    const raw = readFileSync(userMcp, 'utf8');
    const data = JSON.parse(raw);
    data.mcpServers = data.mcpServers || {};
    data.mcpServers['gcwork-engine'] = {
      command: launcher,
      args: [server],
      disabled: false,
    };
    copyFileSync(userMcp, `${userMcp}.bak-gcwork`);
    writeFileSync(userMcp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    say(`✓ 已更新 ${userMcp}（备份在同目录 .bak-gcwork）`);
  } catch (e) {
    say(`! 用户 mcp.json 更新失败：${e.message}`);
  }
}

say('');
say('完成。重启 WorkBuddy，或在「连接器 → 自定义连接器」里对 gcwork-engine 点重连。');
say(`启动命令：${launcher}`);
