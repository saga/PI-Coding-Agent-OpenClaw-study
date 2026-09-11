# WP05 — Direct durable drive

**Status: WP05 通过 M10 完成：lane 拥有的 inbox、不可变的 result records、13 个 family-neutral leaves、atomic boundary planning、total cancellation/dispatch、公共与复制的 lane surfaces、文档核对，以及 lane-safe 的 provider cache identity。剩余的 assistant-output 工作由 [mobile assistant-output handoff](../mobile-handoff/01-harness/05-assistant-output/message-update.md) 拥有，位于 public-drive gate 之外。**

WP06 的 Session/Branch/Lane 分离是基础的一部分。公共 drive 已启用；`watchSession` 是唯一被推迟的 Harness 方法。

Format 4 仍在进行中。本 package 中的每一个 durable type replacement 都不需要 migration，也不需要针对 pre-redesign 形态的 compatibility decoder。

本文档先前所述的 standalone-compaction inbox/promotion 设计**已撤回**（§5）。R1–R3 与 M7/M8 取代了它。M9 核对了 `docs/harness.md`，它再次独立成为规范性文档。

## 0. 必读

在开始实现工作之前完整阅读：

1. `packages/agent/docs/harness.md`（规范性；由 M9 核对）
2. `packages/agent/docs/runtime-simplification.md`（其 22-leaf 列表被 R3 取代）
3. `packages/agent/src/harness/session/types.ts`
4. `packages/agent/src/harness/session/values.ts`
5. `packages/agent/src/harness/runtime/lane.ts`
6. `packages/agent/src/harness/runtime/types.ts`
7. 每一个现有的 `packages/agent/src/harness/runtime/drive/*.ts`
8. `packages/agent/src/harness/runtime/progress.ts`
9. `packages/agent/src/harness/runtime/restore.ts`
10. `packages/agent/src/harness/execution/{effect-gate,assistant,tools}.ts`
11. 相关的 focused runtime tests

不要检查 Git history 或已移除的 runtime 实现。当前源码与这些文档是唯一的实现输入。

## 1. Runtime model（目标）

### Lane authority

在 Harness 拥有其 Session 期间，`Lane.state` 是权威的。它包含 dispatch 所需的全部 orchestration state：

- tip；
- lane configuration；
- lane inbox：带标记的 queued-input ids（R1）；
- 最后一个 operation id（R2）；
- operation metadata；
- flat operation state，包括 control。

每一个被支持的 mutation 都在唯一的 Session mutation line 上提交，并在释放该 line 之前发布匹配的 `Lane.state`。Drive procedures 从不从 storage 重新读取 `laneState`、`operationMeta`、`operationState`、`branchTip`、`laneConfig` 或 `operationResult`。

`SessionReader` 只用于解引用由内存状态命名的内容，以及枚举 operation 拥有的 cleanup addresses：

- tree entries 与 branch context；
- pending entry payloads；
- assistant frame lists；
- tool arguments、checkpoints 与 memos；
- structural preparations；
- staged tool outcomes；
- cleanup-prefix scans。

### 一个 lane 拥有的 inbox（R1）

Queued input 由 lane 拥有，从不由 operation 拥有。`LaneState`（durable 与进程本地）携带一个有序的 inbox，其中包含 `{ entryId, kind }` 条目，`kind: "steer" | "followUp" | "nextRun" | "write"`。Payload staging 不变：enqueue 铸出 entry id 并写入 `pendingEntry(id)`；inbox 只保存 ids。条目的生命周期是 admission → consumption | cancellation；terminal cleanup 从不触碰 queue payloads。

Tags 是消费资格标记，而不是所有权。Enqueue 总是成功——在 runs、structural operations、cancellation 以及 idle 期间皆如此。每个 drain point 按 tag 选择符合条件的条目，在选择时应用 queue modes，但把所有被选中的条目按 inbox 的单一全局 admission order 放置。Tag 分组绝不能重排用户输入。在 acceptance 时，request prompt entries 跟随被选中的 inbox 条目，因为该 request 是最新的 admission。

| Drain point | 资格与决策顺序 |
| --- | --- |
| acceptance（idle lane） | write + nextRun（全部）、steer（`steeringMode`：全部或最旧）以及 followUp（`followUpMode`）符合条件。按全局 admission order 放置被选中的条目，然后是 request prompt entries。acceptance transaction 放置它们并移除它们的 ids；`starting` 不排空任何内容。followUp 符合条件，因为 idle lane 空洞地满足其「在当前工作之后」条件。 |
| turn-end boundary pass（run） | write + steer 在 threshold/continuation planning 之前符合条件，并按全局 admission order 放置。followUp 只在 `may_finish` 时符合条件，位于 `before_run_end` 与 finish 之前。nextRun 在 run 进行中从不符合条件，也从不阻塞 finish。 |
| idle direct append | queued write items 按 admission order 放置，然后是新的 entry，在一次 commit 中完成 |
| abort（M7） | steer + followUp 从 inbox 中被移除，payload values 被删除，payloads 被返回；nextRun 与 write 条目留下 |

**一个 decision，至多一次 commit（R1b）。** 一次 boundary pass 可能为了有界读取和 `before_run_end` mediation 多次进入 mutation line，但它执行**至多一次 commit**，且该 commit 总是落在一个既不 drain 也不 recheck 的状态（`assistant.ready`、`summary.deciding`、已放置的 entries + `assistant.ready`，或一个 terminal transaction）。任何 boundary decision 都不会提交回 `checkpoint`。commit 之前崩溃会以未消费任何内容的方式重新运行整个 decision；commit 之后崩溃则越过该 decision point 落地。因此 `skipInboxOnce` 与 `thresholdCheckedTriggerEntryId` 被删除：drains 无法再次触发，因为其目标状态不 drain，而 threshold marker 被一个从 branch 本身推导出的 guard 取代——threshold 只在 `shouldCompact` 成立**且**该 branch 最新的 compaction entry 比 trigger entry 更旧时才触发，因此一次已提交的 threshold compaction 就是它自己的 durable marker。Mode remainders 保持排队，并在之后的 boundaries 被消费，从而给出 per-turn 的 steer cadence 与 per-run-end 的 followUp cadence。

不存在 terminal drain。`cancelQueued` triage 不变，且位于单一位置。Queued input 在 operation termination 之后仍然存活（对于 nextRun/write 也包括 abort），直到被消费或被取消；这是一个有意的产品决策。

### Flat state（R3）

`OperationState` 有一个 `at` discriminator，带有 **13** 个直接 leaves：

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

每个 leaf 都携带一个统一的 scope `{ control, settings, latestAssistantEntryId }`。没有 `run.`/`compaction.`/`navigation.` leaf 前缀，没有 per-family scope types，也没有 intersection zoo。四个 `summary.*` leaves 携带一个 `SummaryTask`，其 `boundary` datum（一个封闭的三臂 union，§8）决定 result boundary 处发生什么。`starting` 与 `navigation.ready_to_commit` 是 intent-locked 的 entry leaves。`ToolBatch`/`ToolCall` 保持为嵌套的子集合状态机。`Control` 保持正交，并在 M7 安装 drain-and-return abort 时失去其 drained 字段。

### Durable operation results（R2）

每一个 terminal transaction 都在 `operationResult(operationId)`（namespace `pi.result`，operation id 为 key）写入一条小的不可变 result record。该 record 是 lane-lived 的；把它放在 `pi.op.*` 之外，使该 namespace 的「不晚于 terminal transaction 删除」语法保持完全且无例外。`LaneState.lastOperationId` 指向最新的 record。`laneLastResult`（值、address constructor 与 type union）被删除。

- 对已 settled 的 operations，`drive(id)` 变为 total：当前 id → install/join；record 存在 → 返回该 record 本身；两者皆无 → `OperationMismatch`。
- Recovery 与 attachment 从不读取 result records；它们仅供观察。
- Terminal-control invariant：一个在 durable `cancel_requested` 下执行的 terminal transaction 总是记录 `status: "aborted"`；等价地说，任何其他 status 都意味着 running terminal control。（每一条非 aborted 的 terminal path 都经过 `continueOperation`，它在 cancellation 下改道，而 mutation line 把该 marker 与 terminal commit 串行化。）
- 不存在针对 records 的 listing、filtering、pagination 或 retention API——也没有 hydration layer。`getResult(operationId)` 与 drive 的 settled arm 就是整个读取表面；两者都返回 record 而不解引用任何 entry，因此观察永远不会因缺失 entries 而 fault。

### 一个 lane 拥有的 Drive

不变：每个 lane 一个进程本地的 Drive pass；第一个匹配的调用方 install，之后匹配的调用方观察到同一个 completion；安装之后没有调用方拥有它；invocation cancellation 只 reject 该调用方的观察；一个已安装的 Drive 在进程内从不被放弃或替换；`requestAbort(operationId)` 是唯一的 durable operation cancellation；一个 stale operation id 返回 `OperationMismatch` 且不影响任何东西。`Drive.context` 移除安装时的 invocation signal。

### Close

不变：close 不是 abort。它封住 mutation admission，用 `HarnessClosed` reject 本地观察，观察 detached pass failures，排空 seal 之前被接纳的 mutations，并关闭 Session。它不写入 cancellation marker 或 synthetic terminal state，也从不替换一个 Drive。

### 无外部 finalization

不变：没有 live-process external-finalization path、`OperationEnded`、`finalizedOutcome`、ownership-loss result 或 exact-Drive ABA fence。

## 2. Procedure 形态

Live procedures 是普通的直线式 async 函数：

```text
prepare
→ commit intent
→ admit and await effect
→ commit settlement
```

一个 procedure 是改变其顶层 `at` leaf 的唯一 writer。`requestAbort` 只改变 `control`（以及 lane inbox）；inbox admission 只改变 lane inbox。Operation state 恰好有两个被支持的 writers：procedure 与 `requestAbort`。

Lane 像今天一样提供 `continueOperation` 与 `settleOperation`。一个 terminal decision 追加通用后缀：

1. procedure-specific publication 与 cleanup writes；
2. `setValue(operationResult(operationId), record)`；
3. idle `laneState`，带有 `currentOperationId: null`、`lastOperationId: operationId` 以及被保留的 inbox；
4. idle process-local projection；
5. terminal result 与 event materialization。

state 参数是一个由 dispatcher control flow 建立的 type capability，从不在运行时与当前状态比较。

## 3. 剩余的并发检查

只在另一个被支持的 writer 能够改变相关事实的地方保留检查：

1. `requestAbort` 与 effect admission 和 settlement 之间；
2. lane-inbox 在 drain point、summary result boundary 或 terminal finish 之前到达；
3. 并行的 tool-call statuses 与 source-ready placement；
4. queued frame/checkpoint writes 与 settlement 之间；
5. invocation memo/checkpoint 调用与 effect completion 之间；
6. retry timers 与 cancellation/close 之间；
7. deferred permit consumption；
8. accept/claim serialization；
9. external/provider/content validation。

不要把 operation identity、expected-`at`、exact-Drive 或 ownership-loss 检查重新引入普通 transitions。

`requestAbort` 保留两步 gate 顺序：`beginAbort` 在 cancellation mutation 之前，commit `cancel_requested`，`signalAbort` 在 commit 之后。

## 4. 已完成的里程碑

### M0 — 已撤回的 execution-step controls

已完成。Breakpoints、manual drive 与 drive deadlines 均不存在。

### M1–M2 — 基础与 terminal mechanics

已完成。包括拆分的 effect gate、确定性的 gated storage、权威的进程本地 Lane projection、commit-result usage totals、progress channels、terminal cleanup，以及不可变的 operation-result 观察。

### M3 — Assistant generation 与 recovery

已完成。包括 `run.starting → run.checkpoint`、assistant ready/intent/effect/settlement、frame persistence 与 cleanup、configuration failure、unknown-outcome assistant recovery，以及 response/usage/state atomicity。

### M4 — Retry 与 deferred

已完成。包括 durable retry waits、local wait policy、每个 pass 一个 deferred poll permit、在 fresh ids 下的 unknown-poll replacement，以及保持 event-stream 的 `Models.streamDeferred`。

### M5 — Durable tools

已完成。包括 planned/effect-pending/outcome-ready/completed calls、safe replay、unsafe interruption、invocation memos、有界 checkpoints、completion-order staging、source-order placement、sequential 与 parallel modes，以及 tool-reported usage。

### Pre-M6 简化

已完成。Canonical flat `at` types、`continueOperation`/`settleOperation`、移除 installer 拥有的 Drive model，以及 M3–M5 procedures 的转换。

### M6 structural foundation

已提交（`9b23c6583`）：`runtime/drive/structural.ts`、`test/harness/runtime/drive-structural.test.ts`、compaction modules 中的 one-provider-request seams、threshold routing、overflow preparation、per-request structural intent/usage settlement、hook decisions、structural retry/recovery，以及 unsummarized navigation commit。其 family cross-product layer（三重复的 quadruples、three-armed publishers）由 R3 重建；其 effect seam、preparation plumbing、threshold/overflow logic 与 navigation commit 被保留。

## 5. 已撤回：standalone-compaction inbox 与 run-continuation promotion

那个给 `compaction.*` leaves 一个 `RunScope` inbox，并在 result boundary 处进行单向 cross-family 移入 `run.*` 的设计已被撤回。它的问题：一个被放宽的 intent/state invariant 与 bespoke restore rules、`compact()` 以一个不适合 `CompactionResult` 的 run outcome resolve、被抑制的 `run_start` 产生不均衡的 event brackets、为避免 `cancelQueued` stranding 而设的 fused-consumption rules，以及 reconciliation、cleanup、watch 和 admission 中 promotion-specific 的 arms。

替代方案，散布在本 package 各处：

- 任何 operation 期间的 queued input 由 lane 拥有（R1）——不存在可供 promote 的 operation inbox；
- standalone compaction/navigation 之后的 continuation 是一个**第二个普通 run operation**，带有 fresh id，在 convenience layer 中组合（M8）；
- 每个 operation 恰好投递一个 result；两个 results 都由 convenience call 返回，且都是 durable records（R2）。

没有代码实现 promotion。M9 从 `harness.md` 中移除了被撤回的设计；本节仅作为历史决策记录保留。

## 6. R1 — Lane 拥有的带标记 inbox

### 目标

先把所有 queued input 移到一个 lane 拥有的带标记 inbox（R1a，已实现），然后——在 R3 之后——用单一共享的 atomic boundary planner 取代过渡性的 stepwise checkpoint drains（R1b）。`Control.drained*` 保留到 M7 引入 drain-and-return abort 为止；它不属于 inbox 所有权的一部分。

### R1a — 所有权迁移

- `src/harness/session/types.ts` — durable 的 `LaneState { currentOperationId, inbox }` 与 `InboxItem { entryId, kind }` 取代 `pendingNextRun`；删除 `Inbox` 与 `RunScope.inbox`。暂时保留 `Control.drained*`、`skipInboxOnce` 与 `thresholdCheckedTriggerEntryId`。
- `src/harness/runtime/types.ts` — 进程本地的 `LaneState.inbox` 取代 `pendingNextRun`；`LanePatch.inbox` 把 durable lane-state replacement 与进程本地 publication 配对。
- `src/harness/runtime/lane.ts` — acceptance 按 tag 与 mode 选择，但把被选中的条目按全局 admission order 放置，然后是 request prompt entries；它删除被选中的 pending values 并原子地移除它们的 ids 与 `LaneBusy` 检查一起。单独一条 queued write 从不会使 acceptance 通过校验。任何 operation 期间的 `append` 入队一个 write-tagged lane item 而不触碰 operation state；idle `append` 在一次 commit 中先放置 queued writes，然后是新的 entry。`watch` 从 lane inbox 推导 queues 与 pending writes。
- `src/harness/runtime/drive/checkpoint.ts` — 过渡性的 stepwise drains 读取并替换 lane inbox，而不是 operation state。`skipInboxOnce` 与 `thresholdCheckedTriggerEntryId` 继续保护那些临时的 multi-commit boundaries。
- `src/harness/runtime/drive/terminal.ts` — operation cleanup 从不删除 lane-inbox payloads。Staged 的 `outcome_ready` results、drained abort payloads 以及其他 operation 拥有的 addresses 不变。
- `src/harness/runtime/drive/{generation,response,deferred,tools,structural}.ts` — `runScopeOf` 与 scope copies 丢弃 `inbox`；普通的 operation-state transitions 不能覆盖并发的 input。
- `src/harness/runtime/restore.ts`、fork/legacy normalization 以及 focused tests 使用带标记的 lane inbox。

### R1b — 共享的 atomic boundary planner

**在 R3 之后落地**，因为在 R3 之前 structural result boundary 散布在三重复的 publishers 中：把 planner 融合进三个 arms 然后在 R3 中折叠它们会是双重工作，而在 R3 之后单一的 `ResultBoundary` switch 恰好就是一个 planner 调用点。两个 `CheckpointData` patch fields 作为惰性 baggage 随 R3 的机械重命名一起穿过。

**核心 invariant：任何 boundary decision 都不会提交回 `checkpoint`。** `checkpoint` 是 durable 的「boundary pending」静止 leaf，只从 settlements、run-start consumption 与 deferred redemption 进入。其 pass 的每一次退出都是 `assistant.ready`（带有任何被放置的 entries）、`summary.deciding`、一个被放置的 follow-up + `assistant.ready`，或 terminal transaction。

一个共享的 boundary planner 带一个进程本地的 `threshold: "check" | "skip"` 参数，恰好有两个调用方：

- `checkpoint` pass（`threshold: "check"`）：选择 write + steer（modes，global admission order）→ threshold guard → continuation → followUp（在 `may_finish`）→ `before_run_end` → finish；一次 commit；
- 针对 `resume_checkpoint` 的 structural result boundary（`threshold: "skip"`）：**同一个 planner 在 publication commit 内部运行**——先 compaction entry（成功时），然后是选中的 write/steer items，然后是路由后的 continuation，全部在一个 transaction 中。任何被放置的 conversational item 路由到 `assistant.ready` 并以该 item 作为 trigger，覆盖 `may_finish` 的 resume continuation（steer semantics）。没有任何排队时：`need_assistant` 的 resume 直接提交 `assistant.ready`；`may_finish` 的 resume 提交 `checkpoint{may_finish}` 作为静止 leaf，且 live pass 继续进入 finish phases。

**没有 durable marker 的 threshold。** 该 guard 从 branch 推导：threshold 只在 `shouldCompact` 成立且最新的 compaction entry 比 trigger entry 更旧时才触发。因此一次已提交的 threshold compaction 就是它自己的 marker——任何崩溃后重入都会看到更新的 compaction 并跳过。一个**被拒绝的** threshold compaction 不发布任何 entry，也不需要 marker：decline 从不落到 `checkpoint` 上。decline decision 在其单一 continuation commit 之前保持进程本地、位于 `summary.deciding`（`assistant.ready`、follow-up + ready，或 `before_run_end` 之后的 terminal）；在该窗口内崩溃会恢复 `deciding` 并按其文档化的 repetition contract 重新运行 `before_compaction`。live 的 decline/recheck 循环在结构上不可能，因为没有任何 decline path 会重新进入 threshold-checking pass。

**没有 hooks 在 mutation line 上的 `before_run_end`。** finish arm 是唯一的多阶段情形：(1) on-line verdict，无 commit——只在 `may_finish` 且没有符合条件的 write/steer/followUp 时到达；(2) hook 在 line 之外运行；(3) on-line **从当前状态 replan**——如果 inbox 获得了符合条件的 items 或 control 改变，则丢弃 stale hook result，planner 采用新的 decision；否则唯一的 commit 就是 follow-up injection（entry + `assistant.ready`）或 terminal transaction。Stale-dropping 是 replanning，不是 version check。

具体 control trace（post-R3 名称；threshold compaction 带 `may_finish` resume 且一个 steer 在 compaction 中途到达）：

```text
TX1 settlement:  response n7 + usage + tip, S=checkpoint{may_finish, trigger n7}
pass (check):    shouldCompact && newestCompaction < n7 → prepare
TX2:             preparation, S=summary.deciding{boundary: resume_checkpoint{may_finish, n7}}
TX3 (any time):  steer s1 → pendingEntry(s1), laneState.inbox += s1
TX4..n:          deciding → ready → effect_pending → nested request/usage settlements
TX-pub (skip):   insert compaction c1, tip=c1, insert s1 entry (parent c1),
                 delete pendingEntry(s1), laneState.inbox -= s1,
                 S=assistant.ready{trigger s1}          ← one commit, checkpoint never re-entered
…turn answers s1; next settlement → checkpoint{may_finish, trigger n9}
pass (check):    newestCompaction c1 > … tokens small → no threshold; inbox empty; verdict finish
                 → before_run_end off-line → replan: still empty, still running
TX-final:        record + cleanup + laneState{current: null, last: op}
```

TX4..n 与 TX-pub 之间崩溃 → structural recovery（attempt unknown，按现有规则）；hook window 期间崩溃 → `checkpoint{may_finish}` 被恢复，pass 重新运行（threshold 被 recency guard 跳过），hook 按契约重新运行。

Slices，按顺序（该顺序是承重的——在 decline 仍会重新进入 `checkpoint` 时删除 marker 会造成 live-loop）：

1. **R1b-1**：把未来的共享 planner 融合进 structural 的 `resume_checkpoint` boundary（`threshold: "skip"`）；structural success/decline 直接路由，除了一个 `may_finish` resting checkpoint，它在 durable marker 仍存在时对任一结果都安全。保持 route inline，直到 R1b-2 创建其第二个调用方。两个 patch fields 仍被旧的 checkpoint pass 写入和检查——无害。
2. **R1b-2**：把 `checkpoint` pass 转换为带 recency guard 的 single-commit exits，实现三阶段 finish arm，删除 `skipInboxOnce` 与 `thresholdCheckedTriggerEntryId`。

### 规则

- §1 的资格表、全局放置顺序以及 one-decision-one-commit 目标是规范性的。
- Queue modes 在选择时应用。Remainders 保留全局 admission order，且只在之后符合条件的 boundaries 被消费。
- nextRun items 从不在 run 进行中被消费，也从不阻塞 run finish。
- Deferred-suspension enqueue 总是被接纳；消费发生在 post-redemption boundary。

### Focused validation

在 idle/run/structural/cancelled 状态下 enqueue 总是被接纳；acceptance 在应用 modes 并保留 remainders 的同时保持全局顺序；`one-at-a-time` cadence 让每个剩余 steer 拥有各自之后的 boundary；followUp 在 idle acceptance 时被捕获，且在 run 期间只在 `may_finish` 时被捕获；在其 commit 之前发生的 boundary 崩溃不消费任何内容；threshold 按构造在每个 boundary 至多被检查一次；idle append 先放置 queued writes；items 在每一种 terminal status 与进程丢失后都存活；`cancelQueued` 在每个 boundary 都有效；watch 按 tag 分组而不改变顺序；没有任何 terminal transaction 删除 lane-inbox payload；单独一条 queued write 从不会使 acceptance 通过校验。

## 7. R2 — 中立的 operation outcome 与 durable result records

### 目标

用一条不可变的 per-operation result record 取代三个 per-family outcome unions 与 `laneLastResult`。该 record **就是**公共 settled outcome；不存在单独的 outcome type、不嵌入 entries，也不做 hydration。

### 类型

```ts
type TerminalStatus = "completed" | "declined" | "aborted" | "failed";

/** Stored at operationResult(operationId) — namespace "pi.result" — by the terminal transaction. Immutable, lane-lived. */
interface OperationResultRecord {
  operationId: string;
  kind: "run" | "compaction" | "navigation";   // meta.intent.kind; matches OperationAdmission.kind
  status: TerminalStatus;
  error?: OperationError;              // status "failed"
  fromTipId: string | null;            // meta.sourceTipId — start of the transcript segment
  tipId: string | null;                // lane tip at terminal — end of the segment
  startedAt: number;                   // Unix ms, from meta
  endedAt: number;                     // Unix ms, Date.now() at terminal planning
}

/** Convenience-only suspension observation for prompt()/resume() (M8). Never stored. */
interface SuspendedRun { operationId: string; status: "suspended"; deferred: DeferredHandle }
```

该 record 是一个 disposition 加上指向 transcript segment `(fromTipId, tipId]` 的指针。它从不列出中间工作（compactions、turns、tools），也从不嵌入 entries。**没有 `tipEntry`，也没有 `OperationOutcome` union**：想要 payload 的调用方用已经公开的 `getEntry`/`findEntry` 解引用 `tipId`（对于 runs，最终 message 另外还通过 `message_end`/`entry_added` 投递过）。这换来三件事：terminal planners 执行零次 outcome 读取；观察不会因缺失 entry 而 fault（hydration 内部的一次 `getEntries` throw 曾是只读 convenience 的 harness-fault 路径）；未来的 protocol 从不把 `Entry` 序列化进 results——一个 result frame 是八个 flat 字段。`SuspendedRun` 是唯一的非 terminal 观察，只存在于 convenience returns 上，且不携带任何可在别处推导出的东西。

### 文件

- `src/harness/session/types.ts` — 添加该 record；删除 `LaneLastResult` union；`LaneState` 获得 `lastOperationId: string | null`；删除 `failure_drain`、`RunFailureDrainOperation` 与 `FailureProvenance`。
- `src/harness/session/values.ts` — `operationResult(operationId) = value<OperationResultRecord>("pi.result", operationId)`；删除 `laneLastResult`。`pi.op.*` 的 lifetime grammar 保持完全：没有任何 operation-lived namespace 在其 terminal transaction 之后存活。
- `src/harness/agent-harness.ts` — 删除 `RunOutcome`、`CompactionOutcome`、`NavigationOutcome`、`OptionalFinalAssistant`、`TerminalOperationOutcome`、`ResumeOutcome` 以及过渡性的 `OperationOutcome` union；`DriveOutcome.settled` 直接携带 `OperationResultRecord`（没有重复的 `operationId` 字段）；result aliases 变为
  `RunResult = Result<OperationResultRecord | SuspendedRun, …>`，
  `CompactionResult = Result<{ compaction: OperationResultRecord; run?: OperationResultRecord | SuspendedRun }, …>`，
  `NavigationResult = Result<{ navigation: OperationResultRecord; run?: OperationResultRecord | SuspendedRun }, …>`，
  `ResumeResult = Result<OperationResultRecord | SuspendedRun, …>`；
  `QueueResult` 失去 `NoActiveRun` 并吸收 `NextRunResult`。`SuspendedRun` 在此处声明，但只由 M8 的 convenience paths 构造。
- End-event payloads，每个 event type 一种 shape：`run_end` 与 `navigation_end` 携带 `{ runId, status, error?, fromTipId, tipId }`。`compaction_end` 是一个 segment event，不是 terminal event——它也关闭 in-run 的 threshold/overflow brackets——并且总是携带 `{ runId, reason, status: "completed" | "declined" | "failed" | "aborted", error?, entryId? }`，其中 `entryId` 在成功时命名 compaction entry。嵌入的 `entry`/`summaryEntry`/final-assistant 字段在所有地方都被丢弃（`entry_added`/`message_end` 已经投递过 payloads）。
- `src/harness/runtime/types.ts` — `FinishDecision` 携带该 record 而不是 `lastResult`。
- `src/harness/runtime/lane.ts` — 按 §2 的 terminal suffix；`getLastResult` 被 `getResult(operationId, context): Promise<OperationResultRecord | undefined>` 取代——一次 `getValue`，别无其他；`inspectExecution` 只报告 `lastOperationId`。
- `src/harness/runtime/drive/terminal.ts` — `hydrateTerminalOutcome`/`hydrateOperationOutcome` 被直接删除；该文件只保留 `operationCleanupWrites` 与 `operationResultRecord` constructor。Finish decisions 从它们已经构建好的 record 具体化 `{ kind: "settled", outcome: record }`——任何 terminal planner 内部都不解引用 reader。
- `src/harness/runtime/drive/{checkpoint,response,structural,recovery,deferred,tools}.ts` — 每个 finish decision 都构造该 record；`runCompletion`、per-family last-result construction 以及 results 中的 final-assistant plumbing 被删除。每一个原先的 `failure_drain` producer 改为直接提交 terminal failure：response publication 与 cleanup 留在同一个 transaction 中，in-run structural failure 先关闭 `compaction_end` 再关闭 `run_end`，而排队的 lane input 保持不被触碰，留给之后的一次普通 run。（`latestAssistantEntryId` 仍留在 scope 中用于 cancellation classification 与 checkpoint logic；它只是不再喂给 results。）
- `src/harness/runtime/restore.ts` — 恢复 `lastOperationId`；attachment 从不读取 records。
- Focused tests。

### 规则

- Records 由 terminal transaction 恰好写入一次，且从不被 recovery 删除、更新或读取。
- Terminal-control invariant（§1）：一个在 durable `cancel_requested` 下的 terminal transaction 记录 `aborted`；没有任何路径在 cancellation 下提交其他 status。M7 添加强制该约束的测试；M9 添加 Part 9 invariant。
- Forks 排除 `pi.result` values。
- `drive(id)` arms：current → install/join；record → 直接返回；两者皆无 → `OperationMismatch`。

### Focused validation

对每一种 operation kind 与 status 的每一条 terminal path 都写入 record；`drive(id)` 在 reopen 之后对任意旧的 ids 返回 records；`getResult` 是一次普通的 value 读取，返回该 record 或 `undefined`；没有任何 terminal planner 或 observation path 为 result 读取 entries；`lastOperationId` 恢复；suspension 从不被存储；fork exclusion；segment pointers 正确（`fromTipId` = pre-acceptance tip，包括 navigation）；`compaction_end` 同时关闭 standalone 与 in-run brackets，包括通过 reconciliation 产生的 `aborted`；每个原先的 failure-drain producer 都在一个 transaction 中结束，并为之后的一次 run 保留每一个 lane-inbox item。

## 8. R3 — Family-neutral leaves 与 structural 重建

### 目标

把 22 个 leaves 折叠为 §1 中的 13 个；在一个 summary quadruple 上重建 `structural.ts` 的 state-shape layer，并带有显式的 result-boundary datum。

### 类型

```ts
interface OperationScope { control: Control; settings: RunSettings; latestAssistantEntryId: string | null }

type ResultBoundary =                                  // closed; do not extend
  | { kind: "resume_checkpoint"; resumeAfter: CheckpointData }   // in-run threshold/overflow
  | { kind: "finish" }                                            // standalone compaction
  | { kind: "commit_navigation"; targetId: string; label?: string };

interface SummaryTask {
  taskId: string;
  reason?: "manual" | "threshold" | "overflow";
  customInstructions?: string;
  boundary: ResultBoundary;
}
```

summary algorithm kind 是**从 boundary 推导的**（`resume_checkpoint`/`finish` → compaction；`commit_navigation` → branch summary）；它不被存储，因此不存在可表示的矛盾 kind/boundary 组合。`summary.ready/effect_pending/retry_wait` 另外携带 generation snapshot（result entry id、configuration、stream options、retry policy、attempt counters）；该 snapshot 丢弃它先前重复的 `taskId`/`kind`/`reason` 字段。Canonical declarations 落在 `session/types.ts` 中。统一的 scope 意味着 compaction/navigation acceptance 像 run acceptance 一样捕获 `settings`；`latestAssistantEntryId` 对 structural intents 保持 null。

### 可达性（restore check；取代 intent-prefix check）

| Intent | 可接受的 leaves |
| --- | --- |
| run | `starting`、`checkpoint`、`assistant.*`、`tools`、`deferred.*`、带 boundary `resume_checkpoint` 的 `summary.*` |
| compaction | 带 boundary `finish` 的 `summary.*` |
| navigation | `navigation.ready_to_commit`；带 boundary `commit_navigation` 的 `summary.*` |

按构造即被禁止且不可达（在测试中断言，绝不实现）：除 acceptance 之外任何进入 `starting` 或 `navigation.ready_to_commit` 的边；`summary.*` → `tools`/`assistant.*` 直接相连；`navigation.ready_to_commit` → `summary.*`；terminal → 任何东西。

### Result-boundary 规则

每一个 summary boundary（hook decline、hook-supplied result、generated success、terminal generation failure、model unavailability）都在 mutation line 上规划，并在一处可见的位置对 `boundary` 做 switch：

- `resume_checkpoint` → 在成功或 threshold decline 时发布 result 并恢复被标记的 checkpoint；overflow decline 或 structural failure 在同一个 commit 中关闭 compaction bracket 并使该 run terminal-fail；
- `finish` → 在一个 commit 中发布 compaction entry 并 terminal-complete（或 terminal declined/failed）；
- `commit_navigation` → 单一的 move/summary/label/terminal commit（或 terminal declined/failed）。

一个 `cancel_requested` boundary 让位给 reconciliation，且从不采用其 continuation。

### 文件

- `src/harness/session/types.ts` — 13-leaf union、`OperationScope`、`SummaryTask`、`ResultBoundary`；删除 `RunScope`、`CompactionScope`、`NavigationScope`、`NavigationSummaryScope`、`RunCompactionScope`、`StructuralTask`、per-family `Extract` aliases、`isRunOperationState`。
- `src/harness/runtime/drive/structural.ts` — 重建：保留 `durableCompactionPreparation`/readers、嵌套的 request seam、`performStructuralAttempt`、`runCompactionThreshold`、`prepareOverflowCompaction`、`commitNavigation`；删除七个 union aliases、`startsWith` guards，以及 three-armed 的 `effectPendingFromReady`/`retryWaitFromEffect`/`readyFromRetryWait`/`publishStructuralReady`/`publishStructuralDecline`/`publishStructuralFailure`/`publishCompactionResult`-vs-`publishNavigationSummary` 拆分；一个 quadruple 的 converters 加上一个 boundary switch 取代它们。
- `src/harness/runtime/drive/{checkpoint,generation,response,recovery,deferred,tools,tool-placement,terminal}.ts` — leaf literal 重命名（`run.checkpoint` → `checkpoint`，…）；`response.ts` 的 overflow arm 构造带 `resume_checkpoint` 的 `summary.deciding`；没有其他行为变化。
- `src/harness/runtime/progress.ts` — frame/checkpoint fences 当前匹配 leaf literals `"run.assistant.effect_pending"`、`"run.deferred.effect_pending"` 和 `"run.tools"`；把它们重定向到中立的 leaves。
- `src/harness/runtime/restore.ts` — 上述可达性 predicate。
- `src/harness/runtime/lane.ts` — `capturedModel` 与 `watch` 对中立的 leaves 做 switch；acceptance 写入中立的初始 leaves。
- `docs/runtime-simplification.md` — 取代 22-leaf 列表与状态。
- `test/harness/runtime/drive-structural.test.ts` 与其他 focused tests — 重定向；行为断言保留。

### Focused validation

M6 foundation 覆盖的一切，在中立 leaves 上重新表达，外加：reachability accept/reject matrix（包括损坏的 boundary/intent 组合使 restore fault）；每个 boundary arm × {success, hook result, decline, failure, model absence} × {running, cancelled}；一次 post-terminal leak scan，断言对每个 leaf 都每个 `pi.op.*` address 都消失，而 `pi.result` record 存在；在每一个能被到达的 leaf 上、在每一种能到达它的 intent 下的 crash/reopen。

## 9. M7 — Cancellation reconciliation 与 total switch

### 目标

**已实现并已审查。** 在没有 public wiring 的情况下让内部 graph 变为 total。

创建 `src/harness/runtime/drive/reconcile.ts`、`src/harness/runtime/drive.ts`，以及 focused reconciliation 与 switch 测试。

### `requestOperationAbort`

Package-private 的 expected-id primitive：

1. 当 expected id 不是当前 durable operation 时以 `OperationMismatch` reject，包括该 id 已经有一条 settled result record 的情况；
2. 在一个匹配的 live Drive 上同步 `beginAbort`；
3. 在 Session line 上的一次 commit：`control = cancel_requested`（不带 drained 字段）**加上**从 lane inbox 移除 steer/followUp-tagged ids 并删除它们的 `pendingEntry` values；payloads 在同一个 mutation 中被读取并返回；nextRun/write items 留下；
4. commit 之后的 `signalAbort`；
5. 在一个新请求的 abort 提交之后，发布 `{ type: "operation_abort", operationId, steer, followUp }`，并在 cancellation 变为 durable 后返回。这个 family-neutral event 取代 `run_abort`/`runId`；lane snapshot 已经标识了 operation kind。对同一个当前已取消 operation 的重复调用不发布任何内容、不再进一步排空，并报告 `newlyRequested: false`。

在没有 Drive 但有一个匹配的当前 durable operation 时，它提交同样的 marker 且不启动任何 pass。不存在 `control.drained*`；被排空的 payloads 只存在于返回的 result 中（被接受的损失：abort window 内的一次崩溃会丢失其内容）。

### Reconciliation

在 `before_drive` 与普通 dispatch 之前检查；对 13 个 leaves 做单一的 switch；从不启动新的普通工作。它必须处理：

- 带 live 或 reconstructed results 的 assistant 与 deferred effects；
- planned/effect-pending/outcome-ready tool calls；
- structural 进程本地 results（除非已经原子发布，否则丢弃）；
- 以 `aborted` 结束、但不采用其 `ResultBoundary` continuation 的 cancelled summary boundaries；
- retry waits、checkpoints 与 suspended deferred work；
- 使用 Drive 的 close-only signal 做 best-effort 的 deferred-provider cancellation，绝不使用其已经触发的 operation-abort gate；
- aborted terminal transaction（result record `status: "aborted"`）；
- terminal-control invariant 测试：没有任何 terminal path 在 cancelled control 下提交非 aborted 的 status（这使 §10 的 continuation rule 仅凭 record 就可判定）。

排队的 lane-inbox items **不**被 reconciliation 应用或删除；nextRun/write items 只是保持排队。

每个 Drive 拥有一个私有 close controller，并把其 signal 暴露给强制 cleanup。`closeGate()` 在 harness close 或 fault 时中止该 controller；operation abort 不会。Deferred-provider cancellation 使用这个 close-only signal，因此 cleanup request 可以在 durable operation cancellation 之后启动，但不能比 harness shutdown 存活更久。不要添加 harness-global cancellation controller。

### Total switch

`runtime/drive.ts` 拥有一个对 13 个 leaves 的直接 `state.at` switch。它只导入完整的 procedure modules。没有 graph table、action interpreter、ownership-loss arm、external-finalization arm 或 storage-state reload。一个 `continue` result 必须对应一个被替换的 `Lane.state` projection **或**当前可观察到的 `cancel_requested` control，switch 会把后者在普通 dispatch 之前路由到 reconciliation；任何其他未改变的 continuation 都是 invariant 缺陷。

公共方法在 M7 期间保持被守卫。

## 10. M8 — Public surfaces

**已实现。** 只有在每个 leaf 与 reconciliation path 都变为 total 之后，execution guards 才被移除。

顺序：

1. 接纳 compaction/navigation requests（acceptance 捕获 `settings`；写入 R3 的 entry leaves）；
2. 实现 `drive` 的 install/join/record lookup（三个 arms，§7）；
3. 暴露 `requestAbort`；
4. 添加 convenience compositions；
5. 添加 queues/configuration/usage/idle surfaces；
6. 把 `watchSession` 保留为唯一的 `SliceNotImplemented` 方法。

### Queues

`steer`/`followUp`/`nextRun` 是同一个 enqueue 之上的 tag sugar，且总是被接纳。`queue_update` 与 `LaneSnapshot.queues` 暴露同一个带标记的有序 inbox，包括 pending writes；客户端按 tag 分组而不重排它。

### Client replication surface

来自一个可工作的 RPC 形态 client replica（mini TUI 演练）的发现汇总于此。目标是单一可测试的契约：远程 client 完全从复制的 `LaneSnapshot` 与 event stream 渲染，没有 side-channel getters。

- **规范性 reducer。** 从 `packages/agent` 导出 `reduceLaneSnapshot(snapshot, event): LaneSnapshot | { rebase: true }`。它是唯一被支持的 event fold：in-run 的 `compaction_start`/`compaction_end` 是 segments，且不得清除 `operation`（fold 知道 open operation 的 kind，因此不需要 event 字段）；`run_suspend` 让 `operation` 保持非 null 并设置 `deferred`；只有在 compaction-kind operation 下的 `run_end`、`navigation_end` 与 `compaction_end` 才是 operation-terminal。`navigation_end` 返回 `{ rebase: true }`，因为被移动的 tip 可能位于 replica 之外。Conformance assertion：对于每一种非 navigation flow，把一个 `watch()` snapshot 在其自身 event stream 上折叠，等于之后的一次 `watch()` snapshot——这个等价性测试正是让 event 词汇保持完整的东西。
- **Snapshot 完整性。** `LaneSnapshot` 获得 `configuration: LaneConfiguration`、`lastResult?: OperationResultRecord`（取代裸的 `lastOperationId` 字段）、一个真正的 `faulted` flag（当前硬编码的 `false` 是一个缺陷），以及作为 usage baseline 的 session `stats: SessionStats`（usage events 已经携带 `totals`；snapshot 提供第一个 event 之前的值）。
- **可复制的 configuration events。** 每个其 value 是数据的 `config_update` variant 都携带 `value`/`previous`（`streamOptions`、`retryPolicy`、`compactionSettings`、`steeringMode`、`followUpMode`，以及现有的 lane variants）；`tools`/`resources` 保持仅通知，因为 registries 是代码——客户端重新获取名称。
- **基于 identity 的 `setModel`。** `setModel` 接受 `ModelIdentity`（`{ provider, modelId }`）；一个 live 的 `Model` object 是进程本地 registry 的关注点，而一个未注册的 identity 会在 generation 时带内失败，就像任何 registry 缺失一样。
- **Re-basing。** `WatchHandle.resnapshot(context): Promise<LaneSnapshot>` 在 mutation line 上捕获一个新的 snapshot，与同一个 stream 串行化——这是 `{ rebase: true }` 之后的恢复路径，无需 teardown/re-subscribe 编排。
- **Start-event timestamps。** `run_start`/`compaction_start`/`navigation_start` 携带 `startedAt`（operation starts：`meta.startedAt`；in-run segment starts：commit timestamp），因此 folds 从不凭空造出时间。

### Convenience compositions 与 continuation

- `prompt`/`skill`/`promptFromTemplate`：accept + drive；返回 `Result<OperationResultRecord | SuspendedRun, …>`——terminal outcomes 对应 record，run defer 时为 `SuspendedRun`。
- `compact`/`navigateTree`：accept A + drive A。如果 A 以 status `completed`、`declined` 或 `failed` settled，且存在符合条件的 steer/followUp/nextRun items，则用**公共的 empty-prompt request**（`{ kind: "prompt", prompt: "" }`）接纳一个 continuation run B：acceptance 不放置任何 request messages，且恰好当其捕获至少放置一个 conversational item 时才合法；`OperationMeta.intent` 是一个普通的 run intent，带有空的 `promptEntryIds`。然后 drive B 并返回 `{ compaction|navigation: A, run?: B }`。绝不在 `aborted` 之后：abort 已经排空了 steer/followUp，而 terminal-control invariant（§7）使 `status ∈ {completed, declined, failed}` 蕴含该 operation 从未被 durable 取消，因此该规则仅凭 record 就可判定。B 是一个普通 run——它发出 `run_start`，运行 `before_run`（带 `prompt: []`，即现有的 captured-only acceptance shape），并拥有完整的 run graph，没有任何 continuation-aware 的特殊情形。
- Continuation races：一个赢得 idle window 的竞争 accept 把排队的 input 捕获进它自己的 run；随后 continuation accept 以 empty（`InvalidMessage`）或 `LaneBusy` 失败，convenience 返回 A 而不带 `run`。两种历史都合法。A 的 terminal 与 B 的 acceptance 之间的一次崩溃会把 items 留在排队中；reopen 时不自动启动。
- `resume`：inspect + drive 当前 id，一个 deferred-poll permit；返回 `OperationResultRecord | SuspendedRun`。
- `abort`：inspect + `requestAbort` + 确保一次 reconciliation pass；返回被排空的 steer/followUp payloads。
- `getResult(operationId)`：公共。
- 等价性：每一个 convenience call ≡ 其仅使用公共 request kinds 的 primitive composition（带 continuation 的 `compact()` ≡ `accept(A); drive(A); accept({ kind: "prompt", prompt: "" }); drive(B)`），writes 与 events 字节级一致——任何 scheduler 都可在外部复现。

### Focused validation

一次 install 与同 id joins；stale-id isolation；对旧 ids 的 record lookup；安装之前/之后的调用方 cancellation；cooperative 与 non-cooperative effects 期间的 close/fault；accept/drive 与 convenience 的等价性，包括通过公共 empty-prompt request 进行的 continuation；仅 steer、仅 followUp 与仅 nextRun 的 continuation 各自启动 run B；两种 continuation race 顺序；abort drain-and-return，包括两种顺序下的 abort/settlement race；通过 public surfaces 在每一种状态下 enqueue；跨全部 13 个 leaves 的完整 crash matrix；没有未处理的 detached rejection；除 `watchSession` 外没有 `SliceNotImplemented`；在每一种非 navigation flow 上的 reducer fold-equivalence（包括 in-run compaction segments、suspend/resume、retry waits 与 mid-stream reattach）；`navigation_end` fold 返回 rebase，且 `resnapshot` 恢复等价性；snapshot 的 `configuration`/`lastResult`/`faulted`/`stats` 仅通过 events 复制。

## 11. M9 — 文档核对

**已实现。** `docs/harness.md` 已与 runtime 核对，并独立成为规范性文档。更新的章节包括：

- §1.3 address table 与 lifetime grammar：新的 lane-lived `pi.result` namespace、`laneLastResult` 被移除、`LaneState.inbox`/`lastOperationId`；`pi.op.*` 严格保持 operation-lived；
- §1.7 引用 `pi.lane.lastResult` 的 JSONL/SQLite 示例；说明有界增长权衡——每个 operation 一条小的不可变 record，永久保留，随 JSONL snapshot compaction 一起携带；
- §2.9 精确重写：为那些其 `tipId` 被该 rewrite 移除的 records 决定并记录策略（retain-dangling 或 delete）；
- §3.1–§3.2 state shapes：13 个中立 leaves、`OperationScope`、`SummaryTask`/`ResultBoundary`（kind 从 boundary 推导）、不带 drained 字段的 `Control`、不带 `skipInboxOnce`/`thresholdCheckedTriggerEntryId` 的 `CheckpointData`；
- §3.5 graph（一个 summary quadruple、boundary arms）；
- §3.6 acceptance：per-tag 且尊重 mode 的选择、全局 admission-order 放置、prompt entries 在最后、idle followUp 资格，以及 empty-prompt continuation acceptance；
- §3.9/§3.10 summary machinery 在 boundary datum 上表达一次；
- §3.11 完整重写：一个 lane inbox、选择表、one-decision-one-commit boundaries、晚到 steer 的静默推迟（一个未被消费的 steer 变成 future-run input 而不是错误），以及 structural operations 期间无界的 write pendency，带 `waitForIdle`-then-append 的逃生通道；
- §3.12 checkpoint procedure：one-commit boundary decision 取代 stepwise algorithm；failures 使 operation 终结，而排队的 lane input 留给之后的一次普通 run；
- §3.13 terminal transactions：result records、通用后缀、observation contract（`drive(id)` total、`getResult`）；
- §4.6 abort：drain-and-return、没有 drained control，以及 client 可见的后果——被排空的 steer/followUp payloads 只存在于返回的 result 中，因此该窗口内的一次崩溃或响应丢失会永久丢失其内容；
- §5.1 lane surface 与所有 result types；§5.5 `queue_update` 与 end-event payloads（`compaction_end` 作为带 `aborted` 的 segment event）；
- Part 9：invariants 12–16、21、26（result-record lifetime、通过 records 观察、continuation equivalence）、新的 terminal-control invariant（一个非 aborted 的 terminal status 蕴含 running terminal control），以及触及 drained items、`cancelQueued` 与 continuation 的 race catalog 行；
- Appendix A glossary（Inbox、Result record、Continuation run、Boundary pass；移除 Drained）；
- §5.5 event taxonomy：明确说明哪些 events 是 operation-terminal（`run_end`、`navigation_end`、compaction-kind 的 `compaction_end`），哪些是 segment brackets（in-run 的 `compaction_start`/`compaction_end`），哪些是非 terminal lifecycle（`run_suspend` 让 operation 保持 durable open），并把 `reduceLaneSnapshot` 命名为规范性 fold；
- §2.5 branch-scan 尖锐边界：`stopAtType` 在排序之后应用，因此 `oldestFirst` + `stopAtType: "compaction"` 返回最旧的 segment；把 canonical context read 记录为 `newestFirst` + reverse；
- serving-layer 边界声明：branch-relative reads/appends 留在 `AgentLane` 上，而 whole-tree browsing、forks、label inventory 与 session listing 位于其旁边、在由 RPC facade 组合的 Session/repository services 中。

还要更新 `docs/runtime-simplification.md` 的状态，并移除 repository 文档中每一处剩余的 promotion 引用。Grep gate：

```bash
rg -i 'promotion|drainedSteer|drainedFollowUp|laneLastResult|lastResult|skipInboxOnce|thresholdChecked' packages/agent/src packages/agent/docs
```

（`src` 中匹配必须为零；docs 只可在已完成的 milestone records 内部保留历史说明。）

## 12. M10 — Provider KV-cache identity 审查

### 目标

**已实现并已审查。** 仅凭 Core Session identity 并不是有效的 provider cache lineage：多个 lanes 可能在分叉的 transcripts 上发出并发请求。因此普通 assistant requests 从 Session metadata id 加 lane name 推导 identity；structural requests 保持隔离。

### 审查范围

- 清点每一条设置、保留、推导或消费 `SimpleStreamOptions.sessionId` 的 harness 与 pi-ai 路径，包括 prompt-cache keys、affinity headers、WebSocket/session-resource caches、deferred requests 与 structural summary requests。普通 harness generation 现在转发推导出的 lane identity；legacy 的 `src/agent.ts` 保留其独立的 conversation id；structural summary requests 铸出 fresh ids。
- 定义一个独立于 durable Session id 与 operation id 的 provider-request cache lineage。并发 lanes 绝不能仅仅因为属于同一个 Session 就共享一条 lineage。
- 把普通 assistant lineage 推导为 `Session metadata id + ":" + lane name`；不要存储另一个 durable identifier。它在 lane 的生命周期内保持稳定，并在一个 Session 内跨 lanes 不同。
- 保留同 lane 在普通 assistant turns 与 retries 之间的复用。Compaction、navigation、branch replacement 与 model changes 可能 miss 一个旧 prefix，但不能错误地复用它；不要添加 rotation machinery。
- 保持 structural summary requests 隔离：`cacheRetention: "none"` 与每个 nested request 的 fresh request identity 保持为 baseline，除非该审查证明存在安全且有用的替代方案。
- 区分 cache identity 与 observability correlation。Session、lane、operation、task 与 request ids 仍然可供 telemetry 使用，而不会被盲目复用为 provider affinity/cache keys。
- 审查 provider-specific semantics，而不是假设 `sessionId` 仅意味着 KV caching；某些 adapters 还把它用于 headers、WebSocket reuse、fallback state 或 resource cleanup。

### Focused validation

- 一个 Session 中的两个 active lanes 发出并发、分叉的 prompts，并接收到不同的 provider cache/affinity identities。
- 一个 lane 在 reuse 有效的 append-only assistant/tool turns 之间保持稳定的 lineage。
- Context-prefix 不连续会安全地 miss 旧 cached prefixes，而不做 lineage rotation。
- Assistant retries 保留 lane identity；deferred handle polling 不需要 cache identity。
- Structural split-turn requests 与 transcript assistant caching 保持隔离。
- Faux-provider tests 断言稳定的同 lane identity 与不同的跨 lane request identities。

### 退出条件

普通 assistant requests 使用推导出的 lane identity，structural requests 保持 fresh identities 且 `cacheRetention: "none"`，deferred handle polling 不发送 cache identity。该策略记录在 `docs/harness.md` 中，并在 WP05 完成之前被独立审查。

## 13. Mobile assistant-output handoff

**被跟踪的后续工作；不属于 M8/M10 的 public-drive gate。** 一个微不足道的 mini coding-agent Session 产生了约 300 KB 的 JSONL 文件，因为 live assistant streaming 持久化了大量 `pi.pending.assistant_frame` 列表追加。逻辑上的 frame cleanup 并不回收已经追加到 JSONL history 的字节，因此短对话可能有不成比例的 durable storage 与 replay 成本。

权威的后续工作是 [mobile assistant-output handoff](../mobile-handoff/01-harness/05-assistant-output/message-update.md) 及其在 [mobile handoff README](../mobile-handoff/README.md) 中编号的前置条件。它处理完整路径而不仅是 batching frames：Chord op tracking、scoped pending-output durability、tool/assistant output reduction，以及 `message_update` replication amplification。保留现有的 crash contract：一个被接纳的 assistant effect 保持可重建，progress observation 保持有用，且 settlement 退役 operation 拥有的 pending state。

退出检查：

- 有代表性的短 streamed responses 不产生数百 KB 的 durable frame history；
- 在每一个 assistant 与 deferred effect boundary 处的 crash/reopen 都重建同一个 pending message；
- frame/checkpoint writers 保持被 fence 到拥有它们的 durable effect；
- backend conformance 同时覆盖 reconstruction 与有界的 write amplification。

## 14. Module boundaries

```text
session/**             durable storage; imports no runtime module
execution/**           neutral provider/tool/gate mechanics
runtime/types.ts       LaneState, Drive, command decisions
runtime/progress.ts    frame/tool progress channels
runtime/drive/*.ts     direct procedures
runtime/drive.ts       total flat switch, created only in M7
runtime/lane.ts        Lane actor and public surfaces
runtime/harness.ts     Harness lifecycle and Lane composition
```

Procedure modules 以 type-only 方式导入具体的 `Lane<TContext>` 类型。`TContext` 保持 `object | undefined` invariant。没有 `any`、`Lane<any>`、`as unknown as`、`@ts-expect-error`、inline imports、parameter properties、enums 或其他不可擦除的 TypeScript 语法。

## 15. 排除项

不要引入：

- generic scheduler、graph、action interpreter 或 effect-plan DSL——`ResultBoundary` 保持为一个封闭的三臂 data union，在一处可见的位置做 switch；
- per-family outcome unions、`OptionalFinalAssistant` 或存储 records 中嵌入的 result entries；
- result-record 的 listing、filtering、pagination、status queries 或 retention machinery；
- operation 拥有的 queues、drained-control fields 或 terminal queue cleanup；
- convenience layer 之下任何位置的 automatic continuation（绝不在 `drive` 内部）；
- 第二条 mutation line 或 transaction framework；
- 针对唯一顶层 writer 的 expected-`at` runtime checks；
- 进程本地的 Drive replacement 或调用方拥有的 lifetime；
- external finalization；
- 对权威 control state 的 storage rereads；
- read caches、read budgets 或通用的 `getValues` batching；
- 针对任何 pre-redesign durable shape 的 compatibility aliases；
- structural events 上的 `phase`/segment discriminator 字段——reducer 从 open operation 的 kind 推导 segment-vs-terminal；
- `AgentLane` 上的 whole-tree、fork、label-inventory 或 repository 方法；branch-relative reads/appends 仍是 lane facade 的一部分，而更广泛的管理位于其旁边。

Procedure-specific writes、effect admission、settlement classification 与 event construction 在其调用点保持可见。

## 16. 验证与审查

在每个代码阶段之后：

```bash
npm run check
```

从 package root 运行每一个被修改的 focused test 文件。不要直接调用完整的 Vitest suite。只在最终 package validation 或明确要求时运行 `./test.sh`。

Review checkpoints 在 R3、R1b、M7、M10 以及最终完成时是强制性的。Delegated reviews 使用 provider `anthropic` 与 model `claude-fable-5`。

最终 greps：

```bash
rg 'lost_ownership|LostOwnership|DriveAbandoned|commandDriveOwned|installerSignal|finalizedOutcome|OperationEnded' \
  packages/agent/src/harness packages/agent/test/harness
rg 'drainedSteer|drainedFollowUp|laneLastResult|RunOutcome|CompactionOutcome|NavigationOutcome|TerminalOperationOutcome|skipInboxOnce|thresholdCheckedTriggerEntryId' \
  packages/agent/src/harness
rg 'SliceNotImplemented' packages/agent/src/harness/runtime
rg ': any\b|<any>|as unknown as|@ts-expect-error' packages/agent/src/harness/runtime
```

最终退出条件：

- 每个 flat leaf 都是 driveable 且 reconcilable 的；
- 公共 primitive/convenience 行为等价，包括 continuation；
- 每一个 focused test 与 backend conformance path 都通过；
- public drive 不暴露任何 partial graph；
- `watchSession` 是唯一被推迟的公共方法；
- `drive(id)` 能回答 session 中每一个 settled operation id；
- harness.md 与实现自洽（M9）；
- provider cache/affinity identity 在并发与 context-reset 的历史中是 lane-safe 的（M10）；
- 独立的最终审查报告没有 blocker。
