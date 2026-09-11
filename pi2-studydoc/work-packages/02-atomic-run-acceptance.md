# WP02 — 原子性验收与连贯的 lane 观察

## 状态

已完成。Phase A 建立了最小 attachment、open-operation 清单、Session-line 检查/watch 捕获、commit-continuation 接收者绑定，以及带内 identity 失败词汇。Phase B 落在 `beac75ecc` 中，focused、monorepo-check、full-suite 以及最终的 Fable 审查均通过。

实现还更新了变更后的公共契约所要求的下游 protocol/coding-agent wire projection。没有添加任何执行 owner、provider/tool effect、timer、retry、polling、cancellation 流程、manual action 或 terminal settlement。

## 目标

交付两个无 effect 的边界：

```text
idle lane
→ atomic prompt/skill/template acceptance
→ durable open operation in payload-free starting

open or running lane
→ Session-line watch capture
→ complete snapshot plus gap-free subsequent events
```

在 `AgentHarness.create(options, context)` 成功之后：

- 每个已配置的 lane 都拥有一个完整的、小的、进程本地 projection；
- `open` 清点每一个 durable current operation，而不预测 model/tool 的可用性；
- attachment 不启动任何 hook、provider、tool、timer、breakpoint、drive owner 或 application callback；
- `inspectExecution(context)` 在 Session line 上观察小 projection 与本地 owner；
- `watch(context)` 在一个 no-write lane job 中注册 buffering、克隆 live presentation，并执行有界的 snapshot 读取；
- 每个 committing lane job 都发布 memory，并在 commit continuation 中同步绑定其 event batch；
- 该 mutation 不等待 listener 投递，而公共 operation 会等待。

WP02 不实现 drive、provider generation、hooks、tools、retries、deferred polling、cancellation 流程、manual action 执行或 terminal settlement。

## 决策

### 1. Attachment 恢复的是 projection，而非 presentation

将 open Session 传给 `AgentHarness.create()` 会转移 orchestration 所有权，直到 create 拒绝或 harness 关闭。在该时间区间内，禁止直接 `Session.mutate`、`Session.createLane`、reserved-address 写入以及第二个 harness 的构造，因此 lane 清点不可能与带外 lane 创建发生竞态。

Attachment 只读取：

- `branchTip`、`laneConfig`、`laneState`，可选的 `laneLastResult`；
- 针对当前 operation 的 `operationMeta` 与 `operationState`。

它校验必需的存在性、operation id/lane 所有权，以及 intent/state kind 的兼容性。Projection 损坏会使 `create()` fault。

Attachment 不读取 transcript、queues、pending writes、drained payloads、deferred sources、frames、tool calls、arguments、checkpoints、preparations、memos 或 staged outcomes。这些引用在被消费时由 `watch()` 或 drive 检查。缺失或自相矛盾的必需 payload 数据属于 terminal storage corruption，会使该消费者 fault。可选的 frame/checkpoint 缺失是合法的。

### 2. Watch 拥有详细 snapshot 读取

一个 no-write Session mutation job 定义了 watch 边界：

```text
enter after all earlier lane jobs
→ synchronously register buffering watcher
→ synchronously clone live presentation state
→ perform bounded durable reads while later lane jobs are excluded
→ assemble snapshot
→ release Session line
→ return handle
```

没有特殊的 first-watch cache。同一条路径处理紧接 attachment 之后的 watch、reconnect，以及 live execution 期间的 watch。

有界读取集为：

- 从当前 tip 开始的一次 compaction 限界 branch scan；
- 针对 next-run、steer、follow-up、writes 和 abort drains 的精确 `pendingEntry(id)` 读取；
- 在被表示时精确的 deferred source entry；
- tools-phase assistant entry 以及被表示的 `effect_pending` 调用的精确 args，使用 `batch.turnId` 作为 args step id；
- 有界的精确 assistant-frame pages 以及精确的可选 tool checkpoints。

`ToolCall.sourceIndex` 是 assistant message 完整 content 数组中的索引，而不是过滤后的 tool-call 序号。被表示的 call 必须索引到一个 tool-call block。

### 3. 接收者绑定属于 commit continuation

一个成功的 committing lane job 执行：

```text
commit
→ publish small owned projection
→ synchronously bind recipients and append the complete `{ event, context }` batch
→ return from the mutation without awaiting delivery
→ await delivery before the public operation resolves
```

WP02 最初用 `enqueue()` 加上由调用方操作的 `start()` 来实现这一点。WP04 用同一个 commit-observation continuation 中的一次立即的 `emitBatch()` 调用取代了那道 gate。接收者绑定与投递等待保持不变。在 `emitBatch()` 之后注册的 listener 或 watcher 无法收到那个历史 event。

唯一的 watcher/publication 顺序是：

```text
watcher first
→ snapshot-before + complete buffered event batch

publication/`emitBatch` first
→ snapshot-after + no old event
```

live provider/tool presentation 更新遵循同样的同步 publish-plus-`emitBatch` 纪律。Frame/checkpoint commits 是 lane jobs，排在 watch capture 之后。

### 4. 检查是一次 no-write 的 Session-line 观察

`inspectExecution(context)` 观察：

- lane 与 tip；
- 已配置的 model identity，表示为未解析的 `{ provider, modelId }` 字符串；
- 当前 operation 的 id/kind/start time；
- 进程状态 `running`、`open` 或 durable `aborting`；
- 当当前 durable phase 包含 model identity 时捕获到的 model identity；
- 可选的最新 result。

它不解析 model/tool registries，也不读取 transcript 或 presentation payloads。

### 5. 缺失的实现是带内 outcome

没有 `blocked`、missing-identity suspension、predictive classifier 或 acceptance registry preflight。

在实际的执行边界处：

- 在 provider intent 之前不可用的 captured model 或已配置的 active-tool definition 会变成不可重试的 configuration failure；
- pre-intent configuration failure 不预留 response/usage ids，也不伪造 assistant response 或 usage row；
- 已恢复的 `effect_pending` 在任何后续 configuration failure 之前，于其现有 reserved ids 下了结不确定性；
- 不可用的 deferred model 通过 configuration failure 以 durable 方式放弃 redemption；R7 实现并测试已恢复的 `effect_pending` 放弃，包括删除其精确的旧 assistant-frame 列表，同时丢弃 reserved response/usage 字符串而不伪造 settlement；
- 缺失的被请求 tool 会暂存一条直接的 `isError` `ToolResultMessage` 并继续；
- 缺失/不再安全的 replay 实现会合成 interruption，而不是等待。

合成的 harness tool results 省略 `details`。一个 tool 拥有其 details 契约的类型；harness 不得凭空造出 `{}` 或诊断对象。`isError` 与人类可读内容承载 tool 层级的诊断。Run 层级的 configuration failure 通过 `OperationError` 与 `laneLastResult` 保持机器可读。

稳定的 configuration error codes：

- `model_unavailable`，details `{ provider, modelId }`；
- `configured_tools_unavailable`，details `{ tools: string[] }`。

`failure_drain` 获得 `{ kind: "configuration" }` provenance。实际的 transition 随其所属的 execution packages 一起落地；WP02 只落地规范性/源码词汇。

### 6. 验收独立于进程 registries

验收校验的是 durable caller input 与 lane state，而不是当前的 model/tool registrations。这避免了一次 time-of-check/time-of-use 检查，并允许在一个进程中验收、在另一个进程中执行。

一个配置错误的 convenience prompt 最终会从 drive 返回一个 durable failed run。显式的 hosted acceptance 即使在 execution worker 加载实现之前也保持 durable。

### 7. 调用 Context 保持显式

每一个当前公共 harness/lane operation 都接收尾随的 `context: Context`。Acceptance、attachment、watch capture、Session reads/commit、faults 以及 event publication 都保留它。共享的 harness/lane/Session receivers 不保留任何调用方的 Context。Context 及其 signal/telemetry 值永远不是 durable business data。

Buffered events 保留精确的 emitting Context。Invocation cancellation 与 durable `requestAbort()` 保持区分。

## 终态公共契约

```ts
export interface ModelIdentity {
  provider: string;
  modelId: string;
}

export type OperationStatus = "running" | "open" | "aborting";

export interface OpenOperation {
  lane: string;
  operationId: string;
  kind: "run" | "compaction" | "navigation";
  startedAt: number;
  aborting?: true;
}

export interface CurrentOperationInfo {
  id: string;
  kind: "run" | "compaction" | "navigation";
  startedAt: number;
  status: OperationStatus;
  capturedModel?: ModelIdentity;
}

export interface LaneExecutionInfo {
  lane: string;
  tipId: string | null;
  configuredModel: ModelIdentity;
  current: CurrentOperationInfo | null;
  lastResult?: LaneLastResult;
}

export interface LaneInfo {
  name: string;
  tipId: string | null;
  operation: CurrentOperationInfo | null;
}

export interface AgentHarnessConstructor {
  create<TContext extends object | undefined = object | undefined>(
    options: AgentHarnessOptions<TContext>,
    context: Context,
  ): Promise<{ harness: AgentHarness<TContext>; open: OpenOperation[] }>;
}
```

规则：

- `open` 对每个 durable current operation 恰好有一个条目，并省略 idle lanes；
- `aborting:true` 只来自 durable `cancel_requested`；
- `open` 是清点，不是 scheduling 或 identity 建议；
- 普通应用建立 watch 并调用 `resume(context)`；
- hosted schedulers 保留 expected-id `drive` fencing；
- configured/captured identity 字段是 durable 字符串，可能无法解析。

### Outcomes

删除 `MissingIdentitySuspension`、`MissingIdentities`、missing-identity drive waiting，以及 missing-identity suspension events。

将 deferred suspension 保留为 provider semantics：

```ts
{ kind: "suspended"; reason: "deferred"; ... }
```

WP05 在执行被启用之前移除已撤回的 action outcome。Convenience operation outcomes 保持为 `ResumeOutcome` 的带 operation 标记的分支。

### Snapshot

```ts
export interface LaneSnapshot {
  lane: string;
  transcript: Entry[];
  tipId: string | null;
  lastResult?: LaneLastResult;
  operation: null | {
    id: string;
    kind: "run" | "compaction" | "navigation";
    startedAt: number;
    status: OperationStatus;
    action?: ActionInfo;
    retry?: { attempt: number; maxAttempts: number; nextAttemptAt: number };
    deferred?: { handle: DeferredHandle; poll: number };
    drained?: { steer: QueuedItem[]; followUp: QueuedItem[] };
    streamingMessage?: AssistantMessage;
    runningTools: {
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult?: AgentToolResult<unknown>;
    }[];
  };
  queues: { steer: QueuedItem[]; followUp: QueuedItem[]; nextRun: QueuedItem[] };
  pendingWrites: {
    entryId: string;
    type: EntryType;
    customType?: string;
    message?: AgentMessage;
    data?: JsonValue;
  }[];
  faulted: boolean;
}
```

Configuration 不在 snapshots 中重复。`inspectExecution()` 暴露 configured/captured model identities；getters 暴露当前 configuration。

## 原子性 run 验收

WP02 为 prompt、skill 和 prompt-template 请求实现 `accept()`。Compaction/navigation 验收仍留在它们各自的 execution packages 中。

与状态无关的 normalization 发生在 `Lane.command(plan, context)` 之前：

- prompt strings/images；
- 提供的 message 或 message array；
- 显式的 skill formatting；
- prompt-template formatting；
- pending assistant rejection；
- 未知 skill/template 错误；
- 提供或铸出的 operation 与 prompt-entry ids。

公共 prompt convenience 重载仍然恰好是 `[text, images | undefined, context]` 和 `[messageOrMessages, context]`，但 convenience 实现保持 `SliceNotImplemented` 直到 R2。

在一个 lane command 内部：

1. 拒绝 busy；
2. 捕获当前的 `pendingNextRun` ids；
3. 读取并校验捕获到的 pending messages；
4. 拒绝零条被放置的 messages；
5. 让捕获到的 next-run entries 成为 request prompt entries 的 parent；
6. 恰好提交一次；
7. 发布小 owned projection；
8. 用 acceptance event batch 和 accepting Context 同步调用 `emitBatch`；
9. 从 mutation callback 返回而不等待投递；
10. 在 `accept` resolve 之前等待 event 投递。

精确写入：

```text
insert captured nextRun message entries
insert request prompt entries
delete captured pendingEntry values
set branchTip
set operationMeta
set operationState(run starting)
set laneState(current operation, pendingNextRun=[])
```

精确 event 顺序：

```text
run_start
for each placed message:
  message_start
  message_end
  entry_added
queue_update if nextRun was captured
```

Acceptance 不启动任何 drive 或 effect，也不写入任何 Context。

## Phase A — 规范性重写

在 runtime source 之前更新 `harness.md`：

- 用最小 projection restore 取代 eager attachment hydration；
- 用 open inventory 取代 predictive status/classifier；
- 规定 configured/captured identity 检查而不做解析；
- 把详细读取移到 ad-hoc Session-line watch capture；
- 要求在精确的 commit-observation continuation 中进行接收者绑定；
- 移除 identity preflight/suspension/error/event 类型；
- 规定带内 model/tool 不可用性与 configuration provenance；
- 要求直接的、无 details 的合成 tool-result messages；
- 更新 invariants、races、roadmap、glossary 和 Appendix C。

Review stop：

1. `git diff --check`；
2. 全新的 Terra 矛盾/源码可行性审计；
3. 针对完整 docs 与 source 的 full-context Fable review；
4. 解决所有 findings，并重复直到没有 findings；
5. 在 runtime source 之前获得用户批准。

## Phase B — 实现

### 公共与 durable 类型

修改 `agent-harness.ts`：

- 移除 `SuspendedOperation`、`MissingIdentityInfo`、`MissingIdentities`，以及 missing-identity outcome/event 分支；
- 添加 `ModelIdentity`、`OperationStatus`、`OpenOperation`，以及修正后的 inspection/snapshot 类型；
- 把 create 的结果从 `suspended` 改为 `open`；
- 落地带 operation 标记的 action-required outcome families；
- 修正 `executeAction`/`runToCompletion` 签名；
- 在所有地方保留尾随的 Context。

修改 session types：

- 添加 `failure_drain` configuration provenance；
- 添加已经是规范性的 `ToolCall.outcome_ready` 词汇，不带 producers；
- 将 `sourceIndex` 记录为完整 assistant-content 索引；
- 向 `SessionReader` 添加 callback-scoped 的 `scanBranch`；被 `SessionMutator` 与 `Session` 继承是有意为之；
- 在 `StorageBackedSession` 及其 mutator 和 `MemorySessionFacade` 中实现它；Session mutation authority 保持进程本地，并且没有远程 Session facade。

### Event 发布

WP02 最初添加了带保留 delivery gate 的同步接收者绑定。WP04 只取代该机制：

- `HarnessEventBus.emitBatch()` 同步快照 ordinary 与 watcher 接收者；
- 投递只使用那个已绑定列表；
- watcher buffers 保留 `{ event, context }`；
- 在 `emitBatch` 之后注册的 watcher 从该 event 中什么也收不到。

`LaneCommand` 的 commit 决策保留一个同步的 post-commit event batch。commit 成功后，`Lane.command` 发布 `next`，作为其最后一个 mutation action 调用 `emitBatch`，并把 delivery promise 带出 `Session.mutate` 之后再等待它。每一个现有的产生 event 的 commit 都使用这条路径，包括直接的 idle/pending appends、lane configuration setters，以及 session-name/entry-label setters。

WP04 还把 harness lane publication 移入 `Session.createLane` 的 committed-publication callback。Session 提交，Harness 在该 continuation 中发布 `lanesByName` 并调用 `emitBatch(lane_created)`，而 Session 在释放该 line 之后等待保留的 delivery promise。

不要在 line 上执行 listeners。

### Attachment

保持 `restore.ts` 仅做 projection。校验 lane/operation 所有权与 kind 兼容性。从 `createAgentHarness` 中移除 `describeSuspension` 和所有 payload hydration。构造 lanes 并返回 `open` 清点，而不解析 registries。

### 检查

将 `inspectExecution(context)` 实现为一次 no-write 的 `Lane.command` 观察。从当前 durable phase 推导 captured model identity。不读取任何 storage payloads，也不解析任何 registry identities。

### Watch

将 `watch(context)` 实现为一个 no-write lane job：

- 同步注册 watcher 并克隆 live presentation；
- 通过 callback-scoped readers 执行上述有界读取矩阵；
- 组装隔离的 snapshot payloads；
- 在必需的 corruption 上 fault 并取消订阅；
- 保留合法的可选缺失；
- 在返回之前释放该 line。

允许一个 focused 的内部 snapshot helper。不要创建持久化的 hydrated presentation cache 或 generic reducer。

### 范围之外

`drive`、`resume`、prompt convenience、compaction/navigation acceptance、abort/queues、`executeAction` 和 `runToCompletion` 在尚未实现的地方保持 `SliceNotImplemented`。

Provider/tool/configuration-failure 的 transitions 现在已被规定，但由 R2/R3/R4/R7/R8 实现。WP02 不添加任何 effect、active operation、timer、hook、provider request、tool execution、retry、deferred fetch、cancellation reconciliation 或 terminal transaction。

## 必需的测试

### 公共类型

- `SuspendedOperation`、`MissingIdentities` 以及 missing-identity status/outcomes/events 不存在；
- open/current/status unions 可穷尽地收窄；
- configured 与 captured model identities 是未解析的字符串；
- action-required outcome families 与方法签名匹配；
- prompt 重载元组保持精确；
- `AgentHarnessOptions` 没有 receiver telemetry default。

### 验收

- 仅文本、仅图片、文本加图片、提供的数组；
- pending assistant rejection；
- skills/templates 与未知 resources；
- 空输入不写入任何内容，除非捕获到的 nextRun 提供输入；
- 没有 identity registry preflight；
- 提供/铸出的 operation ids；
- 精确写入、parent chain、metadata、starting state、settings、commit materialization；
- pending-next-run 的捕获/删除；
- busy run/structural operation；
- 一个并发的 accept winner；
- commit failure 与 close races；
- 精确的 event 顺序与 object-identical 的 accepting Context；
- 不调用任何 hook、provider、tool、timer、drive-owner 或 option callback；passive event-listener delivery 仍然必需。

### Attachment 与检查

- idle 被省略，每个 open operation 都被清点；
- durable cancellation 只设置 `aborting:true`；
- create 时不读取 transcript/pending/frame/tool；
- configured 与 captured model identities 可能不同，且在未解析时仍然可见；
- 检查在 Session line 上运行，且不执行任何 payload 读取；
- projection corruption 会使 create fault；
- 不启动任何 option callback/effect。

### Event 发布与 watch

- 接收者集合在 `emitBatch` 时绑定：在 publication 之后、delivery 之前注册的 watcher 什么也收不到；
- state/event batch publication 发生在 Session-line release 之前；
- direct append、lane configuration、session-name/entry-label、acceptance 以及 lane-creation commits 全部使用那条 publication 路径；
- `value_update` 与 `lane_created` 在它们的 commit continuation 中绑定接收者，因此更晚的 listeners 两个历史 event 都收不到；
- watcher-first 给出 snapshot-before 加上完整 events；
- publication-first 给出 snapshot-after 且不带旧 events；
- awaited capture 期间的 live update 只作为克隆的 live snapshot 之后的一个 buffered event 出现；
- frame/checkpoint mutations 排在 capture 之后；
- first watch 与 reconnect 使用同一条路径；
- 精确的 transcript、queues、writes、drain、deferred、frame、tool args/checkpoint 字段；
- 必需的 payload corruption 会使 watch fault 并移除 watcher；
- 缺失的 frames/checkpoints 省略可选的 partials；
- pre-registration lifecycle 不被重放；
- buffered events 保留 object-identical 的 emitting Context；
- payload mutation 不能影响之后的状态/listeners；
- close/fault lifecycle 与 event bus 匹配。

### 带内 identity 词汇

Type/direct-state 测试证明：

- acceptance 没有 `MissingIdentities` 路径；
- configuration failure provenance 与稳定 error codes 可被表示；
- deferred configuration abandonment 仍然分配给 R7，而不是在这里添加一个 execution transition；
- missing-tool 合成的 `ToolResultMessage` 可以省略 `details`；
- sourceIndex 使用完整 assistant-content 索引；
- outcome-ready calls 不被渲染为 running。

WP02 中不添加任何 execution transition。

## 文件

### 添加

- `packages/agent/test/harness/runtime2/accept.test.ts`
- 如果现有文件变得过大，则添加 focused watch tests。

### 修改

- `packages/agent/docs/harness.md`
- `packages/agent/docs/work-packages/02-atomic-run-acceptance.md`
- `packages/agent/src/harness/agent-harness.ts`
- `packages/agent/src/harness/events.ts`
- `packages/agent/src/harness/session/types.ts`
- `packages/agent/src/harness/session/session.ts`
- `packages/agent/src/harness/session/memory.ts`
- `packages/agent/src/harness/session/remote.ts`
- `packages/server/src/remote-session-manager.ts`
- `packages/agent/src/harness/runtime2/harness.ts`
- `packages/agent/src/harness/runtime2/lane.ts`
- `packages/agent/src/harness/runtime2/restore.ts`
- `packages/agent/src/harness/runtime2/types.ts`
- `packages/agent/test/harness/runtime2/harness.test.ts`
- `packages/agent/test/harness/runtime2/lane.test.ts`
- `packages/agent/test/harness/runtime2/restore.test.ts`
- `packages/agent/test/harness/types.test.ts`
- `packages/agent/test/harness/storage-backed-session.test.ts`
- `packages/agent/test/harness/memory-session-repo.test.ts`
- `packages/server/test/conformance.test.ts`
- 接收者绑定与 callback-scoped branch reads 所需的 event/session 测试文件。

不预期有 backend schema、telemetry schema、coding-agent 或 changelog 变更。如果其中一个变得必要，则停下来做边界审查。在 `dev` 上，推迟 changelog 条目。

## 验证

Phase A 之后：

```bash
git diff --check -- \
  packages/agent/docs/harness.md \
  packages/agent/docs/work-packages/02-atomic-run-acceptance.md
```

Phase B 之后：

```bash
cd packages/agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run \
  test/harness/runtime2/accept.test.ts \
  test/harness/runtime2/harness.test.ts \
  test/harness/runtime2/lane.test.ts \
  test/harness/runtime2/restore.test.ts \
  test/harness/types.test.ts

cd "$(git rev-parse --show-toplevel)"
git diff --check
npm run check
./test.sh
```

报告 runtime2 source 行数。同步的 pre-WP02 runtime2 baseline 是 967 行；把超过 1,900 source 行的增长视为一次 design review 的触发条件，而不是目标。

## 停止条件

在以下情况停止：

- acceptance 恰好提交一次进入 payload-free 的 `starting`，且没有 registry preflight；
- attachment 返回最小完整 projections 与 open inventory；
- 检查是一次连贯的 Session-line no-write 观察；
- watch 在 Session line 上 ad hoc 捕获详细状态；
- state publication 与 `emitBatch` 接收者绑定发生在 commit continuation 中，而 mutation 从不等待投递；
- snapshots 与 buffered events 没有间隙或重复；
- 必需的 payload corruption 使其消费者 fault；
- 不引入任何 execution effect 或 owner；
- focused tests、`npm run check` 和 full tests 通过；
- 最终的 Fable review 没有 findings。

不要开始第一个真正的 drive package。
