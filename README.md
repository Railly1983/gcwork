# 吉克搬砖（花名吉克）

Codex/Claude协作专家。不写业务代码——判断任务难度、选模型、写简报、发单、验收。

## 能力介绍

把本机安装好的 Codex 和 Claude Code 接入 WorkBuddy。预设规划、攻坚、主力、杂活四档调度规则，自然语言对话即可调用。C老师和克老师一起助你。

## 擅长领域

Codex 和 Claude 官方接口调度。支持 Astra / Sol / Terra / Luna / Fable / Opus / Sonnet / Haiku 8 个模型调用，low / medium / high / xhigh / max 五档思考强度可选。

## 四档

| 档位 | Codex | Claude | 强度 | 职责 | 权限 |
|---|---|---|---|---|---|
| `plan` | `astra` | `fable` | high | 架构、技术方案、复杂规划 | **只读** |
| `hard` | `sol` | `opus` | high | 疑难 Bug、复杂改造、关键审核 | 可写 |
| `main` | `terra` | `sonnet` | medium | 日常开发，默认主力 | 可写 |
| `chore` | `luna` | `haiku` | medium | 小改动、检查、测试 | 可写 |

档位默认走 Codex 侧。要用 Claude 侧直接点名模型。

`plan` 是程序级只读：Codex 用 `-s read-only`，Claude 用 `--permission-mode plan`，它改不了你的文件。

## 怎么用

**让它自己判断：**

> 这个 bug 卡我半天了，你看着办。

**点名模型和强度：**

> 用 astra high 把架构方案想清楚，先别动代码。我确认之后，再让 Sonnet 用 low 强度去执行。

**只要最便宜的：**

> 这活不复杂，让最便宜的档去干。

## 典型流程：先规划，后执行

```
第一单  --tier plan        astra 出方案 → 吉克存到 .gcwork/plans/plan-M1.md
第二单  --tier main        sonnet 读方案后执行
```

执行单不搬运方案全文，只给路径——CLI 自己在工作目录里能读。这样吉克的上下文不会被几万字的方案撑爆。

## 前提

本机已安装并登录：

- **Codex CLI**（`codex`），用于 astra / sol / terra / luna
- **Claude Code**（`claude`），用于 fable / opus / sonnet / haiku

装好后自查（PowerShell 或 Git Bash 都行）：

```powershell
# PowerShell
codex --version
codex login status
claude --version
claude auth status
```

```bash
# Git Bash
GCROOT=$(ls -d "$HOME"/.workbuddy/plugins/marketplaces/my-experts/plugins/gcwork 2>/dev/null | head -1)
node "$GCROOT/skills/gcwork-dispatch/scripts/dispatch.mjs" --check
```

`--check` 会给出：程序是否装上、是否真的登录、当前认证方式、八个模型各自解析成什么、有没有会改变计费路径的环境变量。

**常见问题**：`claude` 或 `codex` 命令找不到，说明装了但不在 PATH。Windows 下 npm 全局装的通常在 `%APPDATA%\npm\`，本地安装的在 `%LOCALAPPDATA%\Programs\`。脚本自己会去这几个位置找，`--check` 显示 `installed: false` 才需要处理。

## 成本

每次启动外部 CLI 都有初始化上下文开销，实际消耗以 CLI 返回的 `usage` 为准，跟任务大小关系不大。

省钱的三个杠杆，按效果排序：

1. **降强度** —— `high` 改 `medium` 或 `low`
2. **换便宜模型** —— `chore` 档干杂活，别拿 astra 改错别字
3. **少派单** —— 能一次干完的，别拆两次

## 结构

```
.codebuddy-plugin/plugin.json   专家清单（agent 型）
agents/gcwork.md                专家本体：四档、派单流程、验收、错误码
skills/gcwork-dispatch/
  SKILL.md                      派单手册
  scripts/dispatch.mjs          派单脚本（零依赖、无状态、可单测）
tests/dispatch.test.mjs         43 项单元测试（node --test，不烧额度）
avatars/expert.png              专家头像
LICENSE / CHANGELOG.md
```

派单产物落在 `~/.workbuddy/gcwork/runs/<runId>/`，保留 14 天。

跑测试：

```bash
node --test tests/dispatch.test.mjs
```

## 已知限制

- **单次派单硬上限 9 分钟**（脚本 540s，宿主须传 590s）。这是宿主工具的天花板，不是可调参数。超时会杀进程树，不自动重试。
- **不做会话续接**。每单都是新会话（Codex `--ephemeral`、Claude `--no-session-persistence`），靠 `.gcwork/handoff.md` 传递上下文。
- **改动检测靠 git**。工作目录不是 git 仓库时 `changedCount` 为 `null`，且会在 `gitWarning` 里提示没有回滚保障。
- **模型名按家族动态解析**。家族不存在时报 `MODEL_UNAVAILABLE`，不会挑个别的模型顶上；读不到 `models_cache` 时才用写死名字并给 `warning`。
- **两个 CLI 是独立额度池**。Codex 四个模型共用一份账号额度，Claude 侧独立。
- **继承宿主环境变量**。若 `ANTHROPIC_API_KEY` 等被设置，CLI 可能走 API 计费而不是订阅额度，此时 `billingWarning` 会提示；想强制走 CLI 自身登录，加 `--env clean`。

## 许可与变更

MIT，见 `LICENSE`。版本变更见 `CHANGELOG.md`。
