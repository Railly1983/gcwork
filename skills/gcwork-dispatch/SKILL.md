---
name: gcwork-dispatch
description: "派单手册：把一份简报交给本机 Codex / Claude Code CLI，按档位选模型与思考强度，拿回结构化结果。含命令、四档表、权限矩阵、结果卡字段、错误码与产物清单。"
---

# 吉克搬砖 · 派单手册 2.0.1

## 一条命令

```bash
GCROOT=$(ls -d "$HOME"/.workbuddy/plugins/marketplaces/my-experts/plugins/gcwork 2>/dev/null \
  || ls -d "$HOME"/.workbuddy/plugins/marketplaces/*/plugins/gcwork 2>/dev/null | head -1)
node "$GCROOT/skills/gcwork-dispatch/scripts/dispatch.mjs" \
  --tier <档位> --brief <简报路径> --cwd <工作目录>
```

体检（不烧额度）：

```bash
node "$GCROOT/skills/gcwork-dispatch/scripts/dispatch.mjs" --check
```

## 四档与权限

| 档位 | Codex | Claude | 强度 | 职责 | Codex 沙箱 | Claude 权限 |
|---|---|---|---|---|---|---|
| `plan` | `astra` | `fable` | high | 架构 / 方案 / 规划 | `read-only` | `plan` |
| `hard` | `sol` | `opus` | high | 疑难 / 复杂改造 / 审核 | `workspace-write` | `dontAsk` |
| `main` | `terra` | `sonnet` | medium | 日常开发，主力 | `workspace-write` | `dontAsk` |
| `chore` | `luna` | `haiku` | medium | 小改动 / 检查 / 测试 | `workspace-write` | `dontAsk` |

`plan` 档是**程序级只读**，不是提示词约定：Codex 用 `-s read-only`，Claude 用 `--permission-mode plan`。它写不了项目文件，方案只出现在 `message.md` 里，落盘由吉克做。

## 三种用法

```bash
# 1. 按档位（默认 Codex 侧）
--tier plan

# 2. 点名模型（默认强度取其所在档位）
--model sonnet

# 3. 点名模型 + 覆盖强度
--model sonnet --effort low
```

- `--tier` 与 `--model` **互斥**，同传直接 `BAD_ARGS`
- `--effort` 取 `low / medium / high / xhigh / max`
- `--model` 是精确指定：**永不替换模型**；模型家族不存在时返回 `MODEL_UNAVAILABLE` 并列出可选项
- `--tier` 是意图指定：遇 `NOT_FOUND` / `AUTH` / `QUOTA` / `MODEL_UNAVAILABLE` 会**换到同档 Claude 侧重试一次**，`fallback` 字段写明换了谁
- `--env inherit|clean`：默认 `inherit`。`clean` 会清掉 `ANTHROPIC_*` / `OPENAI_*` / `CODEX_*` 认证变量，强制走 CLI 自身登录
- `--force`：只有确认并发锁是死锁时才用

## ⚠️ 调 Bash 必须传 timeout: 590000

宿主 Bash 工具默认 **120 秒**杀进程，硬上限 600 秒。脚本内部上限 **540 秒**，外层留 50 秒收尾。

**每次跑 dispatch 都必须带 `timeout: 590000`。** 不传，超过两分钟的任务一律死在半路，钱照花、活没干完。

三层关系：内部 540s < 外层 590s < 宿主硬上限 600s。脚本触发超时会先杀整棵进程树，再留 8 秒交卷。

## 结果卡

stdout 只输出一张卡，完整结果在 `runDir/result.json`。

```json
{
  "runId": "20261114-234210-ec0977a0",
  "ok": true,
  "code": null,
  "tier": "main",
  "model": "terra",
  "resolvedModel": "gpt-6.1-terra",
  "modelSource": "cache",
  "effort": "medium",
  "readOnly": false,
  "changedCount": 2,
  "changedStats": { "added": 1, "modified": 1, "deleted": 0 },
  "hasMessage": true,
  "partial": false,
  "fallback": null,
  "warning": null,
  "billingWarning": null,
  "gitWarning": null,
  "runDir": "C:\\Users\\<用户>\\.workbuddy\\gcwork\\runs\\20261114-234210-ec0977a0",
  "messagePath": "...\\message.md",
  "artifacts": ["brief.md", "result.json", "message.md", "raw.log", "last.md", "changed.txt"]
}
```

| 字段 | 含义 |
|---|---|
| `ok` | 干完没有（退出码 0 / 1） |
| `code` | 失败原因，成功为 `null` |
| `tier` / `model` / `resolvedModel` | 哪档、点名谁、实际解析成什么 |
| `modelSource` | `cache` 从 `~/.codex/models_cache*.json` 解析；`alias` Claude 侧；`fallback` 读不到缓存、用写死名字（附 `warning`） |
| `readOnly` | 是否只读档 |
| `changedCount` / `changedStats` | 改动文件数；新增 / 修改 / 删除 |
| `hasMessage` | CLI 是否产出了正文 |
| `partial` | **仅当超时被杀但拿到了部分正文**时为 `true` |
| `fallback` | tier 模式降级时才有，形如 `{"from":"luna","to":"haiku","reason":"QUOTA"}` |
| `billingWarning` | 计费通道异常，**必须转告用户** |
| `gitWarning` | 非 git 仓库 / 执行期间 HEAD 变动 |
| `artifacts` | 本次产物清单 |

## 产物

`runDir` 下（`~/.workbuddy/gcwork/runs/<runId>/`）：

| 文件 | 何时有 | 内容 |
|---|---|---|
| `brief.md` | 总是 | 本次简报原文 |
| `result.json` | 总是 | 完整结果，含 `usage`、最多 40 条 `changedFiles`、权限参数 |
| `message.md` | 总是 | **CLI 的正文结果**，只看前 20 行 |
| `raw.log` | 总是 | stdout + stderr，超 8 MB 截断。**排障用，不要读进上下文** |
| `last.md` | Codex 侧 | Codex 的 last message 原始文件 |
| `changed.txt` | 有改动时 | 全量改动文件列表（超过 40 条才需要看） |

`runs/` 保留 14 天，之后每次派单自动清理。

## 错误码

| code | 触发 | 处置 |
|---|---|---|
| `BAD_ARGS` | 参数错、互斥冲突、简报不存在、档位/模型/强度未知 | 自己修 |
| `NOT_FOUND` | 找不到 codex / claude 入口 | 让用户跑 `--check`；tier 模式自动换边 |
| `MODEL_UNAVAILABLE` | 指定家族在该侧模型目录里不存在 | 不换模，把 `available` 给用户选 |
| `TIMEOUT` | 超过 9 分钟，已杀进程树 | **不重试**，拆小范围重发 |
| `QUOTA` | 额度用尽 | **不重试同一侧**；tier 模式已换边，两侧都尽就报恢复时间 |
| `AUTH` | 登录失效 | 让用户重新登录，不要自己试 |
| `BUSY` | 同目录已有写入任务 | 等它结束；确认死锁后 `--force` |
| `FAILED` | 其它 | 读 `message.md` 前 20 行，判断是简报问题还是环境问题 |

## 简报模板

写到 `<cwd>/.gcwork/brief-<里程碑>.md`：

```markdown
## 目标
一句话说清这一单要交付什么。

## 现状
必要背景。文件路径、函数名、报错原文。不要贴整份文件。

## 本轮范围
只做这几件事。边界越具体越好。

## 验收标准
怎么算完成。可验证的判据。

## 验证要求
需要跑哪些测试或检查。

## 禁止
不能动的东西、不能装的包、不要做的操作。
```

**不要**在简报里写模型名或思考强度——那是命令行参数的事。

## 规划与执行分离

规划单：`--tier plan`。只读，方案落在 `message.md`，吉克另存到 `<cwd>/.gcwork/plans/plan-M<n>.md`。

执行单：`--tier main`（或 `hard`），简报里只写：

```
规划方案在 <cwd>/.gcwork/plans/plan-M<n>.md，你先读它，再按它执行。
```

**不要粘贴方案全文。** 让 CLI 自己读文件，既准确又不占上下文。

## 并发

同一目录的可写任务由 `.lock` 互斥（`~/.workbuddy/gcwork/locks/`），撞上返回 `BUSY`。只读的 `plan` 档不抢锁，可以和写入任务并行。

## 环境

- `CODEX_HOME` 被设置了就用它，否则 `~/.codex`
- 模型按家族后缀匹配（`-astra` / `-sol` / `-terra` / `-luna`），同家族多版本取版本号最高的，不按文件时间、不按 priority 乱挑
- 非 git 目录才会给 Codex 加 `--skip-git-repo-check`，并在 `gitWarning` 里提示没有回滚保障
- 脚本零 npm 依赖，Node 18+ 可跑
