# Assistant partial durability — 实现交接

本文档规定用于普通 assistant 生成和 deferred-response polling 的 durable partial assistant 消息。它建立在以下内容之上：

- 来自 `values.md` 的 bound typed value/list addresses；
- 来自 `@earendil-works/pi-ai` 的 `AssistantMessageFrame`、`AssistantMessageFrameEncoder` 和 `reduceAssistantMessageFrames()`；
- `harness.md` 中的 assistant intent/effect/settlement 状态机。

该设计持久化紧凑、可重放的 stream frames，而不使其成为 operation-state 权威，也不在每次更新时存储不断增长的完整 partial 消息。

## 目标

1. 在 process loss 之后重建最新已提交的 partial assistant 消息。
2. 保留 provider stream 顺序，而不产生重复的 full-snapshot 写放大。
3. 避免来自 storage commits 的 provider backpressure。
4. 复用 pi-ai 的规范 frame 转换与归约语义。
5. 保留当前公开 assistant 事件顺序。
6. 使 operation `effect_pending` 状态在 recovery 中保持权威。
7. 随正常或 synthetic response settlement 原子地删除所有 partial frames。

## 非目标

- 从 frames 推断 provider completion。
- 将 terminal `done`/`error` 事件与 response settlement 分开持久化。
- Exactly-once provider 请求。
- 公开 frame cursors 或 frame-persistence 事件。
- 通用 batching、timers、coalescing 或 flush APIs。
- 持久化 structural summary-generation streams。
- 持久化任意 provider SDK 事件或重复的 full `partial` snapshots。

## Storage

`session/values.ts` 中的内置 address 构造器：

```ts
export const pendingAssistantFrames = (
  operationId: string,
  responseEntryId: string,
) => list<AssistantMessageFrame>(
  "pi.pending.assistant_frame",
  `${operationId}:${responseEntryId}`,
);
```

该 procedure 为普通生成或 deferred poll 绑定一个精确 address：

```ts
const frames = pendingAssistantFrames(operationId, responseEntryId);
```

`responseEntryId` 已在 assistant/deferred `effect_pending` 状态中预留。operation state 中不存储任何 frame count、cursor 或 list identity，并且后续 list 操作只接收 `frames`——绝不会接收另一个 key。

每个 list 元素是一个 `AssistantMessageFrame`。storage transaction 的全局写入序列为 frames 排序。该 list 是辅助性的：

- 缺失是合法的；
- 它不证明 request admission、completion、success 或 failure；
- 它绝不选择 restart point；
- base restore 不读取它。

## Frame 契约

为每个 provider stream 创建一个 pi-ai encoder，并按顺序向它喂入每一个事件：

```ts
const encoder = new AssistantMessageFrameEncoder();
const frame = encoder.encode(event);
```

`partial` 是 provider 的共享 live response-so-far helper，而不是 event-time snapshot。encoder 为每个 open block 维护计数器，并裁剪掉已被 advance 的 block-start snapshot 所表示的 text/thinking delta 前缀。它只临时缓冲同步一个已 advance 的 tool call 所需的 raw JSON 前缀，然后发出一个 checkpoint 并恢复紧凑的 deltas。它绝不在每个事件上克隆不断增长的完整消息。

- `start` 产生一个空 content 的 metadata frame；
- 一个非 terminal 事件产生零个或一个 frame；
- 已被覆盖的 queued deltas 不产生 frame；
- terminal `done` 和 `error` 不产生 frame，因为 final response settlement 是分开的；
- `start` 之前的 setup `error` 是合法的，且不产生 frames；
- text/thinking/tool end frames 包含权威的已完成 block 值；
- 已完成的 tool-call arguments 仍不针对 tool schema 进行校验。

不要定义第二个 harness frame codec 或 reducer。持久化直接存储导出的 pi-ai 值；hydration 调用 `reduceAssistantMessageFrames()`。

Provider 事件 blocks 可能交错。编码与归约依赖 `contentIndex`，绝不依赖 block 连续性。Text 和普通 thinking blocks 在 `*_start` 发布时必须为空，然后只通过匹配的 deltas 追加直到 end；redacted thinking 可以在 start 时就是完整的，并且不发出 deltas。Streaming tool calls 以空 arguments 开始，并通过 deltas 发出其完整 raw JSON；如果 provider 以完整 arguments 开始，则它必须在后续 argument deltas 之前发出一个 cumulative delta 前缀，该前缀在某个事件边界处解析后等于该 snapshot。

## Fresh stream 调度

最简单的调度是刻意为之的：每个已转换的 frame 对应一个 list-append transaction，在 provider loop 中入队而不 await storage。

对于每个 `start` 或 update 事件：

```text
encode the event against the per-stream frame encoder
→ when a frame is returned, synchronously enqueue invocation-fenced appendList(frames, frame)
→ attach the ordinary harness-fault observer to the returned promise
→ replace process-local latestFrameWrite promise reference
→ emit and await the existing message_start/message_update event
→ consume the next provider event
```

`appendList()` 对每个返回的 frame 同步调用，因此所有 frame mutations 都按 provider-event 顺序进入 Session line。该 procedure 不 await 每次写入。每个 promise 都在最新引用替换其前驱之前被立即观察以传播 fault。已被覆盖的 queued events 不分配 durable frame 或写入。Encoder 状态与 open block 数量加上活跃 tool-call JSON stream 的未同步前缀成正比；它不保留第二份完整 assistant 消息。Model 输出限制将 queued frame bytes 限制为有界输出加上 frame/transaction 开销。

事件侧保留既有行为：`AssistantStreamObserver.start/update` 对每个事件 await `events.emit()`。不存在单独的 latest event-delivery promise，因为当 provider loop 推进时没有 assistant event delivery 仍处于未完成状态。

当 provider stream settle 时：

```text
stop frame admission
→ await latestFrameWrite when present
→ run after_response
→ emit message_end
→ classify and commit final response settlement
```

Session mutation line 是 FIFO 的，因此 `latestFrameWrite` 完成意味着每个更早的 append 都已完成。不存在 promise 数组、timer、batcher、active/waiting 状态、coalescer 或 public/internal flush 方法。

frame append 失败会在 `after_response` 开始之前使 harness fault。完整的 final response 保持 process-local，并且在 storage fault 之后不会提交。

## Normal settlement

每个使用了 frame list 的 assistant response settlement 都会在与不可变 response entry、usage、tip 和 next operation state 相同的 transaction 中删除那个精确 list：

```text
TX[
  insert response entry R,
  insert usage U,
  setValue(branchTip(lane), R),
  deleteList(frames),
  setValue(operationState(operationId), classified next state)
]
```

这适用于：

- 成功的 assistant responses；
- provider `error`/`aborted` responses；
- 有效的 deferred responses；
- deferred poll responses。

`after_response` 可以在 settlement 之前转换 final response。Frames 保留 provider-stream 观察，而不可变 entry 保持为 post-hook 规范结果。

在 final frame append 之后但在 settlement 之前发生 crash 仍会恢复 `effect_pending`；frames 不会把看起来完整的草稿变成已 settle 的 response。

## Unknown-outcome generation recovery

一个孤立的 assistant generation `effect_pending` 没有存活的 provider stream。Activation：

1. 从当前 typed state 构造 `frames = pendingAssistantFrames(operationId, responseEntryId)`，并从那个精确 address 读取有界的 pages；
2. 用 `reduceAssistantMessageFrames()` 归约 frame values；
3. 在已预留的 response ID 下构造一个 harness 所有的 synthetic assistant response；
4. 当 frames 存在时，保留重建的 partial content 和安全的 message identity metadata；
5. 设置 `stopReason: "error"`、zero usage，以及显式的 interruption/unknown-outcome `errorMessage`/diagnostic；
6. 原子地提交 synthetic response、zero-usage row、frame-list deletion、tip 以及普通的 retry/failure state。

必需的 warning 含义：

```text
The provider request was interrupted. The preceding content is the latest
committed partial response; newer live output may be missing, and the external
request outcome is unknown.
```

如果没有 start frame 提交，harness 会根据捕获的 model/API identity 构造相同的、content 为空的 synthetic error。

synthetic response 遵循普通的 assistant error 分类：

- attempts 仍有余量 → 插入 error response 并进入普通的 retry-wait/next-attempt 路径；
- 达到 cap → 插入它，并在同一 settlement transaction 中使 operation terminal-fail。

Error responses 保留为 durable transcript history，但按既有 projection 规则从后续 provider context 中省略。被中断的 error response 内部的 partial tool calls 绝不执行。

Recovery 不运行 `after_response`：没有可信任的完整 provider result 可供转换。

## Cancellation

一个 live 被取消的 provider stream 通过其普通的 final `aborted` response settle。所有已接受的 frames 先被 await，然后 normal settlement 删除该 list。

对于已恢复的 cancelled assistant/deferred `effect_pending`，cancellation reconciliation：

- 归约可用的 frames；
- 构造一个 synthetic `aborted` response，保留已提交的 partial content；
- 使用 zero usage 和既有 reserved IDs；
- 原子地插入 response 并删除 frame list；
- 不启动 provider request，也不运行 response hook。

即使归约后的 content 看起来完整，cancellation 仍然赢得分类。

## Deferred polling

一个返回 `AssistantMessageEventStream` 的 deferred poll 使用相同的 `pendingAssistantFrames(operationId, responseEntryId)` address 构造器。

- 正常的 pending/ready/error settlement 删除该 poll 的 frame list；
- restored cancellation 从 frames 合成一个 aborted response；
- 一个没有 permit 的未知 restored poll 保持 suspended，并可能在 snapshots 中暴露其 durable partial；
- 当 poll permit 用新的 reserved response/usage IDs 替换该未知 poll 时，那个 intent transaction 会删除被放弃的旧 frame-list address；
- replacement poll 在其新的 response ID 下启动一个新的 list。

Frames 绝不改变 poll-number 规则。

## Structural generation scope

Structural summary-generation streams 保持 process-local。它们不发出公开的 assistant-message lifecycle，并且可能在一个 structural publication 之前跨越多个嵌套 provider requests。既有的 attempt-level retry 和 usage recovery 仍保持权威。

在本 slice 中，不要将其中间文本存储在一个 `pendingAssistantFrames(...)` address 处。如果 structural partial diagnostics 成为需求，请添加一个单独的、显式限定 scope 的 consumer，而不是静默复用 transcript-assistant 语义。

## Snapshots 与 reconnect

`LaneSnapshot.streamingMessage` 表示最新观察到的 partial assistant 消息，而不是当前已附加 provider stream 的证明。

优先级：

1. 在拥有 live stream 时，最新的 process-local partial；
2. 否则，对于 assistant/deferred `effect_pending`，为从已提交 frame pages 归约出的值；
3. 否则缺失。

因此，一个 restored lane 可能处于 `suspended` 且带有非 undefined 的 `streamingMessage`。该字段保持在 `transcript` 之外；只有 `entry_added` 会把完整 response 移入 transcript history 并清除 partial。

Snapshot hydration 从可信的 typed operation state 构造精确的 bound frame address，并强制执行 assistant consumer 的总 frame/page 预算。它不扫描任意 lists，也不执行宽泛的 semantic restore audit。

Reconnect 不重放任何历史 `message_start` 或 `message_update` 事件。snapshot 携带 durable partial。Recovery 稍后为它实际 settle 的 response 发出普通的 recovery-tagged synthetic message lifecycle。

## Events

已启动的 generation 保留此 live event 顺序：

```text
message_start
→ message_update*                 each listener delivery awaited by provider loop
→ await latest frame write
→ after_response
→ message_end
→ atomic response settlement + frame-list delete
→ entry_added
→ usage
```

request setup failure 可能在 `start` 之前产生 `error`；该路径不发出 `message_start` 或 frame，并经过 `after_response`、`message_end` 和普通的 error settlement。`start` 之前出现成功的 `done` 和 updates 是 protocol defects。

Frame commits 只发出普通的 storage telemetry。不存在公开 frame event，也不声称某个 `message_update` 是 durable 的。`entry_added` 仍是 final assistant entry 已提交的唯一证明。

crash 可能发生在某个 live update event 之后、但在其异步入队的 frame append 提交之前。此时 reconnect 显示最新已提交的 frame 前缀，它可能比最后一个 live event 更旧。

## Close、fault 与 external finalization

Close 是一次受控 crash：

- 不写入 synthetic response；
- 已入队的 frame commits 是普通的已准入 session 工作，并可能在 close barrier 下完成；
- process loss 可能丢弃尚未提交的 mutations；
- reopen 在不变的 `effect_pending` 状态下恢复最新已提交的 frame 前缀。

frame-commit storage failure 会使 harness fault。该进程中不会有后续 response settlement 提交。

被授权的 external finalization 在其 terminal transaction 中删除 operation 所有的 frame-list address。每个 append mutation 都会在 Session line 上验证当前 operation/response 所有权：

- append 先发生 → external terminal cleanup 删除该 list；
- finalization 先发生 → stale append 被拒绝，且不重建 state。

## Terminal cleanup、forks 与 migrations

Normal/synthetic response settlement 应当已经删除其精确 frame address。当 state 为 assistant/deferred `effect_pending` 时，operation terminal transaction 还会防御性地构造并删除当前 operation 所有的 frame address。

Idle forks 绝不复制 `pi.pending.assistant_frame` address 家族中的 lists。Precise rewrites 和 migrations 分页读取 frame lists，并在保留它们时保留元素序列。

改变 `AssistantMessageFrame` 形状的 migration 必须映射每一个存活元素，或者显式删除整个 list 并让 `effect_pending` recovery 没有 partial。它绝不能从 legacy frames 推断完成。

JSONL 保留已删除的 frame bytes 直到 snapshot compaction。逻辑删除是立即的。

## Races

| Race | 必需结果 |
|---|---|
| frame append vs next frame | 同步 lane enqueue 保留 provider-event 顺序 |
| frame append vs stream settlement | settlement await 最新 promise；所有已接受的 appends 先完成 |
| live update event vs frame commit | 两者都可能先完成；event 是观察，reconnect 只使用已提交的 frames |
| append vs external finalization | append 先发生时被 cleanup 删除；finalization 先发生时对 append 设栅栏 |
| process loss with queued writes | 只有已提交的前缀会恢复 |
| final frame vs response settlement | frame 先提交；settlement 原子地删除 list 并插入 final entry |
| activation vs snapshot | 两者归约相同的已提交序列前缀；activation 随后可能 settle 并清除它 |
| unknown generation vs retry | synthetic partial error 在后续 attempt 开始之前以旧 reserved IDs 提交 |
| unknown deferred poll vs replacement | 旧 list 随新的 replacement intent 被删除；新 response ID 获得一个新 list |

## Invariants

1. 标量 assistant/deferred state 是唯一的 restart 权威。
2. 一个 effect-pending response ID 精确构造一个 assistant frame-list address。
3. 每个存储元素都是导出的 pi-ai `AssistantMessageFrame`。
4. Terminal `done`/`error` 事件绝不作为 frames 存储。
5. Frame 顺序是 provider event 顺序的一个子序列；零 frame 的已覆盖 events 不扰乱顺序。
6. 在 stream settlement 时 await 最新 frame-write promise 意味着所有已接受的 appends 都已完成。
7. Frames 绝不确立 provider completion，也绝不抑制 unknown-outcome recovery。
8. Final 或 synthetic response settlement 原子地删除精确的 frame list。
9. 一个 restored partial 可能出现在 `streamingMessage` 中，但在 settlement 之前绝不出现于 `transcript`。
10. 被中断的 partial tool calls 绝不产生 tool plan，因为 synthetic response 以 `error`/`aborted` 停止。
11. 在本 slice 中，structural generation 绝不写入 `pendingAssistantFrames(...)` list。
12. Terminal cleanup、external finalization 和 idle forks 不留下任何 operation 所有的 assistant frame list。

## Required tests

### Frame integration

- 一个 per-stream encoder 处理共享的 live partials 和同步 event bursts 而不产生重复 content；
- 每个事件追加零个或一个 frame，已被覆盖的 queued deltas 不追加任何内容；
- `done`/`error` 不追加任何内容，包括 pre-generation error；
- 交错的内容 indexes 保留序列；
- provider loop 不 await 单独的 frame writes；
- frame appends 在下一个 provider event 之前同步入队；
- 只保留最新的 promise 引用；
- await 最新 promise 意味着所有更早的写入都已完成；
- 有界输出限制 queued frame memory；
- storage failure 阻止 `after_response` 并使 harness fault。

### Settlement and recovery

- 每个普通 response 类别都原子地删除 frame list；
- 在每个 frame/settlement 边界处 crash；
- 无 frames 以及 partial text/thinking/tool-call frames；
- 权威的 end-frame content 存活；
- 被中断的 generation 提交 partial synthetic error，然后重试或在 cap 处失败；
- 被中断的 partial tool calls 绝不执行；
- recovery 使用 zero usage 和既有 reserved IDs；
- cancellation 在 synthetic aborted response 中保留已提交的 partial content；
- `after_response` 绝不针对 restored synthetic settlement 运行。

### Deferred, snapshots, and lifecycle

- deferred poll frame 持久化与正常 cleanup；
- 没有 permit 的 unknown poll snapshot；
- replacement intent 删除被放弃的 poll frames；
- live partial 优先于 durable reduction；
- reopen 在 suspended effect-pending lane 上暴露归约后的 `streamingMessage`；
- 不重放历史 update event；
- recovery settlement 在 `entry_added` 时清除 partial；
- structural generation 不写入任何 assistant frame list。

### Storage lifecycle

- Memory/JSONL/SQLite 归约出完全相同的 frame sequences；
- 在 normal、synthetic、cancellation 和 external terminal transitions 之后 frame list 均不存在；
- idle fork 排除 frames；
- JSONL compaction 移除已删除的 frame bytes；
- migration 映射或显式丢弃每个 legacy frame；
- instrumentation 记录 append/delete 顺序，且 telemetry 中不含 frame content。

## Implementation map

预期的 runtime 区域：

- `session/values.ts` 中的内置 `pendingAssistantFrames(operationId, responseEntryId)` address 构造器；
- 来自 `values.md` 的 bound value/list storage 实现；
- assistant execution observer 与 generation procedure；
- deferred polling procedure；
- activation 与 cancellation recovery；
- snapshot hydration；
- terminal cleanup、forks 与 migrations；
- instrumented writer 与 backend conformance tests。

先实现 bound typed value/list addresses，然后实现 frame enqueue/settlement，再实现 recovery/snapshots。在实现 runtime assistant parity 之前，用这个完整的 lifecycle 更新 `harness.md`。
