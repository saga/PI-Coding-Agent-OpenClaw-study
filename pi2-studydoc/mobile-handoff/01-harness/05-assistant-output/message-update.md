# `message_update` 写入放大

> **Scope：** harness-local。依赖 [delta tracking](../01-delta/delta.md) 以获得已落地的 Chord `Op`/`WireOp` 词汇表，并依赖 [scoped storage](../02-scopes/scopes.md) 以获得 durability。Chord delta tracking 已经落地；scoped storage 和这个 Harness 集成还没有。

## 1. 问题

```ts
{ type: "message_update", runId, message, event, frame? }
```

同一事物的三种表示一起传输：

- `message` —— 完整的 `AssistantMessage`；
- `event` —— 一个 `AssistantMessageEvent`，它自身携带 `partial: AssistantMessage`，
  即第二份完整副本；
- `frame` —— 实际的 delta，可选。

按每个 streamed token 计，这大致是两个完整 snapshot 加上一个 delta，因此字节数在一次响应过程中
呈二次增长。

reducer 甚至根本没有使用 delta：

```ts
case "message_update":
  if (next.operation?.id === event.runId && event.message.role === "assistant") {
    next.operation.streamingMessage = event.message;
  }
```

一次直接赋值。所以在任何 wire 上，发送 event 都*比*发送一个
snapshot 更糟 —— 它发送两个，而 `replace` 只发送一个。

wire adapter 已经走到了修复的半路：它丢弃 `event` 并发送 `message`
加上 `frame`。那就是完整 snapshot 连同产生它的 delta。

## 2. 紧凑形式已经存在

```ts
/**
 * Compact, replayable assistant-message progress. Terminal settlement is
 * intentionally excluded and must be persisted separately.
 */
export type AssistantMessageFrame =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start" | "text_delta" | "text_end"; contentIndex: number; ... }
  | { type: "thinking_start" | "thinking_delta" | "thinking_end"; ... }
  | { type: "toolcall_start" | "toolcall_checkpoint" | "toolcall_delta" | "toolcall_end"; ... };
```

`AssistantMessageFrameEncoder` 产生它，`reduceAssistantMessageFrames` fold 它，
而 `openFrameProgress` 已经用 `appendList` 持久化它。delta 格式已经
被构建、被使用，并且是持久的。它只是不是 `message_update` 所携带的东西。

## 3. 先例

pi 已经在下一层做到了 wire-is-delta。`PiMessagesEvent` —— pi-messages 后端发送的序列化形式 —— 没有 `partial`：

```ts
| { type: "text_delta"; contentIndex: number; delta: string }
| { type: "text_end"; contentIndex: number; content: string; contentSignature?: string }
```

然后 `pi-messages.ts` 重新水合：它持有一个本地的 `partial`，按 event mutation 它
（`partial.content[i].text += event.delta`），并返回进程内的
`AssistantMessageEvent`，附带 `partial`。

所以这个约定已经建立。它只是在 provider 边界处停下，而不是
继续穿过 harness。

## 4. 变更

```ts
| { type: "message_update"; runId: string; entryId: string; frame: AssistantMessageFrame }
```

`message` 和 `event` 被移除；`frame` 不再是可选的。

影响范围很小，因为 `HarnessEvent` 并不是大多数 streaming consumer 所
读取的东西。`AgentEvent`（`agent-loop.ts`）和 `AgentSessionEvent`（`agent-session.ts`）是
恰好共享该 tag 名称的独立 union，它们直接从 pi-ai event 构建自己的
`message_update`。它们不在本文档的范围内。

`HarnessEvent.message_update` 的真实 consumer 和 producer：

| site | change |
| --- | --- |
| `runtime/drive/response.ts` | 发出所需的语义 frame；停止附加完整 snapshots |
| `runtime/reducer.ts` | fold 该 frame，而不是赋值 `event.message` |
| lane/facet state adapter | 在 Chord tracker 之下运行该 fold 并发出 `Op[]`/encoded `WireOp[]` |
| `experimental/harness-wire-adapter.ts` | 停止把原始 `HarnessEvent` 当作最终复制格式 |
| `harness/telemetry.ts` | 仅名称列表 |
| `protocol/harness.ts` | 复制携带 encoded `WireOp[]`，而不是原始 event |

`message_end` 继续携带已 settle 的消息，因为 frames 刻意
排除 terminal settlement。那是每条消息一次，而不是每个 token 一次。

## 5. 需要一个增量 applier

`reduceAssistantMessageFrames` 是对一个 `Iterable` 的整-流 fold。reducer
需要一个 step function：

```ts
export function applyAssistantMessageFrame(
  state: AssistantFrameState,
  frame: AssistantMessageFrame,
): void;
```

在普通对象上进行 plain mutation。**没有 `Draft`，没有 Immer。** 早先的一个草稿
主张使用 draft-mutating 签名，以便它能在 `produce`
recipe 内部组合；那个动机已经消失（[delta.md §8](../01-delta/delta.md#8-what-this-removes-from-the-codebase)）。这个 step function 仍然
需要 —— 整-流版本会变成对它的循环 —— 只是为了一个更简单
的理由：reducer 一次 fold 一个 frame。

### 5.1 pi-ai frames 留在 pi-ai 边界；Chord ops 跨越复制边界

`AssistantMessageFrame` 是 pi-ai 的语义 delta 词汇表（`text_delta`、`text_end`、…）。[Delta tracking §6](../01-delta/delta.md#6-there-is-no-frame-type) 没有定义第二个 frame wrapper：进程内复制携带 `Op[]`，而 wire adapter 携带 encoded `WireOp[]`。Pi-ai frames 停在 fold 处；Chord ops 跨越复制边界。

`AssistantMessageFrame` 是 pi-ai 自己的 delta 词汇表，保持不变。改变的是
它不再是持久化单元或复制单元。

harness 通过 plain mutation 把 frames fold 进 `LaneView`。在 Chord tracker 之下，这会产生：

```json
["a",["operation","streamingMessage","content",0,"text"],"Let me "]
```

经测量，在这个 workload 上 interned ops **比 frames 更小** —— 对于 200 个 deltas，
是 13.6 KB 对 21.5 KB raw —— 因为一个 frame 自带三个 key，
而一个 interned op 只携带一个整数。所以把 frames 放上 wire 的尺寸论据已经
死了。

frames 保留的是语义：`text_end` 在一个原子单元中携带权威内容加上一个
signature，而 ops 会需要两个，并且对它们之间关系的契约更弱。这就是为什么它们仍然是*输入*词汇表，并且
在任何东西跨越边界之前就被 fold。

### 5.2 Reducer 状态必须存在于被 reduce 的值中

文本和 thinking 是纯 fold 的：`block.text += frame.delta`，而 `*_end` 用
权威内容加 signature 覆盖。`ReducerBlockState` 中的 `ended` 标志
只用于校验，可以去掉。

工具调用则不能。`toolcall_delta` 执行 `state.json += frame.delta`，累积
一个**从不存储在消息上的 raw JSON 字符串** —— block 持有
`arguments`，即解析后的值。你无法从 snapshot 恢复这个累积器，
也无法向一个已解析的对象追加 delta。

所以累积器必须成为被 fold 的值的一部分 —— 例如
`LaneView` 上的 `operation.frameState[contentIndex].json` —— 从而让
`AssistantMessage` 保持干净。一般地：

> **一个被复制的 reducer 的状态必须是该被复制值的一部分。** 任何
> 被存放在它旁边的状态，都会在任何没有运行 producer 的 fold 的 consumer 上发生分歧。

推论是 `arguments` 本身**不应**被 replicated。它是由 `json`
推导出来的，而一个已解析的对象在每次解析时都是一个新的引用，所以
同时存储两者会发送同一信息的两个副本。按需推导它。

这之所以安全，正是因为 `parseStreamingJson` 是 **total** 的 —— 四个 fallbacks，
最终落到 `{}`，它不可能抛出 —— 所以 replica 无条件地推导，没有
error 路径，也没有 agreement protocol。没有解析失败状态需要
表示，也没有 block 需要 error 槽位。

### 5.3 解析成本

对一个不断增长的字符串在每个 delta 上执行一次 `parseStreamingJson`，每条消息都是二次的。
由于 `arguments` 现在是推导出来的而不是 replicated，这个成本落在读取它的任何一方身上，而不是落在每个 consumer 身上。呈现层可以在语义 checkpoints 和 `toolcall_end` 处刷新 derived arguments，而不是在每个 delta 上解析；那个策略与 encoder 当前为什么发出一个 checkpoint 是分开的（§6）。

## 6. `toolcall_checkpoint` 是用来做什么的

`EncoderBlockState` 携带 `caughtUp` 和 `catchupJson`，因为一个排队的 provider event 的共享 `partial` 可能已经领先于该 event 的 delta。这个 checkpoint 把语义 frame 流追赶到 block 开始时可见的权威工具调用 arguments；它当前不是一个通用的 late-subscriber protocol。

在 frames fold 进 tracked 状态之后，一个 Chord 根替换（`r`）就是复制与持久化-恢复的重同步点。`toolcall_checkpoint` 仍然是该 fold 的语义输入，而不是承担传输责任。

## 7. 待处理输出的写入量

`openFrameProgress` 调用 `appendList(pendingAssistantFrames(...))`，所以每一个
frame 都是一行。一次长响应就是数千次写入。

**该地址被重命名为 `pendingAssistantOutput`**，并变成一个 `list<WireOp[]>`，与 `pendingToolOutput` 匹配（[tool-output handoff §7.2](../04-tool-output/harness-tools.md#72-renaming)），并且它不再是 frames 的列表。progress sink 用每个响应一个带状态的 encoder 编码 tracked `Op[]`，然后再追加每个持久化的 `WireOp[]` batch；显式的 `rebase()` 调用会产生用于恢复的、受上限约束的根替换 batches。该列表存在于一个 **ephemeral scope** 中，因此它在 settle 时被 unlink，而不是持久化在主日志中（[scoped storage](../02-scopes/scopes.md)）。

重要的性质是，这个列表**不是历史**：`deleteList` 在
`response.ts`、`deferred.ts` 和 `terminal.ts` 中于 settle 时运行。它的存在是为了让响应中途的崩溃
能够恢复一条部分的 assistant 消息。已 settle 的消息被单独
持久化。

这意味着 per-frame 的 durability 几乎买不到任何东西，而写入速率可以直接被
交换掉：

- **用一个有界的、不重置的窗口进行 coalesce。** 第一个待处理 frame 打开这个
  窗口；后续 frames 加入它而*不*延长截止时间，因此一个持续
  streaming 的响应无法无限期地推迟第一次写入 —— 这正是
  朴素 debounce 的失败模式。在一次活动写入期间被接纳的 frames 构成下一个 batch。
- **在 flush 时拼接。** 针对同一个 `contentIndex` 的一串 `text_delta` frames
  会折叠成一个带有拼接文本的单一 frame。fold 结果完全相同，所以
  对我们的目的而言这是无损的。

这样，一次崩溃至多丢失一个窗口的 in-flight streaming。

### 7.1 与 DeepSeek Harness 的对比

DSH 无法做这个交换。它的 `assistant/chunk` events 是规范日志条目，所以
per-token durability 是强制的，于是它转而攻击尺寸：

- 同样的有界、不重置的 write-behind 窗口；
- **packed rows** —— 连续的 chunk deltas 以
  `text-chunks` / `reasoning-chunks` / `tool-call-chunks` 存储，无损，并且在一次真实 session 上大约小 60%，
  读取是无条件的，因此 layout 从不依赖于
  写入开关；
- 默认使用带校验和的 zstd frames，并能从被截断的最终 frame 中恢复。

他们的 packing 必须重建精确的 event 边界、sequence numbers 和 timestamps，
因为 `seq = log.length`，而校验要求一个连续的逻辑日志。我们的不需要，
因为 frames 在 settle 时被丢弃 —— 所以普通的拼接对我们可用，
而不需要 packing 机制。

## 8. 对 ad-hoc listeners 的后果

`HarnessEvent.message_update` 不再是自描述的。一个在流中途附着的
listener 看到的是一个针对它并不持有的 partial 的 delta。

任何正确的 listener 都已经有 base，因为 `watch()` 安装订阅
并在一个 `readLane` 临界区内捕获 snapshot，缓冲直到
`start()`。但一个直接调用 `on("message_update")` 而不带 watch 的 listener
不再可行 —— 在 commit 之前值得知道这一点。
