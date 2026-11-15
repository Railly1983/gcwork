# 吉克搬砖（花名吉克）

Codex/Claude协作专家。不写业务代码——判断任务难度、写简报、派单、验收、汇报。

## 架构（2.2.0：两层）

- **薄专家层** `agents/gcwork.md`：只有人设、前置条件、怎么用工具、汇报格式。不含契约、路由、CLI 适配逻辑。
- **MCP 引擎** `mcp/gcwork-engine/`：零依赖 Node stdio MCP server，统一派发、路由、产物解析、验收、续跑。所有判断逻辑都在这里。
- **执行通道**：Codex 走常驻 `app-server`（`thread/start` → `turn/start`，受理毫秒级、进度实时），起不来自动降级 `codex exec`；Claude 走 `claude -p`。

两层之间靠 **MCP 工具的 input/output schema 即契约**，模型调前可读，不需要把契约写进文档。

## 能力介绍

把本机安装好的 Codex 和 Claude Code 接入 WorkBuddy。自然语言对话即可调用，引擎统一路由到合适的 CLI、验收产物、失败后续跑。

- 支持 Astra / Sol / Terra / Luna / Fable / Opus / Sonnet / Haiku 8 个模型，low / medium / high / xhigh / max 五档思考强度。
- 三个角色画像：`planner`（只读规划）/ `implementer`（执行）/ `reviewer`（审查）。不确定就传 `executor:"auto"` 让引擎路由。

## 怎么用

直接自然语言说需求即可，专家会调引擎工具：

- **派单**：`dispatch`（必填 `task_id` / `prompt` / `workdir`；可带 `executor` / `role` / `sandbox` / `timeout_sec`）。
- **查状态**：`status`（按 `job_id` 或 `task_id` 查，进程结束自动收尾）。
- **续跑**：`resume`（同 `task_id` 半自动续跑，引擎接过上一轮改动与剩余指令开新 job）。
- **验收**：`verify`（只看 git 改动范围、敏感文件、测试结果，不采信 CLI 自报完成）。
- **自检**：`health`（两侧是否安装并登录、各角色模型解析、计费风险）。

派单用 **detached 进程**跑，宿主轮次上限（9 分钟）杀不到它——不用自己掐表，也不用为它拆单。

## 前提

本机已安装并登录：

- **Codex CLI**（`codex`），用于 astra / sol / terra / luna
- **Claude Code**（`claude`），用于 fable / opus / sonnet / haiku

不确定就先让专家调 `health` 自查。装好后也可在引擎目录直接跑：

```bash
cd mcp/gcwork-engine
node server.mjs        # 作为 MCP server 启动（stdio）
```

## 安装

从 [Releases](https://github.com/Railly1983/gcwork/releases) 下载 `gcwork-2.2.0.zip`，解压放到本地市场：

```
~/.workbuddy/plugins/marketplaces/my-experts/plugins/gcwork/
```

放好后重开一个会话，在「专家 → 我的专家」里就能看到「吉克搬砖」。平台会自动拉起 `dependencies.mcpServers` 里的 gcwork-engine。

## 成本

每次启动外部 CLI 都有初始化上下文开销，实际消耗以 CLI 返回的 `usage` 为准。

省钱的三个杠杆，按效果排序：

1. **降强度** —— `high` 改 `medium` 或 `low`
2. **换便宜模型** —— 杂活用 `chore` 档，别拿 astra 改错别字
3. **少派单** —— 能一次干完的，别拆两次；失败用 `resume` 续跑，不要整单重发

## 结构

```
.codebuddy-plugin/plugin.json      专家清单（agent 型）+ dependencies.mcpServers
agents/gcwork.md                   薄专家：人设、前置、工具用法、汇报格式
mcp/gcwork-engine/
  server.mjs                       MCP stdio server（零依赖）
  src/
    models.mjs                     路由/选目标/模型解析/CLI 入口探测/参数存在性探测/健康自检
    dispatch.mjs                   派发编排：dispatch/status/resume/契约输出/写锁/并发
    verify.mjs                     独立验收（git 范围 + 敏感文件 + 测试）
    schema.mjs                     MCP 工具声明（即契约）
    adapters/codex.mjs              Codex CLI 适配（参数探测降级 + 结果解析）
    adapters/claude.mjs             Claude CLI 适配
    engine/git.mjs                  git 快照与变更计算
    engine/ledger.mjs               任务台账持久化
    engine/run.mjs                  detached 子进程 + pid 轮询 + 超时杀树
    engine/errors.mjs               错误分类 + quota 恢复时间解析
tests/engine.test.mjs              57 项单元 + e2e 测试（node --test，不烧额度）
avatars/expert.png                 专家头像
LICENSE / CHANGELOG.md
```

派发产物落在 `~/.workbuddy/gcwork/runs/<jobId>/`，台账在 `~/.workbuddy/gcwork/ledger/`，保留 14 天。可用 `GCWORK_HOME` 覆盖根目录（测试隔离用）。

跑测试：

```bash
cd mcp/gcwork-engine && node --test tests/engine.test.mjs
```

## 已知限制

- **宿主 9 分钟轮次上限已绕过**。派单走 detached 进程，宿主杀不到；`status` / `resume` 会主动回收结束的进程并收尾。
- **不做长会话续接**。每单都是新会话（Codex `--ephemeral`、Claude `--no-session-persistence`）；续跑靠 `resume` 把上一轮改动清单 + 剩余指令接上。
- **改动检测靠 git**。工作目录不是 git 仓库时 `changedFiles` 为 `null`，且会在 `gitWarning` 里提示没有回滚保障。
- **模型名按家族动态解析**。家族不存在报 `MODEL_UNAVAILABLE`，不挑别的模型顶上；读不到 `models_cache` 才用写死名字并给 `warning`。
- **两个 CLI 是独立额度池**。Codex 四个模型共用一份账号额度，Claude 侧独立；`quota_exhausted` 时结果带 `resumeAfter`。
- **继承宿主环境变量**。若 `ANTHROPIC_API_KEY` 等被设置，CLI 可能走 API 计费而非订阅额度，此时 `billingWarning` 提示；想强制走 CLI 自身登录，派单传 `env:"clean"`。
- **并发**：全局上限 4 单，同一目录同时仅一个可写任务（写锁）；只读任务可并行。git worktree 隔离为后续增强。
- **CLI 参数存在性探测**：引擎启动时会解析 `CLI --help`，缺哪个参数就省哪个，抗 CLI 版本变更。

## 许可与变更

MIT，见 `LICENSE`。版本变更见 `CHANGELOG.md`。
