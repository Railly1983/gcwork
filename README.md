# codex-dispatch / Codex 派单

把任务交给本机已登录的 Codex 执行，同步等结果。

一个连接器，两个工具。没有专家层，没有技能，没有独立的任务调度系统。

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

### dispatch

```
prompt   任务描述全文，要自足 —— Codex 看不到你的对话
cwd      工作目录绝对路径
task_ref 任务标识，续跑时复用，不传自动生成
model    模型名，不传用 Codex 默认
effort   推理强度，不传用模型默认
read_only 只读模式，默认 false
timeout_sec 软超时，默认 600 秒
```

返回：

```
status        completed / pending / failed / interrupted
summary       回答开头一段，够判断有没有跑偏
changes       files / paths / untracked / deleted / preexisting
line_stats    additions / deletions（非 git 目录只统计新增文件，并注明）
artifacts     diff、全文、日志的路径
diagnosis     失败时才有，写明阶段、错误、失败前改了哪些文件
```

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

## 已知边界

**会话恢复不等于进程恢复。** Codex 的 `thread/resume` 能恢复会话历史和上下文，但不能复活一个已经被杀掉的执行进程。所以中断后是「在原会话基础上再发一轮接着做」，不是「原地继续跑」。这决定了续做时必须告诉 Codex 已经改了哪些文件，否则它会从头再做一遍 —— 代码里这一层是 `buildHandoff`。

**`turn/diff/updated` 不可靠。** 官方协议里有这个事件，但 codex-cli 0.166.0 实测一次都没发过。所以改动证据完全靠 git 自己算，不依赖这个事件。

**同一个 thread 只能有一个 writer。** 旧连接没断开就去 resume 会报 `already has an active writer`。服务内部会先关连接再恢复；如果你同时开了两个 WorkBuddy 窗口对同一目录派单，第二个会明确报这个错。

**同一目录同时只跑一个写任务。** 两个任务同时改同一批文件会互相覆盖，而且两边都报成功，看不出问题。所以派单前会按工作目录加锁，第二个任务直接拒绝并说明谁占着、跑了多久。只读任务不占锁。要真并行，用独立目录或 git worktree。

**非 git 目录能力受限。** 没有 git 就没有行数统计，也没有回滚保障，只能按文件修改时间和大小判断有没有被改过。返回里会明确写出来。

**app-server 是官方标注给开发调试用的。** 接口可能变。所有 JSON-RPC 通信都收在 `appserver.mjs` 一个文件里，协议变了只改那一处。

## 结构

```
mcp/codex-dispatch/
  server.mjs       MCP 协议层，两个工具的定义
  dispatch.mjs     派单编排、续跑判断、结果整理
  appserver.mjs    codex app-server 的 JSON-RPC 连接
  entry.mjs        找 codex 入口
  git.mjs          基线快照与改动识别
  lock.mjs         目录写锁
```

任务记录在 `~/.codex-dispatch/tasks/`，产物在 `~/.codex-dispatch/runs/`。可用 `CODEX_DISPATCH_HOME` 改位置。

锁不在这里：它在系统临时目录（`%TEMP%/codex-dispatch-locks`）。锁必须让所有进程都看见，放进配置目录会因为换了 `CODEX_DISPATCH_HOME` 就互相看不见，等于没有锁。

## 测试

```
node --test tests/*.test.mjs
```

36 项，覆盖基线记录、改动识别（含未跟踪与删除文件、任务前脏文件排除）、软超时转 pending、幂等、失败诊断、中断处理、目录写锁（含跨进程竞争）。

`tests/fixtures/fake-codex.mjs` 是一个可编程的假 app-server，用来注入各种故障，不需要真跑 Codex。