# 现有 AgentHarness runtime 简化

## 范围

改造 `packages/agent/src/harness/runtime/` 下的真实实现以及 `packages/agent/src/harness/session/types.ts` 中的规范 durable 类型。这不是孤立的 scratch spike。

execution graph 是 total 的，且 public drive 已启用。Format 4 仍是进行中的工作，因此 durable 类型替换不需要 migration 或 compatibility representation。

## 实现状态

M6 之前的完成度测量：

- 简化前的 runtime 位于 `eb1185d93`：5,358 行 TypeScript；
- 第一次简化后的 runtime 位于 `417905647`：4,667 行；
- 简化后的 substrate 位于 `0e77e57d9`：4,654 行；
- M6 之前的总体缩减：704 行（13.1%）。

由简化过程实现：

- 显式的 `ContinueOperationResult<T>`，带 `cancel_requested`，取代隐式的 `undefined`；
- 具体的 generation、deferred-poll 与 tool-call 阶段：prepare 不可变输入，publish durable intent，perform effect，publish durable outcome；
- 共享的 assistant stream protocol 消费与 Drive response lifecycle；
- 用于共同的 assistant/deferred durable publication 的 `publishResponse`，以及用于它们相同的 pre-intent failure transition 的 `publishConfigurationFailure`；
- source-order 的 tool publication、单次读取的不可变 source validation，以及隔离在 `runtime/drive/tool-placement.ts` 中的共享 tool-batch reconstruction；
- 移除同调用 tool status 防御、未检查的 `toolOperation()` cast 及其 result union；保留真正的 sibling/progress/memo 检查；
- 集中化的 lane-storage classification，且无重复的 projection 读取；
- 移除 checkpoint 的死检查并精确保留 checkpoint；
- `runtime/transcript.ts` 中共享的 transcript 机制；
- 更窄的 `LanePatch`、无冗余的 Drive promise-settlement flag，且无未使用的 operation reject 分支。

在简化完成时，最大的文件是 `runtime/lane.ts`（~996）、`runtime/drive/tools.ts`（~663）、`runtime/drive/checkpoint.ts`（~452）与 `runtime/drive/response.ts`（~417）。

### WP05 结构状态

M6 在简化后的 substrate 上建立了结构化执行。其第一个连贯的切片添加了：

- 共享的 compaction-bounded transcript/context 读取以及 committed-entry event decoration；
- 为 compaction 与 branch summary 提供 caller-owned 的 one-provider-request seam，同时为既有 non-harness caller 保留 retrying 行为；
- `runtime/drive/structural.ts` 中每个结构 `at` leaf 的直接 procedure；
- 每次触发一次的 threshold routing 与原子性的 overflow preparation publication；
- per-request 的结构 intent 与 usage settlement、attempt retry/recovery、hook decision、compaction/navigation publication 以及 terminal cleanup；
- 针对 threshold/overflow 入口、split-turn request accounting、generated 与 hook 结果、retry/cap/recovery、model 缺失、mid-request durable cancellation、navigation 与 preparation corruption 的聚焦覆盖。

随后 R1a、R2 与 R3 把 queued input 移到 lane，用不可变的 operation record 取代 hydrated family outcome，并把 family cross-product 折叠为 13 个 neutral leaf。R1b 用一个共享的 atomic boundary planner、一个由 transcript 推导的 threshold guard 以及 off-line finish-hook replanning 取代了过渡性的 checkpoint drain 与 marker 字段。M7 移除了 drained control，添加了原子性的 drain-and-return cancellation，调和了全部 13 个 leaf，并安装了 total direct dispatcher。

M8 添加了 primitive/convenience lane surface、一个有序的 tagged inbox、idle ownership、snapshot/event replication、`reduceLaneSnapshot` 与 remote resnapshot。M9 调和了规范规格。M10 只转发一个稳定的 ordinary-provider identity，它由 Session metadata id 加 lane name 推导而来；structural summary 保持全新的 request identity。在 M10 完成时，runtime 为 7,410 行，`runtime/drive` 为 4,147，`lane.ts` 为 1,992，`structural.ts` 为 1,221，新的规范 reducer 为 193 行。相对于已审查的 M7 checkpoint，public/replication surface 增加了 1,130 行 runtime；durable 的 13-leaf procedure model 保持不变。

保持可见的 durable procedure 顺序：
`prepare → publish intent → perform effect → publish outcome`。
不要引入通用的 Procedure interface、runner、scheduler、graph、callback plan 或 dependency facade。历史 work-package 文档保持不变。

## 核心模型

一个 Lane 是一个 process-local actor，作用于一个 durable lane projection。

- `Lane.state` 对 tip、configuration、current operation、control、inbox ID 与 latest operation ID 具有权威性。
- 每个受支持的 mutation 都通过 Session mutation line 提交，并在释放它之前发布匹配的 `Lane.state`。
- 一个 lane-owned Drive 是推进 operation 状态的唯一 writer。
- same-operation caller 观察到同一个 Drive。没有 caller 拥有它。
- Invocation cancellation 在 Drive installation 之后只停止该 caller 的 observation。
- `requestAbort` 是唯一的 durable operation cancellation。
- Close 封闭 mutation admission。它既不 mutate operation 状态，也不替换 Drive。
- Process 丢失会销毁所有 live continuation；recovery 从 attachment 之后的 durable 状态开始。
- 执行期间的 Session 读取会解引用由 `Lane.state` 命名的内容；它们绝不重新发现 control 状态。

## Durable 状态

`OperationState` 有一个判别字段 `at`，包含 13 个直接 leaf：

- `starting`
- `checkpoint`
- `assistant.ready`
- `assistant.effect_pending`
- `assistant.retry_wait`
- `tools`
- `deferred.suspended`
- `deferred.effect_pending`
- `summary.deciding`
- `summary.ready`
- `summary.effect_pending`
- `summary.retry_wait`
- `navigation.ready_to_commit`

每个 leaf 携带一个统一的 `OperationScope`。summary quadruple 携带一个 `SummaryTask`；其封闭的 `ResultBoundary` 选择 in-run checkpoint resumption、standalone finish 或 navigation commit。summary algorithm 由该 boundary 推导而来，而不是在状态中重复。`Control` 保持正交。`ToolBatch` 仍是 child 状态机，因为并行的 tool child 确实会并发地 mutate sibling call status。

## 状态与内容边界

Procedure 绝不读取这些 address 来决定执行：

- `laneState`
- `operationMeta`
- `operationState`
- `branchTip`
- `laneConfig`
- `operationResult`

它们使用由 mutation line 提供的当前 `Lane.state`。

Storage 读取仅保留用于内容与清理：

- prompt、assistant、deferred-source、final-assistant 与 completed-tool entry；
- compaction-bounded 的 branch context；
- `pendingEntry` payload；
- assistant-frame list；
- tool arguments、memos 与 checkpoints；
- structural preparation；
- staged tool outcome；
- terminal cleanup 所需的 operation-owned prefix scan。

## 并发模型

### Operation 推进

当 Drive procedure 存活时，没有受支持的并发 actor 能改变或移除其 operation 状态：

- inbox method 只改变 inbox 字段；
- `requestAbort` 只改变 `control`；
- close 阻止后续 mutation admission；
- 另一个 same-operation caller 加入既有 Drive；
- 当 lane 忙碌时不能接受另一个 operation；
- process crash 会移除 continuation 本身。

因此，普通 procedure transition 不会重新检查 operation existence、operation ID、operation kind、`at`、attempt identity 或 nested status。这些是由 dispatch 建立的 procedure precondition，而不是受支持的 race。

剩余的真正 race 是：

1. cancellation 在 effect admission 之前或 settlement 之前到达；
2. inbox arrival 在 checkpoint routing 或 terminal finish 之前到达；
3. 并行 tool child 对 sibling outcome 进行 staging 与 materializing；
4. queued frame/checkpoint/memo 写入与 effect settlement 竞争；
5. retry timer 与 cancellation 或 close 竞争；
6. deferred permit consumption；
7. Session line 上的 accept/claim serialization。

### Cancellation 边界

Cancellation 只在三处检查：

1. drive loop 在普通 dispatch 之前；
2. gate 在 external effect 开始之前紧邻处；
3. effect settlement，它看到当前 `control` 并提交相应的 cancelled result。

当当前 control 为 `cancel_requested` 时，普通的 transition helper 可以集中地拒绝推进。Procedure 不会手动重复该分支。

### Close

关闭 harness：

1. 标记 harness/lane admission 已关闭；
2. 封闭并排空 Session mutation line；
3. 通过 harness-close observation promise 拒绝 client observation；
4. 保持每个 detached pass promise 被观察到，使后续 rejection 永不处于 unhandled 状态；
5. 在已准入的 mutation 排空后关闭 Session。

Close 不执行 durable write、不安装 replacement Drive，也不创建 ownership-loss state。迟到的 effect 可能返回，但其 mutation 会以 `HarnessClosed` 被拒绝。

close 是否也 signal process-local 的 provider/tool 工作属于 resource-cleanup policy，而不是 durable state-machine 行为。不要把它与 Drive replacement 或 recovery 耦合。

## 小型具体 mutation API

用两个具体的 Lane operation 取代 procedure 中重复的 `LaneCommand` 仪式。它们不是 scheduler、graph 或 action interpreter。

### `continueOperation`

用于普通的非 terminal 推进。

- 进入 Session mutation line。
- 接收当前权威的 Lane projection 与 operation 状态。
- 如果 control 已被取消，则返回显式的 `cancel_requested` 而不调用 semantic planner；caller 不会把 cancellation 与 planner value 混淆。
- planner 提供 procedure-specific write、下一个完整的 `OperationState`、materialization 与 events。
- helper 追加 `operationState` 写入并发布匹配的 process-local operation projection。
- 它不校验期望的 state 或 `at` 值。

### `settleOperation`

用于已准入的 provider/tool/structural effect 之后，以及真正的并行 child transition。

- 即使 control 已被取消也进入 Session mutation line。
- 向 semantic settlement planner 提供当前 control/inbox 字段与 process-local effect result。
- 以原子方式提交 payload、usage、tip movement、cleanup 与分类后的 next state。
- 追加规范的 operation-state 写入并发布匹配的 projection。
- 当 planner 返回 terminal decision 时，追加不可变的 `operationResult`、带 `lastOperationId` 的 idle `laneState` 以及 idle process-local projection。

caller 提供 typed outcome、cleanup/publication write、last result 与 event。Terminal business decision 在拥有它的 procedure 中保持可见。

## Durable procedure 形态

有 effect 的 procedure 暴露四个具体阶段：

```text
prepare immutable inputs
→ publish durable effect intent
→ perform the external effect
→ publish one durable outcome
```

intent 阶段必须保持可见并先于 external effect。否则在 effect 之后、其 intent 之前发生 crash 将不留下可恢复的 unknown-outcome marker。每个 procedure 使用诸如 `prepareGeneration`、`publishGenerationIntent`、`performGeneration` 与 `publishResponse` 这样的具体函数；不存在通用的 Procedure 抽象。

## Drive lifecycle

删除 installer-owned 模型。

- 移除 `installerSignal`。
- 移除 `DriveAbandoned`。
- 从 procedure result 中移除 `LostOwnership` 与 `lost_ownership`。
- 移除 exact-object ABA fencing 与 `commandDriveOwned`。
- 移除 `finalizedOutcome` 与计划中的 external-finalization owner retention，除非 Flue 调查确立了具体需求。
- 只把 `activeDrive` 保留为 lane 的 install/join slot。
- Installation 把工作转移给 lane。每个 caller，包括 installer，都用其自己的 invocation Context 观察完成。
- installation 之前的 caller signal abort 不安装任何东西。installation 之后它只拒绝该 caller 的 observation。
- Drive 在其 pass 完成 settle 或到达 durable wait 之后被移除。没有 live pass 会在 process 内被替换。

`requestAbort` 保留两段式 gate 顺序：

```text
beginAbort before cancellation mutation
commit cancel_requested
signalAbort after commit
```

这防止在 durable marker 提交期间新的 effect 进入。

## 保留的检查

不要移除对 external 或 referenced content 的校验：

- 必需的 entry 存在性与 role；
- pending payload kind；
- deferred handle identity；
- provider stream protocol 顺序；
- response stop-reason invariant；
- UUIDv7 follower timestamp 解析；
- 已配置的 model/tool 可用性；
- tool-call source index 与 staged result identity；
- parallel tool call status 与 ready-prefix placement；
- progress/memo invocation identity；
- retry timestamp 与 deferred permit arithmetic。

这些校验数据或真正的 child 并发。它们不是对 operation 状态机的防御性重校验。

## 已完成的分阶段实现计划

### Stage 1 — 规范的扁平 durable 类型

文件：

- `src/harness/session/types.ts`
- `src/harness/runtime/`、restore、conformance helper 与 focused test 中的 compile-only consumer
- `docs/harness.md`
- `docs/work-packages/05-direct-durable-drive.md`

动作：

- 用扁平的 `at` union 取代嵌套的 operation 状态声明。
- 保留每个 durable datum，不使用 compatibility alias。
- 机械地更新 pattern matching 而不改变行为。
- 保持 ToolBatch/ToolCall 嵌套。
- 在同一次变更中更新规范文档。

退出条件：`npm run check`；既有 focused runtime test 通过；规范的 operation 状态中不再保留 `phase.kind`、generation `status`、deferred `status` 或 structural decision `status`。

### Stage 2 — 添加规范 transition operation

文件：

- `src/harness/runtime/lane.ts`
- `src/harness/runtime/types.ts`
- focused Lane test

动作：

- 添加 `continueOperation` 与 `settleOperation`，包括 terminal-decision 后缀。
- 在一个实现中把每个 durable operation-state 写入与 process-local projection publication 配对。
- 集中化普通的 cancellation diversion。
- 信任 dispatcher 建立的 current leaf；不执行 expected-state 检查。
- 在 call site 保持 procedure-specific write 与 event builder 可见。

退出条件：focused test 证明在每次 helper commit 之后 durable state 与 `Lane.state` 保持一致。

### Stage 3 — 转换 starting、checkpoint 与 assistant

文件：

- `runtime/drive/checkpoint.ts`
- `runtime/drive/generation.ts`
- `runtime/drive/recovery.ts`
- `runtime/progress.ts`

动作：

- 移除重复的 operation/null/kind/state 检查与 `same*` predicate。
- 把普通 progress 转换为 `continueOperation`。
- 把 assistant settlement 转换为 `settleOperation`。
- 只保留 checkpoint inbox/finish race 与 progress-channel ownership 检查。
- 如果更小，则把 assistant recovery 折叠进 effect-pending handler。

退出条件：无 control-state storage 读取；无重复的 assistant state 校验；focused generation test 通过。

### Stage 4 — 转换 deferred 与 tools

文件：

- `runtime/drive/deferred.ts`
- `runtime/drive/tools.ts`
- `runtime/progress.ts`

动作：

- 在语义一致处共享 assistant/deferred 的 response-entry、usage 与 tool-plan 构造。
- 保留 deferred permit 与 handle 检查。
- 移除顶层 operation-state 重校验。
- 保留 per-call tool status merging、completion-order staging、source-order placement、memo fencing 与 progress fencing。
- 对 live、recovery 与 cancellation 模式使用一个 tool-batch procedure，而不是分开的 ownership-result 路径。

退出条件：tool status 检查仅存在于真正的 sibling 并发场景；focused deferred/tool/progress test 通过。

### Stage 5 — 移除 ownership-loss 机制

文件：

- `runtime/types.ts`
- `runtime/lane.ts`
- `execution/effect-gate.ts`
- 所有现有的 `runtime/drive/*.ts`
- 相关的 focused test

动作：

- 移除 `LostOwnership`、`commandDriveOwned`、exact Drive check、`installerSignal`、`DriveAbandoned` 与 `finalizedOutcome`。
- 使所有 drive caller 成为 observation peer。
- 为 Drive completion waiting 添加 observation-only 的 Context cancellation。
- 只为 install/join arbitration 保留 `activeDrive`。
- 移除 ABA/replacement test，并以 install/join/observation-cancellation test 取代它们。

退出条件：grep 在生产 runtime 中找不到 ownership-loss 或 installer-abandonment 词汇。

### Stage 6 — Close 与 fault

文件：

- `runtime/harness.ts`
- `runtime/lane.ts`
- Drive observation helper
- lifecycle test

动作：

- 封闭 mutation admission 并排空已准入的 mutation。
- 在 close/fault 时拒绝 client observation，而不替换 Drive 或改变 durable operation 状态。
- 观察 detached pass failure。
- 验证迟到的 effect 无法在 close 之后提交。
- 单独决定是否为了 resource cleanup 而 signal local effect。

退出条件：close 与 process 丢失留下相同的 durable restart point；没有 close 路径写入 cancellation 或 synthetic settlement。

### Stage 7 — 在更简单的 substrate 上完成 WP05

文件：

- `runtime/drive/structural.ts`
- `runtime/drive/reconcile.ts`
- `runtime/drive.ts`
- `runtime/lane.ts` 的 public surface

动作：

- 直接在扁平 leaf 与 transition operation 之上实现 structural generation。
- 把 cancellation reconciliation 实现为一个 flat-state switch。
- 把 total drive switch 实现为一个 `state.at` switch。
- 只在每个 leaf 都是 total 之后才接上 public claim/join/observation 与 convenience method。

除非 Flue 调查识别出一个无法通过 close、explicit abort、recovery 或 offline administration 表达的具体且当前的 caller，否则排除 external finalization。

## 验证

在每个代码阶段之后：

```bash
npm run check
```

从 package 根目录运行每个被修改的 focused test 文件。不要直接运行完整的 Vitest suite。public drive 只在最终阶段使每个 leaf 都 total 之后才启用。

最终审计：

```bash
rg 'lost_ownership|LostOwnership|DriveAbandoned|commandDriveOwned|installerSignal|finalizedOutcome' packages/agent/src/harness
rg 'operationState\(|laneState\(|branchTip\(|laneConfig\(' packages/agent/src/harness/runtime/drive
```

第二次审计可能匹配到 write constructor，但任何 reader 调用都不得使用这些 control address。
