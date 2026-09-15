# mini

一个构建在持久化 `AgentHarness` 之上的最小 coding agent，拆分为三个进程，通过一个 socket
与一个管道以 JSON 通信。它的存在是为了从真实客户端演练 harness，并弄清一个 RPC 形态的
presentation 实际上需要从它那里获得什么。

```bash
node packages/coding-agent/src/experimental/mini/main.ts [--continue]

# while the harness is changing under us, run from source instead of built dist:
./node_modules/.bin/tsx --tsconfig tsconfig.json packages/coding-agent/src/experimental/mini/main.ts
```

`--continue` 会附加到当前目录最新的 Session。启动两次 `mini` 会将
两个 presentation 附加到同一个 Session；两者都会实时看到相同的 transcript。

## 拓扑

```text
tui        tui        tui          presentation：渲染，无 agent 状态
  \         |         /
   \        |        /             unix socket，~/.pi/agent/experimental/mini.sock
    \       |       /
        server                     路由调用，扇出事件，生成 worker
       /        \
      /          \                 子进程 stdio 管道
  worker       worker              每个 Session 一个：harness、storage、模型 runtime
```

一个 presentation 持有一个连接，并通过它访问每个 service。服务器自己应答
`sessions`，并将其他任何内容转发给该连接所附加的 worker，因此 TUI
永远不会知道哪个主机应答什么。同一条规则反向也成立：worker 调用 `sessions.list`
时，由服务器来应答。

第一个启动的 `mini` 会以分离方式生成服务器。当某个 worker 的最后一个
presentation 断开时，服务器会终止该 worker；并在最后一个 presentation 离开十秒后自行退场，因此
下一次启动总是运行当前代码。如果该 worker 持有一个打开的持久化 Operation，其替代者
会自动从最后记录的恢复状态恢复该 Operation。

## 布局

| 路径 | 角色 |
| --- | --- |
| `main.ts` | `mini` 命令 |
| `shared/transport.ts` | `Connection`：在任何双工对上使用换行分隔的 JSON |
| `shared/rpc.ts` | frame、命名 service、路由、存活检测、取消 |
| `shared/protocol.ts` | service token、契约、wire 类型 |
| `server/run.ts` | 路由、worker 监督、事件扇出 |
| `worker/run.ts` | 打开 Session，构建 harness，提供 service |
| `worker/lane-service.ts` | `Lane`：watch 订阅与 lane 命令 |
| `worker/models-service.ts` | `Models`：目录、账户、交互式登录 |
| `tui/run.ts` | presentation 宿主：确保服务器、附加、运行视图 |
| `tui/session.ts` | 附加、订阅、持有复制后的 Snapshot |
| `tui/view.ts` | alt-screen 渲染，复用交互模式组件 |

## RPC

两个动词。**Call** 提出问题并得到一个答案；**emit** 发布给任何监听者。在每个连接上
双向可用。

```ts
const peer = createPeer(connection, { forward });   // forward handles names this peer lacks
peer.provide(Lane, laneService);                    // register and announce
const lane = peer.use(Lane);                        // Remote<LaneServiceApi>
await lane.prompt("hi");                            // -> { kind: "call", id, method: "lane.prompt" }
peer.on(Lane, (event) => fold(event));              // typed by the token
```

wire 有六个 frame 种类：`call`、`result`、`error`、`cancel`、`event`、`announce`、`ping`。
回复通过 `id` 关联并解析一个 promise；事件携带 service 名称而没有 id，因此两者
绝不互相干扰 — 一个五分钟的 `lane.prompt` 会保持挂起，而它的事件流从旁流过。

Service 是在 token 下注册的普通对象，而 token 携带名称以及 call 与
event 类型，因此 `provide` 检查实现，`use` 检查调用方。名称在注册时被宣告，
因此路由就是一次查找，无法路由的调用会失败并列出双方的清单。

失败处理：关闭的连接会拒绝每个挂起的调用，并中止每个进行中的处理器；
对等方每五秒 ping 一次，并在十五秒后宣告一条沉默的线路死亡，这能捕获一个卡住
且永不关闭的进程；调用方可以传入 `signal`（发送 `cancel`）或 `timeoutMs`。超时
按调用点选择启用，因为一个 agent 轮次没有有界的持续时间。

## 状态复制

worker 持有每个活跃对象。一个 presentation 持有一个 `LaneSnapshot`，别无其他。

每个 presentation 在 worker 中获得**它自己的** `lane.watch()`，处于 harness 的两个阶段：
`watch()` 捕获一个 Snapshot，同时 harness 缓冲该订阅的事件，而 `start()`
将它们排空。由于 harness 将 Snapshot 与流配对且没有间隙、没有重复，客户端
不需要自己的缓冲或排序逻辑 — 它使用 harness 自己的
`reduceLaneSnapshot` 来应用事件。当 fold 应答 `{ rebase: true }`（一次完成的导航会如此）时，
presentation 会获取一个新订阅并丢弃旧的。首次附加与 rebase 是同一个
函数。

渲染是该 Snapshot 的纯函数。Transcript 条目以 id 为键并被追加，因此一个
流式传输的 token 只会付出一次 markdown 重建的代价，而不是重绘；视图仅当
条目 id 前缀发生分歧时才整体重绘，而 Compaction 与导航正是这样做的。

## 它不是什么

没有斜杠命令系统、extension、skill、Hook、除共享 theme 之外的 theme、Session 选择器或
tree 导航。交互式登录与模型选择之所以存在，是因为它们证明了协议中那些别扭的
方向：服务器到客户端的请求，以及基于身份的配置。

两个已知的捷径：服务器将某个 worker 的事件广播给每个已附加的 presentation，因此当有
N 个 presentation 时，每个事件会跨越 N² 次，且每个客户端会丢弃不属于自己的副本；
以及取消交互式登录只会在提示处中断，因为该 worker 的登录尚无
中止路径。
