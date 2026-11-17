# 修订记录

## 3.1.0 — 2026-11-17

**上架形态改成纯 MCP 插件加一个引导文件。** 平台只收专家，且沙箱评测要求资产能被直接调用；之前的纯 MCP 包没有 `agents` 字段，进不了评测。现在补一个不到 2KB 的 `agents/codex-dispatch.md`，只写「什么时候派单、怎么念回执、连不上时怎么让用户操作」，业务逻辑一行没搬进专家层。

**配套补齐平台必填项。** `expertType`、`agentName`、`displayName`、`profession`、`avatar`、`defaultInitPrompt`、`plugin`、`tags`。头像按规范出 512×512 PNG，由 `assets/icon.svg` 同一套几何绘制，蓝底白 `>_`。

**自查 26 项全过。** 含简介字数（45 字，平台上限 50）、`tags` 恰好 3 个（上次被这个卡过）、`quickPrompts` 中英齐全且首条等于 `defaultInitPrompt`、`command` 用裸名 `node`、`args` 用 `./` 相对路径、不写 `cwd`、不声明 `dependencies`。

## 3.1.0 — 2026-11-16

**新增 `status` 工具。** 查本机 Codex 装没装、登录没登录、什么套餐、有哪些模型、每个模型支持哪些思考强度、能不能联网搜索与生图。不建会话、不改文件、不占锁、不花额度，几秒返回，一分钟内重复查走缓存。

模型清单随账号与套餐变化，写死在提示里的名字必然过期。有这个工具，模型和强度就不用猜。

**派单前核对模型与强度。** 传错名字当场拒绝，并列出可用值。加这一层是因为实测踩到：`sol` 这类短名在 ChatGPT 账号下 `thread/start` 照样成功，到执行阶段才报 `The 'sol' model is not supported when using Codex with a ChatGPT account`，白等十几秒还占一次会话。回执里的 `diagnosis.hint` 现在也会区分这种情况，直接告诉调用方去查 `status`、用完整 id。

**只读模式修好联网。** 沙箱策略从 `{ type: 'readOnly' }` 改为 `{ type: 'readOnly', networkAccess: true }`。此前只读（含 2.x 的计划模式）被当成离线，联网搜索、查官方文档、核对外部接口全不可用，只读能力被砍掉一半。只读只管「不许改文件」，不该管联网。实测：只读 + high 强度的审查任务里 Codex 正常调用了 4 次 `webSearch` 并给出带来源链接的结论。

**回执带上 `model` / `effort` / `read_only`。** 用户指定了参数，就该在结果里看到实际用的是哪一个，不用另开一轮确认。

**简介改成说明能力而不是说明机制。** 中文：在 WorkBuddy 中调用本机 Codex 执行任务，可以指定模型和思考强度，任务中途意外中断可接续。

## 3.0.0 — 2026-11-16

**改名为 codex-dispatch（显示名：Codex 派单）。** 只支持 Codex 了，名字里带出来，不再用 gcwork 这个中性的旧名。环境变量前缀 `GCWORK_*` → `CODEX_DISPATCH_*`，数据目录 `~/.gcwork` → `~/.codex-dispatch`。

**加了目录写锁。** 同一目录同时只允许一个写任务，第二个直接拒绝并说明谁占着。用 `openSync(path, 'wx')` 这一个原子操作实现，没有 flock、没有轮询、没有等锁队列。锁放在系统临时目录，因为只有那里是所有进程、所有配置都能看见的位置。


**重做。去掉专家层和异步状态机，只留一个直派通道。**

2.x 的不稳定集中在同一个地方：为了让派单「看起来可控」，在 Codex 之上又造了一套任务管理系统——状态机、判活、孤儿回收、事件落盘、双执行器适配、模型路由、角色画像、独立验收。这些机制本身成了故障源。2.2.0 期间修的三个 bug 全部出在这套东西上：

- `turnStatus` 停在 `running` 而状态记着 `failed`，调用方反复查询空转
- `finalize` 去读 `stdout.log`，但 app-server 传输从不写这个文件，导致失败时诊断为空
- 失败时用半截进度覆盖真实错误

这一版把这些问题从根上去掉：不再自己维护任务状态，直接用 Codex 自己的 thread 机制。

### 结构变化

| 2.2.0 | 3.0.0 |
| --- | --- |
| 专家提示词 3 KB | 删除，引导写进工具 description |
| 7 个工具 | 2 个（dispatch / continue） |
| codex + claude 双适配器 | 只留 codex |
| 8 个模型名 + 3 种角色 + 自动路由 | 删除，模型与强度直接透传 |
| 台账、孤儿回收、会话日志 | 删除（写锁按最轻方式加回，见上） |
| 独立验收模块 | 删除，改动证据由 git 对比给出 |
| 6 个源码模块 1640 行 | 6 个源码模块 1421 行 |

### 派单模式：同步 + 可续

调用一次拿到结果。超过软时限时返回 `pending` 和 `task_ref`，调用方带同一个 `task_ref` 调 `continue` 接着等。

不做轮询的理由有两条。一是轮询要维护状态机，出错面大；二是每次查询都是一轮完整对话，历史越长越贵，而轮询拿到的信息量远小于它的成本。

续跑靠 Codex 自己的 `thread/resume`，不在外面记录执行状态。

### 实测确认的四件事

这四条都影响实现，不能只按文档写：

1. **`thread/resume` 能恢复会话历史与上下文，但不能复活已被杀掉的执行进程。** 进程死了 turn 变成 `interrupted`，续做必须开新 turn。所以续做前要告诉 Codex 已经改了哪些文件，否则它会从头再来一遍。
2. **`turn/diff/updated` 在 codex-cli 0.166.0 上不发。** 协议里有，实测跑了多次一次没收到。改动证据改为自己用 git 算。
3. **同一 thread 只允许一个 writer。** 旧连接没断开就 resume 会报 `already has an active writer`。服务内部先关连接再恢复；两个窗口同时派同一目录会明确报这个错。
4. **宿主给 MCP 工具的超时是 1 小时**（宿主代码里 `MCP_TOOL_TIMEOUT` 默认 `36e5`），且 `resetTimeoutOnProgress` 为真。软超时默认 10 分钟，留 60 秒余量，确保不被硬杀以致连 `task_ref` 都拿不到。

### 改动识别

只认工作区实际状态，不认 Codex 自述：

- 任务开始记 `HEAD`、以及工作区已有未提交改动的内容指纹
- 结束对比，未跟踪文件单独列，删除的文件单独列
- 任务前就脏、这次指纹没变的文件，从本次产出里剔除，并说明原因
- 非 git 目录退回文件快照对比，且明确声明没有行数统计与回滚保障

### 数据目录

`~/.codex-dispatch`，与 2.x 的 `~/.workbuddy/gcwork` 分开。两版记录格式不同，混在一起会被当成损坏文件。

## 2.2.0 — 2026-11-16

**修好 MCP 连接（三个叠加的配置错误），codex 执行通道换成官方 app-server。**

### MCP 一直连不上的真正原因（三个叠加）

1. **声明了 `dependencies.mcpServers`**。声明后平台把自带 MCP 当成「需要用户手动连接的外部依赖」，弹引导卡片并一直 pending，永远不会自动启动。官方文档写明：不声明时才会自动读包根 `.mcp.json`。这是主因，已删除该字段。
2. **`command` 里放了 `${CODEBUDDY_PLUGIN_ROOT}`**。宿主对 `command` 不做任何变量替换，`${...}` 原样传给 spawn，路径不存在，进程起不来——报 `Connection closed`、connectMs 只有个位数毫秒。
3. **多写了 `cwd`**。cwd 指向不存在的路径时 Windows 上 spawn 报 `ENOENT`，看起来像 node.exe 缺失，把排查方向带偏很久。已删除。

正确写法（依据宿主实现，不是照文档抄的）：

```json
{"mcpServers":{"gcwork-engine":{"command":"node","args":["./mcp/gcwork-engine/server.mjs"]}}}
```

宿主 `resolveStdioRuntimeCommand()` 特判裸名 `node` / `node.exe`，换成本机自带的 Node 绝对路径；`resolveExpertMcpLaunchConfig()` 只处理 `args`，把以 `./` 开头的元素按插件根解析成绝对路径；`command` 字段不做任何替换。所以 `command` 只写裸名，插件内路径放 `args` 的 `./` 形式，两边都不写绝对路径。

### 为什么换 app-server

`codex exec` 每单起新进程，启动 2–5 秒且无进度。`codex app-server` 是官方常驻 JSON-RPC 服务，`thread/start` → `turn/start`，受理毫秒级，过程有通知流。

实测（codex-cli 0.166.0）：initialize 1.0s / thread/start 2.7s（仅首次）/ turn/start 受理 0.01–0.04s。

### 会话日志去重

同一单派单写一行、收尾写一行，3 单会被算成 6 单。改为按 job_id 去重。