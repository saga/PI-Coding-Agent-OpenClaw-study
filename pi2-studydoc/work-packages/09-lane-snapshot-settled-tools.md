# Work package 09 — LaneSnapshot 中已 settled 但未放置的 tools

## 状态与基线

- Repository：`earendil-works/pi`
- handoff 创建时的 branch：`dev`
- Baseline commit：`d14d6b22327d545d6a253f932165b63e48d7f9c8`
- 用户在此 handoff 之前立即报告 worktree 干净。
- 本文档在 conversation compaction 之后作为一份 implementation handoff 开始，现在记录已实现的设计。它本身不是规范性 harness specification；`packages/agent/docs/harness.md` 仍然是规范性的。

## 目标

让每一个已开始或已 settled 但未放置的 tool call 在 `LaneSnapshot.operation.runningTools` 中保持可见，直到它不可变的 `toolResult` entry 被放置到 transcript 中。

预期的 projection 是：

```text
planned         → not yet represented in runningTools
effect_pending  → runningTools(status: "running")
outcome_ready   → runningTools(status: "settled")
completed       → transcript toolResult entry
```

对每一个在它成为 presentation-active 之后的 call，`runningTools` 和已放置的 transcript entries 不得有 gap 或 overlap。Placement 是一次 source-prefix flush，而不是 all-tools barrier。在它自己的 `entry_added` 上从 `runningTools` 移除一个 call，绝不在 `turn_end` 上。

## 原始 bug

一个 call 在 real-effect 完成与 source-ordered tree placement 之间消失了：

1. `packages/agent/src/harness/runtime/reducer.ts`：`tool_end` 把该 call 从 `runningTools` 中 splice 出去。
2. `packages/agent/src/harness/runtime/lane.ts`：`captureLaneSnapshot()`、`case "tools"` 只 projection `effect_pending` calls，并跳过 `outcome_ready` calls。
3. 已 finalize 的 result 已经在 `pendingEntry(resultEntryId)` 处 durable，但一个新的/reconnected snapshot 无法显示它。
4. 它只在 `entry_added` 放置了不可变的 `toolResult` entry 之后才重新出现。

对于一个并行 batch `[A, B, C]`，如果 B 在 A 仍 pending 时 settle，B 可能保持 `outcome_ready` 直到 A 就绪。如果 A 已被放置，B 可以在不等待 C 的情况下放置。因此清空 `turn_end` 上的所有东西是错误的：提前放置的结果会临时同时存在于 `transcript` 和 `runningTools` 中。

## 确认的当前架构

Mini **不** 复制 structural object deltas。

- `packages/coding-agent/src/experimental/mini/worker/lane-service.ts` 发送一个初始 full snapshot，然后转发单独的 `HarnessEvent` 对象。
- `packages/coding-agent/src/experimental/mini/tui/session.ts` 通过 `reduceLaneSnapshot()` 折叠那些 events。
- Reconnect/rebase 获取另一个完整 snapshot。
- `tool_update` 当前携带一个完整的 replacement progress result，而不是嵌套 diff。

`packages/agent/src/harness/runtime/drive/tools.ts` 中已实现的 durable tool flow：

```text
prepare
→ before_tool
→ intent commit (effect_pending + effective args), then tool_start
→ execute/update/checkpoint
→ after_tool
→ finalize
→ publishToolOutcome staging commit (pendingEntry + outcome_ready), then tool_end
→ materializeReady prefix placement
→ entry_added
```

所有真实的、immediate synthetic、cancellation 和 recovery outcomes 都通过 `publishToolOutcome()` 汇聚。

`Lane.settleOperation()` 支持 commit-bound events。它提交、发布进程本地状态、构造 event batch，public operation 等待 delivery。在并行执行中，`materializeReady()` 仅在 outcome-completion promise resolve 之后才被调度。因此，`tool_end` 在 staging 之后、placement 之前被投递。

## 商定的事件契约变更

**不要**添加 `tool_result_ready` 或 `tool_outcome_ready`。

相反，把 harness 的 `tool_start`/`tool_end` 重新定义为 tool-call processing/result lifecycle events，而不是专属的 real external-effect lifecycle events。

### 全新的已执行 call

```text
intent commit
→ tool_start
→ tool_update*
→ execute/finalize
→ TX[pendingEntry + outcome_ready + cleanup]
→ tool_end
→ source-ordered placement
→ entry_added
```

### 全新的 synthetic call

```text
TX[pendingEntry + outcome_ready]
→ tool_start
→ tool_end
→ source-ordered placement
→ entry_added
```

staging transaction 的 post-commit event batch 包含 `tool_start` 后接 `tool_end`，因此 watcher 无法在没有权威 staged state 的情况下观察到任一 lifecycle event。

Fresh synthetic calls 包括：

- unknown tool；
- argument preparation 或 validation failure；
- `before_tool` denial 或 invalid replacement arguments；
- 真实的 assistant `length`/truncated call handling；
- 在仍为 `planned` 时或在 intent 之后但 effect admission 之前的 cancellation。

### Recovery

Historical lifecycle events 不被重放。

- 一个 restored 的 `effect_pending` call 已由初始 snapshot 表示。
- Safe replay 从 checkpoint-clear commit 发出 recovery-tagged 的 `tool_start`，并从之后的 outcome-staging commit 发出 `tool_end`。
- Unsafe interruption synthesis 可能发出一个 recovery-tagged 的 `tool_end` 而不新发出 `tool_start`；初始 snapshot 提供了 running row。
- 一个已 restored 为 `outcome_ready` 的 call 在初始 snapshot 中显示为 settled，在 placement 之前不需要重放的 end event。

### `tool_end` 的含义

在此变更之后，`tool_end` 意味着：

> 完整的 final tool result 已 durable 地 staged，且该 call 为 `outcome_ready`。

它成为从 running 到 settled 的权威 reducer transition。它必须在 staging commit **之后**发出，而不是之前。

旧有的、真实执行结果与 synthetic 结果之间的区分是通过省略 lifecycle events 来编码的。没有 in-repo runtime consumer 要求该区分。如果希望保留它，请讨论添加一个显式字段，如 `execution: "executed" | "synthetic"`；该字段曾被讨论但**未获同意**，所以不要静默添加它。

## LaneSnapshot 类型

把 `packages/agent/src/harness/agent-harness.ts` 中的 `LaneSnapshot.operation.runningTools` 改为对 progress 和 final output 使用同一个 `result` 字段。不要在 snapshot 中保留单独的 `partialResult` 字段。

优先使用 discriminated union，使非法组合不可表示：

```ts
type SnapshotTool =
  | {
      status: "running";
      toolCallId: string;
      toolName: string;
      args: unknown;
      result?: AgentToolResult<unknown>; // latest complete progress snapshot
    }
  | {
      status: "settled";
      toolCallId: string;
      toolName: string;
      args: unknown;
      result: AgentToolResult<unknown>;  // complete finalized result
      isError: boolean;
    };
```

用户明确同意了该 discriminated union。

`tool_update.partialResult` 在 event API 中可以保持命名为 `partialResult`；reducer 把它赋值给 snapshot row 的统一 `result` 字段。

当前 mini transport 发送 semantic events，而不是 structural deltas，因此 `tool_end` 仍然携带完整的 final result，即使它等于最新的 update。统一 snapshot 字段仍然是正确的 state model。

## 精确的 reducer 行为

File：`packages/agent/src/harness/runtime/reducer.ts`

### `tool_start`

- 用 `matchingOperation(snapshot, event.runId)` 解析 operation。
- 按 `toolCallId` upsert；不要盲目 push。
- 设置 `status: "running"`、`toolName`、`args`。
- 如果替换一个已存在的 row，清除陈旧的 settled-only 字段。
- 不保留任何陈旧的 final result。一个新开始/replayed 的 call 可能接收后续的 `tool_update` values。

Upsert 是必需的，因为一次 watch 可能在缓冲的 `tool_start` event 被投递之前捕获到 durable 的 `effect_pending` state。

### `tool_update`

- 使用 `matchingOperation(snapshot, event.runId)`，而不是直接使用 `snapshot.operation`。
- 找到匹配的 row。
- 对一个 running row，用 `event.partialResult` 替换 `result`。
- 忽略 wrong-operation 或缺失的 rows。

### `tool_end`

- 用 `matchingOperation(snapshot, event.runId)` 解析。
- 按 batch-local `toolCallId` 找到已存在的 row；一次只有一个 tool batch 是 presentation-active 的。
- 用 `status: "settled"` 替换它，保留它的 arguments 并使用 `event.result` 和 `event.isError`。
- 这自然地移除了旧 `result` 的临时解释；没有单独的 `partialResult` 需要删除。
- Finalized result 保持显示直到 placement。

`tool_end` 不携带 arguments，也不能创建 row。Fresh synthetic `tool_start` 和 `tool_end` 在 staging commit 之后一起发出，消除了旧的 capture/event gap。Unsafe recovery 依赖初始 snapshot 的 running row。

### `entry_added`

如果 `event.entry` 是一个 role 为 `toolResult` 的 message，从 `snapshot.operation?.runningTools` 中移除匹配的 batch-local `toolCallId`，然后应用 transcript update。Harness events 是序列化的、受信任的、恰好发出一次且不历史重放的，因此既不需要 duplicate-entry handling，也不需要 cross-batch identity。

不要在 `turn_end` 上清除 tool rows。

## 精确的权威 capture 行为

File：`packages/agent/src/harness/runtime/lane.ts`、`captureLaneSnapshot()`、`case "tools"`。

assistant entry 已经被加载一次。对每一个 batch call：

### `planned`

Skip。它还没有成为 presentation-active。

### `completed`

Skip。它的 `toolResult` entry 必须已经在捕获的 transcript 中。

### `effect_pending`

- 校验 `assistant.message.content[sourceIndex]` 是匹配的 `toolCall` block。
- 读取 `operationToolArgs(operationId, turnId, sourceIndex)`；它对 effect-pending calls 是必需的。
- 读取可选的 `pendingToolOutput(operationId, resultEntryId)`。
- Project：

```ts
{
  status: "running",
  toolCallId: block.id,
  toolName: block.name,
  args: persistedArgs,
  ...(checkpoint === undefined ? {} : { result: checkpoint })
}
```

### `outcome_ready`

- 校验 source tool-call block。
- 读取 `pendingEntry(call.resultEntryId)`。
- 要求一个 role 为 `toolResult` 的 message payload。
- 针对 source block 校验 staged 的 `toolCallId` 和 `toolName`。
- 在存在时读取 `operationToolArgs(...)`。
- 使用 `persistedArgs ?? block.arguments`。Immediate synthetic calls 可能从未写入 `operationToolArgs`，而这种缺失只在 outcome-ready projection 中是合法的。
- 根据需要从 staged 的 `ToolResultMessage` 和 durable call termination flag 重建 canonical `AgentToolResult`。
- Project `status: "settled"`、`result` 和 `isError`。

event 和 capture 表示必须对 final result 做相同的规范化，使得通过 `tool_end` 折叠等于之后的一次权威 snapshot。注意可选的 `details`、`usage`、`addedToolNames` 和 `terminate`；不要依赖偶然的对象属性存在性差异。

对 `outcome_ready` 而言，一个缺失或不匹配的 staged result 是 presentation corruption，必须使 snapshot capture fault。

## Runtime 事件生产变更

Primary file：`packages/agent/src/harness/runtime/drive/tools.ts`

Related helpers：`packages/agent/src/harness/execution/tools.ts` 和 `packages/agent/src/harness/runtime/drive/tool-placement.ts`。

### 内部 outcome shape

当前：

```ts
type ToolOutcome = { message: ToolResultMessage<unknown>; terminate: boolean };
```

扩展/重构它，使 post-commit event production 拥有完整的 canonical final result 和 `isError`，而没有有损重建。它必须保留足够的数据用于：

- staged 的 `ToolResultMessage`；
- `tool_end.result`；
- `tool_end.isError`；
- cancellation normalization 之后 durable/effective 的 `terminate`。

Synthetic helpers 当前直接返回 `ToolResultMessage`。仔细重构，使 synthetic outcomes 也携带 canonical result data。不要在 transcript 中臆造 `details`：现有的 unknown/invalid synthetic results 有意省略 message details。

### Commit-bound 的 `tool_start`

对于 fresh execution，`publishToolIntent()` 把 `tool_start` 附加到持久化 effective arguments 并把该 call 变为 `effect_pending` 的那次 commit 上。public operation 在 admit `executeToolCall()` 之前等待 delivery，保留 `tool_start → tool_update*` 而无需每个 update callback 都等待 delivery。

对于一个从不写入 effect intent 的 fresh synthetic call，`publishToolOutcome()` 在 outcome-staging commit 的 event batch 中把 `tool_start` 附加在 `tool_end` 之前。它报告 source block arguments。

对于 safe recovery，checkpoint-clear commit 使用持久化的 effective arguments 发出 recovery-tagged 的 `tool_start`。不要为一个已 restored 的 unsafe `effect_pending` call 发出 fresh start；它的初始 snapshot 就是基线。

### Post-commit 的 `tool_end`

从 `performToolInvocation()` 中移除当前 pre-staging 的 `tool_end` emission。

`publishToolOutcome()` 把 `tool_end` 附加到同一个 staging command 的 `events` callback。该 event 携带：

- `runId`、`turnId`、`toolCallId`、`toolName`；
- canonical final `result`；
- `isError`；
- cancellation-normalized 的 durable `terminate`；
- 在适用时 `recovery: true`。

Arguments 属于 `tool_start`，不在 `tool_end` 上重复。Event data 描述实际提交的状态，尤其是 cancellation 强制 `terminate: false`。

因为 `Lane.command()` 等待保留的 event delivery，且 `runParallel()` 从 outcome-completion promise 调度 materialization，所以要求的顺序是：

```text
staging commit
→ tool_end delivery
→ source-ready message lifecycle
→ placement commit
→ entry_added
```

### 需审计的 call sites

每一个 `publishToolOutcome()` 调用都必须正确地提供 source tool call 和 recovery context：

- `startToolInvocation()` 中的 immediate outcome；
- intent 之后但 execution 之前的 cancellation；
- 正常的 `performToolInvocation()` completion；
- safe replay completion；
- unsafe recovery interruption；
- `planned` 的顺序 cancellation；
- `effect_pending` 的顺序 cancellation。

还要审计 `performToolInvocation()` 内部的同步 `AbortRequested` path：一个带 durable intent 的 call 即使 effect admission 立即失败，也必须有一致的 start/end presentation。

## Mini 和其他 presentation consumers

### Mini

File：`packages/coding-agent/src/experimental/mini/tui/view.ts`、`MiniTui.apply()`。

对每一个 `runningTools` row：

```text
status running:
  markExecutionStarted()
  if result exists: updateResult({...result, isError:false}, true)

status settled:
  do not call markExecutionStarted()
  updateResult({...result, isError}, false)
```

Final result 在等待 placement 期间保持可见。在 `entry_added` 之后，transcript synchronization 提供不可变的 `ToolResultMessage`，该 row 不再位于 `runningTools` 中。

### 其他 shared consumer

在以下位置应用等效处理：

- `packages/coding-agent/src/experimental/client-tui-chat.ts`

在编辑之前阅读 `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`，以确认 `updateResult(result, isPartial)` 语义。

## 测试

### Reducer tests

File：`packages/agent/test/harness/runtime/reducer.test.ts`

添加一个带 calls 0、1、2 的并行 batch event-fold 测试：

1. 把三个都建立为 running。
2. Call 2 在 call 0 之前 settle。
3. Call 0 settle 并在 call 1 仍在运行时被放置。
4. Call 1 settle。
5. Placement 按 source order flush calls 1 和 2。
6. 在每一个 settlement 和 placement event 之后，断言每一个 presentation-active call 恰好出现在以下之一中：
   - `operation.runningTools`；或
   - transcript `toolResult` entries。
7. 断言 call 2 在被更早的 calls 阻塞期间，仍以 `status:"settled"` 和它的 final result 存在。
8. 断言每一个 `entry_added` 只移除它匹配的 active row。

添加针对以下内容的聚焦覆盖：

- 来自陈旧/错误 `runId` 的 `tool_update` 不修改当前 operation；
- `tool_start` 对从 durable intent 捕获的 row 进行 upsert 而非 duplicate；
- `tool_end` settle 已存在的 batch-local row。

### Capture/watch tests

File：`packages/agent/test/harness/runtime/watch.test.ts`

构造一个 durable tools state，包含：

- `planned`（省略）；
- 带 checkpoint 的 `effect_pending`（`status:"running"`，checkpoint 作为 `result` 暴露）；
- 不带 checkpoint 的 `effect_pending`；
- 带持久化 effective args 的真实 `outcome_ready`；
- 不带 `operationToolArgs`、回退到 source block arguments 的 synthetic `outcome_ready`；
- 在可行处仅由一个 transcript entry 表示的 completed call。

断言 staged settled content、`isError`、arguments 以及没有重复。添加缺失/不匹配的 `pendingEntry` corruption 断言。

### Runtime tool tests

File：`packages/agent/test/harness/runtime/drive-tools.test.ts`

更新/添加 ordering 断言以证明：

- real：`intent commit < tool_start < tool_update* < staging commit < tool_end < entry_added`；
- immediate synthetic：`staging commit < tool_start < tool_end < entry_added`，没有 tool effect 也没有 `after_tool`；
- planned cancellation 获得一致的 start/end；
- unsafe recovery 使用初始 snapshot 加上 recovery-tagged end，而不重放 effects；
- B 可以发出 post-commit end 并在 A 阻塞 placement 时保持 settled；
- source-order placement 保持不变；
- staging 之后的 crash 不能重放该 call。

baseline 的规范性测试/文档要求 `tool_end` 在 staging 之前；该实现有意反转了那些预期。

### Type/event catalog tests

审计：

- `packages/agent/test/harness/types.test.ts`
- `packages/agent/src/harness/telemetry.ts`

不添加任何新的 event name。`tool_end` 省略 arguments 且其语义改变。

### Mini regression

在 unit tests 之后，运行此前使用的真实 mini abort smoke test：

- 精确执行 `sleep 20`；
- 大约两秒后发送 Escape；
- 断言出现 `Command aborted` 和 elapsed time；
- 断言 raw ANSI 包含 `toolErrorBg`（`48;2;60;40;40`）；
- 验证 durable session 包含一个 `isError:true` 的 tool result 和 operation status `aborted`。

还要演练一个并行 batch，其中一个更晚的 tool 先完成，并验证它的 final result 在 in-order placement 之前保持可见。

## 文档变更

编辑之前完整阅读两份文档：

- `packages/agent/docs/harness.md`（规范性）
- `packages/agent/docs/tool-durability.md`

该实现更新了那些要求以下内容的 baseline 陈述：

- staging 之前的 `tool_end`；
- `tool_start`/`tool_end` 仅用于 real effects；
- synthetic outcomes 不发出 lifecycle；
- `outcome_ready` 被从 `runningTools` 中省略；
- snapshot 字段 `partialResult`。

baseline 中重要的已知位置：

- `harness.md` §3.8，约 lines 784–796；
- `harness.md` §5.4 `LaneSnapshot`，约 lines 1101–1134；
- `harness.md` §5.5 events，约 lines 1140–1158；
- `harness.md` tool phases，约 lines 1214–1224；
- `harness.md` conformance requirements，约 lines 1386–1400；
- `tool-durability.md` finalization，约 lines 255–280；
- `tool-durability.md` snapshots/events，约 lines 568–584；
- `tool-durability.md` test requirements，约 lines 671–679。

修订后的文档必须陈述：

- `tool_end` 是 final result 的 post-staging durability evidence；
- fresh synthetic outcomes 接收 start/end lifecycle；
- recovery events 不历史重放；
- `outcome_ready` 在 placement 之前保持 projection 为 settled；
- `entry_added` 把 settled presentation 移入 transcript；
- 统一的 snapshot `result` 在 running 时是临时的，在 settled 时是最终的。

除非单独要求，不要修改独立的 `response.ts`/`tool-placement.ts` recovery `turn_end` discrepancy。

## Compaction 之后需完整重读的文件

Core/specification：

1. `packages/agent/docs/harness.md`
2. `packages/agent/docs/tool-durability.md`
3. `packages/agent/src/harness/agent-harness.ts`
4. `packages/agent/src/harness/runtime/reducer.ts`
5. `packages/agent/src/harness/runtime/lane.ts`
6. `packages/agent/src/harness/runtime/drive/tools.ts`
7. `packages/agent/src/harness/runtime/drive/tool-placement.ts`
8. `packages/agent/src/harness/execution/tools.ts`
9. `packages/agent/src/harness/runtime/types.ts`
10. `packages/agent/src/harness/session/types.ts`
11. `packages/agent/src/harness/events.ts`
12. `packages/agent/src/harness/telemetry.ts`

Tests：

13. `packages/agent/test/harness/runtime/reducer.test.ts`
14. `packages/agent/test/harness/runtime/watch.test.ts`
15. `packages/agent/test/harness/runtime/drive-tools.test.ts`
16. `packages/agent/test/harness/types.test.ts`
17. 那些文件导入的相关 test helpers。

Mini/presentation：

18. `packages/coding-agent/src/experimental/mini/tui/session.ts`
19. `packages/coding-agent/src/experimental/mini/worker/lane-service.ts`
20. `packages/coding-agent/src/experimental/mini/shared/protocol.ts`
21. `packages/coding-agent/src/experimental/mini/tui/view.ts`
22. `packages/coding-agent/src/experimental/client-tui-chat.ts`
23. `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`

在编辑之前，运行 `git status --short` 并检查当前 diffs，因为其他 Pi sessions 可能共享该 worktree。

## 验证命令

从 repository root，在变更之后：

```bash
cd packages/agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/harness/runtime/reducer.test.ts
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/harness/runtime/watch.test.ts
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/harness/runtime/drive-tools.test.ts
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/harness/types.test.ts
cd "$(git rev-parse --show-toplevel)"
npm run check
```

除非被要求，不要运行 `npm test`、完整 Vitest suite 或 `npm run build`。

如果使用委派的审查，repository policy 要求：

```text
--provider anthropic --model claude-fable-5
```

保持 extensions 启用。

## 非目标

- 不为 mini 提供 generic structural-delta transport。
- 不做任何优化来避免 final result 在 `tool_end` 中过一次 wire，又在 `entry_added` 中再过一次。
- 不改变 source-prefix placement 语义。
- 不在 `turn_end` 上清除。
- 不改变 tool effect replay/durability 规则。
- 不改变 `after_tool`：在它现有的 cancellation contract 下，它仍然只对实际的 fresh/safely replayed effects 运行。
- 不处理 `response.ts` 与 `tool-placement.ts` 之间独立的 recovery `turn_end` discrepancy。
- 不添加 backward-compatibility layer，除非用户明确要求。
- 除非用户要求，不要提交。
