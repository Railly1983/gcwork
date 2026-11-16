# gcwork 交接文档

> 这份文档是 2026-11-15 23:49 ~ 11-16 08:45 会话的压缩结果。
> 读它 + 读代码，可以完全接手项目，不需要任何对话历史。
> 最后更新：2.2.0 / commit `f504d96`

## 一句话是什么

把本机 Codex 与 Claude Code 接进 WorkBuddy 的专家包。薄专家（提示词）+ MCP 引擎（零依赖 Node），自然语言派单，引擎负责路由、验收、续跑。

## 当前状态

| 项 | 值 |
|---|---|
| 版本 | 2.2.0（未发版） |
| 本地 commit | `f504d96`（**未推送、未发布、未提审**） |
| 单测 | 49/49 |
| selfcheck | 28/28 |
| 包 | `release/gcwork-2.2.0/gcwork-2.2.0.zip` |
| 开发目录 | `D:/workbuddy/2026-11-14-01-25-04/_repo_gcwork` |
| 安装目录 | `~/.workbuddy/plugins/marketplaces/my-experts/plugins/gcwork` |
| 缓存目录 | `~/.workbuddy/plugins/cache/my-experts/gcwork/2.2.0` |
| 台账 | `~/.workbuddy/gcwork/ledger/` |
| 任务产物 | `~/.workbuddy/gcwork/runs/<job_id>/` |

## 架构（两层）

```
agents/gcwork.md          薄专家：人设 + 自检 + 派单 + 汇报。不含契约
.codebuddy-plugin/plugin.json  专家清单
.mcp.json                 插件自带 MCP（自动加载）
bin/run-node(.cmd)        解析宿主 Node 并启动 MCP
mcp/gcwork-engine/
  server.mjs              MCP stdio 服务端（逐行 JSON-RPC）
  cli.mjs                 命令行入口（排查/测试用，不进分发包）
  src/dispatch.mjs        派发编排、状态机、契约输出
  src/models.mjs          模型解析、角色画像、入口探测、health
  src/schema.mjs          工具 inputSchema（9 个参数）
  src/verify.mjs          独立验收（git 改动 / 敏感文件 / 测试）
  src/engine/appserver.mjs  codex app-server 客户端
  src/engine/worker.mjs    单任务执行器（codex 走 app-server，claude 走子进程）
  src/engine/locks.mjs     同目录写锁
  src/engine/ledger.mjs    台账（原子写）
  src/engine/git.mjs       git 快照与差异
  src/engine/run.mjs       pid 存活、超时标记
  src/adapters/            argv 构造与结果解析
```

## 关键技术决策（都有原因，别改回去）

### 1. MCP 走插件自带，不写 dependencies

`plugin.json` **绝不能**声明 `dependencies.mcpServers`。声明后平台会把自带 MCP 当成「需用户手动连接的外部依赖」，弹引导卡并永久 pending。

正确做法：只放包根 `.mcp.json`，不声明 dependencies，平台会自动加载。

### 2. `command` 必须指向 `bin/run-node`

不能写裸 `node`：WorkBuddy 不把自带 Node 放 PATH，而是通过 `WORKBUDDY_EXTRA_PATHS`（分号分隔）导出目录。`bin/run-node.cmd` 按这个变量找 node.exe，再退回 PATH。

**`run-node.cmd` 必须全 ASCII**——Windows 按系统 ANSI 码页解析批处理，中文注释会变成垃圾命令。

**`bin/run-node` 必须 LF 行尾**，否则 macOS/Linux 报 `bad interpreter: ^M`。已用 `.gitattributes` 锁死。

### 3. 不要写 `cwd`

`cwd` 指向不存在的路径时，Windows spawn 报的是 `ENOENT`，看起来像 node.exe 缺失，极容易误判。

### 4. 宿主不展开 `${CODEBUDDY_PLUGIN_ROOT}`（本机现状）

插件 MCP 被落地到用户 `~/.workbuddy/mcp.json` 时变量原样保留，导致路径不存在。**本机 workaround**：把安装目录和 cache 目录的 `.mcp.json` 改成绝对路径（仓库里保留变量版，供分发）。

同步脚本必须带 `/XF .mcp.json`，否则会覆盖掉绝对路径版。

### 5. 任务跑在常驻 MCP 进程内

不受宿主轮次上限和 Bash 调用超时（最长 10 分钟）影响。**这是长任务能跑完的唯一可靠办法**。

不要试图用 detached worker：Windows 沙箱的 Job Object 会在父进程退出时杀掉整棵进程树，`detached` / `cmd start /B` / `Start-Process` 全部验证失败。

### 6. 默认放开可写沙箱

只读会砍掉模型一半能力，不该是常态。只有两种进只读：
- 显式 `sandbox: "read-only"`
- `role: "planner"`（计划模式）

### 7. 沙箱语义按官方来

- `readOnly` → 网络被拦（`networkAccess` 传了也没用）
- `workspaceWrite` + `networkAccess: true` → shell 能联网
- **`web_search` 是独立工具**，默认 cached 模式走 OpenAI 索引，**不受沙箱网络限制**

### 8. 判活靠心跳，绝不按 pid 杀进程

任务跑在常驻 MCP 里，`job.pid` 就是服务自身 pid，杀了等于把引擎和所有并行任务一起干掉。`pid` 只用于判断「执行进程是否已结束」。

### 9. 写锁三线索判活

`stale = !((running && (alive || fresh)) || undead)`

- `alive`：锁文件 pid 或 job pid 活着
- `fresh`：心跳在阈值内（180s）
- `undead`：`lockHeld=true` 且进程还活着——**必须独立于 running 判断**，否则「超时但仍在写」的任务锁会被下一单抢走

### 10. 单任务收尾不关共享 app-server

连接是进程级共享的，关掉会打断同进程其他任务。交给进程退出处理。

## 已解决的 22 个问题（按类别）

### 状态机与判定
1. 失败被判 ok（Claude `is_error`、Codex `turn.failed` 带部分回答）
2. `turn/completed` 不看 `turn.status`，failed/interrupted 被当成功
3. 完成但无文字被判 crashed（只改文件不总结是正常行为）
4. 台账缺 `startedAt` 的记录永远挂 running
5. `{...null}` 写出 `undefined.json` 垃圾记录

### 锁与并发
6. dispatch 内另有一份锁实现，忽略 `workerPid`，运行中的写任务被抢锁
7. `lockHeld` 死条件：要求 `running` 才生效，但只在终态写入
8. 派单到首次心跳的窗口内锁被判死（job 没写 pid）
9. 锁 hash 全平台 `toLowerCase`，POSIX 上 `/Foo` 与 `/foo` 共用一把锁

### 超时与进程
10. 超时查询 `killJob(job.pid)` 杀掉整个 MCP 服务
11. worker 的 crash handler `process.exit(1)` 杀掉常驻服务
12. 异常钩子跨任务污染（不摘除，finish 别人的任务并释放别人的锁）
13. `spawnSync` 阻塞事件循环（verify 跑测试、git 快照、health），心跳停摆导致别的任务被判死

### 连接与生命周期
14. 单任务收尾 `shutdownAppServer` 打断其他任务
15. 旧连接事件污染新连接（缺 `thisConn` 校验）
16. 反向审批请求不可达（带 id 的 method 被当响应吃掉）
17. env clean 复用已有连接时失效（`envMode` 未参与复用判断）

### 契约与参数
18. schema 声明 12 个参数，6 个没人读
19. `env: "clean"` 空承诺（`childEnv` 有实现但无人调用，spec 也没带 env）
20. resume 只建记录不执行（MCP 和 CLI 两个入口都没调 `runJob`）

### 跨平台（Windows 特有）
21. `spawnSync('npm')` 直接 `ENOENT`（npm 是 `.cmd`，Node 18.20+ 禁止无 shell 启动批处理）→ 改走 `node npm-cli.js`
22. `run-node.cmd` 中文注释变垃圾命令；`bin/run-node` 被 git 转 CRLF

## 已删除的东西（别加回来）

- `codex exec` 通道（派单慢、无进度）
- `adapters/codex.mjs` 的 `buildArgv`（执行不再拼命令行）
- `run.mjs` 的 `spawnDetached` / `waitTerminal` / `monitor`（不再跨进程）
- `dependencies.mcpServers`（会弹引导卡）
- 自设的全局并发上限 4 单（交给宿主调度）
- CLI 的 `--async` / `--blocking`
- 测试 fixtures `fake_codex_degrade/fail/resume`（e2e 已删）

## 已知遗留

1. **codex 服务端故障**：`workspace routing discovery failed`，11-16 08:35 时仍不可用。这是 codex 侧问题，非本项目。
2. **错误分类不全**：`workspace routing failed` 被判成 `failed` 而不是明确类型，`switchRequiresConsent` 不触发。
3. **换模型需同意**只覆盖 `quota_exhausted`，「执行器不可用」也该覆盖。
4. **`.mcp.json` 绝对路径是本机 workaround**，根治要平台修变量展开，或插件走正式安装流程。
5. 测试没覆盖 MCP 并发路径（现有用例主要是单元级）。

## 常用命令

```bash
CLI="$HOME/.workbuddy/plugins/marketplaces/my-experts/plugins/gcwork/mcp/gcwork-engine/cli.mjs"

node "$CLI" health                    # 环境自检（ready/blockers）
node "$CLI" dispatch --workdir <dir> --prompt "<任务>" \
  --executor codex --model sol --effort high --role reviewer --sandbox read-only
node "$CLI" status --ref <job_id|task_id>
node "$CLI" verify --ref <ref>
node "$CLI" resume --task <task_id>
node "$CLI" list --limit 20

# 测试与验收
cd mcp/gcwork-engine && node --test tests/engine.test.mjs
node release/gcwork-2.2.0/07-selfcheck.mjs

# 同步到安装目录（必须排除 .mcp.json）
robocopy ... /MIR /XD .git /XF .mcp.json
```

## 发版流程

1. 单测 + selfcheck 全绿
2. 子代理独立审查通过（结论必须是「可以发版」）
3. `git archive` 打包，剔除 tests 和 .gitignore
4. 校验包内：含 `bin/run-node`、`cli.mjs`、`server.mjs`；不含 `server.mjs` 以外的 MCP 配置残留
5. **老大点头后**才推送 / 发 Release / 提审

## 教训

1. **遇到平台功能不工作，先找官方内置插件的实现照抄**。我推断"变量不替换"错了三轮，最后发现是 `dependencies` 声明导致的引导卡。
2. **别自己造降级方案**。exec→app-server 换完就该删 exec，留着是负担。
3. **审计员每轮都会发现新问题**，且常常是上一轮修复引入的。修完要再验。
4. **上下文成本要靠压缩，不能靠截断**。截断丢信息，回退丢历史。正确做法是提炼成文档（就是这份）。
