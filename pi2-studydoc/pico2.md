# pico v2

一个用于运行 agent 的 harness。本文档是评审中的设计，
而非一项实现声明。实现前仍需要的决策列于 §25。

前置知识：pi-ai（`Models`、`streamSimple`、tool definitions、thinking levels、deferred
handles、`AssistantMessage`/`UserMessage`/`ToolResultMessage`）。其余一切都定义于此。
接口与示例是提议的 TypeScript 形态，不是现有的包导出，也不是一项
实现完整性的声明。JsonValue/JsonObject 表示严格 JSON。AssistantMessage、UserMessage、
AssistantMessageFrame、DeferredHandle、Usage 与 Models 复用 pi-ai；AgentMessage/ThinkingLevel 与
Context 复用现有的 agent harness。Host capabilities 与显式开放的契约不由此处的
草图静默实现。规范性用词：MUST、MUST NOT、SHOULD、MAY。

历史：`pico.md`（v1）把 session 建模为一棵常驻的 node 树；`pico-v2-tree-draft.md`
试图对该树分页；`pico-v2-folds-draft.md` 用 transcript 取代了树，并用
"folds" 来限定模型的 context。本版本保留 v1 的 driver、kinds、scratch、line、hooks、
typed values 与 watch，并用三种各自独立存续的事物以及一个显式
context 列表取代了树与 folds。

---

## 0. 一页概览

一个 **session** 存储会话、entries、tasks、values 与 lists。它已提交的写入共享
一个有序序列；物理表示由 backend 决定。JSONL 保留 main history 与
分离的具名 working scopes（§4）。一个会话由三样东西组成：

1. 一个 **transcript**：一个仅追加的不可变 **entries** 列表（一条用户消息、一条 assistant
   消息、一条 tool result、一条 summary）：发生了什么；
2. **tasks**：带有 status 与 code 的小型可变记录（一个进行中的 generation、一个
   正在执行的 tool、一个后台 job、一个 subagent、一个等待中的 approval）：driver 运行什么；
3. **typed values 与 lists**：settings 与 plugin state，带有位于 journal
   位置处的不可变版本：fork 与 rewind 在某个已提交边界处读到的东西。

Session-scoped values 持有诸如 entry labels 与 request identities 之类的元数据。它们不会 rewind。
Conversation values 与 lists 跟随 history，独立于 transcript 选择（§5）。

模型不读取 transcript。它读取会话的 **context**：一个简短的 entry ids 列表，
由三个 op（`append`、`replace`、`reset`）编辑，其形状始终是
"一个 head entry（一条 summary 或一个 handoff），随后是按 transcript 顺序选中的 entries"。

一个 **kind** 定义 entry 或 task 是什么，并且对 tasks 而言，定义运行、
恢复与中止它的 code。Values 与 lists 使用 typed bound addresses，而非 kind 注册。一个 **read model**（SQLite 用表；JSONL 在内存中重建）回答
"什么是 live"、"这个 task 现在是什么"、"位置 P 之前 key K 的最新 value"，并对
transcript 分页，而无需重放 journal。Memory 持有每个 live 会话的 context
entries 及其 live tasks；其余一切按需读取。一个 **subagent** 是一个
拥有一个会话的 task；唯一的嵌套是 `conversation ⊃ task ⊃ conversation`。Clients **watch** 一个
会话，并接收一个 transcript 页、context 列表、live tasks，然后是 journal records
在它们 commit 之时。

---

## 1. 定义

- **seq**：record 在 journal 中的位置；一个 session-global 的正安全整数，在
  line 上构建 command 时铸造（§7）。每个 entry、task 与会话都由
  创建它的 journal record 的 seq 标识。Storage 保留这些 seqs；它不分配
  也不重映射它们。内部标识不需要 UUID 或单独分配的 id。一个可选的 external
  request identity 通过一个 session value 映射到被接受输入的 numeric id（§18.1）。
- **conversation**：一个标识（其创建 seq），带有一个可变的 **conversation state**（§4.1）、一个
  transcript、work、typed values/lists 以及一个 context 列表。**root** 是没有 parent 的会话。
- **entry**：一个不可变的 transcript 元素（§2）。只写一次；永不 patch；永不重排。
- **task**：一个带有生命周期的可变元素（§3）：一个 generation、一次 tool execution、一个 job、一个 subagent、一个 collapse、一个 approval。由 `set` patch。
- **value**：位于 typed address 的一个 scalar；session-scoped（仅最新）或 conversation-scoped
  （versioned，支持历史读取）。一个 conversation **list** 存储不可变的 sequenced 元素（§5）。
- **history boundary**：一次完整 commit 的最后一个 seq，绝不是某次 commit 内部的位置。
- **transcript order**：一个会话的 entries 按 id（seq）的顺序。不存在其他顺序。
- **context**：模型读取的 entry ids 有序列表（§6）。存在于 conversation state 中。
- **live**：status role 不是 `terminal` 的 task（§3.2）。一个会话是 live 的，如果它有 live
  tasks、一个 live owner task，或一个已挂接的 watcher/handle。
- **the line**：该 session 的唯一 command 队列（§7）。
- **scratch**：具名 working scope 中的普通 values/lists，durable 直到显式 retirement（§3.5）。
- **projection**：模型接收到的 messages，由 context 列表构建（§6.4）。
- **canEditContext**（§8.1）：没有 in flight 的 generation request，且没有未解决的 foreground calls。
  一次安全的 context 编辑不是一次生成请求。
- **generation task**：生成这一 durable 义务；绝不从 context 尾部推断。

---

## 2. Transcript

### 2.1 Entry

```ts
interface Entry {
  id: number;                 // seq of its journal record; also its transcript order
  conv: number;               // owning conversation
  kind: string;               // "user" | "assistant" | "tool_result" | "summary" | plugin content kinds
  by?: number;                // the task that wrote it, if any
  callIndex?: number;         // tool results: index of the call within the assistant message they answer
  through?: number;           // summaries: the last entry the summary replaced (§6.2)
  key?: string;               // optional indexed content key; not a typed value address
  meta: JsonObject;           // small resident fields: timestamp, preview, sizes
  payload?: JsonValue;
  commitEnd: number;          // containing MAIN commit; supports entry-based historical selection
}
```

Entries 是不可变的，且 transcript 是仅追加的：没有任何 journal record 指向一个已存在的
entry，也不会有任何东西被插入到已存在的 entry 之前。一个 entry 通过对其 journal record 的
一次寻址读取来重建。

### 2.2 内容 kinds

```ts
defineContent({ kind, meta: M, payload: P, keyed?: true, context: "select" | "none" },
              { project(entry, ctx): Promise<AgentMessage[] | undefined> })
```
- `context`：插入一个此 kind 的 entry 是否也会把它的 id 追加到会话的
  context 列表（§6.1）。Core：`user`、`assistant`、`tool_result` → `select`；`summary`、
  `custom` → `none`（summary 仅通过创建它的 command 所发出的 `ctx_replace` 进入
  context；reset 的 bootstrap 通过 `ctx_reset` 进入）。不存在 per-entry override。
- `project`：一个被选中的 entry 对模型 messages 的贡献。可以读取 payload
  （`ctx.payload(id)`），除此之外别无其他。一个被选中的 entry MAY 不投影任何内容。

---

## 3. Tasks、scheduling 与 cancellation

### 3.1 Task record

```ts
type TaskRole = "start" | "inflight" | "waiting" | "terminal";
interface Task<S extends string = string, D = JsonObject> {
  id: number;                 // creation-record seq
  conv: number;
  kind: string;
  at?: number;                // originating entry, including an inherited entry
  for?: number;               // spawning task; provenance, not an execution dependency
  after: number[];            // all must be terminal before normal effect starts
  status: S;
  state: D;                   // schema-validated JSON; no promises, closures or mutable aliases
  owns?: number;              // child conversation, reciprocal with conversation.owner
  abort?: true;               // internal durable cancellation target; not a public task-cancel API
}
```

`after` 表达一次 durable 等待。它的意思是 **settled**，而不是 succeeded。沿边不存在自动的
失败传播，不存在 per-edge cancellation 策略，也不存在 kind 级别的并发
标志。普通错误就是结果（outcome）。具体 coordinator 解释它们所需的结果。

```text
parallel tools:    T1, T2, T3; P.after = [T1,T2,T3]
sequential tools:  T1; T2.after = [T1]; T3.after = [T2]; P.after = [T1,T2,T3]
collapse:          G.after = [C]
foreground child: tool.finishing.after = [subagent]
```

依赖必须存在、留在同一 ownership 树中，并构成一个有向无环图。对照 command 中更早的
records 检查创建与依赖编辑。`for` 不是一条依赖
边：G 可以派生 C，然后等待 C，而不产生环。独立的 forks 绝不会因为
另一个 scope 引用了它们就隐式变为可运行。

### 3.2 Roles 与生命周期

| Role | 含义 | 无主时的 Scheduler 动作 |
|---|---|---|
| `start` | 一旦依赖/时间允许，work 或一个本地 continuation 即就绪 | `effect` |
| `inflight` | 外部 work 已开始；一个无主 task 可能已被中断 | `recover` |
| `waiting` | 一个外部 observer 或 owned child 将提供下一次 transition | open 后重新 arm 一次 |
| `terminal` | 不可变结果 | 无 |

一个 kind 声明其 statuses 与允许的 transitions。Status roles 由
harness 解释，而非由 storage 解释。每个非 terminal status 都必须有 recovery/cancellation 方案。

```text
external work:  commit inflight intent → perform effect → commit outcome
local work:     read/prepare → commit outcome
park:          commit new status/dependencies → RETURN
settle:        output + usage + terminal status + required successors, ONE COMMAND
```

一个 task MUST NOT 在 `effect`、`recover` 或 `abort` 内部等待另一个 task 的整个生命周期。它要么
settle 并留下 successors，要么记录一个 dependency/continuation 并返回。一个像 `post_tools` 这样的
control task，当其全部动作就是一条 command 时，不需要假的 inflight 写入。

### 3.3 Kind 与执行接口

这些是提议的接口形态，不是现有的导出 API。Schemas 校验严格 JSON；
具体的 status/state 字段在 §3.9–§3.15 中规定。

```ts
interface JsonSchema<T> {
  parse(value: unknown): T;
}
interface TaskDefinition<S extends string, D> {
  kind: string;
  state: JsonSchema<D>;
  initial: S;
  roles: Record<S, TaskRole>;
  transitions: Record<S, readonly S[]>;
  effect(task: Readonly<Task<S, D>>, ctx: TaskContext<S, D>): Promise<void>;
  recover(task: Readonly<Task<S, D>>, ctx: TaskContext<S, D>): Promise<void>;
  abort(task: Readonly<Task<S, D>>, ctx: TaskContext<S, D>): Promise<void>;
}
interface TaskPatch<S extends string, D> {
  status?: S;
  state?: Partial<D>;
  after?: number[];
}
interface TaskContext<S extends string, D> {
  readonly signal: AbortSignal;
  readonly conv: ConversationView;
  readonly services: TaskServices;
  readonly working: WorkingScope;                       // ordinary values/lists, §5.6
  set(patch: TaskPatch<S, D>): Promise<void>;            // this task only
  settle(status: S, state?: Partial<D>): Promise<void>;
  commit(build: (tx: Command) => void | Promise<void>): Promise<boolean>;
  commit(scope: WorkingScope, build: (tx: WorkingCommand) => void | Promise<void>): Promise<boolean>;
  getValue<T>(address: Value<T>): Promise<T | undefined>;
  readList<T>(address: ValueList<T>, options: ListReadOptions): Promise<ListElement<T>[]>;
  payload(entryId: number): Promise<JsonValue | undefined>;
  emit(kind: string, payload: JsonValue): Promise<void>;
  sleep(ms: number): Promise<void>;                    // this effect's timer, interrupted by signal
}
```

`TaskServices` 是 typed host service bundle（§12），不是另一个 durable 对象。Provider/tool
exceptions 按其 kinds 分类。Storage 与 invariant 失败会逃逸并使
session 发生 fault；围绕 effect 加 settlement 的宽泛 catch 不得把它们转换为 tool errors。
一个意外的 kind exception 会被报告并使 session fault，而不是无休止地重新启动
未改变的 start-role work。Faulted handles 无法继续 cancellation 写入。

### 3.4 Foreground、ownership 与 busy 状态

```text
local foreground:
  generation, or task whose for names a generation
  // tools, post_tools, and automatic collapse are foreground

required foreground work:
  local foreground plus its unfinished after dependencies
  plus foreground work in conversations owned by those required tasks

background:
  other work; e.g. a detached job/subagent, standalone approval, manual collapse

busy(conv):
  local foreground remains OR cancellation targets remain in its required ownership subtree
```

`post_tools` 是 foreground，即使每个 tool 都已 settle。这防止在
tool 完成与 continuation 之间的接受动作意外创建第二个 generation。Background
work 不请求 generation。Automatic collapse 使用 `for: G`；一次独立的手动 collapse
不使用。一个 waiting 的 foreground tool 把其必需的 subagent/approval 保持在 cancellation 之内。

```text
conversation.parent = provenance and historical inheritance
conversation.owner  = subagent task that owns this conversation, if any
scope(conv)         = conv + descendants reached through task.owns, not parent links
```

Root 以及每一个无 owner 的 fork 都是独立的 drive scopes。对 subagent 的 foreground 等待
由该 tool 的依赖来表示，而不是从它的 parent 的 transcript 或 tool 名推断。

### 3.5 Scratch 与 publication

Scratch 是普通 values/lists 在具名 working scope 中的一种用法（§5.6），不是存储子系统。
Kinds 把有界的 list 页归约为部分输出。Task 结果引用不可变 entries；
control tasks 可以没有输出 entry。一个 task 按惯例使用 `workingScope(String(task.id))`。Keys 区分 attempt/poll 标识；
recovery 只读取当前 request 的 keys。被取代的 attempt 数据可能保持不可达
直到 retirement，但不能被误认为活动 attempt 的 frames/candidate。

```text
progress: working-scope-only commit → publish preview
settlement: stop producer/sink admission → drain admitted progress writes
            main commit: output + terminal task + retireScope(working)
cleanup: backend may remove physical working files AFTER that commit
```

Retirement 在逻辑上与 settlement 原子。失败的 unlink 无害：已提交的 retirement
使旧内容不可见。Storage 绝不从 owner 缺失/status 推断 retirement。Close
与 fault 不 retire 任何东西。Invocation fencing 拒绝迟到的写入；generic scopes 允许复用。

### 3.6 Scheduler 与 process-local ownership

每个 session 一个 scheduler，服务所有活动 drive scopes 的并集。多个调用者可能重叠；
它们绝不安装相互竞争的 executors。移除一个调用者不会取消 durable work。

```ts
interface OwnedRun {
  controller: AbortController;
  promise: Promise<void>;       // current effect/recovery and any joined cancellation cleanup
}
const running = new Map<number, OwnedRun>();
const recovered = new Set<number>(); // inherited waiting tasks already re-armed in this process
const openedAt = committedHead;
```

这些结构是 process-local 的。该 map 就是 owned set；不需要重复的 owned bitmap、durable
lease 或 promise registry。每次 retry/phase 都获得一个新的 controller。Scheduler 拥有
任何 promise 替换/清理；effect 完成不能删除更新的 ownership claim。

```text
pass:
  scope = union of active drive scopes
  for marked tasks in scope:
    signal EVERY owned affected execution before waiting on any one
    arrange exclusive cancellation reconciliation (§3.7)
  for unmarked, unowned live tasks in scope:
    start:
      if all after tasks terminal, notBefore elapsed, required poll permit present:
        claim synchronously; launch effect; do not await its whole lifetime in this pass
    inflight:
      claim synchronously; launch recover
    waiting:
      if task.id <= openedAt and not recovered:
        mark recovered before launch; claim; launch recover to re-arm and return
  resolve drive observations from committed state
  wait for commit | effect completion | timer | external observer notification
```

jobs/approvals 的外部 observers 是可丢弃的 subscriptions，而不是由一个
等待另一个 task 的 task 持有的 promises。每个 observer 通过 line 写入，并在发布前检查当前 task 的
status/cancellation。Host 在其 task 结束/关闭时 retire observers。

Scheduler 读取 task metadata，而非 transcript payloads 或兄弟 tool 结果。Terminal
dependency 状态使用有索引的 point reads，并可在被 live tasks 引用期间缓存；
绝不反复重放 history。最初不需要全局 reverse-dependency index。
不存在 conversation `next()`、tail inference 或 open-time successor repair。

### 3.7 Conversation cancellation

公开的 cancellation 是 `conv.abort()`。**不存在公开的 `abortTask(id)`。** 一个 task 内部的
`abort` 位记录它对一次 conversation cancellation 的从属关系；它不是第二种面向用户的
cancellation 机制。`cancelQueued(id)` 只撤回尚未被消费的 input。

```text
abort(conv), ONE COMMAND:
  if this conversation already has outstanding cancellation targets: join; do not drain again
  select current foreground + required dependency/owned-child closure
  mark every selected nonterminal task abort = true
  drain currently queued steer/followUp in affected foreground conversations
  preserve write/nextRun; return drained input identities/content

normal admission/settlement:
  marked work cannot start an external action or create normal successors
  input arriving during cancellation queues; do not consume it during cleanup
  new foreground tasks cannot bypass outstanding cancellation in that conversation
```

选择结果在 task marks 中是 durable 的。当更早的 parent 变为 terminal 时，不要重新计算一个更小的目标集。
Detached background work 不会被普通的 foreground abort 选中。
Deletion/显式的整会话 shutdown 选中 ownership 子树中所有 live tasks；
这仍然是一次 conversation 操作，而不是任意的 graph-node cancellation。

```text
reconcile a marked task:
  retain ONE ownership claim through the entire sequence
  signal its controller if an effect/recovery is owned here
  await that task's own execution returning, whether fulfilled or rejected
  report rejection; storage/invariant faults still prevent further writes
  re-read task; if already terminal, do nothing
  otherwise run kind.abort under the SAME exclusive claim
  release claim only when that invocation finishes
```

该 await 是允许的：它 join 的是本进程对同一个 task 的当前执行。它防止
其 effect 与 abort handler 并发写入。它不是对依赖 tasks 的等待。
一个不配合的外部 effect 可以延迟 cancellation；任何 timeout 都不得静默允许第二个
writer。Driver 的 passes 仍可以 signal/cancel 其他独立 tasks。

从未启动的 sequential tools 可以立即 abort，无论它们的 `after` 依赖如何。
每个都写入其必需的 error result。`post_tools.abort` 不创建 generation，也不执行任何
不安全的 context 编辑；排队的写入可以保持排队。对于一个被标记的 conversation owner，延迟 abort 调用直到被标记的 owned descendants 变为 terminal
（§3.13）；没有 effect promise 等待该条件。正常的 child 完成在 settle owner 之前检查 owner 的
marker，因此 cancellation 不会变成 success。

```text
abort before P settlement: P is marked → no G2
P settlement before abort: P + G2 commit together → abort selects G2
crash after marking: open reports marked tasks → next covered drive reconciles them
crash after effect returned: marked inflight task remains → abort reconciliation resumes
```

Host 是唯一的 live writer。另一个进程可以在 handoff/crash 之后重新 open；并发的
独立 writers 不受支持。一个 remote client 通过拥有它的 host 发送 cancellation。

### 3.8 Open、drive、suspension 与 close

```text
open:
  hydrate storage/residency; validate kinds/statuses/dependencies
  start nothing; write no repair generation; expose inspect()
inspect(): session-wide { start, inflight, waiting }, including cancellation marks
conv.drive(): run only its ownership tree
harness.drive(): run every independent tree in the session
```

处于 `start` 的 task 仍可能被依赖、retry 时间或 deferred-poll 许可阻塞。
`inspect()` 报告 durable roles，而非承诺每个 start-role task 现在都可运行。

```text
conv.drive → idle: no foreground or outstanding cancellation in its ownership scope
harness.drive → idle: no live tasks anywhere
suspended: work remains, but progress requires an outside event/permission
closed: harness closed before requested condition
```

当一个 conversation drive 处于活动状态时，它也服务该 scope 中的 background work，但它不会
在 foreground 静止之后仅仅为了 detached background tasks 而持续等待。一个想要
监督所有 background work 的 host 会让一个 session drive 保持活动。继承的 waiting-task recovery
每个 session 进程一次，而不是每个调用者或 scope 一次。

`close()` 封住 commands 与 scratch 准入，signal owned executions，detach observers，
并 drain 已准入的 persistence。它不写 cancellation marks，也不写任何 task settlements。Effects
必须释放资源/配合 close；当前的 cooperative-wait 策略以及一个可能的
bounded-close 替代方案仍在 §25 中显式保留。一个取消其等待的调用者不是 `abort()`。

### 3.9 Generation

**职责：** 一次 provider generation，包括其 retries/deferred polls。它发布一个
response，并要么发布 tool work 加一个 join，要么发布正常的 final-answer 边界。它绝不等待 tools。

```ts
type GenerationStatus = "pending" | "streaming" | "retry_wait" | "deferred" | "polling"
  | "done" | "failed" | "aborted";
interface GenerationState {
  settings: GenerationSettings;             // captured when this generation is created
  attempt: number;                          // starts at 1
  notBefore?: number;
  requestAsOf?: number;                     // committed context boundary used by current request
  collapse?: { id: number; reason: "threshold" | "overflow" | "manual" };
  overflowRetried?: true;
  deferred?: DeferredHandle;
  poll?: number;
  produced?: number;                        // immutable assistant entry
  calls?: number[];
  postTools?: number;
  error?: string;
}
```

Roles：pending/retry_wait/deferred = start；streaming/polling = inflight；其他为 terminal。
Transitions：pending/retry_wait → streaming 或 failed/aborted；streaming → retry_wait/deferred 或
terminal；deferred → polling 或 aborted；polling → deferred/retry_wait 或 terminal。添加一个
collapse 依赖可以保留当前的 start status。Terminal 状态不接受任何 patch。

```text
creation: idle acceptance, a final-answer continuation, or post_tools settlement
  capture model/thinking/tools/tool order/options/retry policy from current settings
  task pending, attempt = 1

pending/retry_wait effect:
  if captured collapse dependency exists:
    it is terminal (scheduler readiness)
    overflow collapse unsuccessful → fail this generation; no replacement
    threshold/manual failure → proceed using unchanged context
  else if automatic compaction is indicated:
    decide before_collapse outside line
    revalidate context and cancellation inside line
    if approved:
      C = create collapse { for: G, captured prefix/model }
      set G { after: [C], collapse: { id:C, reason:threshold } }
      RETURN; no promise waits for C
  capture conversation's MAIN commitEnd as context boundary; commit streaming intent
  build projection + request; run before_request outside line
  re-check cancellation/close before provider call
  stream provider; scratch receives frames
  classify outcome below
```

一个 live 的 manual collapse 在准入一个新 request 之前被作为依赖挂接，而不是
创建一个相互竞争的 automatic collapse。在 automatic compaction 运行期间，generation 始终存在。
不存在某种状态，其中已消费的 input 仅由一个 background collapse 表示。

```text
provider outcome, in precedence order:
  close → leave task recoverable; no terminal write
  marked cancellation → aborted partial + matching error results; no successors
  deferred → reported usage + set deferred(handle, poll, notBefore)
  overflow, not already retried:
    decide collapse; commit usage + existing G.retry_wait + C + G.after=[C]
    declined/impossible → usage + failed G
  other error → reported usage + bounded retry_wait, else failed G
  successful response with calls → settleWithCalls
  successful response without calls → settleFinal
```

```text
settleWithCalls, ONE COMMAND:
  A = assistant entry with call list
  for each call in source order:
    Ti = tool { for:G, at:A, callIndex, captured active-tool authorization }
    parallel: Ti.after = []
    sequential: Ti.after = [previous tool] except first
  P = post_tools { for:G, at:A, after: all Ti }
  usage(G, reportedUsage)
  settle G { done, produced:A, calls:all Ti, postTools:P }
```

response、所有 tools 以及恰好一个 P 一起 commit。除 toolUse 之外、但带有
calls 的 stop reasons 会创建 truncated tool tasks：它们产生 error results，但不执行外部 tools。
Projection 随后按 callIndex 对结果排序，无论它们在 transcript 中的完成顺序如何。

```text
settleFinal:
  prepare on_yield outside line only if eligible queued input is absent
  ONE COMMAND, checking latest cancellation and queue state:
    A = assistant entry; usage; settle G
    select safe writes and eligible steering/followUp (§18)
    if continuing:
      place selected items in admission order; dequeue
      place hook continuation if applicable
      create next generation with freshly captured settings
    else:
      place safe writes only
      finishOwnedConversation(tx, conv, { outcome:done, result:A })
```

过期的 hook decisions 在 commit 之前被丢弃/重新计算。一个新的 queued trigger 优先于
一个旧的 yield decision。`finishOwnedConversation` 是普通的 settlement 代码
（§3.13），而不是一个更晚的 scheduler pass。Terminal failure 使用相同的 owner notification，带一个
failed outcome 且没有 successor。Input-result attribution 仍单独开放（§18.2）。

**Deferred：** 仅在带 `pollDeferred` 时准入。在 fetch 之前 commit polling intent 并递增 poll；
still-deferred/fetch-error outcomes 在同一个 task 上带 backoff 返回 deferred。
Abort 尽最大努力尝试 provider cancellation，然后在本地完成。不会为 deferred poll 或 retry
创建新的 generation。Retry 延迟使用捕获的 bounded exponential 策略。

**Recovery：** polling 变为 deferred；带有已提交 frames 的 streaming 发布一个被中断的
aborted partial 与匹配的 error results；没有 frames 的 streaming 在预算内重试或
失败。这保留了当前 draft 的策略；old-lane interrupted-stream 对齐尚待处理
（§25）。Recovery 绝不能让一个被标记的 generation 复活，也不能创建新的 retry 预算。

**Abort：** 停止/drain frames，如果存在则 cancel deferred handle，写入必需的 partial/error
entries 与已知 usage，settle aborted。一个从未启动的 generation 没有伪造的 assistant
response。cancellation 之后不跟随任何 tools、join、yield continuation 或 provider retry。

### 3.10 Tool execution

**职责：** 一次 call。不读取兄弟、不做 last-sibling 检查、不 drain 队列、不 reset context、
也不创建 next-generation。同一个 handler 同时服务 parallel 与 sequential 执行。

```ts
type ToolStatus = "planned" | "truncated" | "running" | "waiting" | "finishing" | "done" | "aborted";
interface ToolState {
  callIndex: number;
  callId: string;                          // provider call identity; task.id is harness invocation identity
  name: string;
  args: JsonObject;
  allowed: boolean;                        // captured from generation's active-tool names
  replay: "safe" | "never";
  approved?: true;
  approval?: number;
  delegated?: number;                      // a subagent/job whose outcome supplies this tool result
  produced?: number;
  terminate?: boolean;
  handoff?: string;                        // requested reset; interpreted by post_tools only
  error?: string;
}
```

Roles：planned/truncated/finishing = start；running = inflight；waiting = waiting；done/aborted =
terminal。Planned 可以变为 waiting/running/done/aborted；running 可以变为 finishing/done/aborted；
waiting 可以变为 planned/done/aborted；finishing 变为 done/aborted。Safe recovery 可以把
running 返回为 planned，同时保留有效的 arguments/memos。Tool 与 sink 接口：§16。

```text
planned effect:
  unavailable/inactive tool → settle own error result
  validate arguments against tool schema
  before_tool outside line, unless already approved:
    block → settle own error result
    hold → create approval + set this tool waiting, ONE COMMAND; RETURN
  commit running intent with effective args and replay declaration
  execute with own signal, invocation identity, scratch/sink and application context
  drain output; run after_tool outside line
  ONE COMMAND:
    re-check cancellation
    append own result; reported usage; active-tools additions
    settle this tool, retaining terminate/handoff control metadata

truncated effect:
  settle own "not executed" result; never invoke tool
```

仅仅存在于 registry 中的一个 definition 不足以构成授权：generation 必须
已经提供过它。Arguments 与 replay declarations 在外部调用之前被捕获。
一个普通的 tool throw 变为 `isError`；storage errors 则不然。未知的 addTools 名字在现有的 draft 策略下
仍然被丢弃。Final text 有上限；truncation 是显式的（§16）。

**不等待另一个 task 的 Delegation：** 一个 harness-native tool 可以返回一个 durable wait action。

```text
ONE COMMAND:
  S = create subagent/job with for = this tool
  set tool { finishing, delegated:S, after:[S] }
RETURN from current execution

S eventually terminal → scheduler can run this SAME tool's finishing phase
finishing effect:
  load S's committed result
  apply after_tool outside line
  commit this tool's own result + terminal outcome
```

这复用了 tool task，而不是发明一个 operation wrapper。当异步的 after_tool 处理必须发生在
child settlement command 之外时，需要这个额外的 phase。不存在 in-process 的
waitFor(S)，无论最初还是在 recovery 时。Background delegation 则立即用 task id settle 该 tool；
它与 detached work 没有依赖关系。

**Recovery：** 仅当捕获的与当前的 declarations 都允许 safe replay 且没有
cancellation 胜出时才 replay。保留 task id、有效 arguments 与 memos。否则从最后的 checkpoint
settle 一个 interrupted error result，而不施加不确定的 addTools/terminate/handoff 效果。
Waiting holds 被恢复为 holds；finishing 依赖存续而不重新 arm 一个 promise。

**Abort：** 在 join 自己的执行之后，drain scratch 并 settle 一个带
aborted metadata 的 error tool result。未启动的 calls 也会得到 results，从而完成 assistant exchange。没有依赖
必须先完成。此 handler 不检查兄弟，也不自己调用 post_tools。

### 3.11 Post-tools

**职责：** join 一个 generation 的 tool results 并决定接下来发生什么。这是一个真正的
exchange coordinator，而不是一个会话级的 progression loop。

```ts
type PostToolsStatus = "pending" | "done" | "aborted";
interface PostToolsState {
  generation: number;
  produced?: number;                         // optional terminal result reference, never payload
}
```

由 generation settlement 创建，`for:G`，`after:all calls`。Pending = start；done/aborted =
terminal。它没有外部 effect，也没有 inflight status。它的 effect 是一条序列化 command：

```text
P.effect, ONE COMMAND:
  require all after tasks terminal and P still pending
  read completed call outcomes                         // ONLY this coordinator reads siblings
  if marked cancellation: settle P aborted; RETURN
  select safe writes, mode-selected steering, and any valid handoff
  place selected content in admission order; dequeue consumed items
  apply handoff reset after full exchange completion, if requested
  if exchange was aborted or termination policy says stop:
    do not consume generation-triggering input
    settle P done
    finishOwnedConversation(tx, conv, terminal outcome)
  else:
    G2 = create generation with current model/thinking/tools/options
    settle P done
```

选择先于 mutation：在停止路径上只消费 safe writes。Follow-ups 等待
一个正常的 final answer，而不是这个 tool 边界。一个 handoff 是一个显式 trigger，而不是 tail
inference。Compaction 属于已经创建的 G2；它可以挂接一个 collapse 依赖。

当前的 draft termination 策略是：任何已完成的、请求 terminate 的 call，同时保留所有兄弟
results。它与旧 lane 的 all-results 策略的差异仍列在 §25 中。
一个普通的 error result 不是 cancellation。相互冲突的 handoffs 在实现前需要一项定义好的选择
策略；不要静默地按完成顺序挑选（§25）。

**Recovery：** 不存在未知的外部动作。如果该 commit 没有落地，P 保持 pending；
如果它落地了，P 是 terminal，且 G2 已存在。**Abort：** settle P aborted，不创建任何东西，
不执行任何 context 编辑。剩余写入保持排队；其他被标记的 tasks 独立完成。

```text
T2 settles → P blocked
T3 settles → P blocked
T1 settles → P eligible, already durable
P settles + G2 created → one commit
```

没有 tool 知道哪一个最后完成。每个 exchange 多一个 task/terminal record，换来
对 exchange 策略的单一 owner，并把 orchestration 从每个 tool 实现中移除。

### 3.12 Collapse

**职责：** 总结一个已捕获的 prefix 并发布一个经过校验的 replacement。它绝不
创建 generation。一个 pending generation 已经代表了 automatic continuation。

```ts
type CollapseStatus = "pending" | "summarizing" | "retry_wait" | "publishing" | "done" | "failed" | "aborted";
interface CollapseState {
  through: number;
  prefixVersion: number;
  contextAsOf: number;
  settings: GenerationSettings;
  instructions?: string;
  attempt: number;
  notBefore?: number;
  produced?: number;
  error?: string;
}
```

Pending/retry_wait/publishing = start；summarizing = inflight；其他为 terminal。Pending/retry_wait
→ summarizing；summarizing → publishing/retry_wait/done/failed/aborted；publishing → done/failed/
aborted。一个 publishing task 可以替换其 after 列表，以等待一个当前的 exchange 边界。

```text
creation:
  capture complete-exchange cut, prefixVersion, context boundary and summary settings
  one live collapse per conversation; reuse existing task rather than race duplicate insertion

effect:
  commit summarizing intent
  project captured prefix, including prior summary; call summarizer
  complete candidate → persist in task scratch
  ONE COMMAND:
    usage + outcome
    cancelled/stale prefix → terminal outcome, no context publication
    context editable → summary entry + ctx_replace + settle done
    otherwise → set publishing with after = current request/exchange coordinator
  RETURN

publishing effect, ONE COMMAND:
  re-check cancellation, prefixVersion and canEditContext
  if another exchange is now open: update after to its generation/post_tools; RETURN
  otherwise publish candidate + ctx_replace + settle done
```

只有当一次 speculative summary 在一个繁忙的 exchange 期间完成时，才需要这个 durable publishing phase。
它通过依赖来等待，绝不是通过一个由 effect 持有的 promise。报告的 provider usage
随 attempt outcome 提交一次，在 publishing 时不再提交。Scratch 保留到 terminal
settlement。Prefix 变化会拒绝 publication；超出 through 的 appends 原样存续。

**Recovery：** 在可用时复用一个完整的已持久化 candidate；否则在预算内重试被中断的
summarization，或失败。Publishing 读取其 candidate 并重新校验。**Abort：**
停止 summarizer，drain scratch，记录已知的未提交 usage 并 settle aborted，而不发布 summary。
Automatic G 等待这同一个 task 并解释其 terminal outcome（§3.9）。
Token-budget/split-turn 对齐仍是一个显式的 compaction-policy 决策（§25）。

### 3.13 Subagent

**职责：** 拥有一个 child conversation 并暴露其 terminal foreground result。

```ts
type SubagentStatus = "planned" | "running" | "done" | "failed" | "aborted";
interface SubagentState {
  prompt: AgentInput;
  context: "fresh" | "inherit";
  values: {
    inherit: { namespace: string; key: string }[];
    set: { namespace: string; key: string; value: JsonValue }[];
  };                                      // serialize selections; resolve them in child creation command
  produced?: number;                       // may reference result in owned conversation
  error?: string;
}
```

Planned = start；running = waiting；其他为 terminal。Planned → running/failed/aborted；running →
terminal。`owns` 标识该 child。Scalar 初始化在 §8.3 中有精确定义。

```text
planned effect, ONE COMMAND:
  create child { parent history, owner:S, inheritValues:false }
  write selected initial values + overrides
  append prompt + create child's initial generation
  set S running { owns:child }
RETURN
```

这里没有外部动作需要一个假的 inflight status。Child 的 final-generation 或 stopping
post_tools settlement 在同一个 command 中执行 `finishOwnedConversation`：

```text
finishOwnedConversation(tx, child, outcome):
  if child.owner is absent: return
  S = read owner; require S owns child and is still running
  settle S with outcome/result entry reference
  // A foreground launching tool already exists in finishing, after:[S].
  // It is now eligible; no lost event or new task is required.
```

**Recovery：** 一个 planned owner 只创建 child 一次；一个 running owner 不启动任何东西并返回。
它的 child tasks 承载所有 durable continuation。不需要重建任何 waitFor 或 child-completion subscription。
已完成的 result payload 不会仅仅为了 settle owner 而被复制。

**Abort：** conversation cancellation 已经在同一条 marking
command 中标记了必需的 child work。Scheduler 延迟 owner abort 调用，直到其被标记的 owned descendants 变为 terminal；
它不会在它们完成期间持有一个 effect promise。然后 settle S aborted。如果一个 child 被直接
abort，其 live owner 被纳入 cancellation 完成；一个 parent 侧的 finishing tool
可以在其 drive scope 运行时随后报告该 child 的 aborted outcome。Background child
work 不受无关的 parent foreground cancellation 影响。

### 3.14 Job

**职责：** 运行/接管一个进程并带有 durable output，除非该 tool 显式依赖它，
否则不保持一个 foreground tool 存活。

```ts
type JobStatus = "planned" | "spawning" | "running" | "exited" | "killed" | "lost";
interface JobState {
  command: string;
  logPath: string;
  pid?: number;
  processIdentity?: string;                 // host-specific adoption identity, not pid alone
  notBefore?: number;
  produced?: number;
  exitCode?: number;
}
```

Planned = start；spawning = inflight；running = waiting；其他为 terminal。Planned → spawning/killed；
spawning → running/lost/killed；running → exited/lost/killed。

```text
effect:
  commit spawning with durable log/adoption location
  spawn/adopt through host process service
  commit running with process identity
  install exit/output observers; RETURN

exit observer:
  drain bounded output/checkpoints
  commit immutable job-result entry + usage if reported + settle exited
  a dependent tool.finishing becomes eligible through after
```

**Recovery：** spawning 通过 host adoption identity 来调和不确定的 launch；绝不
盲目地 spawn 第二个进程。Running recovery 在 open 后一次，如果同一进程仍存活则重新挂接 output/exit observers，
否则记录为 lost。仅凭一个 pid 不足以证明身份。
精确的 durable adoption/exit-status 能力是一项 host 契约，尚待最终确定（§25）。

**Abort：** 当被必需的 foreground cancellation 或整会话 shutdown 纳入时，
通过其 service 停止进程，drain output，写入 result 并 settle killed。一个 detached job
在普通的 parent foreground abort 与 harness close 之后存续。显式的 background shutdown/deletion
是 conversation-scoped 的。领域特定的进程控制不是通用的 task-cancel 端点。

一个 schedule 使用 planned/notBefore，并且对于重复执行，使用一个与前序 outcome 原子创建的
successor job。Schedule definition 必须提供有限/有界的 recurrence 策略；
不存在隐藏的 recurring-work scheduler，也不存在跨另一个 job 生命周期持有的 task。

### 3.15 Approval

**职责：** 持有一个 durable 的人类决策。等待中的 tool，而不是一个 promise，阻塞其
exchange 以及顺序的 followers。

```ts
type ApprovalStatus = "pending" | "waiting" | "granted" | "denied" | "cancelled";
interface ApprovalState {
  tool?: number;
  prompt: string;
  produced?: number;
  decision?: JsonValue;
}
```

Pending = start；waiting = waiting；其他为 terminal。Pending → waiting/cancelled；waiting →
granted/denied/cancelled。

```text
before_tool hold, ONE COMMAND:
  A = approval { for:tool, tool:tool.id, prompt }
  set tool waiting { approval:A, after:[A] }

approval.effect:
  commit waiting; publish human prompt through observation; RETURN

approve(A), ONE COMMAND:
  verify waiting and not marked
  record decision + settle A granted
  set matching waiting tool planned { approved:true }

deny(A), ONE COMMAND:
  record decision + settle A denied
  write matching tool's own blocked result + settle tool done
```

Decision commands 标识现有的 approval，但不是 cancellation APIs。如果在 denial 时需要异步的
result hooks，则用该 decision 使现有 tool 的 finishing phase 就绪，
而不是在 line 上调用 hooks；那个 phase 只 settle 那一个 tool。这与 subagent results 是同一个 durable
continuation 模式。

**Recovery：** 重新宣告/重新挂接人类决策界面一次；不要 grant 或 rerun 该 tool。
**Abort：** 记录 cancelled approval；被独立标记的 foreground tool 写入其 aborted
result。Denial/grant 与 cancellation 的取舍在 line 上决定。迟到/重复的 decisions 返回
既有 outcome 或一个 rejection；它们绝不重启 terminal work。

---

## 4. Journal、conversation state、read model

### 4.1 Journal records

```
ins_conv     { parent?: {conv, at?, asOf, inheritValues}, owner?, context: number[] }
set_conv     { id, patch }                                                     // inbox, label, queue modes
del_conv     { id }
ins_entry    { conv, kind, by?, callIndex?, through?, key?, meta, payload? }
ins_task     { conv, kind, at?, for?, after, state }
set          { id, patch }                                                     // tasks only
settle       { id, patch (status terminal) }                                   // tasks only; a task's result is an entry
ctx_append   { conv, ids }
ctx_replace  { conv, through, with, expectPrefixVersion }
ctx_reset    { conv, ids }
value_set    { conv?, workingScope?, namespace, key, value }
value_delete { conv?, workingScope?, namespace, key }                          // conversation deletion = tombstone
list_append  { conv?, workingScope?, namespace, key, value, tag? }
list_delete  { workingScope?, namespace, key }                                 // session/working lists only
scope_retire { workingScope }                                                 // MAIN-scope write
// usage(task, conv, usage) appends to the main session list pi.usage; no special storage verb
```
`parent.asOf` 是一个已提交的 parent-history 边界；可选的 `at` 记录一个基于 entry 的选择。
Historical forks 设置 `inheritValues: true`。Subagents 将其设为 false，并把选定的初始
values 存储为本地写入（§8.3）。Parent lineage 与 context inheritance 并不蕴含 value inheritance。
Value/list records 是 journal records，不是 transcript entries，且绝不隐式进入 context。

Command 提供最终的 numeric seqs（§7）；storage 绝不重映射它们。所有 scopes 共享一个
session-global 的序列空间。每个已准入的 batch 是连续的；在 working writes/retirement 之后，保留的 history 与各个
物理文件可能有空洞。Backend 编码是私有的。JSONL
在恰好一个文件中为每次 commit 使用一行完整内容；SQLite 使用一个 transaction。Main-scope
history 被保留以供历史读取；过时的 working data 无需保留。

**Conversation state**（派生；在内存中；SQLite 中为一张表）：
```ts
interface ConversationState {
  id: number;
  commitEnd: number;                                 // last MAIN write affecting this conversation
  parent?: { conv: number; at?: number; asOf: number; inheritValues: boolean };
  // model, thinkingLevel and activeTools are conversation values (§5), not fields here
  inbox: InboxItem[];                                // write | steer | followUp | nextRun; each names stored content
  owner?: number;                                   // owning subagent task, absent on independent forks
  label?: string;
  context: number[];                                 // §6
  prefixVersion: number;                             // bumped by ctx_replace / ctx_reset only
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
}
```

### 4.2 Stored data 与 indexes

Storage 暴露 conversations、entries（包括 conv）、tasks、values 与 lists。Scratch 与 usage
是 values/lists 的用法。它不暴露一个并行的 ReadIndex 或一个原始 journal/payload API。
`Entry` 包含其 payload 及其创建 commit 的结束 seq，因此基于 entry 的 forks 不需要
单独的 commit-boundary 查找。Conversation 的历史读取包含其 context 列表。

```text
current: conversations, tasks, session values/lists, working values/lists
history: entries, conversation versions/context edits, conversation value/list versions
indexes: by conversation/id; live tasks; owner/parent; value/list address + seq
```

历史 scalar/list 查找遵循 §5.3–§5.4。Index 与 payload 布局是 backend 的选择；
这些查询必须使用有界的索引读取，而非全历史扫描。Main-history indexes 可以
引用保留的 records；绝不要仅仅为了保持一个稠密数组而保留已删除的 working payloads。
共享的 SQLite containers 为每个 key 加上 session id 前缀。没有 closure table 或 journal prev pointers。

### 4.3 Storage 接口与 backends

遵循现有的 lane Storage：一次原子 commit、entity reads/scans、values/lists。没有单独的
scratch 接口、raw-record reader 或公开的 index 层。`Context` 是现有的 harness
invocation/cancellation context。下面的类型是提议的接口，不是当前包导出。

```ts
interface CommitResult { firstSeq: number; lastSeq: number }
interface HistoricalRead { asOf: number }             // complete MAIN commit boundary; 0 = empty
interface Scan {
  after?: number; before?: number;                    // exclusive id/seq bounds
  order?: "asc" | "desc"; limit: number;              // default asc; 1..10_000
}
interface ConversationScan extends Scan { parent?: number; owner?: number }
interface EntryScan extends Scan { conv?: number; kind?: string; key?: string; asOf?: number }
interface TaskScan extends Scan { conv?: number; kind?: string; live?: boolean }
interface ListReadOptions extends Scan { asOf?: number; stopAtTag?: string }
interface ListElement<T> { seq: number; value: T; tag?: string }
interface StoredValue<T> { value: T; seq: number }

interface Storage {
  readonly head: number;                              // highest committed GLOBAL seq, including working writes
  commit<Sc extends WriteScope>(writes: Write<Sc>[], context: Context): Promise<CommitResult>;
  getConversations(ids: number[], context: Context, at?: HistoricalRead): Promise<Map<number, ConversationState>>;
  scanConversations(query: ConversationScan, context: Context): Promise<ConversationState[]>;
  getEntries(ids: number[], context: Context): Promise<Map<number, Entry>>;
  scanEntries(query: EntryScan, context: Context): Promise<Entry[]>;
  getTasks(ids: number[], context: Context): Promise<Map<number, Task>>;
  scanTasks(query: TaskScan, context: Context): Promise<Task[]>;
  getValue<T>(address: Value<T>, context: Context, at?: HistoricalRead): Promise<StoredValue<T> | undefined>;
  scanValues<T>(prefix: Value<T>, context: Context): Promise<StoredValue<T>[]>;
  readList<T>(address: ValueList<T>, options: ListReadOptions, context: Context): Promise<ListElement<T>[]>;
  close(context: Context): Promise<void>;
}
```

Storage addresses 包含其绑定的 conversation 或 working-scope 标识（§5.6）。历史
读取仅适用于 main conversation data；session/working values 暴露当前状态。当前的
multi-query snapshots 使用 session line。每一个单独的逻辑查询，包括 ancestor walks，
都观察一个已提交状态。Reads 返回不可变 snapshots；调用者不能修改 owned data。
Filters 先于 limits。`stopAtTag` 包含其匹配元素，且绝不搜索超出 limit。

```text
commit:
  validate one write scope: main OR one exact working id
  require final supplied seqs == head+1, head+2, ...; reject unsafe integers
  validate/prepare touched rows; persist one atomic batch
  publish rows/indexes/head together; only then resolve
  no callbacks, task handlers or plugin reducers inside storage

scope retirement in a MAIN commit:
  invalidate working data through the retirement seq atomically with sibling main writes
  physical cleanup may follow; cleanup failure does not undo the committed outcome

failure:
  pre-admission rejection → no changes or consumed seqs
  admitted persistence failure → fault; outcome may already be durable; reopen, never blind retry
close:
  seal admission; drain admitted persistence; release resources; retire no scopes
```

**Memory：** 为当前 entities/scoped values/lists 使用 maps，为历史数据使用有序引用。
只 prepare 被触及的 rows；同步 publish，不带 awaits/callbacks。Retirement 丢弃当前
working maps 并释放过时的 payloads。Main history 保持可用。对有序
value/list 引用做二分查找；ancestor traversal 的成本是 fork 深度，而非无关的 session history。

**SQLite：** 一个 transaction 更新 entities、historical versions、global head 以及任何 retirement。
Working value/list rows 是普通的 scoped rows，不是每次旧 checkpoint 的 journal。

```text
BEGIN IMMEDIATE
  validate supplied seqs against stored head
  apply entity/value/list writes and required history/index changes
  retirement: DELETE working scalar/list rows WHERE session_id=? AND scope_id=?
  advance global head
COMMIT
```

使用 `(session, conv, address, seq)` 历史索引、`(session, workingScope, address, seq)`
working-list 索引、entity 主键、live-task 与 conversation-owner 索引。在一个同步 SQL 读
transaction 中读取复合查询；持有它时不得 await。WAL 配合
`synchronous=NORMAL` 是基线。可重建的 indexes 是私有的，不是另一项 API 契约。

**JSONL：** 采用
[`implementation-handoff.md`](mobile-handoff/01-harness/02-scopes/implementation-handoff.md) 中描述的 lane scoped-storage 协议。
该文档是设计证据，不是对本树中 scoped storage 已实现的声明。

```text
mainPath                         main entity/history commits + scope_retire records
mainPath.scopes/scope-<id>.scope  one named working scope, value/list commits only

commit:
  one session queue and global counter for BOTH kinds of file
  encode complete batch; writeAll to exactly ONE file, handling short writes
  publish in-memory state only after complete newline reached OS
  main retirement committed → serialize attempted unlink before later scope reuse
  failed unlink → old data still logically retired; retry cleanup on reopen

open:
  validate main/sidecar identity and complete transactions
  compute high-water mark from header + ALL complete main/sidecar records BEFORE cleanup
  find latest main retirement seq per working id
  retain only scoped writes newer than that retirement
  replay retained transactions in global order; preserve boundaries; reject duplicate/overlapping seqs
  discard only unterminated final transactions; malformed complete data fails open
  remove files containing no writes newer than their retirement
```

一个 batch 拥有连续的 seqs，但 files/history 有合法的空洞。绝不要把数组位置当作
seq。没有 per-scope counter、range reservation、cross-file acknowledgement、owner-derived sweeping
或 scope-creation transaction。第一次 scoped write 原子地创建 sidecar，并带一个经过校验的
header；名字是编码后的、固定前缀的组成部分，绝不是原始路径。遵循所链接 handoff 的
Unicode/length 校验与 `.scope` 布局，使 repository listing 不会把它们误认为 sessions。

Scopes 是可复用的。Retirement 通过其 global seq 结束写入，而不是结束该
名字的每一次未来使用。一个被延迟的 unlink 绝不得删除一个更晚的生命周期。Main compaction 必须保留 retirement
boundaries，否则旧的物理文件可能会变为 live。Repository deletion 移除整个
scope 目录。Close/fault 绝不 retire。Main 与 sidecar 的完整写入提供进程
崩溃 durability；掉电 durability/fsync 是一项单独的显式策略，而不是一个跨文件协议。

### 4.4 Memory

```ts
conversations: Map<id, ConversationState>      // live conversations only
tasks:         Map<id, Task>                   // live tasks, plus each conversation's newest generation (§8.1 reads it)
entries:       Map<id, Entry & { payload }>    // every id on a live conversation's context list
history:       LRU<id, payload>                // pages a UI asked for; bounded
```
这是 **residency**，它在每个 backend 上都相同；它不是 read model（§4.2），
也不依赖 backend 如何建立索引。每次 commit 之后，harness 恰好保留
某些 context 列表所指名的 entries，以及处于 live 或为最新 generation 的 tasks，并丢弃其余；一个
把旧 entry 放到某个列表上的 commit（一次 fork）会先加载它。
对象是 values（一次写入产生一个新对象）。所有读取都是异步的；一次命中是一个 microtask，一次
未命中则使用普通的 Storage entity/value/list 读取。执行 residency 与（live 会话数 ×
context 大小）+ live tasks，加上当前所需的 settings 成正比。Active plugin replicas 额外
持有其当前 state 与 tracking data；它们不保留每一个历史 state revision。
进程的总内存还包括 memory/JSONL 上保留的 main history/indexes、live working
scope 内容、SQLite 上有界的 query/cache state，以及活动 dependency metadata。有界的执行工作集并不是对 memory/JSONL 上
总进程内存有界的声明。

---

## 5. Typed values、lists 与 plugin state

### 5.1 Bound addresses

保留旧 harness 的 typed bound-address 方法：namespace 与可选 key 只绑定一次；
后续操作接受该 address，而不是另一个 string key。Scope 与 kind 是其
TypeScript 类型的一部分。不需要注册、declaration merging、runtime token catalog 或 per-write rewind
flag。`declareVar` 被这些 constructors 取代：

```ts
const model = conversationValue<ModelIdentity>("pi.model");
const thinkingLevel = conversationValue<ThinkingLevel>("pi.thinking");
const activeTools = conversationValue<string[]>("pi.active-tools");
const planMode = conversationValue<boolean>("my-plugin.plan-mode");
const moves = conversationList<Move>("my-game.moves");

const sessionName = sessionValue<string>("pi.session.name");
const entryLabel = (id: number) => sessionValue<string>("pi.entry.label", String(id));
const requestInput = (requestId: string) => sessionValue<number>("pi.request-input", requestId);

await conv.setValue(planMode, true);
const enabled = await conv.getValue(planMode) ?? false;
await conv.deleteValue(planMode);
await conv.appendList(moves, move);
await harness.setValue(entryLabel(42), "before migration");
```

Namespace 必须非空；namespace/key 不能包含 NUL；空 key 是合法的。相等的
(scope, kind, namespace, key) tuples 在 receiver 的 scope 内指代同一个 address。`pi` 与
`pi.*` 为核心保留。用不兼容的 value types 构造同一个 address 是
编程缺陷，而不是运行时 registry 的理由。Value types 由 address 决定
（写入时为 `NoInfer<T>`）；错误 scope、错误 kind 与错误 value type 都是编译期错误。
Defaults 属于调用者代码，而不属于 token definitions。已存储的 payloads 是 JSON values。

### 5.2 Scope 与原子写入

- **Session values：** 通过公开 API 仅提供最新 value；设置即替换，删除即
  移除。Session name、entry labels 与 request identities 在 rewind 或 fork 时不变。
  它们的 journal records 保持 durable；current-value index 只需要最新一次 set 的 seq。
- **Session lists：** 当前的 append/page/delete 语义；没有 rewind 或 fork inheritance。Usage
  是一个 main session list。Working lists 使用相同的操作，但具有显式的 lifetime（§5.6）。
- **Conversation values：** 每次 set 在其 journal seq 处追加一个不可变 version。删除
  追加一个 tombstone，它同时遮蔽更早的本地版本与被继承的版本。JSON `null` 是一个 value，
  而不是删除。历史读取选择一个完整的 commit 边界。
- **Conversation lists：** 每次 append 写入一个不可变的 sequenced element。没有 per-element
  update、insertion 或 deletion。Forks 共享 prefixes；它们不截断 parent lists（§5.4）。

Model identity、thinking level 与 active tool names 是普通的、可 rewind 的 conversation values，
而不是 sticky configuration fields。Root 创建在其创建 command 中写入它们的初始 values；
subagent 初始化提供其选定的 settings（§8.3）。Generations 捕获它们所使用的有效
settings；之后的 setting 变化不会重写一个已经创建的 generation。

Convenience setters 各发出一个 command。Read-modify-write 使用序列化的 command line：

```ts
await conv.command(async (tx) => {
  const todos = await tx.getValue(todoBoard) ?? [];
  tx.setValue(todoBoard, [...todos, newTodo]);
});
```

Reads 使用 command 之前的已提交视图（§7）；缓冲的写入在 commit 时按序应用。一个绑定的
conversation command 为其 conversation-address 操作提供其 conversation id。Session-level
command 使用一个显式的 conversation id，从而允许 input 创建、request mapping、
child 创建与初始 values 原子提交。Value/list 写入本身绝不选择 transcript
内容，也不触发 generation。

### 5.3 Historical scalar lookup

只存储本地版本。要通过边界 U 读取会话 C 中的地址 K：

1. 寻找 K 的最新本地版本，满足 `seq <= U`。
2. 一次 set 返回其 value；一个 tombstone 返回 absent，且 MUST NOT 回退到 parent。
3. 如果不存在本地版本，则在 C 没有 parent 或 `parent.inheritValues` 为 false 时停止。
4. 否则在 parent 中继续，令 `U = min(U, parent.asOf)`。

例如，A 在 40 处写入 false，在 80 处写入 true；B 通过 commit 60 fork A。B 读到 false。
60 之后 parent 的写入绝不泄漏进 B，包括通过进一步嵌套的 forks。B 中的一次本地删除
遮蔽 false；之后的一次本地 set 只在 B 的 history 中重新创建该 value。

**Memory/JSONL：** 把 conversation 与 address 映射到一个有序的 version 引用数组；对
cutoff 做二分查找。引用指向 journal records，而不是复制 payloads。Parent 查找
是一次 map lookup。最坏情况是每个 ancestor 一次二分查找，而不是对 journal history 的一次扫描。

**SQLite：** 使用 `value_versions` 主键（§4.2），每个 ancestor 一次索引 seek：

```sql
SELECT seq, deleted
FROM value_versions
WHERE conv = ? AND namespace = ? AND key = ? AND seq <= ?
ORDER BY seq DESC
LIMIT 1;
```

按其索引引用获取获胜版本的 payload（或直接从该 version row 获取）。Parent metadata 是一次 point read，并且可以
为 active conversations 缓存。不需要复制的 inventory、ancestor-closure table 或递归 journal
scan。基线成本取决于 fork 深度；它不是常数时间。Query-plan
测试必须显示有索引的搜索，而不带临时的 ordering b-tree。

### 5.4 Historical lists 与 paging

```ts
const page = await conv.readList(moves, { after: cursor, asOf, limit: 100 });
// [{ seq, value }, ...], oldest first; continue with the last returned seq
```

`after` 是排他的；`asOf` 是一个包含式的已提交边界。省略 `asOf` 表示该次读取时的最新边界；
跨页传递一个固定边界以获得稳定的历史读取。Limits 为正、
有界，并且在此 API 草图中是必需的。Cursor 是对同一 conversation
与 address 的序列过滤，而不是一个 replication revision 或一个可转移的 replica binding。

遍历同一条 parent chain，在每个边界处携带最小 cutoff，并按
最老的 ancestor 优先读取 ranges。一个 historical fork 看到其 ancestor 的可见 prefix，随后是它自己的
appends。Subagents 在其初始化边界处停止 value/list traversal（§8.3）。Descendants 的
本地写入按 journal 顺序跟随其继承的 prefixes，因此拼接这些 ranges 不需要
全局排序或复制。跳过所请求 cursor/cutoff 之外的 ranges，并在页
填满时停止。

Memory/JSONL 对每个本地 element 数组做二分查找。SQLite 使用 `list_elements`，在
conversation/address 上做相等匹配，`seq > after AND seq <= cutoff`，`ORDER BY seq ASC LIMIT remaining`，然后
只获取那些 element payloads。一个有序索引外层循环加上按地址的 payload 查找
不得变成 journal scan 或临时排序。基线遍历的开销是 fork 深度加上对
所请求 elements 的索引读取，而不是与无关 history 成正比的工作量。

### 5.5 Checkpoints 与 replicated state

Plugins 拥有它们的 delta 形态、reducers、校验与 checkpoint 节奏。一个 checkpoint 是一个
普通的可 rewind value；它包含 state 与最后包含的 list-element seq：

```ts
const checkpoint = conversationValue<{ through: number; state: CanvasState }>("my-canvas.checkpoint");
const deltas = conversationList<CanvasDelta>("my-canvas.deltas");
```

Hydration 读取在目标处可见的 checkpoint，然后对 `through` 之后可见的 deltas 分页。
属于一起的 checkpoint 与 delta 写入共享一个 command。一个 active wrapper 保留
当前 state，使普通的更新不必在每次写入时重放 history。Reopen 与 rewind 从
选定的 checkpoint 与 suffix 重建，而不需要逆操作。Checkpoint 节奏只有在跨越
继承的 history 得以维持时才限定 replay suffix，而不是仅仅在每个 child 上重新计数。
当承诺任意 rewind 时，checkpoints 不授权删除更老的 deltas。

Replication 是这些 values/lists 之上的一层，而不是另一个 durable store（§9.1）。只有存在实际
生命周期时才需要一个 task；仅 plugin state 本身不创建 task。

### 5.6 具名 working scopes

History scope（session/conversation）与 working lifetime 是不同的概念。Working addresses
是 session-owned 的，durable 直到被显式 retire，且绝不 inherit/rewind。使用一个具名分组，
而不是一个布尔 retention 提示，使相关的 checkpoints/memos 可以一起 commit 与 retire。

```ts
interface MainScope { readonly kind: "main" }
interface WorkingScope { readonly kind: "working"; readonly id: string }
type WriteScope = MainScope | WorkingScope;
declare function workingScope(id: string): WorkingScope;

declare const valueType: unique symbol;
declare const addressScope: unique symbol;
declare const writeScope: unique symbol;
interface Value<T, Sc extends WriteScope = WriteScope> {
  readonly kind: "value";
  readonly scope: "session" | "bound-conversation" | "working";
  readonly namespace: string; readonly key: string;
  readonly conv?: number; readonly workingScope?: string;
  readonly [valueType]?: (value: T) => T;               // invariant value type
  readonly [addressScope]?: () => Sc;                  // covariant scope for reads
}
interface ValueList<T, Sc extends WriteScope = WriteScope> extends Omit<Value<T, Sc>, "kind"> {
  readonly kind: "list";
}
// Write<Sc> is the §4.1 tagged union, with final seq and this invariant phantom:
interface ScopedWrite<Sc extends WriteScope> {
  readonly seq: number;
  readonly [writeScope]?: (scope: Sc) => Sc;
}
type SessionValue<T> = Value<T, MainScope> & { readonly scope: "session" };
type SessionList<T> = ValueList<T, MainScope> & { readonly scope: "session" };
interface ScalarSelection {
  readonly scope: "conversation"; readonly kind: "value";
  readonly namespace: string; readonly key: string;
}
interface ConversationValue<T> extends ScalarSelection {
  readonly [valueType]?: (value: T) => T;
}
interface ConversationList<T> extends Omit<ConversationValue<T>, "kind"> { readonly kind: "list" }
interface InitialValueWrite { address: ScalarSelection; value: JsonValue }
declare function conversationValue<T>(namespace: string, key?: string): ConversationValue<T>;
declare function conversationList<T>(namespace: string, key?: string): ConversationList<T>;
declare function sessionValue<T>(namespace: string, key?: string): SessionValue<T>;
declare function sessionList<T>(namespace: string, key?: string): SessionList<T>;
declare function setValue<T>(address: ConversationValue<T>, value: NoInfer<T>): InitialValueWrite;
declare function value<T>(namespace: string, key?: string): SessionValue<T>;
declare function value<T>(namespace: string, key: string, scope: WorkingScope): Value<T, WorkingScope>;
declare function list<T>(namespace: string, key?: string): SessionList<T>;
declare function list<T>(namespace: string, key: string, scope: WorkingScope): ValueList<T, WorkingScope>;
```

`sessionValue`/`sessionList` 是显式命名的 main-session constructors。Conversation tokens
在 harness 边界处绑定一个 conversation；backend 在 address 上接收一个 numeric conv。
只有 main addresses 可以携带 conv。相等的 scope id + namespace/key + kind 意味着相等的 address；
对象标识无关紧要。Retention 信息被存储，而不是从 tokens 重建。

```ts
const work = workingScope(String(taskId));
const frames = list<AssistantMessageFrame>("pi.pending.frames", "", work);
const memo = value<JsonValue>("pi.pending.memo", "step", work);

await harness.command(work, tx => {
  tx.appendList(frames, frame);
  tx.setValue(memo, checkpoint);
});

// After sealing/draining that invocation's progress:
await harness.command(tx => {
  const resultId = tx.entry(convId, "tool_result", meta, result);
  tx.settle(taskId, { status: "done", state: { produced: resultId } });
  tx.retireScope(work);                              // MAIN write, not a direct working delete
});
```

一个 command 中的所有写入都是 main，或者是某一个 working id。Type invariance 拒绝 main+working 混用；
一个运行时检查拒绝两个不同的 working ids（它们的静态 tag 相同）。Main commands
可以 retire 多个 working scopes。Reads 可以使用任一种 lifetime；只有写入受限。
绝不要把一次直接的 working append/set/delete 与一次 entity settlement 混在一起，即使在 SQLite 上。

Retirement 是唯一的 storage 权威：没有 task-name 解析、缺失 owner 启发式、TTL 或
close 时的隐式清理。在 retirement 之后复用 scope 是合法的。Harness invocation fencing
必须防止一个迟到的 progress job 意外成为那个新的 lifetime。协调
一个 task transition 的 state 保持 main-scoped；只有独立提交的 working data 进入该 scope。
仅凭一个 typed address 并不能使跨 scope 的原子更新成为可能。

---

## 6. Context

### 6.1 该列表及其三个 ops

`context: number[]` 位于 conversation state 上。仅由以下编辑：
- `ctx_append { ids }`：由插入一个 `select` kind 时发出，在同一条 command 中，按
  transcript order。绝不直接调用。
- `ctx_replace { through, with, expectPrefixVersion }`：移除截至并包含
  entry `through` 的 prefix，把 entry `with`（一条 summary）放在 head。如果 `prefixVersion` 已变动则拒绝。
- `ctx_reset { ids }`：用一个 bootstrap 替换整个列表：`[]`（用户的 `/clear`：等待
  input）、由 `new_context` 请求的一个 `user` handoff（post_tools 重置并创建其 generation），
  或一个 `summary`-kind 备注。Reset 本身绝不请求 generation。

`replace` 与 `reset` 都会递增 `prefixVersion`；`append` 不会。因此该列表始终具有
形状 **[head?，随后是按 transcript 顺序选中的 entries]**，并且一个更早开始的 summarization
在 appends 之后存续（它们落在 `through` 之后），但会被一个相互竞争的 replace 或
reset 拒绝。校验（§7.2）在每一个 `ctx_*` op 上检查：每个 id 都存在于该会话中或
继承的 prefix 中；结果列表具有该形状；且 `through` 不拆分
一个 exchange：`through` 之后没有 `tool_result` 可以回答位于它处或它之前的 assistant entry。
某个更早 commit 时的 context 通过重放 `ctx_*` records 重建（§6.6）。

### 6.2 Summaries 与 handoffs

一个 `summary` entry 由 `collapse` task 追加，并携带 `through`。一个 handoff 是一个 `user`
entry，由 post_tools 为模型的 `new_context` 调用追加，并由 `ctx_reset` 选中。两者
都是位于其追加位置处的普通 transcript entries；它们*在 context 中*的位置是
head。UIs 把一条 summary 画在其 `through` 之后（使保留的 turns 跟随它），把一条
handoff 画在其自己的位置处（§9.2）。

### 6.3 Boundaries

```text
provider request: generation task exists; no unresolved foreground calls
replace/reset: canEditContext (§8.1), checked at committing boundary
historical fork: safe source boundary; subagent capture is separate (§8.3)
queued write: safe message boundary; never splice into an open tool exchange
```

Pending/retry-waiting generation 可以允许编辑，但绝不重复 generation。Settlements 完成
exchanges，包括必需的 error results。`through` 不得拆分一个 exchange；reset 丢弃
整个 exchanges。空/仅备注的 resets 不创建任何 work。

### 6.4 Projection

```
messages := for each id in conv.context: entries[id].kind.project(entry)      (tool results ordered by callIndex within their message)
         then before_request hooks edit the request
```
没有其他内容。Projections 绝不写入。

### 6.5 Collapse policy

```text
generation.pending, before provider intent:
  if captured collapseId exists: observe that task; do not recreate it
  else if usage > threshold × contextWindow and more than keepRecent turns remain:
    decide before_collapse outside line; revalidate context inside line
    if approved: commit collapse task + generation.after=[collapse] and captured reason
    RETURN; generation stays pending and scheduler waits for its dependency
  build request from resulting context
  commit streaming intent → call provider

provider overflow:
  decide collapse outside line; revalidate before outcome commit
  commit attempt usage + generation.retry_wait + collapse task/id together
  existing generation waits for that collapse, then retries once
  declined/impossible/failed overflow collapse → fail existing generation; no replacement

manual collapse: create collapse task only; does not request generation
collapse success: commit summary entry + ctx_replace + usage + terminal collapse
```

该 id 是一个具体的 task dependency，而不是一个 progression flag。Driver 可以在其
generation 等待时运行 collapse；reopen 观察到同一个 task。Retry timers 绝不绕过未完成的依赖。
Threshold decline 用现有 generation 继续，而不是另做一次 conversation 检查。Threshold
collapse failure 用未改变的 context 继续；overflow collapse failure 结束该 generation。
Summary 捕获 `through` 与 `prefixVersion`，包含前一条 summary，并把它 subsumes。

### 6.6 某次 commit 时的 Context

```text
contextAsOf(conv, asOf):
  require complete commit boundary, with conv already created
  base = newest ctx_reset <= asOf, otherwise conv's ins_conv
  context = copy(base.ids or base.context)                 // inherited initial context included
  page context_ops in (base.seq, asOf], oldest first:
    ctx_append: append ids
    ctx_replace: replace prefix through named entry; retain EXISTING suffix
    ctx_reset: replace entire list
  return context
```

Replacement 不是一次完整 checkpoint：`[u1,a1,u2,a2] → [summary,u2,a2]` 保留 u2/a2，尽管它们的
appends 先于 replacement。有索引的基线 replay 排除无关 history，但可能跨越
该会话自创建/reset 以来的范围。Compaction-bounded reconstruction 仍是一项待
评审的优化。当前 context 是一次物化的 point read；plugin hydration 使用 value/list indexes。

---

## 7. The line

每个 session 一个 command 队列。`session.command(build)`（作为
`ctx.commit(build)` 暴露给 task handlers）用 command-local buffer 与前一条 command 的
已提交视图来运行 callback。Reads 可以是异步的；在此 command 完成之前不会有其他 command 运行。

该 buffer 的序列计数器从最后已提交的 seq + 1 开始。添加一个 record 会立即铸造其
seq 并推进该计数器。创建方法返回该 seq 作为新对象的 id；
之后的 records 直接使用它。这些方法只构建 command：它们不执行任何 storage 写入
也不发布任何 state。

```ts
interface ValueReader {
  getValue<T>(address: Value<T>): Promise<T | undefined>;
  readList<T>(address: ValueList<T>, options: ListReadOptions): Promise<ListElement<T>[]>;
}
interface ValueCommand<Sc extends WriteScope> extends ValueReader {
  setValue<T>(address: Value<T, Sc>, value: NoInfer<T>): number;
  deleteValue<T>(address: Value<T, Sc>): void;
  appendList<T>(address: ValueList<T, Sc>, value: NoInfer<T>, tag?: string): number;
  deleteList<T>(address: ValueList<T, Sc>): void;          // reject historical conversation-list deletion
}
interface WorkingCommand extends ValueCommand<WorkingScope> {}
interface EntryOptions { by?: number; callIndex?: number; through?: number; key?: string }
interface TaskOptions { for?: number; at?: number; after?: number[] }
interface Command extends ValueCommand<MainScope> {
  readonly view: ConversationView;                      // committed pre-command reader
  conversation(options: Pick<ConversationState, "parent" | "owner" | "context">): number;
  setConversation(id: number, patch: Partial<ConversationState>): void;
  deleteConversation(id: number): void;
  entry(conv: number, kind: string, meta: JsonObject, payload?: JsonValue, opts?: EntryOptions): number;
  task(conv: number, kind: string, state: JsonObject, opts?: TaskOptions): number;
  set(id: number, patch: TaskPatch<string, JsonObject>): void;
  settle(id: number, patch: { status: string; state?: JsonObject }): void;
  ctxReplace(conv: number, through: number, withId: number, expectPrefixVersion: number): void;
  ctxReset(conv: number, ids: number[]): void;
  retireScope(scope: WorkingScope): number;              // always a MAIN write
  usage(taskId: number, conv: number, usage: Usage): number; // session-list append convenience
  bindValue<T>(conv: number, address: ConversationValue<T>): Value<T, MainScope>;
  bindList<T>(conv: number, address: ConversationList<T>): ValueList<T, MainScope>;
}
```

绑定的 `conv.command` 提供 conversation-token 的读/写而无需重复 conv。Main command
的读取可以检视 working values；它的写入不能直接修改它们。WorkingCommand 只
暴露 value/list 写入，且运行时校验把所有写入钉在所提供的 working id 上。

```ts
await ctx.commit((tx) => {
  const assistantId = tx.entry(convId, "assistant", meta, { message }, { by: generationId });
  const calls = message.content.filter(block => block.type === "toolCall");
  const toolIds: number[] = [];
  for (const [callIndex, call] of calls.entries()) {
    toolIds.push(tx.task(convId, "tool", {
      status: "planned", callIndex, callId: call.id, name: call.name,
      args: call.arguments, allowed: activeToolNames.includes(call.name), replay: "never",
    }, {
      for: generationId, at: assistantId,
      after: sequential && toolIds.length ? [toolIds[toolIds.length - 1]!] : [],
    }));
  }
  const postTools = tx.task(convId, "post_tools", { status: "pending", generation: generationId }, {
    for: generationId, at: assistantId, after: toolIds,
  });
  tx.usage(generationId, convId, message.usage);
  tx.settle(generationId, { status: "done", state: { produced: assistantId, calls: toolIds, postTools } });
  tx.retireScope(workingScope(String(generationId)));
});
```

对一个被选中的 kind 而言，`entry` 还会立即缓冲其 `ctx_append`，并带有自己的 seq（§6.1）。
调用者既不需要自己追加它，也不需要在它周围计算 offsets。所有方法都使用同一个
计数器，包括 patches 与 context operations；ids 不需要 `{ref}` placeholders、保留
ranges、深度遍历或 fix-up pass。

Callback 正常返回即提交该 buffer；返回而不添加 records 是一次 no-op。一次 throw
或校验拒绝会丢弃整个 buffer，且不推进已提交序列。已铸造的
ids MUST NOT 在 command 成功之前被发布或用于外部 effects。Command
对象只在其 callback 期间有效；它不能被保留以便之后添加 records。

Callback 返回之后，line 加载 records 所指向的 rows，按顺序对照已提交 state 加上 buffer 中更早的 records
校验它们（§7.2），并把整个 buffer 作为
一次原子 commit 追加。Storage 校验所提供的 seqs 是连续的，并且紧接其
global committed head 之后开始；它绝不重新编号。Storage 把其 read model 作为 commit 的一部分发布
（§4.3），而不是通过第二次 harness 写入。Line 随后更新执行 residency（§4.4），投递给
listeners，并 resolve `true`（no-op 时为 `false`）。一次 storage failure 会使
该 session fault（§7.3）；重新 open 会从最后一次完整的 durable commit 推导下一个 seq。Sequence
耗尽会 reject，而不是分配一个不安全的整数。没有其他东西写入 journal。

### 7.1 Guarantees
1. 没有两条 commands 交错；一个 callback 看到前一条 command 的已提交 state。
2. 调用者在投递之后 resolve；一个 listener 看到其 records 所描述的 state；一个 listener
   MUST NOT 在其 callback 内 await 同一 session 上的一条 command；一个抛错的 listener 被
   报告为 `handler_error`，且不影响该 commit。
3. Terminal settlement 封住/drain working writes，然后把 outcome + scope retirement 一起提交。
   物理 unlink 随后进行；不存在基于 task-status 的 orphan 推断（§3.5）。
4. 一个已完成的 task 及其 successors 一起提交；不需要更晚的 driver/event pass 来创建它们。

### 7.2 校验（拒绝整个 commit）
- `ins_entry`：conversation 存在；`through`（如果有）是它的一个 entry。
- `ctx_replace` / `ctx_reset`：结果列表（§6.1）具有 head+有序 suffix 的形状；`through`
  不拆分一个 exchange；`expectPrefixVersion` 匹配。
- `ins_task`：conversation 存在；可选的 at 属于它或其继承的 prefix；for 有效；
  初始 status 被允许；after 目标存在于同一 ownership 树中且无环。
- 每条 command 都写入 main 或某一个 working id。Main retirement 是唯一的跨 lifetime 动作；
  它 retire 逻辑 scope 内容，而不需要一次 second-file transaction。
- `set`/`settle`：目标存在；keys 是该 kind 的；status 变化是一次被允许的 transition；
  `settle` 到达一个 terminal status；一个 terminal task 不接受任何 patch。
- `ctx_*`：每个 id 都存在于该会话或其继承的 prefix 中。
- Conversation value/list 写入：目标 conversation 存在，包括在同一条 command 中
  更早创建的情况。Parent history boundaries 是完整 commits；一个 historical fork 的
  inheritance link 与一个 subagent 的独立初始化在 reopen 后原样存续。
- `del_conv`：ownership 子树没有 live tasks；删除之前已经驱动 cancellation。
  保留独立 forks 所需的不可变 history；拒绝在已删除 conversations 中的新 work。

### 7.3 Faults
一次 plan 决策之后的失败会使该 session fault：之后的 commands 会 reject；进程应当
退出并重新 open。Rejections（§19）不是 faults。

---

## 8. Conversations 与 admission

### 8.1 Context 编辑不是 scheduling

Scheduler、drive scopes 与 cancellation 仅在 §3.6–§3.8 中定义。

```text
canAcceptNow = no foreground work and no outstanding cancellation (§3.4)
canEditContext = no streaming/polling request and no unresolved call in the current exchange
```

Pending post_tools 阻塞 acceptance，即使所有 calls 都已 settle。Pending/retrying/deferred
generation 可以允许安全编辑，但绝不允许另一个 generation。一个 held call 阻塞 replacement/reset。
Background jobs 不阻塞 edits。仅 context 的写入在 open 时绝不成为 generation requests。

### 8.2 Acceptance 与链条

```text
idle accept, ONE MAIN COMMAND:
  place eligible queued content + input in selected admission order; dequeue
  capture settings; create pending generation
  write optional external request mapping

busy/cancelling accept, ONE MAIN COMMAND:
  store unselected input + queue followUp
  write optional external request mapping
```

Acceptance 不启动任何 provider effect。链条是 generation → tools + post_tools → 下一个 generation
（§3.9–§3.11）。每个 tool 只 settle 自己。该 join 在任何 call 开始之前就已存在；最后一个 tool
只是使它 eligible。Post_tools 与 final-answer generation 拥有 exchange/turn-end 决策。

### 8.3 Subagents 与 jobs

一个 subagent 是一个带 `owns` 的 `subagent` task。它的创建是**初始化**，而不是历史性的
value inheritance：创建它的 tool 选择要复制的 scalar addresses 与 typed overrides。Context
inheritance 是独立的。公开 API 草图：

```ts
await conv.spawn({
  prompt: "inspect the parser",
  context: "inherit",
  values: {
    inherit: [model, thinkingLevel],
    set: [setValue(activeTools, ["read", "grep"])],
  },
});
```

这里的 `setValue(address, value)` 构造一次 typed initial write；它不独立提交。
token 上不存在通用的 `inherit` flag：一个 tool 可能需要的 value，另一个 tool 必须排除。
Common selections 是 typed addresses 的普通数组，而不是一个 registry。Selection 仅限 scalar；
canvas/game lists 不会被隐式复制进 subagents。

在一条序列化的创建 command 内，捕获 parent 边界，读取选定的有效
values，创建带 `owner` 与 `parent: {conv, at?, asOf, inheritValues: false}` 的 child，写入选定的
present values 与 overrides，插入 prompt 及其初始 generation task，并用 `owns` 把
owner task 标记为 `running`。
一个缺失的选定 value 保持缺失，除非被 override。复制 values，而不是可变对象别名。
只存储所得的本地 values，而不存储 token 对象或一个 durable selection policy。
Child 在这条 command 提交之前不能 drive。它没有 parent value/list fallback：未被选中的 plan
mode 与 plugin state 是缺失的，即使其 context 被继承。Model、thinking
level 与 tool names 变为普通的、可 rewind 的本地 values。Child 之后的一次 historical fork
正常继承这些 values，并在 child 的独立初始化边界处停止。

Child 按 `context: "fresh" | "inherit"` 得到一个空 context 或继承的 context。初始化可能
在 parent 运行期间发生；一个继承的 context 必须终止于一个完整的 exchange，且不编辑
parent 的 context。一个正在执行的 parent 的确切 context-capture 策略仍在评审中
（§25）。Child 的 finishing command settle 其 owner（§3.13）。一个 foreground tool 已经停在
finishing 中，带 after:[owner]；它无需 waitFor promise 即变为 eligible。Background launch
立即用该 id settle 该 tool。Job 行为在 §3.14 中定义。

### 8.4 Forks 与 rewind

一个 historical fork 记录 `parent: {conv, at?, asOf, inheritValues: true}`。它继承在该边界处可见的**所有**
conversation values 与 lists；不适用任何 per-token filter。Fork 创建
既不复制 value inventories 也不复制 list prefixes。本地写入 override 继承的 scalars，且
本地 list appends 跟随继承的 prefixes（§5.3–§5.4）。Session values 保持 session-wide。

一个 target 可以是 `{ at: entryId }` 或 `{ asOf: commitEndSeq }`。Entry selection 解析到**包含**
该 entry 的 commit 边界，因此在同一条 command 中的 tool result 与 active-tools update
被一起继承。一个显式的 commit target 支持不包含任何 message entry 的 moves 或 canvas changes。
一次 commit 内部的 seq 会被 reject，而不会被四舍五入到一个部分可见的状态。

对于继承的 context，复制所选边界处 parent 的 context（§6.6）；对于
entry selection，还按原始 fork 契约限制到所选 entry 位置。
修剪到最后一个完整 exchange。该 fork 独立于之后的 parent 编辑而演化。
Historical forks 继承 context/values，而不是 live tasks。要继续需要显式的 generation-task
创建或 acceptance；drive 一个复制而来的、以 user 结尾的 context 不得推断出 work。

除非 keepRunning，`rewind` 在创建 fork 之前 abort/drain 当前 conversation 的 foreground work。
它不按 at 有选择地 cancel graph nodes。keepRunning 使 source chain
不受触动。Entry/commit targets 选择继承的 history，而不是 cancellation 归属。`/tree`
按 parent 列出，并通过缺失的 owner 区分独立 forks。

### 8.5 Open、resume、close、delete

- `open`：conversation states、live tasks、live conversations 的 context 列表上的 entries、live tasks 的
  scratch。不启动任何东西；按 role 报告 live tasks。
- `drive(opts)`：调度所选的 ownership scope；session drive 覆盖所有树（§3.8）。
- `abort(conv)`：标记 foreground targets 并 drain 合格的队列一次（§3.7）。
- `close()`：封住 admission，signal executions，drain persistence；不 retire/settle 任何东西。
- `shutdown(conv)`：conversation cancellation，包括 background work。
- `delete(conv)`：报告 work；确认后，shutdown/drain ownership 子树，然后 del_conv。
  保留独立 forks 所需的 history；物理 repository 删除是分开的。

---

## 9. Observation

### 9.1 Watch

`watch(conv, { limit })` 在 line 上运行：它在一步内注册 listener 并读取 base，
因此没有间隙。Base：
```
{ asOf: seq,
  conversation: ConversationState,                        // includes context and prefixVersion
  entries: [ last `limit` transcript entries in transcript order, with payloads ],
  tasks:   [ live tasks ],
  scratch: { [taskId]: reduced } }
```
然后按 commit batches 投递相关 main writes，保留每次写入的 seq（`ins_entry`、
`ins_task`、`set`、`settle`、`set_conv`、context/value/list 编辑与 scope retirement；如果被请求，还包括 owned
conversations）。Usage 是一次 main-list append。Working progress 作为 preview 投递，
以及 ephemeral deltas `{ frame | progress | kind-emitted, taskId }`，外加 `quiescent` 与 `fault`。
更早的 pages：`entries(conv, { before, limit })`，各带自己的 `asOf`；client 对它所分页的 entries
忽略 `seq ≤ asOf` 的 stream records。Remote clients 通过 RPC 进入 host，因此同一个
一步 base 也适用于它们。

**Replicated plugin state** 是 conversation checkpoints 与 delta lists（§5.5）之上的一层 wrapper，
暴露 Chord 的 `ReplicatedState<T>` 读表面。Persistence 与 conversation identity 仍然是
Pi/application 的关注点，而不是 Chord 概念。

- **没有 durable replication revisions。** Storage 只记录 journal seqs。在全新 hydration 时，
  adapter 建立 stream revision 0，然后为发出的 update batches 编号 1、2、3、…。
  因此位于 104 与 117 的 journal updates 可以是 stream revisions 1 与 2。Chord 的连续
  revision 检查保持不变；不存在存储的 `stateSequence` 或第二个分配索引。
  Adapter 独立于 live stream counter 保留用于 catch-up 的 journal cutoff。
- **Commit 先于 publication。** 读取当前已提交 state 并在
  line 上推导/校验变更；缓冲 delta/checkpoint 写入；commit；然后在下一条 command 运行之前
  发布对应的 state。并发的更新不能从同一个过时 base 计算。一条失败的
  command 不发布任何东西，且其私有 draft 不得污染后续的 update。
  在 active 期间保留当前已提交 state；hydration 不会每次写入都重复。
- **Hydration 与 binding。** 读取可见的 checkpoint 与 delta suffix，捕获 journal
  边界，并在一个 line 步骤中注册 update capture。在 rewind 时，重建所选
  history，使旧 binding 失效，hydrate 新的 binding 并重启其 live counter。拒绝
  来自已 retire bindings 的投递。一次周期性 checkpoint 本身不会重启一个既有的
  replication stream，也不会在 state 未变时要求一个 client 可见的 update。
- **实际的 Chord 边界。** `replicatedState(initial)` 暴露被追踪的 `.state`、已发布的 `.value`
  与同步的 `.publish(context)`；其公开 subscription 投递完整 values。其
  decoded-operation subscription 与 producer registration 是私有的。此外，订阅一个
  producer 或其 service 可能 flush 待处理的 mutations。因此，先 mutate 一个暴露的 producer
  然后 await storage 并不是一个安全的 persistence adapter。Draft tracking 必须保持私有
  直到 commit；确切受支持的 Chord adapter seam 仍有待设计（§25）。
- **Delta ownership 与编码。** Chord Delta 公开提供 `track`、`apply`、`applyImmutable`、
  `encoder` 与 `decoder`。Decoded `Op[]` 携带完整 paths；压缩的 `WireOp[]` 可能依赖
  先前的 path definitions。一次完整 replacement 会重置那些 dictionaries。任意的 wire batches
  不能在没有其匹配 codec state 的情况下被独立 replay 或跨 histories 拼接。
  checkpoints/forks 处的 durable encoding 与 codec handling 仍是一项显式的设计选择（§25），
  而不是 list storage 所能推断的东西。Mutable replay 必须拥有其 payloads；它不得 mutate
  权威的 in-memory journal。Immutable application 共享未变的 subtrees，但复制
  变化路径的 containers，其成本可能取决于 container 大小。

Wrapper 拥有 checkpoint 节奏与 state/batch 边界。Rewind 重建；它不发送
逆操作。不能仅仅因为存在更新的 checkpoint 就 prune 历史数据。

### 9.2 Rendering

Transcript order，外加一条规则：一条 `summary` 被画在其 `through` 之后（如果 `through` 未加载，
则画在已加载页的顶部）；其他一切都画在其所在之处。context 列表标记
模型看到什么（其余变暗）。
一个 client 侧的 `toLaneSnapshot(base)`（transcript、来自 generation 的归约
scratch 的 streaming message、来自 live tool tasks 的 running tools、来自 inbox 的 queues）服务于想要
旧形态的 renderers。

### 9.3 Events

按 kind 与 transition 对 journal records 的 subscriptions；没有单独的事件词汇表。

---

## 10. Hooks

Points 与 decisions：`before_request`（edit）、`after_response`（observe）、`before_tool`
（`allow | block(text) | hold`）、`after_tool`、`on_yield`（`pass | continue(message)`）、
`before_collapse`（`decline | {meta}`）。`hooks.on(point, handler, { priority })`，升序；第一个
`block`/`hold`/`decline` 胜出；第一个 `continue` 胜出。Hooks 不拥有任何 state。

---

## 11. 具体 task 索引

§3 是权威的 task 契约；此索引不引入第二套生命周期定义。

| Task | 职责 | Durable continuation |
|---|---|---|
| generation（§3.9） | provider response/retry/poll | tools + post_tools，或 final boundary |
| tool（§3.10） | 一次 call 与自身 result | 没有 sibling/turn orchestration |
| post_tools（§3.11） | join calls，施加 exchange policy | 下一个 generation 或 finish |
| collapse（§3.12） | summarize 并安全替换 prefix | 现有 generation 变为 eligible |
| subagent（§3.13） | 拥有 child conversation | child terminal command settle owner |
| job（§3.14） | spawn/adopt process，观察 exit | 依赖的 tool 或 scheduled job |
| approval（§3.15） | 人类决策 | 恢复/完成现有 tool |

`new_context` 是一个 tool outcome，而不是另一个 task kind：该 tool 存储 handoff intent；post_tools
追加 handoff，重置 context 并原子地创建下一个 generation。

---

## 12. 公开 API 与用法

### 12.1 共享类型与 host services

```ts
type AgentInput = string | UserMessage | readonly AgentMessage[];
interface ModelIdentity { provider: string; modelId: string }
interface RetryPolicy { maxAttempts: number; baseDelayMs: number }
interface CollapsePolicy { threshold: number; keepRecent: number }
interface GenerationSettings {
  model: ModelIdentity;
  thinkingLevel: ThinkingLevel;
  activeToolNames: string[];
  toolOrder: "parallel" | "sequential";                  // creates after edges; not a scheduler lock
  streamOptions: JsonObject;
  retry: RetryPolicy;
}
interface DriveOptions { pollDeferred?: boolean }
type DriveOutcome = "idle" | "suspended" | "closed";
interface Inspection { start: Task[]; inflight: Task[]; waiting: Task[] }
interface Accepted { entryId: number }
interface AbortReport { drained: InboxItem[] }
type HistoryTarget = { at: number } | { asOf: number };
interface TaskServices {
  models: Models;
  tools: ReadonlyMap<string, Tool>;
  hooks: Hooks;                                         // typed points in §20
  resources: ReadonlyMap<string, unknown>;               // host capabilities; checked by consuming kind
  retry: RetryPolicy;
  collapse: CollapsePolicy;
}
interface SpawnOptions {
  prompt: AgentInput;
  context: "fresh" | "inherit";
  values: { inherit: readonly ScalarSelection[]; set: readonly InitialValueWrite[] };
}
interface RegisteredKind { readonly kind: string }       // opaque result of validated registration
declare function defineTask<S extends string, D>(definition: TaskDefinition<S, D>): RegisteredKind;
interface HarnessOptions extends TaskServices {
  initial: GenerationSettings;
  kinds: readonly RegisteredKind[];
  systemPrompt: string | (() => string | Promise<string>);
}
```

`RegisteredKind` 是 defineTask/defineContent 返回的经过校验/擦除的 registration；每个
constructor 保留其 schema 的 state/status 类型。这不是一个用于 values 的任意对象 registry。
Provider option patching 与 process-adoption 能力仍是 host seams（§25）。

### 12.2 Harness 与 conversation

```ts
interface ConversationView {
  state(): Promise<ConversationState>;
  entry(id: number): Promise<Entry | undefined>;
  task(id: number): Promise<Task | undefined>;
  entries(query: Omit<EntryScan, "conv">): Promise<Entry[]>;
  tasks(query: Omit<TaskScan, "conv">): Promise<Task[]>;
  getValue<T>(address: ConversationValue<T>, at?: HistoricalRead): Promise<T | undefined>;
  readList<T>(address: ConversationList<T>, options: ListReadOptions): Promise<ListElement<T>[]>;
}
interface ConversationCommand {
  readonly view: ConversationView;
  getValue<T>(address: ConversationValue<T>): Promise<T | undefined>;
  setValue<T>(address: ConversationValue<T>, value: NoInfer<T>): number;
  deleteValue<T>(address: ConversationValue<T>): void;
  appendList<T>(address: ConversationList<T>, value: NoInfer<T>, tag?: string): number;
  readList<T>(address: ConversationList<T>, options: ListReadOptions): Promise<ListElement<T>[]>;
  entry(kind: string, meta: JsonObject, payload?: JsonValue, options?: EntryOptions): number;
  task(kind: string, state: JsonObject, options?: TaskOptions): number;
  set(id: number, patch: TaskPatch<string, JsonObject>): void;
}
interface Conversation extends ConversationView {
  readonly id: number;
  accept(input: AgentInput, options?: { requestId?: string }): Promise<Accepted>;
  drive(options?: DriveOptions): Promise<DriveOutcome>;
  prompt(input: AgentInput, options?: { requestId?: string }): Promise<AssistantMessage | undefined>;
  result(inputId: number): Promise<InputResult>;          // contract still open in §18.2
  appendMessage(message: AgentMessage): Promise<number>; // context only, deferred if unsafe
  steer(input: AgentInput): Promise<number>;
  followUp(input: AgentInput): Promise<number>;
  nextRun(input: AgentInput): Promise<number>;
  cancelQueued(id: number): Promise<"cancelled" | "already_consumed" | "not_found">;
  abort(): Promise<AbortReport>;                        // commit intent; drive performs cancellation
  shutdown(): Promise<void>;                           // mark + drive whole ownership subtree, including background
  waitForIdle(): Promise<void>;                         // observe only; starts no work
  runWhenIdle<T>(callback: () => Promise<T>): Promise<T>; // host-side admission; semantics to finalize (§25)
  collapse(options?: { instructions?: string }): Promise<number>; // create task, not provider effect
  resetContext(ids: number[]): Promise<void>;
  fork(options: HistoryTarget & { context: "fresh" | "inherit"; label?: string; summary?: string }): Promise<Conversation>;
  rewind(target: HistoryTarget, options?: { keepRunning?: boolean }): Promise<Conversation>;
  spawn(options: SpawnOptions): Promise<number>;        // create owner task; return immediately
  setValue<T>(address: ConversationValue<T>, value: NoInfer<T>): Promise<void>;
  deleteValue<T>(address: ConversationValue<T>): Promise<void>;
  appendList<T>(address: ConversationList<T>, value: NoInfer<T>, tag?: string): Promise<number>;
  command(build: (tx: ConversationCommand) => void | Promise<void>): Promise<boolean>;
}
interface Harness extends ValueReader {
  root(): Promise<Conversation>;
  conversation(id: number): Promise<Conversation | undefined>;
  conversations(query: ConversationScan): Promise<ConversationState[]>;
  inspect(): Inspection;
  drive(options?: DriveOptions): Promise<DriveOutcome>;
  command(build: (tx: Command) => void | Promise<void>): Promise<boolean>;
  command(scope: WorkingScope, build: (tx: WorkingCommand) => void | Promise<void>): Promise<boolean>;
  setValue<T>(address: Value<T, MainScope>, value: NoInfer<T>): Promise<void>;
  deleteValue<T>(address: Value<T, MainScope>): Promise<void>;
  watch(conv: number, options: { limit: number }, listener: (event: WatchEvent) => void): Promise<() => void>;
  decideApproval(id: number, decision: "grant" | "deny", details?: JsonValue): Promise<void>;
  delete(conv: number, options: { confirm: boolean }): Promise<void>;
  close(): Promise<void>;
}
declare const Harness: {
  open(storage: Storage, options: HarnessOptions): Promise<Harness>;
};
```

Invocation Context 由 host binding 提供；Storage 显式接收它。公开的 async
wait cancellation 必须保持 observer-only；它绝不静默调用 abort。Expected-input fencing
与确切的 observer Context overloads 仍开放（§25）。`InputResult` 需要 §18.2 中显式的 attribution
契约，而不是按时间顺序猜测答案。WatchEvent 是 §21 中的 wire union。

Conversation tokens 携带 scope/kind/value type，但在被绑定之前不携带 conversation id。SpawnOptions
包含 prompt、fresh/inherit context、scalar address selections 与 typed initial writes（§8.3）。
异构的 selections 只有在每次写入都通过其 address 的 NoInfer 检查之后才被擦除。

### 12.3 Accept、inspect、drive 与 cancel

```ts
const h = await Harness.open(storage, options);          // no effects
const root = await h.root();
const accepted = await root.accept("Inspect the parser", { requestId: "web-request-42" });
console.log(h.inspect());                               // includes pending generation
const outcome = await root.drive();
if (outcome === "idle") console.log(await root.result(accepted.entryId));

// Another caller can cancel the conversation while drive is active:
const driving = root.drive();
const cancelled = await root.abort();                   // durable marks; no per-task cancel
await driving;                                         // provided this scope remains driven
console.log(cancelled.drained);

// After a restart, inspect for display, then drive; do not iterate tasks to resume each one.
console.log(h.inspect());
await h.drive({ pollDeferred: true });                  // all independent trees
```

### 12.4 Queueing 与独立 scopes

```ts
const first = await root.accept("Analyze A");
await root.accept("Then analyze B");                   // first generation exists: queues followUp
await root.steer("Use read-only tools");
await root.nextRun("Apply this on the next explicit idle acceptance");
await root.drive();

await root.appendMessage({ role: "user", content: "Context only", timestamp: Date.now() });
await root.drive();                                    // creates nothing merely from this message

const fork = await root.fork({ at: first.entryId, context: "inherit" });
await fork.accept("Try a different approach");
await fork.drive();                                    // parent and sibling forks remain parked
```

### 12.5 Values、child 初始化与 working state

```ts
const model = conversationValue<ModelIdentity>("pi.model");
const thinking = conversationValue<ThinkingLevel>("pi.thinking");
const tools = conversationValue<string[]>("pi.active-tools");
const plan = conversationValue<boolean>("my-plugin.plan");
await root.setValue(plan, true);
await root.spawn({
  prompt: "Inspect only the parser",
  context: "inherit",
  values: { inherit: [model, thinking], set: [setValue(tools, ["read", "grep"])] },
});
await root.drive();

// Working value/list writes use the SAME command path, pinned to one named lifetime.
const work = workingScope("upload-preview");
const chunks = list<string>("my-plugin.chunks", "", work);
await h.command(work, tx => { tx.appendList(chunks, "first chunk"); });
await h.command(tx => { tx.retireScope(work); });
await h.close();
```

这些示例是 API 说明，而不是 benchmark 结果或可执行的集成测试。

---

## 13. Invariants 与 tests

1. Read model 在每次 commit 时、在每个 backend 上都等于一次 replay。
2. 每个外部 effect 之前都有已提交的 inflight intent；settlement 与 successors 是同一条 command。
3. 每个非 terminal status 都有一个 driver 动作；一个未知 status 在 open 时失败。
4. 在 abort 与一次完成的 cancellation drive 之后，所有被选中的 foreground/required tasks 都是 terminal，
   且其 working scopes 已 retire。Detached background tasks 存续；shutdown 包含它们。
5. 投递顺序与 listener 规则（§7.1）。
6. Projections 绝不写入；driver 绝不读取 payload。
7. Entries 绝不 patch 或重排；一个 terminal task 不接受任何 patch。
8. context 列表始终是 `[head?，随后是按 transcript 顺序的 entries]`；其上的每个 id 都存在；`through` 绝不拆分一个 exchange；带过时 `prefixVersion` 的 `ctx_replace` 会 reject；一次 summarization 在 appends 之后存续，并被一个相互竞争的 replace/reset 拒绝；任一 commit 边界时的 context 都可以通过从最新的 reset 起重放 `ctx_*` records 来重建。
9. **Residency**：执行持有 live conversation states、live tasks、它们的 scratch、context entries 与所需的 settings。Backend history 与 active plugin replicas 是分开的、被显式计入的成本（§4.4）。
10. **Bound**：resident entries = context-list ids 的并集；resident tasks = |live| 加上尚未 live 的最新 generations；在每个 backend 上都独立于 journal 长度。在 ≥100k turns 并伴随冷 reopen 的情况下验证；这是一项必需的测量，而不是已验证的结果。在 memory/JSONL 上分别统计完整 journal/index 内存与 active plugin tracking state。
11. 一个 fork 的 context 在其 parent 之后 summarize 或 reset 时绝不改变。
12. 一个比任何 summary 都更老的 task 在冷 open 后存续，被 recovery，settle，并可按 id 读取。
13. Watch 没有间隙：base 与 subscription 是一个 line 步骤；一个被分页加载的 entry 绝不使一个流式 update 倒退（`asOf`）。
14. Session metadata 在导航后原样存续；historical scalar reads 尊重每一个 ancestor cutoff 与 deletion tombstone。
15. Historical forks 不复制任何 value/list prefixes；subagents 只存储选定的初始 scalar values 与 overrides，且没有 parent fallback。两种行为在 reopen 后都存续。
16. List pagination 与 checkpoint replay 在嵌套 forks 上产生与一次参考遍历相同的可见 history；没有页泄漏 sibling 或更晚 parent 的写入。
17. Input acceptance 与 external identity mapping 是一次原子 commit；一个丢失的 response 不能只留下其中之一 durable。
18. Replication 只发布已提交 state。Journal gaps 不需要 durable replication counter；fresh bindings 在连续的 emitted updates 之前 hydrate。
19. Acceptance/settlement/显式 caller commands 创建 generation tasks，绝不依赖 driver tail inference。
20. Generation 原子地创建其 tools 与恰好一个 post_tools。Tools 只 settle 自己；
    post_tools 保持 foreground，并以其自身的 settlement 创建恰好一个 successor。
21. 仅 context 的写入不请求 generation，无论在 reopen 之前还是之后；pending/retrying/deferred work 阻止重复的 foreground admission。
22. Reported usage 随其 attempt outcome 提交，包括 retries 与过时的 collapse publication。
23. Main/working 混合写入在 mutation 之前 reject。Retirement 随 task outcome 提交；物理
    unlink 失败不能使已 retire 的数据复活。迟到的 progress 不能重新打开一个已完成 task 的 scope。
24. 重叠的 drive scopes 共享 ownership；effect/recovery 与 abort 绝不并发写入。
25. Open 不启动任何东西，不发明任何 successors，且只恢复显式为 live 的 working lifetimes。

Scenarios：v1 套件重新表达；§15 中的 walkthroughs；对抗性清单：在
替换一个 conversation value 之后 rewind；一个 plugin 写入数千个版本（执行 residency 保持平坦，
backend history 单独统计）；在 deletes 与 checkpoints 之前/之后的嵌套 forks；没有继承 plan mode 的选择性
subagent settings；反复 compact
（一个 head，绝不是一条链）；一个古老的 job 跨越许多 summaries 等待；在之后 parent summary 之前的 fork；在一个 summarization 运行时的 reset（summary 被拒绝）；在 updates
到达时 page（`asOf`）；在 `limit: 3` 下渲染一条带保留 tail 的 summary（§15.6）。

---

## 14. Contrast

| | runtime/（lanes） | dom/ 与 pico v1 | pico v2 |
|---|---|---|---|
| unit | lane over an entry branch | node tree | conversation = transcript + tasks + values, with a context list |
| in-flight state | one 13-leaf op record per lane | status on nodes | status on tasks; one live set |
| model context | scan back to the compaction entry | collapse node / folds | explicit list: head + suffix; three ops |
| memory | window per lane | whole tree (v1) | context entries + live tasks |
| history | branch index, `getEntry` | resident tree | transcript pages, typed historical value/list reads |
| subagents | child lanes | nodes | tasks owning conversations |
| plugin state | session values/lists + custom entries | nodes | typed session values and rewindable conversation values/lists |
| rewind | move a cursor | fork node | historical fork; optionally cancel source conversation foreground |
| storage | entries + branch index | ops + checkpoints | journal + read model; JSONL rebuilds by scan, SQLite keeps tables |

---

## 15. Walkthroughs

下面的 task 名字代表 numeric creation seqs。花括号分组一次原子 main commit。Progress
commits 只写入具名 working scope；terminal commits 包含其 retirement。

### 15.1 One tool

```text
accept:       { user U; create G1 }
request:      { G1 streaming } → provider
response:     { assistant A; create T; create P after:[T]; settle G1; retire G1 scope }
execution:    { T running } → tool
result:       { tool result R; settle T; retire T scope }      // P remains live, no idle gap
coordination: { settle P; create G2 }
answer:       { assistant B; settle G2; retire G2 scope }      // no continuation: idle
```

T 对 P 或其他 tools 一无所知。P 在 T 开始之前就已存在，因此 T 的 result 之后的 crash
不需要修复：P 已经 ready。T 期间的 crash 执行其正常的 recovery 策略。

### 15.2 Parallel 与 sequential calls

```text
parallel response:
  { create T1,T2,T3; create P after:[T1,T2,T3]; settle G1 }
completion order:
  { R2; settle T2 } → P blocked
  { R3; settle T3 } → P blocked
  { R1; settle T1 } → P ready
  { settle P; create G2 }

sequential response:
  { T1; T2 after:[T1]; T3 after:[T2]; P after:[T1,T2,T3]; settle G1 }
execution:
  T1 terminal → T2 ready → T2 terminal → T3 ready → T3 terminal → P ready
```

两者使用相同的 tool 与 join handlers。transcript 保留完成顺序；model
projection 按 call 顺序发出 results。一个被阻塞的 tool 产生一个普通的 error result 并
settle。只有 P 解释已完成的 exchange outcomes 并决定 generation 是否继续。

### 15.3 Hold、restart 与 conversation cancellation

```text
T1 held: { create approval A; T1 waiting after:[A] }
T2 after:[T1] and P remain blocked
open: inspect reports all tasks; starts nothing
approve: { A granted; T1 planned approved:true } → covered drive runs T1

instead, conv.abort():
  { mark T1,T2,T3,P and required approval A; drain steer/followUp once }
  signal owned effects; join each task's own execution before abort handler
  each tool writes its error result; unstarted tools need not await predecessors
  P aborts without generation; every terminal task retires its working scope
```

只有 conversation cancellation 是公开的。删除一个 queue item 与取消 live
work 是分开的。Detached background tasks 在 foreground cancellation 之后存续；shutdown/delete 包含它们。

### 15.4 Foreground/background subagent

```text
foreground tool T delegates:
  { create owner S; T finishing after:[S] }                 // effect returns
S starts:
  { create child C owner:S; initial values; prompt; Gchild; S running owns:C }
child finishes:
  { final assistant B; settle Gchild; settle S result:B }   // existing T is now eligible
T finishes:
  { parent tool result from B; settle T }                  // parent P waits for all calls

background tool T delegates:
  { create S; tool result containing S.id; settle T }       // no dependency on S
```

没有 effect 跨 child 生命周期持有一个 promise。Recovery 驱动现有的 child tasks 与已存储的
dependencies。Child 完成不会在调用者的 drive scope 之外执行 parent work；
它只是在完成的一部分中 settle 其 owner。Parent tool 的 finishing 在被覆盖时运行。
Forks 没有 owner，且绝不因为 provenance 而被拉入某个 parent 的 scope。

### 15.5 跨 restart 的 background job

```text
{ create job J; tool result J.id; settle launching tool }
{ J spawning, durable adoption/log location } → spawn/adopt
{ J running, verified process identity } → install output/exit observers, return
parent P creates next generation without waiting for J

open → inspect J running; covered drive re-arms observer once
exit → { immutable result E; settle J exited produced:E; retire J scope }
later tool → indexed read J and E, even if J.at is long outside current context
```

外部进程日志与有界的 working checkpoints 具有显式的 host lifetime 规则。
context compaction 与普通的 foreground cancellation 都不会使一个 detached job 消失。

### 15.6 Collapse、speculative、subsuming，以及在 `limit: 3` 下的渲染

Transcript `u1 a1 u2 a2`（ids 1..4），context `[1,2,3,4]`，预算超出，`keepRecent` 保留 `u2 a2`：
```
20  T collapse C {pending, through:2, prefixVersion:0}      21 set 20 {summarizing}
    — meanwhile generation 22 runs and appends 23 (u3), 25 (a3): ctx [1,2,3,4,23,25] —
26  E summary C "…" through:2 by:20   (context: "none": not auto-appended)     ┐ one commit
27  ctx_replace {through:2, with:26, expectPrefixVersion:0}   → ctx [26,3,4,23,25]   │  prefixVersion 1
28  settle 20 {done, produced:26}                                                  ┘
```
一次本会在 21 与 26 之间落地的 reset 会递增 `prefixVersion`，而 27 会 reject；
20 会 settle `failed`。之后的一次 collapse 捕获 `through: 23` 并总结 prefix
`[26, 3, 4, 23]`，其中包含 summary 26：新的 summary subsumes 它；列表保持一个 head
加一个 suffix。

Rendering：transcript order 是 `u1 a1 u2 a2 u3 a3 S`（S = 26 最后被追加）。一个带
`limit: 3` 的 watch 收到 `[u3, a3, S]`；S 被画在其 `through`（a1）之后，而 a1 未被加载，因此在
顶部：`S u3 a3`。`before: u3` 的分页返回 `[u2, a2]`，画在 S 之下，因为它们的位置在
a1 之后：`S u2 a2 u3 a3`。再次分页返回 `[u1, a1]`：`u1 a1 S u2 a2 u3 a3`。Pagination 使用
按存储的 transcript order；只有 summary 的显示位置被重定位。

### 15.7 Reset（Codex 风格）

new_context tool 用 handoff intent settle 自己的 result。它绝不检查兄弟或编辑
context。一旦所有 calls settle，post_tools 施加该 handoff：
```text
{ append handoff H; ctx_reset [H]; create G2; settle post_tools }
```
这是显式的 continuation。仅 `/clear` 不创建 task；在一个 generation
已经 pending 时改变 context 不会隐式取消该 task。
Transcript 不变；jobs 不变；conversation values/lists 不变。下一个 generation 投影 `[40]`
加上后续的 appends。一个 watcher 把 handoff 画在其位置处，并把其上的一切变暗。

### 15.8 Fork 与 rewind

在 `a1`（entry 2）处 fork，且在 §15.6 已发布之后：该 fork 复制 C 的 context，限制到 ids `≤ 2`：
`[26]`？不：26 有 `through: 2`，其 head 代替 `1..2`；限制到 `≤ 2` 时该 head 不
适用（它是在 fork 点之后发布的，且该 fork 的 `asOf` 更早），因此该 fork
读取 C 的 context **as of `asOf`** = `[1, 2]`，修剪到最后一个完整 exchange，并从
`[1, 2]` 开始。之后的 parent summaries 绝不触及它（invariant 11）。在 tool 7 于 generation 2 之下运行时
`rewind(C, at: 2)`：cancel/drain source conversation 的 foreground chain，然后 fork。
该 fork 中的 values/lists 沿 parent link 穿过包含 entry 2 的 commit；之后的 parent
versions 不可见。一个单独的 `{ asOf }` target 可以选择一个仅含 value 或仅含 delta 的 commit。

### 15.9 Plugin state 与 replicated state

Plan mode 在 commit 80 处启用：`value_set C my-plugin.plan-mode=true`。一个穿过
commit 60 的 historical fork 看到先前的 value（如果缺失则为调用者的 default）；60 之后 parent 的变化
不可见。在该 fork 中删除 plan mode 遮蔽继承的 value，而不改变 C。
一个 subagent 可以复制 C 的 model/thinking level，但省略 plan mode 并 override active tools；所有
初始 settings 随 child 创建一起提交（§8.3）。

一个 canvas 在创建时以及周期性地存储一个 checkpoint value，外加每个 delta
batch 的一次 list append。Hydration 找到通过所选 commit 可见的 checkpoint，并只重放其
可见 suffix，包括继承的 ranges。一个 fork 在本地 append，而不复制 parent strokes。
一个 entry label 或 external request mapping 保持为一个 session value，且不 rewind。

如果已提交的 deltas 具有 journal seqs 104 与 117，一个刚 hydrate 的 replication binding 发出
revisions 1 与 2。两个 revision 都不被存储。Rewind 替换该 binding 并重新
hydrate 所选 state。未 journal 的 preview（cursors）是 canvas 的 live task 上的 scratch，如果它有的话。

### 15.10 Open，一般情况

读取 live tasks（`terminal = false`）及其 conversation states；对每个 live conversation 读取
其 context 列表上的 entries（一次批量读取）；读取具名 working values/lists。然后 drive 所期望的 scope。
执行状态读取使用 indexes 而不是重放 journal。JSONL 首先导入完整的
journal；active plugin state 从 checkpoints 与有界 delta pages 单独 hydrate。

---

# Part II — 接口细节与校验

Task definitions 在 §3 中。以下各节补充它们，而不定义另一套
生命周期。开放的设计问题在 §25 中显式列出。Templates 与 skills 仍在其上的一层。

## 16. Tools

```ts
interface Tool {
  name: string; description: string;
  parameters: JsonObject;                              // provider-compatible JSON Schema
  replay?: "safe" | "never";                           // default never
  output?: { retain?: "head" | "tail"; maxBytes?: number }; // default tail, 64 KiB
  execute(args: JsonObject, ctx: ToolExecutionContext): Promise<void | ToolDelegation>;
}
interface ToolExecutionContext {
  signal: AbortSignal;
  invocationId: number; callId: string;
  conv: ConversationView;
  out: ToolSink;
  resources: ReadonlyMap<string, unknown>;
}
type ToolDelegation =
  | { kind: "subagent"; options: SpawnOptions; background?: boolean }
  | { kind: "job"; options: { command: string; notBefore?: number }; background?: boolean };
interface ToolSink {
  write(text: string): void;                          // appended to scratch; capped per `output`; truncation is marked in the result
  details(json: JsonValue): void;                     // result details, replaced on repeat
  image(image: ImageContent): void;                  // image block in final tool result
  handoff(text: string): void;                       // intent for post_tools, never edits context here
  usage(u: Usage): void;                              // journaled atomically with attempt outcome
  addTools(names: string[]): void;                    // updates the activeTools conversation value at settlement; unknown names are dropped
  terminate(v: boolean): void;                        // the run stops after this exchange; the assistant's other calls still settle
  progress(partial: JsonObject): Promise<void>;       // durable checkpoint in scratch; a `progress` delta to watchers; reported by recovery
  memo: { get(key): Promise<JsonValue | undefined>; set(key, v): Promise<void> };   // durable per-execution memos, retired at settlement
}
```
规则。一个 tool 的 throw 变为一个 error result（`isError: true`，消息文本）；在
`signal.aborted` 之后的 throw 变为一个 aborted result。只有 `execute` 位于 harness 的 try 之内；在 settling 期间的一次 storage
failure 会传播（§7.3）。Results 是 `tool_result` entries `{ callIndex, isError,
bytes }`，带有被截断的文本（被截断时追加 `[truncated: N bytes total]`）、details 与
images。对一个不在 `tools` 中的 tool 的 call 以 `not found` settle；一个 `truncated` call（stop reason
不是 toolUse）以 `not executed` settle，且绝不运行。`addTools` 名字不在
`tools` 中的被忽略。`terminate` 在当前 exchange 之后结束 run：没有新 generation，
该 turn 是 quiescent，`drive` 返回 `idle`。除非捕获的 `toolOrder` 是 sequential，calls 是并行的：
generation 按 callIndex 顺序创建 after edges，而一个
被 hold 的 predecessor 保持 nonterminal。Scheduler 没有 tool 特定的 concurrency lock。

## 17. Provider request 边界

Generation 生命周期、classifications、retry、polling、recovery 与 cancellation 只定义一次，
在 §3.9 中。Request 构建投影捕获的 context（§6.4），解析捕获的 model/tools，
解析 system prompt 并施加 before_request。Tools 仍必须强制执行捕获的 active-tool
authorization，而不仅仅是 registry 中存在。在 request intent 之前捕获 MAIN context boundary；
working progress seqs 不是导航目标。Provider payload/cache/option 对齐仍在 §25 中。

## 18. Queues 与仅 context 写入

```ts
interface InboxItem {
  id: number;
  kind: "write" | "steer" | "followUp" | "nextRun";
  entry: number;             // durable unselected content, not yet placed in context
}
```

```text
API                         idle                              busy
accept(input)               place + create generation         enqueue followUp
appendMessage / selected    place safely; no generation       enqueue write
  context-only insertion
steer / followUp / nextRun   enqueue its tag                   enqueue its tag

boundary                    eligible items
idle acceptance             writes + nextRun + mode-selected steer/followUp, then accepted input
post_tools                  writes + mode-selected steer; successor unless stopped
normal final answer         writes; mode-selected steer/followUp if continuing
idle context-only append    earlier writes, then new write; no generation
abort                       drain steer/followUp; retain write/nextRun
```

在选中的 items 内保留 admission order。`steeringMode`/`followUpMode` 默认为 `all`；
`one-at-a-time` 选中该 tag 最旧的 item，把其余留给更晚的 boundaries。`write`
placement 绝不请求 generation，即使它留下一个 user 形状的 context tail。`nextRun`
只被显式的 idle acceptance 消费。在 failure/termination 时，放置 safe writes，但
不消费需要 successor 而该 successor 又不会被创建的 input。

```text
enqueue: unselected content + inbox item in one command
consume: selected placement + dequeue + required generation in one command
cancelQueued: queued → cancelled; already placed → already_consumed; absent → not_found
```

把未选中内容与 placement/cancellation history 关联起来的表示仍与
result attribution 一起开放（§18.2）。Admission 位置不一定是 model-context 位置；不要
静默复制 payloads，也不要假定旧 entry ids 可以被按 transcript 顺序之外追加。
四种 queue 行为与原子消费不依赖于该表示选择。

### 18.1 Caller 已知的 acceptance identity

普通的 `accept(input)` 返回其 numeric input id。一个可选的、由调用者提供的 `requestId`
用于 acceptance 已提交但其 response 丢失时的 recovery。它是一个不透明的 external key，
不是内部 entity id，也不必是 UUIDv7。只有带 key 的 acceptances 付出其 storage 成本。

在序列化的 acceptance command 内，查找 `requestInput(requestId)`（§5.1）。如果不存在，
则创建被接受的 input 并在同一 commit 中把该 session value 设为其 id。如果存在，
则解析既有的 acceptance，而不是插入另一个 input。在一条原子 command 中两个 records 之间没有 crash window，
也没有单独的 request 特定 storage 抽象。

Memory/JSONL 通过 journal replay 维护当前的 keyed map；SQLite 使用 session-values
主键解析 request key，然后从 journal payload 获取其 numeric input id。
每个 entry、task 或 conversation 上都不需要 UUID 字段或二级 UUID 索引。该映射
是 session-wide 的，在 rewind 后存续，且不会作为 child conversation state 被复制。Core 拥有这些
mappings；接受一个 request 不得覆写既有的 identity association。

用不同 input 或不同 conversation 复用同一个 key 的确切行为必须在实现前
确定；它不得静默接受一个新 request 或返回另一个 conversation 的
answer。Lookup 本身只是 `harness.getValue(requestInput(requestId))`，随后进行 input/result
lookup。此机制不需要一个 convenience result overload。

### 18.2 Pending result attribution 契约

原始规则 "the first final assistant after the input" 是无效的。如果 B 在 A
运行时被排队，A 的 final answer 可能出现在 B 的 acceptance entry 之后，却并不回答 B。需要一个显式的 durable
input-to-completion 关联，包括 queued consumption、cancellation、failure，
以及多个 inputs 被一起消费的情况。其表示与确切的 result outcomes 仍开放；
request identity lookup 不解决这第二个关联。不要把按时间顺序的
result inference 作为替代来实现。

## 19. Outcomes、reports、errors

- Drive outcomes 与 ownership scope 在 §3.8 中定义。Conversation idle 关注 foreground；
  session idle 意味着没有 live tasks。Suspended 包含被依赖阻塞的 work，其 prerequisite
  等待一个外部事件。在 commits/passes 之后观察已提交 predicates；events 只是唤醒。
  Callers 共享执行，而不是取消它的权限。
- `inspect()` → 来自 live set 的 `{ start: Task[], inflight: Task[], waiting: Task[] }`；`open()`
  报告相同内容且不启动任何东西。
- Errors：`Closed`（`close` 之后的 command）、`Faulted`（一次 fault 之后的 command；`.reason`）、
  `Rejected` 带一个 code（`invariant`、`busy`、`unknown_target`、`version_mismatch`、`not_found`）；
  这些都不是 fault。一个抛错的 listener 通过 `handler_error` signal 被报告。
- `close()` 等待 in-process effects 观察到 cancellation（每个 `abort` signal 触发；effects
  返回），不 settle 任何东西，不等待 jobs。

## 20. Hooks，精确地

```ts
interface HookContract<I, D> { input: I; decision: D }
interface ProviderRequest {
  systemPrompt: string; messages: AgentMessage[]; tools: Tool[]; streamOptions: JsonObject;
}
interface HookContracts {
  before_request: HookContract<{ conv: ConversationView; generation: Task; request: ProviderRequest }, ProviderRequest>;
  after_response: HookContract<{ generation: Task; message: AssistantMessage }, void>;
  before_tool: HookContract<{ call: Task; args: JsonObject }, { kind: "allow" } | { kind: "block"; text: string } | { kind: "hold" }>;
  after_tool: HookContract<{ call: Task; result: JsonValue }, void>;
  on_yield: HookContract<{ conv: ConversationView; generation: Task; message: AssistantMessage }, { kind: "pass" } | { kind: "continue"; message: AgentMessage }>;
  before_collapse: HookContract<{ conv: ConversationView; through: number; prefixVersion: number }, { kind: "decline" } | { kind: "allow"; meta: JsonObject }>;
}
interface Hooks {
  on<P extends keyof HookContracts>(
    point: P,
    handler: (input: HookContracts[P]["input"]) => HookContracts[P]["decision"] | Promise<HookContracts[P]["decision"]>,
    options?: { priority?: number },
  ): () => void;
}
```

| point | input | decision | combination |
|---|---|---|---|
| `before_request` | `{ conv, generation, request: { systemPrompt, messages, tools, streamOptions } }` | `request` | applied in order |
| `after_response` | `{ generation, message }` | — | all run |
| `before_tool` | `{ call: Task, args }` | `allow` \| `block(text)` \| `hold` | first block/hold wins; later hooks do not run |
| `after_tool` | `{ call, result }` | — | all run |
| `on_yield` | `{ conv, generation, message }` (completed final response candidate) | `pass` \| `continue(message)` | first continue wins |
| `before_collapse` | `{ conv, through, prefixVersion }` | `decline` \| `{ meta }` | first decline wins; metas merged |
一个抛错的 hook：`before_request` 使 generation 失败；`before_tool` 用错误文本 block；
`before_collapse` decline；`on_yield` pass；observers 被报告为 `handler_error` 并被忽略。Hooks 由 effects 在 line 之外调用，因此一个 hook
MAY `await ctx.commit(...)`（追加 entries、写入 typed values/lists、插入 work）；那些 commands 在 §24 之下与其他 actors 交错。一个 `before_request` hook 只通过它返回的
request 影响*本次* request；它追加的一个 entry 从下一个 generation 起被投影。只有 listeners
（watch/`on`）被禁止在其 callback 内发出 commands。

## 21. Watch wire 形态

```
base   { type: "base", asOf, conversation: ConversationState, entries: Entry&{payload}[], tasks: Task[], scratch: { [taskId]: JsonValue } }
commit { type: "commit", firstSeq, lastSeq, writes: [ { seq, change } ] } // relevant MAIN writes, §4.1
delta  { type: "delta", taskId, kind: "frame" | "progress" | string, payload }
signal { type: "quiescent", conv } | { type: "fault", message } | { type: "handler_error", taskId?, message }
page   entries(conv, { before | after, limit }) → { asOf, entries: Entry&{payload}[] }
```
Base 与 subscription 是一个 line 步骤。Commit batches 即使在过滤掉无关写入时也保留 boundaries；
clients 在发布之前归约整个 batch。因此 tool/result retirement
或 post_tools/successor 创建不会变成一个部分可见的 transition。Preview/signal 字段
不是 durable work requests。Pages 携带它们自己的 asOf 用于去重。del_conv 结束 watch；
context replacement/reset 会提示 model-context rendering。WatchEvent 是这个 base/commit/delta/signal union。

## 22. Usage ledger 与 telemetry

**Usage** 随对应的 attempt outcome 一起 journaled，而不是独立写入一个 ledger。

```text
provider completes: commit reported usage + outcome/retry/deferred transition together
collapse loses prefix race: commit reported usage + failed collapse, without summary/context edit
tool completes: commit usage + own result + own settlement + working-scope retirement
post_tools completes: commit exchange policy + successor generation, if continuing
identity: usage record seq, NOT taskId; a task can have several attempts
query: read the main session usage list; any aggregate/filter indexes are backend implementation details
fork: costs remain attributed to original conversations; no copied billing rows
cleanup: task completion/scratch retirement never removes usage
```

一个没有 provider report 的中断 request 具有未知成本；不存在 exactly-once billing 声明。
Reject 过时/重复的 outcomes，而不是追加重复的 usage。Usage 是一个普通的 main
session list；不存在单独的 ledger authority/file，也不存在 task patches 中冗余的完整 usage payload。

**Telemetry** 使用 pi 的 callback `TelemetryContext`（typed schemas，没有第二套契约）。Spans 与
它们的 parents 遵循过程嵌套：
```
harness.open · harness.drive (per pass)
  acceptance / task settlement              (explicit successor creation)
  task.effect / task.recover / task.abort   (attributes: kind, taskId, status from→to, attempt)
    ai.request                              (model, usage, stop reason, durations; never prompts or completions)
    tool.execute                            (name, callIndex, bytes, isError; never args or results)
    hook (point, name, decision)
  line.command (op count, seqs, duration)   ← parent: the command's caller
  watch.deliver (listener count, duration)
```
一个 pre-aborted signal 不启动任何 span。Attributes 是 ids、names、counts、durations、statuses 与
usage；绝不是 message text、arguments、results、file contents、provider payloads、headers 或 handles。
每条 command 与每个 effect 都携带自己的 telemetry parent 与 abort signal；cancellation 只结束
该调用者的 observation。

## 23. Storage conformance

每个 backend 通过：
1. commit 保留 command 铸造的 global seqs 与原子 batches。每个已准入 batch 从
   global head+1 开始且连续；main files、working files 与保留的 history 有合法的空洞。
2. 每次 commit 之后 read model 等于一次 journal replay（entries、tasks、conversations、
   context lists、`prefixVersion`）。
3. Transcript pages 与 content queries 等于一次 scan；typed value reads 与 list pages 等于
   参考 history traversal，包括嵌套 fork cutoffs 与 deletion tombstones。
4. Working values/lists 使用普通的读/写，在 restart 后存续，并且只通过
   显式 retirement 消失。Result + task settlement + retirement 一起存续或一起消失。
   物理 unlink 之前的 crash 留下逻辑上已 retire 的文件，而不是可恢复的 task state。
5. JSONL：每次 commit 一行；一个被撕裂的最终行在 open 时被截断；对同一 journal，rebuild-by-scan 产生与
   SQLite 的表相同的 read model。
6. Usage 与其 outcome 一起原子存续，包括一个 task id 下的多次 attempts。
7. Storage open 不创建 conversation/tasks。在空 storage 上 harness open 在一条 command 中创建 root + 初始
   values；非空 open 不启动任何 work，也不写任何 journal records。
8. Command 构建：创建方法在 append 之前返回其最终 numeric ids；之后的
   records 直接引用它们，包括自动 context appends。No-op 与 rejected commands
   不消费任何 seqs；并发 commands 分配不相交的连续 ranges；reopen 在
   最后一次完整 commit 之后继续。诸如 `{ ref: 0 }` 的 payloads 原样 round-trip。
9. SQLite value/list queries 使用有序索引，不带 journal scans 或临时排序；
   稀疏 keys 与深层 fork chains 不需要读取无关 history。Fork 创建不添加
   任何继承的 value/list rows。Subagent 创建只存储选定的 present values 与 overrides。
10. Reopen 保留 metadata、historical versions、list cursors 与 subagent 初始化。
    内存 journal 中的 checkpoint payloads 在一次由 wrapper 进行的 mutable replay 之后保持不变。
11. Acceptance 与 request mapping 一起存续或一起消失；一次丢失 response 之后的重试
    不会创建第二个 input。冲突复用的测试遵循 §18.1 中仍待定的策略。
12. Paused persistence 暴露旧的完整 state，绝不暴露被提议的 indexes。Short/failed JSONL 写入
    以及在 newline/SQL commit 之后、publication 之前发生的 crash，会重新 open 到一个完整 prefix。
    格式错误的完整 JSONL 行会使 open 失败；只有未终止的最终字节被丢弃。
13. Close drain 已准入的 main/working 写入，且不 retire 任何东西。复用的 scope ids 只保留
    比最新 retirement 更新的 records。旧的 cleanup 不能删除一个被复用的 lifetime。
14. 围绕 acceptance、tool 与 post_tools/final settlement 的 crash：join 始终存在；不存在没有 generation 的已消费
    trigger，reopen 时没有重复 successor；usage 与 outcomes 一致。
15. 混合 main/working 与两个 working-id 的 commits 会 reject。Memory、JSONL 与 SQLite 在逻辑
    retirement 上一致。High-water 计算在 cleanup 之前包含已 retire 的物理 records。
16. 迟到的 progress 被 invocation fencing 拒绝，而不是被对 scope-id 复用的全局禁令拒绝。

## 24. Race 目录（每个都恰好有两种 durable 顺序；tests 断言两者）

| race | orders |
|---|---|
| 在一个 idle conversation 上的 `accept` vs `accept` | 第一个是 prompt；第二个作为 followUp 排队 |
| keyed `accept` vs 在 response/`drive` 之前的进程丢失 | input 与 mapping 都缺失 → 重试可以 accept；两者都存在 → 解析既有 input，绝不重复它 |
| `drive` vs `drive` | 两者 join 同一个 pass |
| `abort` vs generation settlement | marker 在前 → aborted，无 successor；settlement 在前 → output 与 successors 提交，然后 abort 触达任何仍然 live 的 successor |
| `abort` vs tool outcome | marker 在前 → effect 的 signal 触发，它 settle `aborted`；outcome 在前 → `done`，result 保留 |
| `abort` vs `retry_wait` | settle `aborted` 而不等待 timer |
| `abort` vs collapse settlement | marker 在前 → collapse aborted，列表不变；settlement 在前 → 列表被替换 |
| `abort` vs `on_yield` continuation | marker 在前 → continuation entry 不被插入；entry 在前 → run 继续，abort 使其 settle |
| `cancelQueued` vs boundary consumption | cancellation 在前 → cancelled；consumption 在前 → already_consumed |
| conversation setting write vs generation creation | 旧 value 或新 value；generation 捕获它所使用的东西 |
| `nextRun` vs `accept` | 被本次 prompt 捕获，或留待下一次 |
| collapse settlement vs `ctx_reset` | reset 在前 → `version_mismatch`，collapse `failed`；settlement 在前 → reset 施加到新列表 |
| collapse settlement vs appends | appends 在任一顺序下都存续 |
| frame/progress write vs settlement | 先 seal/drain；outcome + retirement 一起提交；失败的 unlink 留下逻辑上已死的数据 |
| watcher registration vs commit | 一个 line 步骤：旧 base + 所有更晚 records，或新 base |
| `close` vs settlement | settlement 在 close 之前提交，或该 task 保持 inflight 并在下次 open 时 recover |
| fork vs parent summary | 该 fork 已按 `asOf` 复制其列表；该 summary 不被施加到它 |
| subagent initialization vs parent setting write | 在一个捕获边界处选定旧 values 或选定新 values；没有混合初始化 |
| plugin update vs plugin update | 第二条 command 从第一个已提交 state 推导其 update |
| replica binding vs committed delta | hydration 包含它，或新 stream 在 hydration 之后发出它；绝无间隙 |
| parallel tool outcomes | 任一顺序都只 settle 那些 tools；当所有依赖为 terminal 时既有 post_tools 变为 ready |
| steering vs generation creation | 随创建一起包含，或排队到下一个 boundary |
| context-only write vs drive/reopen | context 可能改变；两种顺序都不创建 generation |
| settlement vs 不确定的 persistence outcome | 在 reopen 时 output/usage/successors/retirement 要么全部缺失要么全部 durable；旧 handle fault |
| post_tools settlement vs conversation abort | 被标记的 join 不创建任何东西，或 successor 先提交并成为一个 cancellation target |
| scope retirement vs reuse | 更晚的写入存续；更旧的 unlink 在新 lifetime 之前被序列化 |
| working progress vs retirement | 已准入的旧写入在 retirement 之前 drain；过时的 producer 不能重新创建 task data |
| 重叠的 drive callers vs cancellation | 一个共享的 ownership claim 覆盖 effect join 与 abort handler |

## 25. 剩余设计决策

这些并未被上述 value/list 与 identity 决策所确定：

- **Result attribution：** durable input-to-completion 关联与冲突的 request-key 复用
  （§18）。Caller 已知的 identity 不得与 result ownership 混淆。
- **Historical context optimization：** §6.6 定义了正确的基于 creation/reset 的 replay；更快的
  compaction-bounded reconstruction 仍需评审。仅 replacement 不是一次 checkpoint。
- **Subagent context：** 在 parent tool exchange 打开时安全地捕获继承的 context；调用者的
  selections 在 child 创建时被复制，而不是在 address 构造时隐式复制。
- **Host 与 background lifecycle：** durable process adoption/exit status、有界 schedules，以及
  close 是保留 cooperative waiting 还是获得一个有界的 host 策略。最终确定 runWhenIdle
  admission/observer cancellation，而不引入第二个 execution owner。
- **Queue/response policy：** 确切的 input normalization、steering precedence/mode capture、冲突的
  handoffs、保留的 failed/deferred attempt messages 与 projection。把表示与策略
  同已确定的 chain 机制分开。
- **Old-harness parity：** 有意决定在 tool termination aggregation、hook
  transformations/error handling、interrupted-stream recovery、retryable/overflow classification、
  deferred poll permits/external retry scheduling、token-budget/split-turn compaction、summarized
  navigation/import、usage adjustments/totals 与 complete watch hydration 上的差异。这些不会通过重写 tasks 被
  静默移除。Expected-input cancellation/result fencing 仍与 attribution 绑定。
- **Chord adapter：** 选择一个受支持的 producer/operation seam 与 durable delta encoding，包括
  checkpoint/fork codec state。在一个 commit pending 时不要 mutate 一个暴露的 producer。Stream
  revisions 仍然是 process-local 的发出记账，无论此选择如何。

实现、更强的回归覆盖以及等价的 faux-provider benchmarks 在设计
评审之后进行。CPU 时间、总进程内存与实际磁盘字节（包括 scratch 与 usage）必须
分别测量；spike 的现有数字不是本设计的已验证比较基准。
