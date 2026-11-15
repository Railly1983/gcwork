# 修订记录

## 2.2.0 — 2026-11-16

**修好 MCP 连接（三个叠加的配置错误），codex 执行通道换成官方 app-server。**

### MCP 一直连不上的真正原因（三个叠加）

1. **声明了 `dependencies.mcpServers`**。声明后平台把自带 MCP 当成「需要用户手动连接的外部依赖」，弹引导卡片并一直 pending，永远不会自动启动。官方文档写明：不声明时才会自动读包根 `.mcp.json`。这是主因，已删除该字段。
2. **`command` 写成裸 `node`**。WorkBuddy 不把自带 Node 放到 PATH，而是通过 `WORKBUDDY_EXTRA_PATHS` 导出所在目录，裸 `node` 找不到。改为官方内置插件的做法：`command: "${CODEBUDDY_PLUGIN_ROOT}/bin/run-node"`。
3. **多写了 `cwd`**。cwd 指向不存在的路径时 Windows 上 spawn 报 `ENOENT`，看起来像 node.exe 缺失，把排查方向带偏很久。已删除。

`bin/run-node` 在 POSIX 上从 `WORKBUDDY_EXTRA_PATHS`（冒号分隔）找 `node`，Windows 的 `run-node.cmd` 用分号分隔找 `node.exe`，再退回 PATH，都没有才报 127。脚本必须全 ASCII——Windows 命令行按系统 ANSI 码页解析批处理，中文注释会变成垃圾命令；`bin/run-node` 必须 LF 行尾，否则 macOS/Linux 报 `bad interpreter`，用 `.gitattributes` 锁死。

### 超时问题

MCP 进程由宿主常驻，任务跑在进程内，因此不受 Bash 工具单次调用超时（最长 10 分钟）的限制。这是长任务能跑完的可靠办法。

### 为什么换 app-server

`codex exec` 每单起新进程，启动 2–5 秒且无进度。`codex app-server` 是官方常驻 JSON-RPC 服务，`thread/start` → `turn/start`，受理毫秒级，过程有通知流。

实测（codex-cli 0.166.0）：

| 环节 | 改造前 | 改造后 |
|---|---:|---:|
| 派单返回 | 5–10 秒 | 0.34 秒 |
| turn 受理 | — | 6–40ms |
| 进度 | 无 | `progress.recent` 实时可查 |
| 中断 | 杀进程树 | `turn/interrupt` |

### 变化

- 新增 `bin/run-node` 与 `bin/run-node.cmd`：解析宿主 Node 并启动 MCP。
- 新增 `src/engine/appserver.mjs`：常驻连接、thread/turn、通知流、断线检测。
- 新增 `src/engine/worker.mjs`：`runJob()` 跑完一单。
- 新增 `src/engine/locks.mjs`：写锁独立，两处共用。
- 恢复 `server.mjs`：MCP stdio，任务在常驻进程内后台跑。
- 删除 `exec` 通道，只留 app-server；claude 无 app-server，走一次性子进程。
- schema 参数从 12 个减到 9 个，删掉 `risk_level`、`task_type`、`file_count`、`need_write`、`transport`、`output_mode`、`blocking`——要么没人读，要么在 MCP 下无意义。

### 修复

- Claude 可写任务权限模式用错：`dontAsk` 的语义是「不弹窗、只放行已预授权的工具」，不等于允许写工作区。改为 `acceptEdits`；只读仍是 `plan`。
- Windows 上 npm 起不来：`spawnSync('npm')` 实测 `ENOENT`（npm 是批处理脚本，Node 18.20+ 禁止无 shell 启动批处理）。改为定位 `npm-cli.js` 用 node 启动；找不到就跳过测试标 needsHuman，不判失败。
- 两个适配器重复的 `launcher` 合并为 `launcherFor`，Windows 下批处理脚本走 `cmd /c`。
- 台账进度落盘加 500ms 节流（逐 token 写盘会把派单拖慢数秒）。

### 测试

单测 51 项、selfcheck 20 项全绿。

## 2.1.1 — 2026-11-15

修复外部审计发现的 5 个问题，其中 4 个会直接导致误判或权限越界。

### 修复

- **MCP 协议不兼容（连接失败根因）**：server 原先只认 `Content-Length` 帧，而 MCP 标准 stdio 是逐行 JSON。标准客户端发 initialize 得不到响应，握手必然失败。改为输出逐行 JSON、输入兼容两种格式。
- **验收不看任务状态**：`verify` 原先只要 HEAD 未动、测试通过就判通过，`failed` / `timeout` / `running` 的任务也能被验收。改为先判 `job.status`，非 `ok` 一律拒绝。
- **只读角色可被显式模型绕过**：`pickTarget` 在显式指定 `model` 时忽略 `role` 的只读默认，`reviewer + sol` 会拿到可写沙箱。改为只读角色的默认优先，显式 `sandbox` 才可覆盖。
- **异步任务超时不生效**：`timeout_sec` 原只对 `blocking` 生效。改为非阻塞任务也起后台监控，并在 `status` 查询时做惰性超时判定。
- **写锁可被超时抢占**：存活任务的锁超过 15 分钟会被第二单抢走。改为以台账里 job 是否仍 `running` 且子进程存活为准，时间不再是唯一依据。

### 测试

- 单测从 34 项增至 40 项，每个修复各有一条回归用例；新增标准 MCP 客户端（逐行 JSON）握手用例。

## 2.1.0 — 2026-11-15

**架构精简：三层（专家 + Skill + MCP）改为两层（薄专家 + MCP 引擎），删除独立的派单 Skill。**

### 结构变化

- **薄专家** `agents/gcwork.md`：只留人设、前置条件、工具用法、汇报格式。原先的契约、路由、CLI 适配、错误码表全部下放到引擎，**专家文档不再重复这些逻辑**。
- **MCP 引擎** `mcp/gcwork-engine/`：零依赖 Node stdio MCP server（JSON-RPC 2.0 over Content-Length 帧化）。
  - 工具：`dispatch` / `status` / `resume` / `verify` / `health` / `list_jobs`。**契约即工具的 input/output schema**，模型调前可读。
  - `models.mjs`：确定性 `route()`（review/只读→codex；refactor/implement 且文件>3→claude；fix/generate_tests→codex；high 风险→claude；显式 executor 不替换）+ `pickTarget()` + 严格模型解析 + CLI 入口探测 + **参数存在性探测（解析 `CLI --help`，缺参降级）** + 健康自检。
  - `adapters/codex.mjs` / `adapters/claude.mjs`：构造 argv（参数探测降级）+ 结果解析。
  - `engine/run.mjs`：**detached 子进程 + pid 轮询**，长任务脱离宿主/Agent 轮次上限独立跑完。
  - `engine/ledger.mjs`：任务台账持久化（可 `GCWORK_HOME` 覆盖，测试隔离）。
  - `verify.mjs`：独立验收（git 改动范围 + 敏感文件标记 + 跑测试，无 test 脚本则降级为 needsHuman，不硬判失败）。
- **删除** `skills/gcwork-dispatch/`（契约/路由/adapter 已整体迁入引擎）。
- `plugin.json`：版本升 2.1.0；移除 `skills` 字段；新增 `dependencies.mcpServers.gcwork-engine`（stdio，`node mcp/gcwork-engine/server.mjs`），由平台自动拉起。

### 关键能力

- **抗 9 分钟宿主超时**：派单走 detached 进程，宿主轮次上限杀不到；`status` / `resume` 主动回收结束的进程并收尾。这是本轮要解决的核心痛点（长任务被宿主杀、白烧额度）。
- **半自动续跑**：任何失败先返 `partialOutput` + `changedFiles`；同 `task_id` 调 `resume` 即可开新 job 续跑，引擎把上一轮改动清单 + 剩余指令接上。`quota_exhausted` 在结果里带 `resumeAfter`，原样转告用户，等额度恢复再 `resume`，不静默无限重试。
- **统一契约**：输出强制含 `status` / `artifacts` / `claims`（空，验收只看 artifacts）/ `partialOutput`（失败必非空）/ `changedFiles` / `resumeAfter`，消费方无需再读引擎内部。

### 测试

- 新增 `tests/engine.test.mjs`，34 项：路由、`pickTarget`、适配器参数探测降级、结果解析、错误分类、git 差集、台账、校验、**3 个 e2e（codex 成功 / codex 失败 / 半自动续跑）+ claude 成功**，以及 MCP server 帧化收发集成验证。全部不烧额度（用 fake CLI）。

### 已知限制 / 后续

- 并发：全局上限 4 单，同目录仅一个可写（写锁）；只读任务可并行。**git worktree 隔离为后续增强**（本版靠写锁保证不冲突）。
- 平台是否真自动安装 `dependencies.mcpServers` 依赖待实装机验证；若未自动拉起，需在连接器入口手动信任。

## 2.0.2 — 2026-11-15

只改对外展示文案与引导问题，**不改功能、不改参数、不改权限**。

- 市场说明改为「将 Codex 与 Claude 接入 WorkBuddy，自然对话即可调用，模型与思考强度可指定。」
- 三条引导问题重写，按普通用户说话方式，不套档位名（不再出现「攻坚档」「杂活档」）：
  1. 先摸底：两侧是否可用、各有哪些模型与思考强度、预设规则怎么配的。
  2. 点名模型与强度：用 `sol` + `high` 干一件真活，跑完测试。
  3. 交给专家自己拆：方案评估 + 任务拆解两个子任务，分派给合适的模型。
- `defaultInitPrompt` 与第一条引导问题保持一致（平台规范要求）。

## 2.0.1 — 2026-11-14

按外部独立审查（5 个 P0 / 8 个 P1）整改，未改变总体架构与四档体系。

### 安全与权限

- **plan 档真只读**：Codex 走 `-s read-only`，Claude 走 `--permission-mode plan`。此前只靠提示词约束，程序上没有边界。规划结果改为只出现在 `message.md`，由吉克另存到 `.gcwork/plans/`。
- **计费路径可见**：`--check` 与结果卡新增 `billingWarning`，检测 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` / `OPENAI_API_KEY` 等会改变计费的环境变量。只检测、只汇报，不静默修改。新增 `--env clean` 主动切回 CLI 自身登录。
- **不再静默换模**：模型家族不存在时返回 `MODEL_UNAVAILABLE` 并列出可用模型，不再挑个 priority 最小的顶上。
- **同目录写锁**：可写任务按工作目录互斥，撞上返回 `BUSY`；只读的 `plan` 档不抢锁。死锁 15 分钟自动判过期，`--force` 可强抢。
- **git 保护**：只有确认非 git 仓库时才给 Codex 加 `--skip-git-repo-check`，并在 `gitWarning` 里提示没有回滚保障。

### 可靠性

- **超时分层**：内部 540s < 外层 590s < 宿主硬上限 600s。此前内外都是 540s，外层可能在脚本落盘前就把进程杀了。现在超时先杀整棵进程树，再留 8 秒交卷。
- **模型解析修正**：同家族多版本按版本号取最新。此前按 catalog 文件 mtime 取第一个命中，`terra` 会被解析成 `gpt-5.6-terra` 而不是 `gpt-6.1-terra`。
- **登录检测**：改用 CLI 原生命令与退出码。Codex 用 `codex login status`（修正 `/logged in/i` 会匹配 `Not logged in` 的漏洞），Claude 用 `claude auth status` 的 JSON（`loggedIn` / `authMethod`）。程序存在 ≠ 已登录，两件事分开报。
- **改动检测**：git 快照在 `status --porcelain` 之外补 `diff --numstat`，「改前已修改、改后又被改」不再漏报；新增 `changedStats`（新增 / 修改 / 删除），并能识别执行期间 HEAD 变动。
- **会话不落盘**：Codex 加 `--ephemeral`，与 Claude 的 `--no-session-persistence` 对齐，兑现「不做会话续接」的承诺。
- **日志控量**：stderr 上限 1 MB，`raw.log` 上限 8 MB 并截断保留头尾；`runs/` 保留 14 天自动清理。
- **stdin EPIPE**：子进程提前退出时不再抛未捕获异常。
- **runId**：改用 UUID 片段，降低并发撞号概率。

### 文档与文案

- 产品定位改为「Codex/Claude协作专家」，对外文案不出现「CLI」，强调接入的是本机已装已登录的两个助手。
- 统一规划文件路径为 `.gcwork/plans/plan-M<n>.md`（此前 agent / SKILL / README 三处不一致）。
- `--tier` 与 `--model` 同传改为参数阶段直接拒绝，不再「谁优先」。
- 不再宣传固定的 1.2 万 token 开销，改为以 CLI 返回的 `usage` 为准。
- 明知不需要规划的任务不再强制先规划；`hard` 档不再称「长时任务」。
- 补齐 `LICENSE`、`CHANGELOG`、Windows 安装与排障说明。
- 补 `author.email`（开放平台专家包必填项）。

### 体积

- 删除 `avatars/models/` 下 9 张不参与 UI 的历史头像（3.3 MB）。
- `expert.png` 由 455 KB 压到 88 KB（512×512，256 色自适应调色板）。
- 包体积 3.75 MB → 约 0.12 MB。

### 测试

- 新增 `tests/dispatch.test.mjs`，43 项断言覆盖参数解析、冲突拒绝、模型严格解析、权限参数、超时关系、git 差集、并发锁、结果卡。

## 2.0.0 — 2026-11-14

- 由 team 型（1 主理人 + 8 成员）改造为官方标准 agent 型单专家。
- 派单参数从 `--member` 改为 `--tier` / `--model` / `--effort`。
- 四档路由（plan / hard / main / chore）写进脚本，不再由主理人临场判断。
- `--tier` 支持跨侧自动降级；`--model` 精确指定不替换。
- 结果卡改为 17 字段，全量结果落 `result.json`。
- 定名「吉克搬砖」，花名「吉克」。

## 1.0.0 — 2026-11-13

- 首版：team 型专家团，1 主理人 + 8 成员，10 张头像。
