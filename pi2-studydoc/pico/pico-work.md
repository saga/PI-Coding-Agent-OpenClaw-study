# pico 实现计划

Clean room。没有从 pico2 复制任何东西；阅读它的测试是为了了解它们抓到的 bug（一次失败的
generation 从未结束其 run、task patches 内部的 refs、一次 collapse 导致 appends 死锁、
在 retry wait 期间触发 quiescence、watch 丢弃迟到的 deltas），从而让 packages 6、9、12 和
16 各自为它们保留一个用例。

目标是自底向上的 modules，各自拥有自己的 tests 和显式依赖，每一步之后都保持绿色。
下面的编号分组是一个临时的 coverage map，而不是最终的 work-package 规模，
也不是已完成的依赖审计。在剩余的概念性 blockers 解决之后，运行下面描述的
独立 whole-document review 与最终 work-package decomposition。
`pico-v3.md` 是参考设计；`pico-usage-guide.md` 展示了预期的 surface。

## 1. Types 与 ids

`Id`、`EntryIdentity`、`EntryBase`、可组合的 `EntryData` / `ModelProjection` /
`ContextHead` / `ContextEdits` facets、`Entry`、`EntryKind`、`EntryInput`、`ContextEdit`、`Task`、
`TaskRole`、以 status 标记的 task-state unions 及其派生的 `Orphaned` 变体、仅编译期的
`TypedTask`/`TaskDefinition` witnesses（保留完整的 union 与字面量 role map）、存储的 task roles
与 `turn` flag、`Conversation`、`QueuedInput`、`InputResult`、`InboxOp`、acceptance
receipts、`Call`（Chord Context 的别名）、`TaskRuntime`/`ToolRuntime`、私有的带类型 invocation
identity、`Address`/`Value`/`List`/`Scope`、`Write`/`CommitBatch`、`Page`/`Cursor` 以及 query shapes。
每个 async harness/handle/runtime 方法都接受一个必需的末尾 Call；没有重复的 signal options、
task-conversation facades 或 admission gates。

添加由 `defineSystemSection<T>` 创建的不可变 `SystemSection<T>` 定义：一个 durable 的 string
`key` 和一个同步纯函数 `render(value: T): string`，其 payloads 可表示为 JSON。Tokens 提供
带类型的访问，无需 plugin casts；只有它们的 keys 与 payloads 会被序列化。导出带类型的内建
`systemSections.identity`、`.environment` 和 `.skills`；plugins 可以定义/注册它们自己的。
Token 上没有 discovery/read callback，entry kind 上也没有 renderer callback。Payload
shapes 在 wire validation 之后被视为可信；shape 变更需要 migration 或兼容的替换。

`SystemSectionDraft` 暴露带类型的 `get(token)`、`set(token, value)`、`delete(token)` 和
`wrap(token, rendered => string)`。`get` 返回一个 owned copy；array 变更使用 get+set，而不是 append
operator。持久化有序的 `SectionChange` records：

```ts
type SectionChange =
  | { key: string; action: "set"; value: JsonValue; rendered: string }
  | { key: string; action: "remove" };
interface SystemData {
  baseline?: true;
  sections?: readonly SectionChange[];
}
type SystemEntry = EntryBase & EntryData<SystemData> & ModelProjection<SystemMessage> & Partial<ContextEdits>;
```

Baseline sections 是一个完整有序的 set records 数组。Null 与 empty string 是合法的
payloads；删除是一个显式 action。Definitions 与 wrapper closures 永远不会被存储。Tool
definitions 只存在于 model fields 中，绝不会在 SystemData 中重复。

Tests：无需 plugin casts 的 typed token/draft inference；owned-copy reads；JSON null 与删除的对比；
每一个 entry facet 与 built-in 组合；持久化的 payload+rendered text 与 model-only tool definitions。
Task type tests：`defineTaskKind<States>()({ ... })` 推断出字面量 roles；确切的 role-map keys、
仅 start 的 initial status、保留的 orphaned、一致的 common-field types/optionality；orphaned 仅通过
`Pick<S, Exclude<keyof S, "status">>` 暴露 common fields，并保留 common optional fields。Typed reads
包含 orphaned；kind methods 排除它。没有 compiler witness 被存储，untyped readers 也不需要它。

## 2. Memory storage

`Storage` 与 `MemoryStorage`：从 `lastSeq` 开始为 `commit` 编号、point reads、fork-aware 的
`scanEntries` / `scanTasks` / `scanConversations`（带 cursors）、在存储的 numeric boundaries 之上做
target-capped 的 `newestHead`、存储的 entry data/model/edits、在某个位置读取的 value versions 与
list elements、`ownedFrom`、已写入的 entry kind strings 集合以及 session-wide 的 live-task scans。
对命名 owners 使用现有的批量 `getTasks`；没有 header/projection APIs 或 inbox-specific queries。

Tests：针对手工构造的 batches 测试 §7.2 query table 的每一行；ids 为 `lastSeq + 1 + i`；无需
kind 即可找到 head；entry reads/scans/head lookup 在索引选择之后返回完整 entries；live-task scans
跳过 terminal rows（命名 owner reads 可能会获取它们）；`remove` 与 `clear` 按位置隐藏。

## 3. Line 与 `Tx`

在序列化的 line 上执行 `commit(plan, call)`：buffered writes、ids 在 call 时最终确定、在 entry 抛错之后
可 rewind 的 conversation value/list writes、抛错的 plan 丢弃一切、在 persist 之后 publish；在调度或
测试 idle 之前将整个 batch 应用到 live indexes。Driver callbacks、signals 与 task methods 在 line 之外
dispatch。Session 与 sticky conversation state、task writes 与 conversation writes 可以出现在任何位置。
`task` / `patch` / `settle` 从 kind 的 status map 物化 role；status 只存在于 `state.status`。
`patch(task, status, payload)` 与 `settle(task, status, payload)` 始终要求显式 status 及其不含
status 的完整 payload。二者都用 `{ ...payload, status }` 替换 state；没有 partial merge 或 status-free overload。
Patch 针对 start/inflight roles，settle 针对 terminal roles 并 retire scratch；二者都不暴露
orphaned。一个裸 id 必须先以某个 kind 读取，才能获得 typed witness。从 kind 物化 `turn`，并
维护已索引的 `inTurn` predicate。当 turn tasks 处于 live 时，`entry` 拒绝 outside-turn 的
model-visible writes；`write` 立即放置或在安全边界排队，并返回一个 inputId。
`value` / `list` / `entry` / `task` / `patch` / `settle` 构建 §7.3 的 batch。

Tests：并发的 commits 会串行化；被拒绝的 commit 不消耗 ids；每个 builder verb 产生
预期的 write；plan 内部的 reads 只能看到已 commit 的 state；session 与 sticky conversation
writes 可以跟随并引用一个新的 entry；在 entry 之后可 rewind 的 value set/delete 与 list
append/remove/clear 各自被拒绝；精确的 invocation-token checks 在 line 上运行；
post-mark 的 main/scratch mutation 在 builder 之前被拒绝；只有 owned task 的当前 invocation 才能
patch 其 state/status 或 settle 它（host abort marks 仍然允许）；caller cancellation 绝不
放弃已 admit 的 persistence；Tx/ScratchTx reads 是异步的，builders 可以 await 它们
而不释放 line；writes 保持同步。Builders 中不允许外部 effects 或嵌套的 line entry。
Compile-time cases：必需的 target fields 与 types、literals/variables/spreads 上不允许额外的顶层 keys、
不允许重复的 status、union arguments 下的 status/payload correlation、inference 不产生 role/status widening、
narrowed task 保留所有 transition targets、typed reads 无法写入 orphaned、没有 bare-id
escape。覆盖合法的 same-status full replacement 与 optional fields；记录 structural typing/cast
的局限，而不是添加深度的 exact-type machinery。Runtime cases：replacement 丢弃 prior-variant
fields、拒绝错误的 roles/保留的 statuses/重复的 payload status、当前 terminal tasks 不能
改变，且 same-status replacement 不会推进 epoch。Payload validation 保持在 wire boundaries。

## 4. Entry kinds 与 context

`EntryKind` 即 `kind` 加上 `is`、registry 以及针对 built-in kinds 的 typed append helpers
（`user`、`assistant`、`tool_result`、`system`、`notice`、`summary`、`handoff`、`reset`）。Writers
物化可选的 model messages 与存储的 controls；context = 最新的 stored head 前置到
从其 numeric boundary 开始的 fork-aware range，排除更旧的 heads，存储的 edits 按
transcript 顺序折叠，存储的 model arrays 拼接，然后是按 call index 排序的 pi-ai tool results。
本 package 没有 managed-system state fold、baseline hoisting 或 system-kind projection filter。
Generation preparation 写入任何必需的 system changes 与 omission edits（group 9）；通用的
projector 只应用存储的 facets。任意的 plugin head writers 不需要 system-specific 行为。

Tests：data-only 与 model-only entries；summary 保留 tail；handoff/reset 规范化 `"self"`；
重复的 compaction 会被 subsumes；低于先前可见边界的 stored head 会被拒绝；edits
omit/replace targets 并跨 turns 持续存在；任意的 managed-system targets 被拒绝，而原子的
fresh-baseline supersession 被允许；在其 plugin kind 未注册时 context 完全相同；
保留的 system deltas 保持可见，直到之后的某个 stored omission 生效；tool-result 顺序。

## 5. Forks 与历史性读取

带 `parent` 的 `createConversation`、fork-aware `scanEntries` 中的 shared prefix、针对 values 与 lists
的 capped-source lookup、任意的 transcript-entry fork points。

Tests：fork 能看到其 entry 处生效的 head、edits 与 values；source 之后添加的 heads/results
不可见；深层 fork chains；成功但不完整的 tool exchanges 在投影时带有缺失的
results，但不继承任何 tasks；在 entry 之后 commit 的 state（一次 model change）不在该 fork 中。

## 6. Task kinds 与 driver

`TaskKind` 带有 `(task, runtime, call)` 方法、registry 与 `TaskRuntime`；对 operations 采用统一的
Call-final 约定，沿用现有的 Context-aware env/provider/hook 边界。Driver decisions、attachments、
waiters、invocation completion 与 lifecycle 在 commit line 上运行。只有 effects/callbacks 在其之外
dispatch。Live tasks 只 seed 一次；已 commit 的 batches 更新 live、reverse-dependency 与 conversation
indexes。只为 live/owned work 向上解析 ownership；淘汰未使用的 ancestry。Stable attachments
与临时 waiters 不同。没有 Wake、polling loop、worker pool、poison graph、gate 或 parked role。

每个 task ID 一个 invocation，跨 IDs 并发；在 dispatch 之前 reserve，且只在
实际返回之后 release，即使已经 terminal。Durable abort 撤销 execute/recover 的 main 与 scratch writes，
然后在 line 之外发出 signals；只有 fresh abort invocation 写入 cancellation outcomes。Status epochs
统计实际已 commit 的 transitions，包括 same-start/end cycles。Task-contract faults 会 fail-stop：
拒绝 waiters、停止 admission、signal/join 并 close；保留 durable recovery state。

Tests：一次 open scan，每次完成时不进行 full scan；100,000 个 historical children 与两个 live tasks；
whole-batch 的 settle/successor publication；精确的 epoch 规则；owned-task 独占 mutation；每个 ID
一个 invocation；被阻塞的 calls 不会阻塞其他 calls；abort 绕过 dependencies 且绝不与
execute 重叠；重复的 mark 不干扰正在运行的 abort；abort-handler 失败；cooperative signal window；
已知的 direct/dependency self-waits，包括 background caller 与创建新 cycle 的 admission；
already-aborted waiter registration 以及每一种 cancellation/idle race；重复的 drive 使用一个
attachment；foreground 在 attached background work 继续时处于 idle；reopen 恢复 marked work。

## 7. Scratch

Scratch batches、每个 batch 一个 task、`ScratchTx`、在 settle 时 retire、与 sidecar 无关（memory）。

Tests：settle 之前的 crash 保留 scratch；settle 删除它；在 mark/settle/retired token 之后的 writes
被拒绝；新的 attempts 清空 scratch；持久化的 assistant frames 使用 pi-ai compact frame encoder，
而不是原始的累积 provider events；被拒绝的 stream-frame write 会取消并 join producer，
然后才 invocation completion（iterator exit 不够）；harness progress bridges 拥有每一个 promise，只抑制预期的
late cancellation，报告 persistence errors，并在 invocation completion 之前 drain。原始 task
scratch calls 必须被 await/catch；不允许成功的静默 no-op。

## 8. Harness shell 与 handles

`Harness.open`（built-in registries、`kinds` 与 `replace` options、kinds-set check、`inspect`、
`drive`、`close`、`shutdown`）、`ConversationHandle`（`commit`、`value` / `list`、`config` /
`settings`、带 `abort` 的 `fork`、`abort`、以 `subtree` 划定 scope 的 `hooks.on`）、`acceptance(requestId)`、
`result(inputId, call)`、`abortTask`、带 `parent` / 独立过滤的 `conversations`。每一个 async
public/runtime operation 都需要 Call，包括 reads 与 lifecycle；不向 tasks 暴露原始的 host-lifecycle
Harness。没有 section-order option 或单独的 ordering configuration。尚无 agent
behaviour。Root creation 以原子方式且仅一次地应用显式的 `rootValues`；reopen 保留
durable model/thinking/selectedTools。Registry 内容并不意味着 tool selection。Children 使用
显式的 value-inheritance policy；缺失必需的 generation configuration 会明确失败。

初始的 `Harness.open` 除 built-in tokens 外还接受 `sections: [...]` definitions。
可变 registry operations 需要一个必需的末尾 Call，并在 line 上串行化：
- `h.sections.register(token, call)`、`.replace(token, call)`、`.remove(tokenOrKey, call)`。
- 并行的 `h.entryKinds` 与 `h.taskKinds` register/replace/remove APIs 使用 kind definitions 或 names。

Register 拒绝重复项；replacement 是显式的，且必须理解存储的 shape。移除
代码绝不会删除 durable entries 或 section state。In-flight preparation 保留其捕获的 section
registry snapshot；之后的 preparations 会看到更新的 definitions，包括显式的 renderer replacements。
在 registry mutation 或 replay 期间不运行任何 rendering。当存在 live instances 时，task-kind removal
被拒绝。Open 将 missing-kind 的 foreground tasks 按 `orphaned` settle，将 missing-kind 的 background tasks
park，且不触碰 terminal history。Registration 在已 attached 的
scopes 中恢复 parked recovery；它既不隐式 drive 其他 scopes，也不复活 terminal tasks。

Tests：rootValues 仅对 fresh root 原子应用，在 reopen 时被忽略；registry 变更不会自动产生 tool
selection；required-config errors；在空 storage 与已有 storage 上 open；
initial/custom/built-in section definitions；重复
registration 被拒绝；兼容的显式 replacement；removal 保留 durable state 与存储的
rendered fallback；preparation 期间的 registry 变更不会改变其捕获的 definitions，而
之后的 preparation 会看到 replacement。未注册的 entry kinds 会在不做 history scans 的情况下被报告，
且存储的 facets 仍会推导出 context；缺失的 foreground kinds 变为 orphaned，缺失的 background
kinds 保持 parked 并被报告，registration 恢复 recovery，terminal history 保持不被触碰；
存在 live instances 时的 removal 被拒绝。按 name 进行的 Replace 保持 `h.kinds.<name>` 一致；`settings` 可往返；scoped hooks 在
harness-wide hooks 之后运行，最内层最后；derived Call 保留带类型的私有 identity 与 telemetry；
stale/foreign task token 被拒绝；close 在一个非持久化的 line job 中停止 admission，并在外部 join；
shutdown 只原子地标记 live tasks，然后允许 abort cleanup；queued items/results 保持
不变，包括 idle 的 inbox-only conversations；crash/reopen 的 child cleanup 只标记 tasks 并
保留 queues；重复的 close/shutdown 共享完成；close interrupt 拒绝 shutdown；
带 task identity 的 lifecycle calls 被拒绝；delete 拒绝未完成的 terminal invocations。

## 9. Generation kind

一个稳定的 generation task 携带 `inputs: Id[]`，并在 faux provider 上循环 pending → streaming → retry_wait /
deferred → streaming，直到 done / failed / aborted；为其整个 input group 提供显式的 terminal results；
捕获的 config（model、thinking、selected tools、profile、budget）；
`system_instructions`、`before_request`、`after_response`、`on_yield`；retry 在 execute 中 sleep；
从 frames 恢复；usage 按 attempt 记录。

**Durable configuration 与 typed preparation。** Config 仍是普通的 scoped state，在变更时按其声明的
rewind/sticky policy 持久化。Host files 与 catalogue 内容不会
神奇地作为 config 存储。Call-final 的 `system_instructions` hook 接收捕获的 config 和
一个共享的可变 `SystemSectionDraft` 作为 `sections`。Sections 是被 mutate 的，而不是被返回的；handler
可以返回 `{ tools?: readonly Tool[] }` 作为完整的期望 loadout。Handlers 按
registration order 顺序运行，outer scopes 在 inner ones 之前。

从 canonical durable section payloads 与 rendered text 为每个新 draft seed。带类型的 `get(token)`
返回一个 copy；变更需要 `set(token, value)`。设置已存在的 key 会保留其位置；
新的 key 会追加；`delete(token)` 显式移除它。Array payloads 使用带类型的 get+set，没有
append operator。缺失的 contributions 或已注册的 definitions 不是 deletions。未被触碰的
seeded section 保留其存储的 rendered text，包括在 restart 之后；不可用的 renderer
使用该 fallback。Initial sections 需要提供的 base payload 或存储的 fallback。

显式的 set/wrap 或 renderer replacement 会通过捕获的 registered renderer 重新计算。
`wrap(token, rendered => string)` 需要一个 registered section；wrappers 是同步的、纯的，并且
在渲染其 payload 之后按 registration order 应用，而不是叠加在已 wrapped 的 stored text 之上。
Wrappers 只属于当前 draft，并在每次 preparation 时重置。Host handlers 在 plugin transformations 之前刷新完整的
current base payloads；这会刻意重建 wrappers。跨越 refreshed base 的
missing wrapper 的保留不做承诺。组合后的 transformation CHAIN 必须在
重复 preparation 下达到固定点，或使用更早的 authoritative base reset。逐个
idempotent 的 handlers 是不够的；harness 不添加通用的 convergence loop。

Disk discovery 与 caches 对 host/hook closures 或 services 保持私有，并由它们自己的
watcher/TTL policy 刷新。Tokens 没有 source-read callback，entries 也不保留任何 callback state。Refresh
failure 不是 deletion。在现有的 skip-failed-handler policy 下，丢弃该 handler 的 draft
mutations（包括 wrappers），同时保留更早 handlers 的 changes；绝不 publish 一个部分的 delete。
在 hooks 之后，在 line 之外捕获 payloads 与纯 rendered results。没有 plugin renderer 会在
replay 或 commit line 上运行。

**Canonical section state，与 model projection 分离。** 将 fork-visible 的 managed system data
沿 target 折叠，从最近的 baseline 开始，独立于 model heads 与 baseline
supersession omissions。那些 facets 控制 model projection，而不是 canonical section payloads。使用现有的已索引
kind scans，而不是无关的 transcript scans 或新的 storage API。一个可选的 per-handle cache 保留
current section state 及其 prepared cursor，而不是完整 history；每个 fresh baseline 都会 checkpoint 所有
canonical sections。没有额外的 sticky full-state write。因此缺失的 contributors
即使在原始 baseline 位于保留的 model range 之外时，也能在 restart 与 compaction 后存续。

按 key 比较 payload 与最终 rendered text，绝不通过解析散文来比较。Baseline data 包含
完整有序的 set records；delta data 只包含 set/remove changes。JSON null 与 empty string
是 values，而不是 removal。当不存在独立的 tool change 时，payload-only 变更会持久化一个带 `model: []` 的
metadata-only managed delta。payload 未变而 renderer/wrapper 变更时，若 rendered text 变化则发出一个
model update。纯 reorder 不发出任何 entry 或 order-change delta。按 draft 顺序渲染
baselines 与同时发生的 changes，并以 stable key 使用通用的 initial/change/remove labels；
historical messages 永远不会被重新排序。一个 system entry 记录的是为某个 request PREPARED 的
canonical instructions，而不是 provider 已收到它们的证明；append 它不会调用任何 provider。

Tool differences 与 section differences 保持独立。完整的 definitions 只出现在
SystemMessage 的 `toolsAdded`/`toolsRemoved` 中，绝不出现在 SystemData 中。先折叠 removals 再折叠 additions；additions
按 name upsert，包括同名 definition/schema 的替换，而不为该 name 发出 removal。
一次 deletion 携带此前存储的完整 definition，而不是在今天 catalogue 中的 lookup。

**Epoch preparation，而非 head-time behavior。** 每一次 generation/provider request preparation 都会检查
最新的可见 head 与生效的 managed system entries。缺失 current-epoch baseline
时需要一个 fresh baseline。任意的 managed-system edits 被拒绝；当前 baseline 的 supersession
omissions 不会反复使其失效。Rebuilding 使用来自独立 data fold 的 canonical payloads/rendered fallback，
而绝不只用 model tail。
为被取代的保留 managed baselines 以及 deltas，在同一条 fresh baseline entry 上
append 存储的 omission edits，绝不针对任意的 system notices。在 preparation 之前，generic context 可能暴露
悬空的旧 deltas；没有任何 request 会绕过 preparation。Head writers 保持通用。Fresh baseline
仍位于保留 tail 之后其被 append 的位置，而不是位于隐藏的 prepended slot 中。

在从所有剩余的生效 SystemMessages（包括 non-managed messages）折叠 tool declarations 之前，
先应用 planned omissions。Fresh baseline 添加完整的期望 tool set，并显式
移除不需要的剩余 declarations；`baseline: true` 不是 pi-ai tool-map reset。绝不发出
仅由同一次 preparation 即将 omit 的 messages 推导出的 removals。

在 hooks 之前捕获 canonical section state/cursor 与 section registry snapshot。在 line 之外完成 hook 与
render 之后，在 line 上验证没有并发的 managed section-state change
发生，包括 metadata-only changes。如果发生了变化，则在 line 之外从
fresh canonical state 重新开始 preparation。仅 compaction 的 head change 不会使 payload draft 过期：只在
line 上重新计算 model baseline/delta choice、planned omissions 与生效的 tool differences。

在 prepared generation variant 上原子地持久化任何 baseline/delta（包括 metadata-only）、inflight status 与
`state.requestThrough`。即使不需要 system change 也要捕获 cutoff；unprepared variants 没有 cutoff，
deferred variants 保留其 request 的 cutoff。在
persistence 之后，同一个 line operation 将 current model cache 追赶到 cutoff，并捕获一个
不可变的生效 entry references 数组（包括不可变的 replacement projections），然后
释放 line。Current caches 独立推进；invocation 保留其 snapshot，而不是可变的
cache containers。仅为 request-local 的 mutating normalization/hooks 克隆 messages。在更旧 cutoff 处的 Cold/recovery
reads 从 storage 推导，而不 rewind current caches。在 invocation 之后释放 snapshot 与
捕获的 registry references；没有 version registry。

**Request-local overrides。** 在 request-local copy 上保留任意的 `before_request` message transformations；
它们无法 mutate stored entries，也无法让 Pico 退出 messages-only mode。
Canonical prepared state 仍是后续 diffs 的基础。精确的 transformed requests 无法
从该 state 重建，除非被显式捕获；没有强制性的第二个 request ledger。
在 transformation 之后，对照实际提供的 definitions 校验返回的 tool calls，同时
保留 implementation availability 与 permission checks（group 10）。

Tests：
- 带类型的 built-in/custom tokens；owned-copy get 与显式 set；shared-draft 的 registration/inner order；
  已存在 key 的 replacement 保留位置，新 key 追加，显式 delete 与 null/empty
  payload 不同，array updates 使用 get+set，且 wrappers 需要 registered sections。
- 未被触碰的 seeds 保留 rendered text；显式的 set/wrap 与 renderer replacement 会重新计算；wrappers
  按 registration order 组合，并按 draft 重置。Authoritative base refresh 会重建 wrappers；
  missing wrappers 不必在 refresh 后存续。检查完整 transformation chain 的稳定性，
  而不只是其各个 handlers，并检查使用更早 authoritative base reset 的重复 preparation。
- 缺失的 contributor/definition 与失败的 refresh 保留存储的 payload/text；被跳过的 handler 的
  partial mutations 不会泄漏。Registry remove 绝不删除 section state；re-registration 与
  兼容的 replacement 可用。没有 renderer 在 replay/line 上运行；没有 closures 进入持久化 records。
- 持久化 payload 与 rendered text；payload 改变/text 不变会给出 metadata-only 的 `model: []`；
  payload 不变/rendering 改变会给出一个 model update；显式 removals 与 reorder-only 为 no-op。
  Baseline/change 的渲染遵循 draft order。Tool changes 保持独立，包括 tool-only
  的 empty content、additions/removals、同名 schema changes 与 `addTools`；data 中不重复。
- Config change 在下一个 system entry 之前 commit；config change 之后的 crash 保留它；在 system append
  之后、invocation 之前的 crash 不会重复未变的 canonical preparation。Canonical
  recovery 折叠 metadata-only records，且绝不需要原始 contributor/renderer。
- 跨 fork cutoffs、model heads 与 supersession omissions 的独立 canonical fold；missing-plugin
  sections 在原始 baseline 位于 model range 之外时仍能存续，并出现在下一个 full baseline 中。
  重复的 compaction 使用最新的 canonical checkpoint，而不需要无界的 handle history cache。
- Compaction/reset/handoff 与任意 plugin heads；保留的旧 model baseline 仍然需要一个
  新的 epoch baseline；保留的 tail order、baseline-time omissions 与 preserved notices；preparation
  之前与之后的 fork 使用其自己的 canonical state/inherited config，而不改变 source。
- 任意的 managed-system omit/replace edits 被拒绝；fresh-baseline supersession 将 controls 与
  instructions 一起 commit，而不改变 seed 的 canonical data。被取代的 omissions 不会触发
  重复的 baselines。在 planned omissions 之后计算 tool removals；包含剩余的非 managed tool
  declarations。Generic projection 不运行任何 system-kind code。
- hooks/render 期间的并发 canonical writes（包括 metadata-only deltas）会强制 preparation
  在 line 之外重试；registry 变更保留捕获的 snapshot，并影响之后的 prepares。
  Head-only changes 会重新计算 epoch/omissions，而不丢弃 payload draft。projection/streaming 期间
  之后的 head 无法改变 `requestThrough`，包括未 append 任何 system entry 时。
- Preparation snapshots 包含 baseline omissions；之后的 heads、edits 与 cache updates 无法改变
  捕获的 entries 或 replacement projections。Normalization/hooks 只 mutate message clones。
  在更旧 cutoff 处的 Cold/recovery derivation 不改变 current caches；invocation completion
  释放 snapshot references，而无需 version registry。
- Request-local overrides 不改变 stored state，保持 messages-only，并决定实际的
  offered-tool validation；adapter fixtures 受 group 20 中 pi-ai 前置条件的 gate 约束。
- 没有 durable mark 的 In-band provider abort 有一个 kind-level outcome；post-mark 的 execute settlement
  被拒绝，且 fresh abort 原子地写入可选的 partial、cancelled input results 与已知 usage。
  Normal settlement 中没有 mark 分支；缺失的 post-cutoff usage 是未知的；streaming 期间的 crash
  publish 该 partial；retry budget 耗尽 → failed，且没有 successor。

## 10. Tools、post_tools、exchanges

带 sink 的 tool kind（`ToolOutput`、`ToolOutputState`、由 sink 强制执行的 limits、`diag`、
`delegate`、`handoff`、`addTools`、`terminate`）、带结构化 data 及其物化 model message 的 tool-result entries、
`before_tool`（fail-closed）与 `after_tool`、
recover 时的 replay policy；带 `after` 的 post_tools、携带的 input groups、terminate / handoff / steer /
next generation；`accept` 的 idle 与 busy；`prompt`、`result` 与 request acceptance lookup。在 request-local overrides
之后，对照 prepared request 实际提供的 definitions 校验
calls，而不只是捕获的 selected-tool names 或今天的 catalogue。保留 registry 与 permission checks。

Tests：transformed 后的 offered-tool definitions、被移除的 tools 与同名 schema changes；parallel tools
以任意顺序完成；通过 `after` 实现 sequential；被 aborted 的 generation
不创建任何 tool tasks/results，而被 aborted 的现有 tool 会写入它自己的 error result；
`new_context` 在 exchange 之后重置，绝不在其内部；`addTools` 在 settlement commit 中
任何 handoff/user entry 之前写入可 rewind 的 loadout，并出现在下一 turn 的 `toolsAdded` 中；
抛错的 tool → error result，`terminate` 仍被遵守；来自 sink 的 truncation diag；丢失的
accept response 通过 `acceptance(requestId)` 恢复；重复的 create 报告第一个
receipt，而不比较 payloads 或 modes；results 在后续 turns 之后仍可 point-read。
post_tools 通过从 orphaned tool tasks 的 common fields 写入 unavailable-tool results 来处理它们。
Turn-task entry appends 保持立即执行；outside-turn 的 model-visible writes 在 inTurn
非空时排队，并在 post_tools/final boundaries 落地。Data-only entries 永远不会被阻塞。

## 11. Inbox

`pi.inbox` 作为一个 conversation sticky list，其 element id 为 `inputId`，其 value 持有 mode、
user content 或某个 write 的 entry draft 以及可选的 request id；append/remove/clear 的 watch operations；
queued/placed/done/unanswered 的 result variants；三个 placement points；携带的 generation/post_tools
input groups；`queueInput` 与 `abortInput`；abort 会 drain steer 与 followUp，同时保留 write
与 nextRun。一次 write 在其 placement commit 中未获得 answer 即到达 done。

Tests：idle 的 append/remove 是一次 commit，且不发出任何 inbox event；busy 的 image payload 是一次 append
operation；the modes table；steer 在 post_tools 处 join，但在 final answer 之后开始一个 group；
followUp 开始下一个 group；nextRun 等待 idle accept；writes 被放置而不 join；
多个 inputs 解析为一个 answer；cancel/land 与 abort/group-transfer 以两种顺序；queued 与
placed 的 crash recovery；cancelled 的 unplaced payload 不可用；collapse 期间排队的 input 会落地。

## 12. Collapse

Manual、threshold 与 overflow；`before_collapse`；仅在不存在更新的 head 时 publish；overflow
chain（generation settles → collapse → 携带该 attempt 的新 generation）。

Tests：summary 在正在运行的 generation 之下落地，且之后的 entries 仍留在 context 中；一个竞争的
head 会使 summary 变为 stale，而其间发生的 edits 不会；overflow 重试一次，且没有任何 live task
会等待该 collapse；turn 之前的 threshold；对正在运行的 collapse 执行 abort 后 appends 仍继续流动。
一个 head 不添加隐式的 system omissions：下一次 request preparation 会用其 fresh baseline 写入它们。
测试 preparation 之前保留的 deltas 与之后它们存储的 omission，同时不在其冻结的 cutoff 处使
already-prepared request 失效。

## 13. Subagents

`subagent` tool（`run`、`spawn`、`send`、`status`、`wait`、`stop`）、ownership links、通过 live owners 的
foreground reach、`run` 的 recover 再次 drive 该 child、`spawn` 对 config 的初始化、
显式的 child input results。

Tests：在 `run` 中途 restart；conversation abort 能到达 `run` child 并放过 `spawn`
child；abortTask 只标记 owner，且 fresh cleanup 取消其 child；drive waiter 观察到 Call；
cleanup 容忍已经 terminal 的 child/job；`stop`；嵌套 children；child 自己的 baseline。

## 14. Jobs 与 budget

`ExecutionEnv.exec` 上的 `jobKind`，其 output 进入其 scratch、`waitForTask` / `jobOutput`、`bash`
先 delegate 然后带着 budget 等待、`notify` 与 `notice` entry、`job` tool、
schedules。

Tests：job 创建在 tool 上原子地存储 job id 与 cancellation policy；fresh tool abort
使用那些 durable references，而不是 execute locals 或 catch writes；budget 到期会 settle delegated，
且 job 继续；delegation 在单独的 sticky state 中请求 notification，而不是对 owned
job 打 patch；notification/completion 的两种顺序对 exited、lost 与 killed 都只 publish 一次；schedule 循环一个
稳定的 id；foreground drive
忽略 background recurrence；recover → lost 或安全 rerun；abort 杀死 non-detached job。

剩余集成设计：arbitrary-promise budget adoption 必须在 tool invocation 释放之前显式转移 effect 与
sink ownership。不允许被 race 掉的、被放弃的 promise。
保留该 capability（crash outcome lost），但在 transfer 确定之前实现 job-first execution。

## 15. Previews

`runtime.preview` 作为每个 task 的 Chord tracker；generation 将 stream events 应用到一个 partial
message，tool 的 preview 是其 sink state，job 的也一样；`preview.init` 在 attach 与
reopen 时；每次 scratch commit 之后 flush。

Tests：一个 token → 一个 `a` op，别无其他；mid-stream 没有 `r`；reopen 之后的 init 产生一个
等于 live preview 的 base；滑动的 tool tail → `t` + `a`。

## 16. Watch

`ConversationView`、`ConversationEvent`、导出的 kind-free `applyEvent`、`WatchHandle`
（在 line 上 capture、有界 buffering、`resnapshot`、`unsubscribe`）、带
`report` 与 `usage` 的 session watch、usage ledger（`pi.usage` + totals）。

Tests：fold 是正确的（N 个 events 之后的 view 等于 fresh capture，随机化）；head 与 edit
entries 更新派生的 context；inbox 的 append/remove/clear operations 更新 view，且同一 commit 内的
append/remove 会取消；一个 commit 的所有 events 一起投递；在已记录 stream 之上的 thin-client reducer，未加载任何 kinds；
lag → fault → resnapshot；从 listener 内部执行 `resnapshot`；usage totals 等于 ledger
fold，包含 failed 与 aborted 的 attempts。

## 17. JSONL storage

Append-only batches、在 open 时 replay、丢弃 torn tail、malformed line 使 open 失败、来自 replay 的 entry
`data`/`model`/`head`/`edits` 与 kind-string 集合。main 与 scratch 文件中的整份 value sets 与内在 list
operations；没有 Chord storage codec。先 replay main，然后是存活的 live
scratch；per-file sequence gaps 是合法的。从最大的完整存活 batch
endpoint 恢复 lastSeq，包括 clear/remove。Retired scratch 被忽略；其之后的 settlement 覆盖其 ids。
在 append 之前物理移除 torn suffixes；malformed 的完整 replayed batches 会失败。

Tests：对照 memory 的 conformance；磁盘上的 full replacement values；紧凑的增量 frames/output
operations 避免反复增长的 snapshots；main=100/live scratch=150 在 150 处 reopen；settle=151
且 unlink 失败时忽略 retired scratch，即使 malformed；clear/remove 的 high-water；torn 的 main 与
live scratch tails；不重叠的 ranges；accepted payload 加上 placement 有两个 JSONL copies，
包括 idle acceptance。Backend memory 与 disk growth 的主张与 whole-value 行为一致。

## 18. SQLite storage

§7.5 的 Tables 与 indexes、data/model/edits 的可空 entry JSON columns 与一个带索引的整数
head boundary、在 settle transaction 中删除的 scratch rows、storage version 与 `migrate`。

Tests：三种方式的 conformance；被移除的 sticky inbox elements 可以被物理丢弃，而
input results 仍可 point-read；cold reopen 解码 live tasks 以及仅具名的必需 owner
records，包括 terminal owners；没有保留的 terminal payload cache；version mismatch 被拒绝。

## 19. Race matrix 与 telemetry

§10.2 matrix 以两种顺序，配合 faux clocks、fake processes 与 storage barriers；spans 按
task call 与按 commit。

Tests：the matrix；一个带 tool 与 retry 的 turn 的 span tree；嵌套 Call 保留 active telemetry
parent 与私有 invocation identity；drive-caller cancellation 不会变成 task signal；
providers/env 解释 signals，hooks 传播 cancellation 而不是吞掉它；没有 callback
在 line 上运行；stale 的 RPC-bound invocation 被拒绝。Metadata transport 绝不携带 task authority。

## 20. Clients 与 pi-ai integration 前置条件

mini（`worker/run.ts`、`worker/lane-service.ts`、TUI `apply(view)`）、实验性 agent 的四个
seam files（`session-worker.ts`、`agent-controller-provider.ts`、`models-provider.ts`、
`transcript-provider.ts`）、real providers。integration milestone 仍是：live model 上的 system deltas、
一次 retry、一个 spawned subagent 在 restart 后存续、正在运行的 turn 之下的 speculative compaction。

**外部前置条件，而非已落地的功能。** PRs
[#9116](https://github.com/earendil-works/pi/pull/9116) 与
[#9117](https://github.com/earendil-works/pi/pull/9117) 是本设计轮次中的 open dependencies。
它们商定的 target 与 fixtures 必须在 integration 之前交付并验证；无论是 open
PR 的 types 还是本计划，都不能确立该行为已经存在。

Target：当 `context.systemPrompt` 与 `context.tools` 都为 undefined 时，pi-ai 进入 system-message mode。
Pico 只提供 `{ messages }`，绝不提供平行的 top-level instructions/tools。SystemMessage
携带 text 以及完整的 JSON `toolsAdded`/`toolsRemoved` definitions。Provider/model translation
属于 pi-ai：不受支持的 mid-conversation changes 会变成在其历史位置用 `<system>` 括起来的 user messages，
而 adapters 从 message history 推导出必需的批量 wire tool declarations。Pico 不实现 fallback，
也不把 changes 压平成重写后的 top-level prompt。
Cache preservation 是 best-effort，而不是通用的 prefix-cache 或 instruction-priority 保证。

必需的 adapter fixtures：两个 top-level fields 都缺失与其中任一被提供；有序的 baseline 与
section updates；empty-content 的 tool-only changes；removals 与同名 upserts；对
removed/replaced tools 的历史 calls；historical-position fallback；带保留 tail、stored omissions
与 append 的 fresh baseline 的 compaction。为 summarizer/provider request
paths 包含 messages-only preparation，而不只是普通的 generation。在没有 provider credentials 的情况下运行 faux fixtures；live integration
等待 dependency contract 与单独授权的 smoke tests。

当前的草图把 groups 1–16 放在此 milestone 之前，把 17–19 放在之后。该顺序与这些
规模都是临时的，将在下面的 final planning gate 中验证并拆分。

## Final review 与 work-package gate

在剩余的概念性 blockers 解决之后，对 spec、guide 与本计划执行一次独立的 whole-document audit：
调和 APIs、invariants、examples、cross-references、external prerequisites 与 coverage，同时保留
已商定的 features，并显式追踪残留的 integration questions。
该 audit 仍在前方，并未由 blocker-7 update 完成。

然后用小的、自包含的、可测试的、可人工评审的 work
packages 替换临时分组。每个都需要显式的 prerequisites、有界的 scope、interfaces 与 acceptance tests，并有一个
绿色的增量验证步骤，且没有未解决的 forward dependencies。不要将当前的
编号或 package 规模视为最终的 implementation decomposition。

## 21. Runtime schema bundle

`harness.schema(call)` 遍历三个 registries，并发出一个文档，描述 client 在此 session 中能看到的
一切：core protocol types（`ConversationView`、`ConversationEvent`、
`InputResult`、`QueuedInput`、`DeltaOp`），加上每个已注册 entry kind 的 `data`、每个 task
kind 的 state union 与 preview，以及每个 tool 的 parameters 与 details。在 runtime 生成，而不是
在 build time，因为有趣的那一半是 per installation 的：碰巧被注册的 plugin kinds 与 tools。
Client 每个 session 获取一次，之后就能读取其作者从未听说过的 plugins 的 `Entry.data`、
`Task.state` 与 previews。

Schemas 是按 kind 可选的。不声明任何 schema 的 kind 仍然可用；其 payload 对外部 client 是
opaque JSON，这正是 renderer 已经处理过的 generic-fallback 情形。声明
是渐进的：为你希望第三方 clients 理解的 kinds 添加 schema。

对于 kind 如何声明 schema，有两个待定选项，在尝试第一个之后再选定：

- 一个由 pico 拥有的小型 descriptor（约十二种情况：scalars、literal、array、带
  optional fields 的 object、tagged union、ref、unknown），用 `Static<S>` 推导 TypeScript type，再加上
  adapters `toJsonSchema` / `toTypeBox` / `toZod` 与 `fromTypeBox` / `fromZod`，供那些
  已经用 validator 声明的作者使用。这样 Pico 不依赖任何 validation library。代价：手写的
  conditional types 其错误信息比 TypeBox 的更差，且 adapters 必须拒绝 descriptor
  无法表达的内容（refinements、formats、dynamic keys），而不是静默丢弃它。
- 用 JSON Schema 作为 descriptor，因为 tool 的 `parameters` 已经是一个，adapters 只用于
  编写便利。少一种表示形式；没有 validator library 的作者手写 JSON
  Schema。

Schemas 描述，但不 validate：stored objects 是可信的（§7.3），validation 属于
wire boundaries，因此想要严格 ingest validation 的 host 需要自行 opt in。Versioning 是按 kind 的，而不是
全局的；改变自身 shape 的 kind 会提升自己的 version，这也是 migration signal。

当 client 不是 JavaScript 时需要。不属于 gate 的一部分。

不是 packages：permissions 与 approval policy 属于 plugin territory（`before_tool` 可以阻止或
重写 args，并且可以等待一个人，scratch 持有 durable memo，values 持有
plugin 记住的任何东西，而一个 keyed service instance 会把该问题展示给每一个 attached presentation），
且在本项目处于 experimental 阶段时 session migration 不成问题。

## 从 lane harness 继承什么，以及如何继承

Clean room 意味着不从 `src/harness/runtime`、`session`、`agent-harness.ts` 或
`dom`/`pico`/`pico2` spikes import 任何东西。当旧代码有值得保留的内容时，它会被 **copied** 到
`src/harness/pico/` 并在那里被拥有；pico 必须在 `src/harness` 的其余部分被删除的情况下仍能 build。

复制（除非另有说明，否则位于 `packages/agent/src/harness/` 下）：

| 内容 | 来源 | 去向 | package |
|---|---|---|---|
| `ExecutionEnv` / `FileSystem` / `Shell` types、Node env、capture 与 spill | `types.ts`、`env/`、`tools/tool-context.ts`（03-execenv） | `pico/env/` | 10、14 |
| shell output limits、`applyShellOutputUpdate`、truncation totals | `utils/` | `pico/env/output.ts` | 10 |
| built-in tools（`read`、`write`、`edit`、`bash`、`image`） | `tools/*.ts` | `pico/tools/`，改写为 sink signature | 10、14 |
| system prompt helpers、skills、context files、templates | `system-prompt.ts`、`skills.ts`、`prompt-templates.ts` | host handlers 刷新 typed base payloads；纯 section renderers 格式化它们，不使用 source-read framework | 9、20 |
| telemetry span helpers | `telemetry.ts` | `pico/telemetry.ts` | 19 |

作为 packages 依赖（它们不是旧的 harness）：

- `@earendil-works/chord` 的 Context types 与 `@earendil-works/chord/context` helpers（1、6、8、19）
- `@earendil-works/chord/delta`（15、16：仅 preview/watch；不是 storage）
- `@earendil-works/pi-ai`：用于 tests 的 `faux` provider、用于 thresholds 的 `utils/estimate`；SystemMessage 与
  messages-only adapter 行为依赖上面已验证的 PR #9116/#9117 target（4、9、12、20）

在编写等价物之前先阅读，然后关闭文件：

- `runtime/drive/retry.ts`、`deferred.ts`、`response.ts`：retryable-error classification、overflow detection、deferred polling（9）
- `compaction/`、`runtime/drive/boundary.ts`：exchange-cut rule 与 summarizer prompt（12）
- `runtime/drive/recovery.ts`、`restore.ts`：per-phase recovery case list（9、10、14）
- `runtime/drive/tool-placement.ts`：projection 必须重现的 result order（4）
- `hooks.ts`、`docs/harness.md` §before_tool：确切的 decision shape（10）
- `session/`、`test/harness/jsonl-*.test.ts`：torn-tail 与 malformed-line 规则（17）
- `session/`、`test/harness/mutation-line.test.ts`：line discipline 边界情况（3）
- `agent-harness.ts`：`LaneSnapshot` / `HarnessEventPayload`，仅用于 `toLaneSnapshot(view)` shim（20）

要移植的 Tests（`packages/agent/test/harness/`）：三个 conformance suites 作为 17–18 的模型；
`compaction`、`branch`、`context`、`execution-*`、`values`、`mutation-line` 作为
19 的 parity source；`system-prompt`、`prompt-templates` 用于 9 中的 host handler；`tools`、`truncate`、
`output-capture` 用于 10；pico v1 的 27 个移植场景作为需要
重新证明的最短 behaviours 清单。

不要阅读：`runtime/lane.ts`、`reducer.ts`、`drive/reconcile.ts`、`structural.ts`、
`terminal.ts`、`checkpoint.ts` 以及 `dom` spike。它们是本设计所替换的 operation state machines 与
reconciler。
