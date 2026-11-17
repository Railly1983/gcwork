# codex-dispatch / Codex 派单

在 WorkBuddy 中调用本机 Codex 执行任务，可以指定模型和思考强度，任务中途意外中断可接续。

三个工具：派单、续跑、查状态。专家层只有一个不到 2KB 的引导文件，不写业务逻辑，所有能力在 MCP 里。

## 它解决什么

Codex CLI 一次任务常要跑几分钟到二十分钟。直接在终端或普通工具调用里跑，会被各种单次调用时限打断，中断后上下文全丢。

这个连接器跑在宿主常驻的 MCP 进程里，把 Codex 自己的会话机制用起来：任务在 Codex 那边有独立的 thread，中途断了可以接着那个 thread 继续，不用从头再来。

## 安装

前置：本机装好 Codex 并登录。

```
npm i -g @openai/codex
codex login
```

然后在连接器里启用 `Codex 派单`。启用后能调到 `dispatch` 就说明通了。

## 用法

模型会自动调用，你也可以直接说：

> 用 Codex 把 src 里那几个 TODO 清掉，改完跑一遍测试。

要指定模型和强度：

> 用 Codex 只读审查这个项目，模型用 gpt-6.1-sol，思考强度 high。

不确定有哪些模型可选：

> 查一下 Codex 连接状态，现在能用哪些模型，各自支持哪些思考强度。

模型清单和强度档位由账号与套餐决定，会变。派单前不确定就调 `status` 查，不要猜 —— 传了不存在的模型名，`thread/start` 照样成功，到执行阶段才报错，白等十几秒还占一次会话。

### dispatch

```
prompt   任务描述全文，要自足 —— Codex 看不到你的对话
cwd      工作目录绝对路径
task_ref 任务标识，续跑时复用，不传自动生成
model    模型 id（如 gpt-6.1-sol），不传用 Codex 默认
effort   思考强度：low / medium / high / xhigh / max / ultra
         各模型支持的档位不同，不传用模型默认档
read_only 只读模式：不改文件，仍可联网，默认 false
timeout_sec 软超时，默认 600 秒
```

模型短名（如 `sol`）在 ChatGPT 账号下不被接受，必须用完整 id。派单前会先核对一次，名字不对直接拒绝并列出可用值，不会白跑一轮。

返回：

```
status        completed / pending / failed / interrupted
model         本次实际使用的模型（回执里带上，便于确认参数生效）
effort        本次使用的思考强度
read_only     是否只读
summary       回答开头一段，够判断有没有跑偏
changes       files / paths / untracked / deleted / preexisting
line_stats    additions / deletions（非 git 目录只统计新增文件，并注明）
artifacts     diff、全文、日志的路径
diagnosis     失败时才有，写明阶段、错误、失败前改了哪些文件
```

### status

不留参数，直接查：

```
status        ready / not_ready / codex_not_found
codex         found / version / entry
account       logged_in / type / email / plan
models        id / name / default / default_effort / efforts
capabilities  web_search / image_generation
```

不建会话、不改文件、不占目录锁、不花额度，几秒返回。一分钟内重复查走缓存。

### continue

```
task_ref   dispatch 返回的那个
prompt     续做时的补充要求，可选
```

四种情况自动分辨，你不需要判断：

| 情况 | 行为 |
| --- | --- |
| 任务还在跑 | 接着等，不新起一轮 |
| 任务其实已完成 | 直接取回结果，不重复执行 |
| 任务中断或失败 | 在同一 Codex 会话里接着做 |
| 宿主重启过 | 从磁盘记录恢复原会话 |

## 几个设计取舍

**同步而不是轮询。** 轮询要保存状态机、判活、回收孤儿任务，代码多一倍，出错面也大。而且每次查询都是一轮完整对话，历史越长越贵。同步一次调用拿到结果，只在超软时限时转成 `pending`，让调用方接着问。

**改动以 git 为准。** Codex 说「改好了」不算数。任务开始记 `HEAD` 和文件指纹，结束时对比，报出真实改动。工作区原本就有的未提交修改不会被算成这次任务的产出。

**结果分层。** 成功只给开头八百字和改动清单，全文留在磁盘上按需读。失败相反，给足诊断 —— 那时候省 token 没有意义。

**软超时短于宿主硬超时。** 宿主给 MCP 工具的超时默认一小时，软超时到点主动返回 `pending`，不会被硬杀导致连 `task_ref` 都拿不到。

**模型名不猜，先查。** 模型清单和强度档位跟着账号与套餐走，写死在提示里必然过期。`status` 直接问 Codex 要清单。派单时还会核对一次：名字或档位不对当场拒绝，把可用值列出来。实测 `sol` 这类短名在 ChatGPT 账号下 `thread/start` 能过、执行阶段才报 `model is not supported`，不前置校验就是白跑十几秒。

**只读不等于离线。** 只读模式的沙箱策略是 `readOnly` + `networkAccess: true`。不给联网，只读任务查报错、看官方文档、核对外部接口全废，能力砍掉一半。只读只管住「不许改文件」这一件事。

## 已知边界

**会话恢复不等于进程恢复。** Codex 的 `thread/resume` 能恢复会话历史和上下文，但不能复活一个已经被杀掉的执行进程。所以中断后是「在原会话基础上再发一轮接着做」，不是「原地继续跑」。这决定了续做时必须告诉 Codex 已经改了哪些文件，否则它会从头再做一遍 —— 代码里这一层是 `buildHandoff`。

**`turn/diff/updated` 不可靠。** 官方协议里有这个事件，但 codex-cli 0.166.0 实测一次都没发过。所以改动证据完全靠 git 自己算，不依赖这个事件。

**同一个 thread 只能有一个 writer。** 旧连接没断开就去 resume 会报 `already has an active writer`。服务内部会先关连接再恢复；如果你同时开了两个 WorkBuddy 窗口对同一目录派单，第二个会明确报这个错。

**同一目录同时只跑一个写任务。** 两个任务同时改同一批文件会互相覆盖，而且两边都报成功，看不出问题。所以派单前会按工作目录加锁，第二个任务直接拒绝并说明谁占着、跑了多久。只读任务不占锁。要真并行，用独立目录或 git worktree。

**非 git 目录能力受限。** 没有 git 就没有行数统计，也没有回滚保障，只能按文件修改时间和大小判断有没有被改过。返回里会明确写出来。

**只读模式没有回滚保障。** 只读靠沙箱拦，不是靠事后检查。沙箱策略拦的是写文件，命令本身照样能跑；Codex 若通过沙箱外的路径写入，只读管不到。要严格隔离就别在重要目录上派只读任务。

**app-server 是官方标注给开发调试用的。** 接口可能变。所有 JSON-RPC 通信都收在 `appserver.mjs` 一个文件里，协议变了只改那一处。

## 结构

```
mcp/codex-dispatch/
  server.mjs       MCP 协议层，三个工具的定义
  dispatch.mjs     派单编排、续跑判断、结果整理
  appserver.mjs    codex app-server 的 JSON-RPC 连接
  entry.mjs        找 codex 入口
  git.mjs          基线快照与改动识别
  lock.mjs         目录写锁
  status.mjs       连接状态、账号、模型与强度档位查询
```

任务记录在 `~/.codex-dispatch/tasks/`，产物在 `~/.codex-dispatch/runs/`。可用 `CODEX_DISPATCH_HOME` 改位置。

锁不在这里：它在系统临时目录（`%TEMP%/codex-dispatch-locks`）。锁必须让所有进程都看见，放进配置目录会因为换了 `CODEX_DISPATCH_HOME` 就互相看不见，等于没有锁。

## 测试

```
node --test tests/*.test.mjs
```

36 项，覆盖基线记录、改动识别（含未跟踪与删除文件、任务前脏文件排除）、软超时转 pending、幂等、失败诊断、中断处理、目录写锁（含跨进程竞争）。

`tests/fixtures/fake-codex.mjs` 是一个可编程的假 app-server，用来注入各种故障，不需要真跑 Codex。