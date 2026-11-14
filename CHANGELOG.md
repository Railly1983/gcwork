# 修订记录

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
