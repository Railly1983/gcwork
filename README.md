# 吉克搬砖（花名吉克）

Codex/Claude协作专家。不写业务代码——判断任务难度、写简报、派单、验收、汇报。

## 架构（2.2.0：两层）

- **薄专家层** `agents/gcwork.md`：只有人设、前置条件、怎么用工具、汇报格式。不含契约、路由、CLI 适配逻辑。
- **MCP 引擎** `mcp/gcwork-engine/`：零依赖 Node stdio MCP server，统一派发、路由、产物解析、验收、续跑。所有判断逻辑都在这里。
- **执行通道**：Codex 走常驻 `app-server`（`thread/start` → `turn/start`，受理毫秒级、进度实时）；Claude 走 `claude -p` 一次性子进程。

两层之间靠 **MCP 工具的 input/output schema 即契约**，模型调前可读，不需要把契约写进文档。

## 能力介绍

把本机安装好的 Codex 和 Claude Code 接入 WorkBuddy。自然语言对话即可调用，引擎统一路由到合适的 CLI、验收产物、失败后续跑。

- 支持 Astra / Sol / Terra / Luna / Fable / Opus / Sonnet / Haiku 8 个模型，low / medium / high / xhigh / max 五档思考强度。
- 三个角色画像：`planner`（只读规划）/ `implementer`（执行）/ `reviewer`（审查）。沙箱默认放开可写，只有 `planner` 或显式传 `sandbox:"read-only"` 才只读。

## 怎么用

直接自然语言说需求即可，专家会调引擎工具：

- **派单**：`dispatch`（必填 `task_id` / `prompt` / `workdir`；可带 `executor` / `role` / `sandbox` / `timeout_sec`）。
- **查状态**：`status`（按 `job_id` 或 `task_id` 查，进程结束自动收尾）。
- **续跑**：`resume`（同 `task_id` 半自动续跑，引擎接过上一轮改动与剩余指令开新 job）。
- **验收**：`verify`（只看 git 改动范围、敏感文件、测试结果，不采信 CLI 自报完成）。
- **自检**：`health`（两侧是否安装并登录、各角色模型解析、计费风险）。

派单跑在**宿主常驻的 MCP 进程**里，不受宿主轮次上限和 Bash 调用超时影响——不用自己掐表，也不用为它拆单。

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

放好后重开一个会话，在「专家 → 我的专家」里就能看到「吉克搬砖」。

## 连上 MCP（必须做一次）

专家本身只是提示词，真正干活的是 `gcwork-engine` 这个 MCP 服务。**没连上它，专家就没有任何工具可用**，只会变成一份说明书。

连接步骤：

1. 打开「连接器 → 自定义连接器」，找到 `gcwork-engine`
2. 右侧开关打开；若显示 `Connection closed` 或红点，点「重连」
3. 状态变成已连接、工具数正常后，回到对话召唤专家

排查要点：

- 状态一直连不上，点卡片上的「复制日志」看具体报错
- 包内 `.mcp.json` 用的是官方写法（`command: "node"` + `args: ["./mcp/gcwork-engine/server.mjs"]`），宿主会自己把 `node` 换成本机内置的 Node、把 `./` 解析成插件根的绝对路径。**不要改成绝对路径，也不要在 `command` 里写变量**——宿主只解析 `args` 里的 `./`，`command` 不做任何替换
- 报 `Connection closed` 且 connectMs 只有几毫秒：进程根本没起来，先确认解压后 `mcp/gcwork-engine/server.mjs` 在包里
- 本机直接验证服务能起：

  ```bash
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
    | node mcp/gcwork-engine/server.mjs
  ```

## 成本

每次启动外部 CLI 都有初始化上下文开销，实际消耗以 CLI 返回的 `usage` 为准。

省钱的三个杠杆，按效果排序：

1. **降强度** —— `high` 改 `medium` 或 `low`
2. **换便宜模型** —— 杂活用 `chore` 档，别拿 astra 改错别字
3. **少派单** —— 能一次干完的，别拆两次；失败用 `resume` 续跑，不要整单重发

## 结构

```
.codebuddy-plugin/plugin.json      专家清单（agent 型）；MCP 由包根 .mcp.json 自动加载
agents/gcwork.md                   薄专家：人设、前置、工具用法、汇报格式
mcp/gcwork-engine/
  server.mjs                       MCP stdio server（零依赖）
  src/
    models.mjs                     路由/选目标/模型解析/CLI 入口探测/参数存在性探测/健康自检
    dispatch.mjs                   派发编排：dispatch/status/resume/契约输出/写锁/并发
    verify.mjs                     独立验收（git 范围 + 敏感文件 + 测试）
    schema.mjs                     MCP 工具声明（即契约）
    adapters/codex.mjs              Codex CLI 适配（结果解析；执行走 app-server）
    adapters/claude.mjs             Claude CLI 适配
    engine/git.mjs                  git 快照与变更计算
    engine/ledger.mjs               任务台账持久化
    engine/run.mjs                  进程存活探测与超时标记
    engine/worker.mjs               单任务执行器（进度累积、收尾判定）
    engine/appserver.mjs            codex app-server 客户端（连接、通知流）
    engine/locks.mjs                同目录写锁
    engine/errors.mjs               错误分类 + quota 恢复时间解析
tests/engine.test.mjs              51 项单元测试（node --test，不烧额度）
avatars/expert.png                 专家头像
LICENSE / CHANGELOG.md
```

派发产物落在 `~/.workbuddy/gcwork/runs/<jobId>/`，台账在 `~/.workbuddy/gcwork/ledger/`，保留 14 天。可用 `GCWORK_HOME` 覆盖根目录（测试隔离用）。

跑测试：

```bash
cd mcp/gcwork-engine && node --test tests/engine.test.mjs
```

## 已知限制

- **宿主轮次上限已绕过**。任务跑在常驻 MCP 进程里，宿主结束轮次不影响它；`status` / `resume` 会主动回收并收尾。
- **不做长会话续接**。每单都是新会话（Codex `--ephemeral`、Claude `--no-session-persistence`）；续跑靠 `resume` 把上一轮改动清单 + 剩余指令接上。
- **改动检测靠 git**。工作目录不是 git 仓库时 `changedFiles` 为 `null`，且会在 `gitWarning` 里提示没有回滚保障。
- **模型名按家族动态解析**。家族不存在报 `MODEL_UNAVAILABLE`，不挑别的模型顶上；读不到 `models_cache` 才用写死名字并给 `warning`。
- **两个 CLI 是独立额度池**。Codex 四个模型共用一份账号额度，Claude 侧独立；`quota_exhausted` 时结果带 `resumeAfter`。
- **继承宿主环境变量**。若 `ANTHROPIC_API_KEY` 等被设置，CLI 可能走 API 计费而非订阅额度，此时 `billingWarning` 提示；想强制走 CLI 自身登录，派单传 `env:"clean"`。
- **并发**：不设全局上限，交给宿主与系统调度；同一目录同时仅一个可写任务（写锁）。
- **CLI 参数存在性探测**：引擎启动时会解析 `CLI --help`，缺哪个参数就省哪个，抗 CLI 版本变更。

## 许可与变更

MIT，见 `LICENSE`。版本变更见 `CHANGELOG.md`。
