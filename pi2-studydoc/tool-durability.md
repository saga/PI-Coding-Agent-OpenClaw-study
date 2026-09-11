# Tool durability — 实现交接

本文档规定 durable tool-call lifecycle，以及对当前 tool API 的最小 harness-specific progress-checkpoint 扩展。除此之外，它不最终确定 harness-native 的 public tool interface；该 interface 必须提供此处所需的能力，而不暴露原始 session storage。

该设计有两项独立的添加：

1. 在 external-effect settlement 与 source-ordered conversation placement 之间的 durable `outcome_ready` 状态；
2. 针对完整有界 `onUpdate` snapshot 的 opt-in durable replacement checkpoint。

## 问题

并行 tool effect 按 completion 顺序完成，而 tool-result entry 必须按 assistant source order 进入 conversation。

如果没有中间的 durable 状态：

```text
calls: A, B, C
B finishes
C finishes
A is still running
process crashes
```

B 与 C 只存在于 process memory 中，因为 A 阻止了 source-ordered placement。Recovery 把它们视为未解决，并可能 replay 或 interrupt 已经完成的 effect。

该方案分离了两种顺序：

1. **outcome durability：**实际的 completion 顺序；
2. **entry materialization：**assistant source order。

完整的 finalized result 立即在 `pi.pending.entry` 中变为 durable；该 call 变为 `outcome_ready`；当每个更早的 source position 都 complete 或 ready 时，稍后发生 placement。

## 目标

1. 在其完整的 finalized outcome 变为 durable 之后，绝不重新运行 tool。
2. 持久保留乱序的并行 outcome，而不违反 transcript 顺序。
3. 保留既有的 whole-tool `replay: "safe" | "never"` 契约。
4. 支持 Flue-style `step.do` 的 invocation-scoped durable memoization。
5. 保留 tool 选择的有界 progress checkpoint，用于 reconnect 与 unsafe interruption recovery。
6. 在 outcome settlement、cancellation 或 external finalization 之后对迟到的 tool write 进行 fence。
7. 保持 final tree entry 规范、完整、独立于 progress snapshot 而有界，且不可变。

## 非目标

- 任意 external effect 的 exactly-once。
- 为每个 `step.do` 调用提供嵌套的 durable 状态机。
- 从 progress output 推断 tool completion。
- 把 partial output 视为规范 final result。
- 向 tool 提供原始 `Session`、`SessionMutator` 或 bound storage-address 访问。
- 在本文档中最终确定 public harness-native tool type。

## Durable identity

每个 call 在执行之前已经预留其结果 entry ID。把它用作稳定的 public invocation identity：

```text
invocationId = resultEntryId
```

它是 session-unique 的，能在 safe replay 中存活，并且不同于 provider 的 batch-local `toolCallId`——后者可能被之后的 assistant message 复用。

外围的 operation 状态继续提供：

- `operationId`；
- `turnId`/generation step ID；
- `sourceIndex`；
- assistant entry ID；
- 已捕获的 configuration 与 execution mode。

## Storage

### 既有的 bound value

```ts
operationToolArgs(operationId, turnId, sourceIndex)
// Effective validated arguments, persisted before effect admission.

pendingEntry(resultEntryId)
// Complete finalized ToolResultMessage while outcome_ready awaits placement.
```

### Invocation memo

在 `session/values.ts` 中定义 operation-owned 的 address constructor：

```ts
export const operationToolMemo = (
  operationId: string,
  invocationId: string,
  memoName: string,
) => value<JsonValue>(
  "pi.op.tool_memo",
  `${operationId}:${invocationId}:${memoName}`,
);
```

`memoName` 必须非空且不包含 `:`。名称可以使用点或斜杠进行 application-local 分组。`setMemo(name, undefined)` 删除该精确的 bound value。

`scanValues(operationToolMemoPrefix(operationId))` 允许防御性的 operation cleanup。`scanValues(operationToolMemoPrefix(operationId, invocationId))` 允许在某个 outcome 变为 ready 时进行原子性的 invocation cleanup。Core cleanup 使用这些 owner-defined prefix constructor，而不是重复原始保留 namespace/key 语法。

### Partial tool output

durable recovery value 是 tool 所选的最近一次完整有界 progress snapshot。那是完整的当前状态，因此使用一个 bound value address：

```ts
export const pendingToolOutput = (
  operationId: string,
  invocationId: string,
) => value<AgentToolResult<unknown>>(
  "pi.pending.tool_output",
  `${operationId}:${invocationId}`,
);
```

这是 auxiliary observation data。它绝不证明 effect 成功或完成。已存储的 value 与 live `partialResult` 具有完全相同的 content/details/usage shape；recovery 不需要 tool-specific 的 progress codec。

tool 拥有 snapshot bounding、checkpoint cadence 与 duplicate suppression。harness 拥有 synchronous enqueue、promise tracking、invocation fencing 与 cleanup。第一个 API 没有 generic byte cap，也不截断或重新解释 typed tool data；in-process tool 被信任遵守 bounded-snapshot 契约。不存在 tool 可见的 `flush()` method，也不存在 progress update 的 durable list。

crash 可能丢失比最近一次已提交 checkpoint 更新的 live update。在 compaction 之前，JSONL 的物理增长与不同 requested checkpoint 的大小与频率成正比；Memory 与 SQLite 保留一个 current value。以每两秒 50 KiB 计，JSONL 在未 compaction 时最坏情况约为每十分钟持续变化的 output 15 MiB。

## Tool update API

保留既有的 full-snapshot update callback，并添加 harness-specific option：

```ts
export interface AgentHarnessToolUpdateOptions {
  /** Request replacement of this invocation's durable recovery checkpoint. */
  checkpoint?: true;
}

export type AgentHarnessToolUpdateCallback<TDetails> = (
  partialResult: AgentToolResult<TDetails>,
  options?: AgentHarnessToolUpdateOptions,
) => void;
```

`AgentHarnessTool` 使用此 callback，而不是 legacy 的 `AgentToolUpdateCallback`。harness 总是提供它，即使没有 live listener，因为 tool 可能通过它请求 persistence。legacy 的 `AgentTool` 与旧的 agent loop 保持不变，因为它们无法履行 durable checkpoint。

每次 callback 调用仍是即时的 live update。该 callback 是同步的并返回 `void`；`checkpoint: true` 额外请求持久化该完整 snapshot。它不是 durability acknowledgement。在内部，harness 保留最近的 `events.emit(tool_update)` promise，使既有 listener delivery 在 `after_tool` 之前完成；tool 不 await 也不接收该 promise。

每次 `checkpoint:true` 调用都会在 Session mutation line 上同步 enqueue 一个 scalar replacement，把普通的 harness-fault observer 附加到该 promise，并替换 process-local 的 `latestCheckpointWrite` reference。write 本身既不会被丢弃也不会被合并，且替换该 reference 绝不会让更早的 rejection 未被观察到：

- Session mutation FIFO 保持 request 顺序；
- 每个 mutation 校验同一个 call 仍为 `effect_pending`；
- latest promise 的完成意味着每个更早 checkpoint write 的完成；
- tool-promise settlement 停止接受 update，并在 `after_tool` 之前 await 该 latest promise；
- 失败的 checkpoint commit 依据普通 storage-fault 规则使 harness fault。

请求 checkpoint 的速度快于 storage 的 tool 可能在 memory 中排队 work。在 trusted-tool 契约下，cadence 是 tool 的责任。built-in bash policy 在普通使用中限制该 queue。

当 duplicate suppression 重要时，tool 应与上一次请求的 checkpoint 比较。Storage 不会把读取并深度比较当前 scalar 作为每次 checkpoint 的一部分。

### Bash policy

built-in bash tool 保持其当前 100 ms 的 live update cadence。它最多每两秒请求一次 checkpoint，且仅当完整有界 snapshot 与其上一次请求的 checkpoint 不同时：

```ts
const BASH_UPDATE_THROTTLE_MS = 100;
const BASH_CHECKPOINT_INTERVAL_MS = 2_000;
```

当前的 `ShellCaptureProgress` 已经提供一个有界 snapshot：最后 2,000 行或 50 KiB，外加 truncation metadata 与 overflow-file path。最初的空 update 仅 live。Output 量绝不加快 checkpoint 频率。短小的 tool 可能在不写入任何 checkpoint 的情况下 settle，因为其完整 final result 会改为提交。

## Tool-call 状态

用 `outcome_ready` 扩展 call union：

```ts
type ToolCall =
  | {
      status: "planned";
      sourceIndex: number;
      resultEntryId: string;
    }
  | {
      status: "effect_pending";
      sourceIndex: number;
      resultEntryId: string;
      replay: "never" | "safe";
    }
  | {
      status: "outcome_ready";
      sourceIndex: number;
      resultEntryId: string;
      terminate: boolean;
    }
  | {
      status: "completed";
      sourceIndex: number;
      resultEntryId: string;
      terminate: boolean;
    };
```

`outcome_ready` 意味着：

- execution、error normalization 与 `after_tool` 已完成，或者 harness 已构造出 final synthetic result；
- 完整的 final `ToolResultMessage` 存在于 `pendingEntry(resultEntryId)`；
- invocation memo 与 partial-output storage 已消失；
- 该 tool 绝不再次执行；
- 不可变的 result entry 可能尚不存在，因为更早的 call 尚未 materialize。

确切的 union 之后可能携带少量 settlement metadata，但它不得重复 finalized result payload。

## 状态转换

```text
planned
  ├─ real effect cleared       → effect_pending
  └─ immediate/synthetic       → outcome_ready

effect_pending
  ├─ live effect settles       → outcome_ready
  ├─ safe orphan replay settles→ outcome_ready
  └─ unsafe orphan synthesis   → outcome_ready

outcome_ready
  └─ source position eligible  → completed
```

实现可以把 `outcome_ready → completed` 融合进最终确定一个立即可放置 head call 的同一 transaction，但语义检查与测试仍必须覆盖乱序 call 的 durable `outcome_ready`。优先先实现显式的 two-transaction 形式。

## Fresh execution

### Clearance 与 intent

未改变的 effect sandwich：

```text
planned
→ prepare arguments, run before_tool, validate replacements
→ TX[
     set pi.op.tool_args,
     set call = effect_pending(replay)
   ]
→ post-commit tool_start
→ admit tool execution
```

invocation-scoped capability 只对此 durable `effect_pending` call 生效。

### Partial output

每次 `onUpdate(partialResult, options)` 都通过既有 event/snapshot path 发布 live update。当 `options.checkpoint === true` 时，harness 额外请求一个 scalar replacement：

```text
TX[
  setValue(pendingToolOutput(operationId, invocationId), partialResult)
]
```

该 mutation 校验同一个 operation、turn、source position 与 invocation 仍为 `effect_pending`。它不重写 `pi.op.state`。settlement 之后迟到的 checkpoint 会返回而不提交。

tool 必须 checkpoint 有界的完整 snapshot，而不是不断增长的无界 value。Bash 使用它已经 live 发送的同一个有界 `ShellCaptureProgress` snapshot。Client 可以渲染并在本地保留比 durable checkpoint 更新的 live update，但这些 update 明确是 process-local 的。

### Finalization 到 `outcome_ready`

当 tool promise settle 时：

1. 同步停止接受 update 并使 invocation capability 过期；
2. await 最近一次被跟踪的 `tool_update` delivery 与最近一次 checkpoint-write promise；每一个都意味着其前置 queue 已完成；
3. 当这是真正的 fresh 或安全 replayed result，且 cancellation 未阻止该 hook 时，运行 `after_tool`；
4. 构造完整的 final `ToolResultMessage`；
5. 把 result 提交为 `outcome_ready`；
6. 从已提交的 staging transition emit 并 await `tool_end`。

`setMemo()` 返回 promise，tool 必须 await 它；`step.do` 总是如此。未被 await 的 pre-return mutation 仍会在 staging 之前 enqueue，并被 staging 删除。在 capability 过期之后开始的 call 会被拒绝。不存在单独的 invocation-write drain。

Transaction：

```text
TX[
  setValue(
    pendingEntry(resultEntryId),
    { type: "message", payload: finalizedToolResultMessage },
  ),
  deleteValue(pendingToolOutput(operationId, invocationId)),
  deleteValue(memo.address) for every memo returned before commit by
    scanValues(operationToolMemoPrefix(operationId, invocationId)),
  setValue(operationState(operationId), call = outcome_ready(terminate))
]
```

该 transaction 是 linearization point，在此之后该 invocation 绝不 replay。因此其 post-commit 的 `tool_end` 是 finalized outcome 已 ready 的 durable evidence；它不再是 pre-commit 的 effect observation。

staged message 包含最终的：

- text/image content；
- provider tool-call ID 与 tool name；
- details；
- `isError`；
- usage snapshot（当被报告时）；
- added tool name；
- timestamp。

`terminate` 仍是 orchestration 状态，因为它控制 batch continuation 并在 placement 时被复制到不可变 entry 的 `terminate` 字段。staged `addedToolNames` 在该 result 于 transcript 中 materialize 之前不影响 active tool set。

## Source-ordered materialization

在任何 call 变为 `outcome_ready` 之后，找出从第一个 non-completed source position 开始的连续 ready prefix。

示例：

```text
[completed, outcome_ready, outcome_ready, effect_pending]
             └──────── ready prefix ────────┘
```

在 placement transaction 之前，按 source order emit 并 await 每个 finalized result 的 `message_start` 与 `message_end`。在可行时用一个 transaction materialize 该 prefix，然后按相同的 source order emit `entry_added` 与已报告的 usage event：

```text
TX[
  insert result entry i from pendingEntry(i),
  deleteValue(pendingEntry(i)),
  insert tool usage row i if reported,

  insert result entry i+1 with parent = result i,
  deleteValue(pendingEntry(i+1)),
  insert tool usage row i+1 if reported,

  setValue(branchTip(lane), newest result),
  setValue(operationState(operationId),
           calls i..i+1 = completed and, when complete, next checkpoint)
]
```

每个插入的 entry 使用其已预留的 `resultEntryId`。Write 在 transaction 内按 source order 构造 parent chain。

tool 报告的 usage 在 placement 之前保持 durable 于 staged message 中。初始实现把其 ledger row 与 entry materialization 原子地写入，匹配当前的 entry/usage 顺序，并避免出现引用尚未存在的 entry 的 ledger row。不需要 usage ID reservation，因为失败的 placement transaction 既不写入 row 也不写入 completed state。

当 final call materialize 时，同一 transaction 调用 `scanValues(operationToolArgsPrefix(operationId, turnId))` 并删除每个返回的 address，然后转换到正确的 checkpoint：

- 每个 result 都 terminate → `may_finish`，不需要 final assistant；
- 否则 → `need_assistant(false)`。

## 并行执行

Outcome staging 遵循实际的 completion 顺序。Entry materialization 遵循 source order。

```text
A, B, C start
B finishes → B outcome_ready
C finishes → C outcome_ready
A finishes → A outcome_ready
             materialize A, B, C
```

B 与 C stage 之后 crash：

```text
A effect_pending
B outcome_ready
C outcome_ready
```

Recovery 只对 A 应用 unknown-outcome policy。B 与 C 不需要 tool registration 或 hook execution 即可成为 entry。

durable invariant 从 “completed call 构成 source-ordered prefix” 变为：

- completed call 构成 source-ordered prefix；
- 在该 prefix 之后，并行 call 可以以任意混合形式为 `planned`、`effect_pending` 或 `outcome_ready`；
- 只有 source-ordered materialization 才扩展 completed prefix。

Sequential execution 在 completed prefix 之后最多构造一个 non-planned call。已提交的 call state 在 restore 时被信任；拥有它的 procedure 在创建与消费 transition 时强制执行此形态，而不是通过宽泛的 restore audit。

## 带 partial output 的 unsafe recovery

对于带 `replay: "never"` 的 orphaned `effect_pending`：

1. 当存在时读取 `pendingToolOutput(operationId, invocationId)`；
2. 保留其有界 content 与可序列化的 details；
3. 追加一个必需的人类可读 interruption marker；
4. 构造一个 harness-owned 的 `ToolResultMessage`，带 `isError: true`；
5. 把它提交为 `outcome_ready` 并清理 invocation state。

该 marker 必须说明 output 是 partial 且 external outcome 未知。`isError: true` 描述的是交付给 model 的 result；它并不断言 external effect 失败。

示例 final text 后缀：

```text
[Tool execution was interrupted. The preceding output is the latest durable progress snapshot; newer live output may be missing, and the external outcome is unknown.]
```

规则：

- 不要为此 synthetic result 运行 `after_tool`；
- 当存在时保留 checkpoint 的 `usage`，但忽略 checkpoint 的 `addedToolNames` 与 `terminate`，因为 progress 绝不具有 final-result authority；
- 设置 `terminate: false` 且不添加任何 tool；
- 缺失的 checkpoint value 也是合法的，并且只产生 interruption result；
- 绝不从 partial output 中看似成功的行推断 completion；
- partial output 与 invocation memo 的 cleanup 与 staging synthetic result 原子。

## Safe recovery

对于 stored 与 current 声明都是 `replay: "safe"` 的 orphaned `effect_pending`：

1. 保留 invocation memo；
2. 原子地删除 `pendingToolOutput(operationId, invocationId)`；
3. 按需 emit/reset process-local 的 progress observation；
4. 用已持久化的 arguments 与相同的 `invocationId` 重新运行该 tool；
5. 已完成的 `step.do` call 返回其 memoized value；
6. 新的 partial output 重建干净的 progress stream；
7. finalization 遵循普通的 `outcome_ready` 路径。

删除旧的 progress 可防止 replayed code 再次 emit progress 时产生重复 chunk。在 delete 之后、replay admission 之前发生 crash 仍保持 `effect_pending`；下一次 recovery 重复相同的 safe procedure。

如果当前的 tool 声明缺失或不再 safe，则使用 unsafe interruption recovery 而不是 suspend。

## Invocation memo

harness-native 的 tool call 接收一个专门构建的 invocation capability，概念上等价于：

```ts
interface AgentHarnessToolInvocation {
  readonly invocationId: string;
  readonly operationId: string;
  readonly turnId: string;

  getMemo(key: string): Promise<JsonValue | undefined>;
  setMemo(key: string, value: JsonValue | undefined): Promise<void>;
}
```

每个操作：

1. 校验 memo name 并检查 process-local capability 是否过期；
2. 在返回其 promise 之前同步在 Session mutation line 上 enqueue work；
3. 当该 job 执行时校验 operation、turn、source position 与 invocation 仍是同一个 `effect_pending` call；
4. 只构造并读取或写入 `operationToolMemo(operationId, invocationId, name)`；
5. 在 capability 过期或 durable ownership 丢失之后拒绝。

durable 检查对已授权的 external finalization 很重要。在普通执行中，在 tool 返回之前发起的 memo mutation 在 outcome staging 之前按 FIFO 排序；之后发起的则会因 expired-capability 检查而失败。

迟到的 zombie callback 既不能在 `outcome_ready` 之后重建 memo，也不能写入之后的 operation。

Memo 是即时的 durable replay 状态，而不是 application-visible 的 settlement 状态。当 call 保持 `effect_pending` 时它们能在 close/crash 中存活，并在任何 real 或 synthetic outcome 变为 ready 时被删除。

Terminal cleanup 防御性地扫描并删除 operation-owned family：

```ts
scanValues(operationToolMemoPrefix(operationId))
scanValues(pendingToolOutputPrefix(operationId))
```

此外还有其他 operation-owned 的 address。每个返回的 `StoredValue` 为其 `deleteValue` 提供精确的 bound address；之后的 operation 不会收到原始 key。

## Flue-style `step.do`

在 invocation memo 之上构建 `step.do`；它不需要自己的 harness state union：

```ts
interface ToolSteps {
  do<T extends JsonValue>(
    name: string,
    effect: () => T | Promise<T>,
  ): Promise<T>;
}
```

算法：

```text
validate deterministic unique name
→ getMemo("step/" + name)
→ present: return stored value
→ absent: run effect
→ setMemo("step/" + name, value)
→ await durability
→ return value
```

Crash 行为：

```text
before/during effect                    → effect may run on replay
effect returned, memo not committed     → effect may run on replay
memo committed                          → replay returns memo
step A memoized, step B interrupted      → rerun tool; A skips, B runs
```

这是 exactly-once recorded 且 at-least-once executed。它不会使任意 external effect 成为 exactly once。当 external API 支持时，application 可以从 `(invocationId, stepName)` 推导出一个稳定的 external idempotency key。

Error 不会被 memoize。抛出的 effect 要么贡献给当前 tool result，要么在 safe whole-tool recovery 之后再次运行。

不要在本切片中添加 per-step 的 `replay: "never"`。正确支持它需要嵌套的 `planned → effect_pending → completed` 状态与显式的 unknown-outcome policy。whole-tool replay policy 对已讨论的 Flue 用例已足够。

在一次 live execution 内，两次调用同一步骤名是 invariant error。名称在 safe replay 中必须是确定性的。

## Application persistent state

Flue-style 的 application state 不同于 invocation memo。

Invocation memo：

```text
step completed → memo becomes visible immediately
```

Application state：

```text
tool stages state change
→ crash before outcome_ready: state must not appear committed
→ outcome_ready: state and finalized result become visible together
```

不要通过在执行期间直接调用 `Session.setValue()` 来实现 application state。

两个有效的实现阶段：

1. Flue 把其状态保存在外部，并原子地存储 application state 以及以 `invocationId` 为 key 的完整 result memo。
2. 后续的 harness API 接受 staged application value write，并在 `outcome_ready` transaction 中提升它们。

只有在 Flue 的 `usePersistentState` 移入 harness-owned session value 时才需要第二个选项。其 public typing 与 conflict 语义仍是 harness-native tool 讨论中未决的设计项。

## Cancellation

Cancellation reconciliation 绝不 replay 已 restore 的 tool。

- `planned` call 收到 synthetic aborted result 并变为 `outcome_ready`；
- 已 live 启动的 call 可以在 cancelled control 下 finalize 其真实 local result，然后以 `terminate: false` 变为 `outcome_ready`；
- restored 的 `effect_pending` call 使用 interrupted synthetic result，可选地包含 partial output，无论 safe replay 声明如何；
- 既有的 `outcome_ready` call 被保留并按 source order materialize；
- invocation memo 与 partial output 随每个 staged cancellation outcome 一起删除；
- 在 restored synthetic reconciliation 期间不启动 `before_tool` 或 `after_tool`。

aborted terminal transaction 只在每个 call outcome 都已 materialize 且已接受的 deferred write 依据既有 cancellation 规则排空之后运行。

## Close 与 external finalization

Close 仍是一次受控 crash：

- 在 admission barrier 之下已经 enqueue 的 memo/checkpoint mutation 可以完成；
- 比最近一次已提交的 tool-requested checkpoint 更新的 live output 可能丢失；
- 不写入 synthetic outcome 或 cancellation marker；
- durable state 保持在 `effect_pending` 或 `outcome_ready`。

External finalization 在其 terminal transaction 中删除 operation-owned arguments、invocation memos、partial output、staged pending outcomes 与其他 pending entries。之后试图 stage outcome 的 live task 会 fail ownership fence 并通过 `OperationEnded` 停止。

## Restore 与 consumption-time read

Base restore 从必需的 owner value 构造受信任的 lane/operation projection。它不 hydrate 也不语义审计 tool arguments、invocation memos、progress checkpoints、staged outcomes、completed entries、completed-prefix shape 或已捕获的 execution-mode 关系。

对当前 typed state 负责的 procedure 只执行其确切的 consumption-time read：

### `planned`

Clearance 不需要 auxiliary restore read。它在 effect admission 之前准备 call 并写入 arguments。

### `effect_pending`

Activation 读取 `operationToolArgs(operationId, turnId, sourceIndex)`，并可选择读取 `pendingToolOutput(operationId, invocationId)`。缺失必需的 arguments 在消费时是 invariant defect。Invocation memo 只通过 scoped capability 读取。Safe replay、unsafe interruption 与 snapshot 不使用宽泛的 prefix scan。

### `outcome_ready`

Materialization 读取 `pendingEntry(resultEntryId)`。当 materialization 消费它时，其缺失或错误的受信任 message 关系是 invariant defect。不需要 tool identity 或 effect recovery。

### `completed`

普通 dispatch 不执行 restore-time 的 entry audit。Context/tree 读取稍后通过其正常的 typed path 消费该不可变 entry。

每个 live mutation 仍在 Session line 上校验当前 operation、turn、source position、invocation 与 status。这些检查对并发 settlement、cancellation 与 external finalization 进行 fence；它们不是历史性的 restore validation。Terminal prefix cleanup 仍是防御性的，不会使 orphan scan 成为 restore 的一部分。

## Snapshot 与 reconnect

重新连接的 client 可能看到：

- 比最近一次 durable checkpoint 更新的 live process-local progress，发生在 disconnect 之前；
- 在 process replacement 之后，只有最近一次已提交的有界 checkpoint；
- 在 source-ordered materialization 之前，`outcome_ready` call 作为 `runningTools` 中的 settled row；
- transcript 中已完成的 call。

`LaneSnapshot.operation.runningTools` 是一个 discriminated union。effect-pending tool 具有 `status: "running"` 以及一个可选的 `result`，其中包含最近一次完整 progress snapshot，在 reopen 之后回退到 durable checkpoint。outcome-ready call 具有 `status: "settled"`、其必需的完整 final `result` 与 `isError`；它一直保留在那里，直到其不可变 result entry 的 `entry_added` 移除该 row 并把相同的呈现放入 transcript。Planned 与 completed call 被省略。

## Event 与 hook

- `tool_start` 为一个 fresh call 开始 public processing 呈现；它从建立 effect intent 或 synthetic staged outcome 的 commit 中 emit，且本身不证明 external effect 已开始。它携带 intended effect 的有效 arguments 与 immediate synthetic result 的 source arguments。
- live progress event 与 durable progress checkpoint 不证明 completion。
- harness 在 `after_tool` 之前 await 最近一次 `tool_update` delivery，从而在不使 `onUpdate` 变为 async 的情况下保留既有的 listener 顺序。
- `tool_end` 在其 `outcome_ready` staging commit 之后按 completion 顺序携带完整的 finalized result。它是 durable settlement evidence，且不重复 `tool_start` 的 arguments。
- 对于 fresh 的 blocked、invalid、truncated 或 planned-cancellation synthetic outcome，staging commit 会 emit `tool_start`，随后 emit `tool_end`；这些路径仍不运行 tool effect 或 post-effect hook。effect intent 之后的 cancellation 使用更早的 intent-bound start 与 staging-bound end。
- unsafe restored effect 已被 initial snapshot 表示为 running，并且可能在 interruption synthesis stage 时只 emit 一个 recovery-tagged 的 `tool_end`。
- message lifecycle 与 `entry_added` 在 staged result materialize 时发生，而不是在它首次变为 `outcome_ready` 时；`entry_added` 只移除该 settled row。
- passive listener 不能重入地 mutate invocation state。

Instrumented-storage test 对 execution 断言 `intent commit → tool_start → tool_update* → outcome staging → tool_end → source-ordered placement`，对 fresh synthetic result 断言 `outcome staging → tool_start → tool_end → source-ordered placement`。历史 event 不会被 replay；安全 replayed 的 execution 从其 checkpoint-clear commit emit recovery `tool_start`，并从 outcome staging emit `tool_end`。

## Race

| Race | 必需结果 |
|---|---|
| checkpoint 与 tool settlement | 每个已接受的 checkpoint 都已先 enqueue；settlement await latest promise，然后 staging 删除 checkpoint value；迟到的 update 被忽略 |
| memo write 与 `outcome_ready` | 已 await 或 pre-return enqueue 的 write 先于 staging，随后被删除；post-return call 被拒绝；external finalization 先行时会使 durable ownership 检查拒绝 |
| B outcome 与更早的 A settlement | B 独立 stage；placement 等待 A |
| outcome staging 之后 crash | tool 绝不 replay；pending result 稍后 materialize |
| source-prefix placement 期间 crash | transaction 要么不暴露该 placement prefix，要么全部暴露 |
| safe replay 与旧 partial output | 在 replay emit 新 progress 之前删除旧的 bound checkpoint value |
| cancellation 与 real settlement | Session mutation 顺序选择 real cancelled-control result 或 synthetic reconciliation；最多只有一个 outcome stage |
| terminal finalization 与 late result | terminal ownership 获胜，或 outcome 先 stage；late task 绝不重建 operation data |
| external finalization 与 memo/checkpoint mutation | mutation 先行时由 terminal cleanup 移除；finalization 先行时使该 mutation 的 durable ownership 检查拒绝 |

## Invariant

1. `invocationId` 等于已预留的 result entry ID，并在 safe replay 中保持稳定。
2. 处于 `outcome_ready` 或 `completed` 的 call 绝不再次执行。
3. 每个 `outcome_ready` call 恰好有一个完整的、匹配的 `pi.pending.entry` value。
4. Completed call 构成 source-ordered prefix。
5. 只有 source-ordered materialization 扩展该 prefix。
6. completed prefix 之后的并行 call 可以混合 planned、effect-pending 与 outcome-ready 状态。
7. Invocation memo 只在其 call 为 `effect_pending` 时存在。
8. Partial output 是 auxiliary 的，绝不确立 effect completion。
9. Unsafe synthetic result 显式声明已捕获的 output 不完整且 external outcome 未知。
10. Staging 一个 outcome 会原子地删除其 invocation memo 与 partial output。
11. Materialization 原子地插入不可变 entry 并删除其 staged pending value。
12. 迟到的 invocation capability 无法在 outcome settlement 或 operation loss 之后写入。
13. `step.do` value 只在其 memo write 提交之后被 memoize；effect 保持 at-least-once。
14. Operation terminal cleanup 不留下 tool args、invocation memos、partial output 或 staged outcomes。

## 必需的测试

### 状态与 restore

- 每个受信任的 planned/effect-pending/outcome-ready/completed projection 都在没有 auxiliary read 的情况下 restore；
- base restore 不审计 completed-prefix 或 execution-mode 关系；
- effect-pending 消费读取确切的必需 arguments 与可选的有界 checkpoint；
- outcome-ready 消费读取确切的 staged result；
- 缺失必需的 arguments 或 staged result 在消费它的 procedure 处失败，而不是 base restore；
- staging 之后 invocation memo 与 partial output 不存在；
- snapshot/activation 只在需要时 hydrate 确切的有界 checkpoint value。

### 并行排序

- B 与 C 在 A 保持 pending 时 stage；
- crash/reopen 证明 B 与 C 绝不 replay；
- A recovery 之后是一个 source-ordered 的 A/B/C placement transaction；
- 混合的 `[completed, outcome_ready, planned, effect_pending, outcome_ready]` 状态；
- immediate synthetic outcome 乱序 stage；
- all-terminating batch 在有序 placement 之后正确转换。

### Replay 与 interruption

- safe replay 使用已持久化的 arguments 与相同的 invocation ID；
- safe replay 保留 step memo 但清除旧的 partial output；
- 当前声明从 safe 降级为 never 会 interrupt；
- 在没有 checkpoint 以及有完整有界 checkpoint 的情况下的 unsafe recovery；
- synthetic result 是 error/incomplete/unknown，且绝不运行 `after_tool`；
- cancellation 绝不安全 replay 已 restore 的 call。

### Invocation memo 与 `step.do`

- 带 invocation-address scoping 的 set/get/delete memo；
- completed step 在 reopen 之后跳过 effect；
- memo commit 之前 crash 会重新运行 effect；
- memo commit 之后 crash 返回 memo；
- 若干 completed step 之后跟一个 interrupted step；
- 重复的 live step name 被拒绝；
- memo write 与 outcome staging 竞争；
- 在过期、cancellation outcome staging 与 external finalization 之后的 capability write 被拒绝；
- terminal cleanup 移除 crash 泄漏的 memo。

### Partial output

- 普通 update 保持 live-only；
- `checkpoint: true` 写入完整的有界 snapshot；
- tool 选择的 checkpoint cadence 与 duplicate suppression；
- bash 以 100 ms 发出 live snapshot，并最多每两秒请求一次不同的 checkpoint；
- 每个被选中的 checkpoint enqueue 一个 write，且在 tool settlement 时 await latest promise 意味着所有更早的 write 都已完成；
- outcome staging 之后的 checkpoint 无法重建该 address 的 value；
- Memory、JSONL 与 SQLite restore 相同的 checkpoint value；
- JSONL 增长遵循 checkpoint cadence 而不是原始 bash output 量；
- terminal compaction 依据既有的 dead-byte policy 回收被取代/已删除的 checkpoint snapshot。

### Atomicity 与 instrumentation

- 确切的 intent、synchronous update acceptance、asynchronous update-delivery、`after_tool`、outcome-ready staging、post-commit `tool_end`、source-ordered message lifecycle 与 materialization 顺序；
- outcome staging 与 memo/output cleanup 原子；
- materialization 与 pending deletion、usage、tip 和 state 原子；
- 在每个边界处 crash；
- 在 intent 之前不启动任何 effect；
- 不从 `outcome_ready` 启动任何 effect 或 hook；
- terminal transaction 移除每个 operation-owned tool value。

## 实现映射

预期的 runtime 区域：

- `packages/agent/src/harness/session/types.ts` 中的 operation-state 类型；
- 受信任的 restore projection 与确切的 consumption-time address 读取；
- tool-batch procedure 与 source-ordered materialization；
- terminal cleanup 与 cancellation reconciliation；
- harness-specific 的 update options、snapshots 与 events；
- Session mutation line 上 invocation-scoped capability 的实现；
- 通过 bound value/list API 的 backend conformance；
- instrumented-storage transaction 断言。

`session/values.ts` 中具体的 built-in address constructor：

```text
operationToolMemo(operationId, invocationId, name) → value("pi.op.tool_memo", ...)
pendingToolOutput(operationId, invocationId)      → value("pi.pending.tool_output", ...)
pendingEntry(resultEntryId)                       → value("pi.pending.entry", ...)
```

在 progress checkpoint 之前实现 `outcome_ready` 与 invocation memo。该状态本身解决了不正确的 parallel replay；checkpoint 改善 reconnect observation 与 unsafe interruption diagnostics，而不会成为 completion authority。
