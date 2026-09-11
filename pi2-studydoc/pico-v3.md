# pico v3

设计讨论中。代码与 trace 用于说明所提议的行为；它们并非现有的 package exports。

## 1. 目标与假设

### 1.1 小概念，可替换的行为

使用 conversations、immutable entries、durable tasks 以及 scoped values/lists 来运行 agents。内
置 agent 行为由 tasks 组合而成，而不是内嵌在一个固定的 scheduler 状态机中。

```text
                    ┌─ tool A ─┐
generation ──────────┼─ tool B ─┼─ post_tools ─ generation
                    └─ tool C ─┘

replace a task definition
  → change that behavior
  → keep the scheduler and storage
```

scheduler 理解 task lifecycle、dependencies、timing 与 cancellation。它不理解 prompts、tool
arguments 或 summaries。Storage 理解存储的对象与 atomic mutations，而不是 task behavior。

### 1.2 每个 session 一个 writer

允许并发执行。不允许对同一 session 的并发独立 writers。

```text
caller ───────┐
tool ─────────┼─ session owner ─ serialized commands ─ storage
background ──┘

one command:
  read committed state
  construct mutations and assign numeric IDs
  commit the complete batch
  publish committed changes
```

所有 mutations，包括 working-state writes，都经过那个 owner。IDs 在 session 内唯一，并被原样持久
化。未提交的 IDs 不能逃逸到 callers 或外部 effects。

不同的 sessions 可以有不同的 owners，并共享同一个 SQLite 数据库。SQLite 仍然会串行化它的 write
transactions。崩溃之后，一个替代 owner 从 durable state 恢复；它不得与前一个 owner 并行运行。

### 1.3 Durable work，显式 recovery

Durable storage 保留已被接受的工作，包括尚未开始的工作。打开一个 session 不会启动任何 task
effects。

```text
commit pending task
  → crash
  → open: task is still pending
  → drive: execute it

commit external-effect intent
  → perform external effect
  → commit outcome and required successor tasks together
```

在外部 effect 期间发生崩溃会留下不确定性，而不是"什么都没发生"的证据。每个 task definition 必须
决定如何 recover：安全地 retry、adopt 已有的工作，或报告 interruption。Durability 并不承诺
exactly-once external effects。

```text
close     → stop local execution; leave unfinished durable tasks resumable
abort     → durably cancel selected work; drive its cancellation to settlement
```

### 1.4 无需 residency machinery 的长生命周期 sessions

旧的 transcript entries 与 terminal tasks 仍然可查询。harness 不应仅仅因为先前遇到过它们就保留它
们。

```text
check a dependency:
  read the named task
  inspect its terminal status
  return
  // no harness-owned reference needs to survive the check
```

Active executions 自然会保留它们的 inputs 与 working data。其他查询结果都是普通的 local
variables。没有 pin/unpin API、residency manager，或维护第二个 resident model 的 sweep。常规执行
应依赖当前的工作与 context，而不是扫描累积的历史。

Backend memory 是一个单独的选择：

| Backend | Storage 拥有的 memory | Persistence |
|---|---|---|
| Memory | 所有已存储的数据与 indexes | 无；对测试有用 |
| JSONL | 所有已存储的数据与 indexes，在 open 时加载 | Main file 加上 working sidecars |
| SQLite | Read results 与 database caches；无需 full-history JS copy | Database |

JSONL 加载所有内容是有意为之，并非违反 working-set 目标。当最小化 resident process memory 很重要
时，选择 SQLite。没有强加固定的 session 长度限制；storage capacity、numeric sequence limits 以及
同时存活的工作量仍然是真实的限制。

### 1.5 效率必须被证明

```text
same faux-provider workload on each harness/backend
  → CPU time
  → total process memory
  → actual disk bytes, including working data and auxiliary files
```

偏好小的 atomic writes、indexed queries 与 batched reads。不要把 point lookup 变成 history
scan，也不要为了回答一个小问题而重新加载每个对象。在添加 caches 或 specialized machinery 之前先
测量 hot paths。更快的 spike 是需要调查的证据，而不是证明其 interfaces 或 correctness
shortcuts 属于这个设计的依据。

## 2. Conversations

一个 conversation 拥有一个由 immutable entries 组成的线性 transcript，以及一个为模型选择
entries 的 context list。Tasks 与 state 与它相关联，但并不会隐式地成为模型输入。

### 2.1 Entries 与 transcript

最小形态；`JsonValue` 表示 strict JSON。historical-position 与 ownership metadata 单独引入。

```ts
interface Entry {
  readonly id: number;
  readonly conversationId: number;
  readonly kind: string;
  readonly content: JsonValue;
}

interface Conversation {
  readonly id: number;
  readonly context: readonly number[];
}
```

这些是 read snapshots。更改 context 会产生一个新的 conversation snapshot；一个已存在 entry 的
content 永远不会改变。

```text
conversation A

entry ID    kind          content
10          user          "Inspect the parser"
20          assistant     "The parser has two problems ..."
30          user          "Explain the first one"
40          assistant     "The first problem is ..."

transcript: [10, 20, 30, 40]
```

- 新 entries 追加；已存在的 entries 永远不会被 patch、重排或重新编号。
- IDs 按 transcript 顺序递增，但不必是连续的数字。
- 一个 note 可以属于 transcript 而不属于 model context。

### 2.2 Context 负责选择；projection 负责转换

```text
transcript                  context IDs             provider messages
what happened               what is selected         what the model receives

[10, 20, 30, 40] ──────────> [10, 20, 30, 40] ──────> user, assistant, user, assistant
                                         projection
```

context 存储的是 IDs，而不是复制的 messages 或第二个 transcript。

```text
entryById = readEntries(conversation.context)          // batched read
messages = project selected entries in context order
normalize tool-result groups into their call order
```

一个 entry 的 kind 定义了它的 message 贡献。一个 summary 可以作为 user message 投影；一个被选中
的 custom entry 可以不投影出任何东西。Projection 读取 content 并返回 messages。它不写入任何
entries、state 或 tasks。

Tool 的完成顺序不必等于调用顺序：

```text
assistant calls: [A, B]
transcript:       assistant → result B → result A
model messages:   assistant → result A → result B
```

transcript 在这种 normalization 下保持不变。

### 2.3 三个 context 操作

```text
appendContext(ids)
  extend with newly appended selected entries, in transcript order

replaceContextPrefix(through, replacement)
  replace the prefix ending at through; preserve the existing suffix

resetContext(ids)
  replace the whole context with an empty or bootstrap context
```

追加被选中的内容与追加它的 context ID 发生在同一次 commit 中。仅 context 的变更不会创建
generation tasks。

**Compaction：** 追加一个 summary entry，然后在同一次 commit 中替换一个 prefix。

```text
before:
  transcript [10, 20, 30, 40]
  context    [10, 20, 30, 40]

commit:
  append summary 50 describing the prefix through 20
  replaceContextPrefix(through=20, replacement=50)

after:
  transcript [10, 20, 30, 40, 50]
  context    [50, 30, 40]
```

Summary 50 比 entries 30 与 40 更新，但在 model context 中出现在它们之前。它所概括的那些
entries 仍留在 transcript 中。重复的 compaction 也会概括上一个 summary，而不是形成一条不断增长
的 summary heads 链。

**Reset：** 丢弃被选中的 context，而不是 transcript。

```text
commit:
  append handoff entry 70
  resetContext([70])

after:
  transcript [10, 20, 30, 40, 50, 70]
  context    [70]

resetContext([])
  → empty model context
  → same transcript
```

Baseline 约束：

```text
context shape: optional summary/handoff head + selected entries in transcript order
IDs:           existing entries in this conversation or its inherited prefix; no duplicates
replacement:   a contiguous PREFIX of the current context, not a consecutive numeric ID range
exchange:      replacement/reset must not split an assistant's tool-call/result exchange
concurrency:   no replacement/reset during a provider request or unresolved tool exchange
```

一个针对旧 prefix 准备好的 summary 在之后的追加发生之后仍然可以替换它。一个竞争性的
replacement/reset 会使那个已准备好的 prefix 失效。commit 必须在 publish 之前检查这一点。

这些操作不是一个任意的 list editor：没有中间删除，也没有不受限制的重排。Reset 接受一个空
context 或一个 bootstrap head，而不是旧 entries 的任意排列。单独的 Reset 既不取消已有的
tasks，也不请求新的模型响应。

### 2.4 Forks 共享历史，而非未来的变更

一个 historical fork 在一个选定的历史位置创建一个新的 conversation。它的 transcript 共享
source prefix；新的 entries 属于新的 conversation。

```text
A transcript: 10 ─ 20 ─ 30 ─ 40 ─ 50 ─ 70
                   │
                   └────────────── 90 ─ 100    B

B transcript: [10, 20, 90, 100]
               shared  local
```

Entries 10 与 20 保留它们原本的 IDs 与所属 conversation。它们没有复制的 entry rows。每个
conversation 仍然呈现一个线性 transcript。

fork 继承在其选定位置曾经存在的 context，而不是按 entry ID 截断的今天的 context：

```text
P = historical position after the first exchange

A context at P:   [10, 20]
A context now:    [70]

create B from A at P:
  B context starts as [10, 20]
  NOT [] obtained by filtering today's [70]
```

B 有自己的 context list。A 中之后的 appends、compaction 与 resets 不能改变 B。Live tasks 不会被
继承；继续 B 需要显式的新工作。

这里 P 是 caller 已经选定的一个 historical position。§3 定义了选择一个 transcript entry 如何解析
到那个位置，包括 entry-versus-commit 的区分。State 的初始化与 historical inheritance 定义在
§4。

### 2.5 Fork history 与 task ownership 是两种不同的关系

```text
historical relationship:
  conversation A ── fork at P ──> conversation B

execution ownership:
  conversation A ── task T ── owns ──> conversation C
```

B 是一个独立的 fork。C 是一个 owned child，例如一个 subagent conversation。child 可以以 fresh
或 inherited context 开始；这个选择与初始化哪些 state 是分开的。

```text
historical source → where inherited content/state came from
owning task       → which execution owns this conversation
```

仅凭 historical relationship 并不会把 B 拉进 A 的 drive 或 cancellation scope。Ownership 是显式
的；scheduling 与 cancellation 遵循 §§5–6 中定义的 task relationships。

## 3. Identity、commits 与 historical positions

一个 session-global sequence 为 mutations 排序。一个 creation mutation 的 sequence 就是新对象
的 numeric ID。一个完整的 commit，而不是单个 mutation，才是一个 historical snapshot boundary。

### 3.1 在构造 command 的同时分配

```text
last committed sequence: 99

build command:
  100  append user entry                 → entry ID 100
  101  append context ID 100
  102  set planMode = true
  103  create generation task            → task ID 103

persist ONE batch [100–103]
publish the committed changes
return entry ID 100 to caller
```

command 可以引用它刚刚创建的 IDs。在 persistence 成功之前，它不能用这些 IDs 调用外部服务，也不能
把它们返回给 callers。Storage 保留所提供的数字。

```text
command A constructs [100–103] ─ commits ─ command B starts at 104
command A rejects             ─ no write ─ command B starts at 100
```

数字是正的安全整数；耗尽即拒绝。普通的 entries、conversations 或 tasks 上没有 UUID 列，也没有单
独保留的 ID 范围。

### 3.2 Commit boundaries 是 read result 的一部分

把 §2 中的 entry snapshot 扩展为包含它所在 creation commit 的 end：

```ts
interface Entry {
  readonly commitEnd: number;
}
```

一旦构造完成，end 就是已知的。caller 不需要枚举 commit 中的其他 mutations。

```text
getEntry(100)
  → { id:100, conversationId:1, commitEnd:103, ... }

getConversation(1, asOf=103)
  → context as of that boundary

getValue(conversation=1, planMode, asOf=103)
  → true
```

```text
Memory   entry metadata contains commitEnd=103
JSONL    commit envelope contains [100,103]; replay derives the entry metadata
SQLite   entry row contains commit_end=103, inserted in the same SQL transaction
```

在 103 处创建 task 属于 source 的 durable work。它并不意味着一个 fork 会继承那个 task。Context
与 rewindable state 是 historical 的；task execution 不会被 rewind。

### 3.3 提议的 fork contract：在包含它的 commit 之后

```text
fork(A, atEntry=100)
  → resolve entry 100 to commitEnd 103
  → fork A's transcript/context/rewindable state through 103
  → store source A and boundary 103
  → inherit no live tasks
```

这有意地表示**在包含所选 entry 的 commit 之后**，而不是仅有 mutation 100 之后的中间状态。没有第
二个 filter 会把 context 截断到 IDs <= 100。

```text
commit [200–203]:
  200  append entry X
  201  append entry Y
  202  append context IDs [200,201]
  203  set value V

fork at X ─┐
           ├─ same snapshot: includes X, Y and V
fork at Y ─┘
```

这是一个供评审的提议性语义选择，而不仅仅是一个 indexing trick。UI 不得暗示 X 与 Y 选择了不同的
snapshots。严格的 entry-prefix forks 需要一个不同的规则来把 context/state 变更与 entries 关联起
来；它们不得悄悄地把一个被截断的 transcript 与来自同一 commit 的后续 state 混在一起。

caller 也可以直接选择一个完整的 main-commit boundary：

```text
commit [204]: set V = 2                  // no transcript entry
fork(A, asOf=204)                        // selects this state-only change
```

Entry 与显式 boundary 目标使用相同的 historical query path。位于 commit 内部的位置会被拒绝。一个
需要可用 model context 的 fork 还必须选择一个完整的 tool exchange；拒绝一个不完整的 exchange，而
不是悄悄移动到另一个 historical position。

### 3.4 Sequence gaps 是正常的

Working writes 使用同一个 allocator，但不会成为被保留的 conversation history。

```text
100–103  main commit
104–109  working progress
110–112  main settlement, including retirement of that working scope

retained main history: 100,101,102,103,110,111,112
next sequence:        113
```

永远不要把 array offset 用作 durable identity。一个被删除的 working file 不会释放它的
IDs。Working commits 不是 fork targets。即使 working contents 被 retire，backend 也会保留
global high-water mark；main historical boundaries 仍然可以被独立识别。

### 3.5 在 admission 之前或之后的失败

```text
construction/validation rejection:
  no durable writes; no IDs consumed; session remains usable

persistence outcome uncertain:
  stop using this session handle
  reopen storage
  recover the last complete durable batch and its high-water mark
  continue from recovered state, not the old process's guess
```

任何 observer 都不能看到半个 commit。任何 effect 都不得把一次不确定的 write failure 视为可以用新
分配的 IDs 重试同一个 external action 的许可。

### 3.6 Caller 提供的 identities 使用普通 state

External request keys 是可选的 session-scoped values，而不是替代性的 internal IDs。

```text
accept(input, requestId="client-42"), ONE command:
  read session value (pi.request-input, "client-42")
  if present: resolve the existing acceptance
  otherwise:
    create accepted input and its required task/queue changes
    set session value (pi.request-input, "client-42") = input ID

commit succeeds, reply is lost
  → caller retries "client-42"
  → same accepted input ID, no second input
```

Lookup 与 insertion 发生在 serialized command 内部。Core 拥有这些 mappings；普通 callers 不能覆
盖它们。冲突的 key 重用必须拒绝，而不是悄悄接受一个不同的 request；确切的 input-equivalence
check 属于 §8 中的 acceptance。把一个 key 映射到一个 input 并不能回答哪个最终结果属于那个
input。

## 4. State

State 独立于 transcript content 被寻址。它的 mutations 共享 commit sequence，因此一个
historical boundary 会同时选择 context 与 rewindable state。

### 4.1 Scope 与 rewind 行为

| Address scope | Rewind 行为 | Lifetime |
|---|---|---|
| Session | Sticky；一个 current value/list | Session |
| Conversation | Rewindable 或 sticky | Conversation 以及所需的 fork history |
| Named working scope | 永不 rewind 或继承 | 直到显式 retirement |

```ts
const sessionName = sessionValue<string>("pi.session.name");
const plan = conversationValue<boolean>("plugin.plan", { rewind: true });
const expanded = conversationValue<boolean>("ui.expanded", { rewind: false });
const moves = conversationList<Move>("game.moves", { rewind: true });

await conversation.setValue(plan, true);
const enabled = await conversation.getValue(plan) ?? false;
await conversation.appendList(moves, move);
```

Addresses 绑定 namespace、可选 key、scope 与 rewind policy。Payload types 来自 address；writes
不得为了迁就所提供的 value 而推断出不同的 type。

```ts
// Value<T> and ValueList<T> denote typed addresses, not wrappers around current data.
interface StateWrites {
  setValue<T>(address: Value<T>, value: NoInfer<T>): Promise<void>;
  appendList<T>(address: ValueList<T>, value: NoInfer<T>): Promise<number>;
}
```

最终 interfaces 还会区分 address scopes。一个 conversation address 不能用作 session
address。Constructors 不需要 global registration；defaults 属于 read site。Storage 持久化
scope/rewind 信息，而不是依赖 token objects 在 restart 后存活。所有持久化的 payloads 都是
strict JSON；callers 不能通过返回的 aliases 修改已存储的数据。

### 4.2 小的 mutation vocabulary

```text
value: set(value), delete()
list:  append(value), clear()
read:  getValue(address), readList(address, cursor, limit)
```

一次 append 会从它的 mutation sequence 获得一个 numeric element ID。Baseline lists 保留 append
order；它们不支持替换单个元素、在中间插入或移动元素。Structured editing 使用 delta values，如
§4.5 所示。

```text
rewindable list:
  40 append A
  50 append B
  60 clear
  70 append C

read through 50 → [A, B]
read through 60 → []
read through 70 → [C]
```

Clear 会在它的位置及其之后隐藏较旧的元素；它不会擦除更早的 forks 所需的历史。删除一个
rewindable scalar 同样会记录 absence。JSON null 仍然是一个已存储的 value。

Session/sticky state 只暴露它当前的内容。JSONL 可能仍然包含先前的 mutations；harness 不会把它们
解释为 rewindable history。

### 4.3 Initialization 是显式的；一个 historical fork 会保留历史

创建一个新的 subagent conversation 会独立于 context 选择初始 state：

```ts
await conversation.spawn({
  prompt: "Inspect the parser",
  context: "inherit",
  values: {
    inherit: [model, thinkingLevel],
    set: [setValue(activeTools, ["read", "grep"])],
  },
});
```

```text
ONE creation command:
  read selected current source values
  create child conversation
  copy selected present values, then apply overrides
  append prompt and create initial generation

unselected plan mode → absent in child
inherited context    → does not imply inherited plugin state
```

这个 initialization 复制的是 values，而不是一条指向 parent state 的 live link。后续 reads 没有未
选中的 parent fallback。一个被选中但缺失的 value 会保持缺失，除非被 override。Baseline 选择是
scalar-only 的；lists 需要一个显式的 initialization policy，而不是意外地复制一份无界的 log。

一个 historical fork 有另一个目的：

```text
fork A at P:
  rewindable conversation values/lists → inherit all visible history through P
  sticky conversation state           → copy only explicitly selected current values/overrides
  session state                        → same session-wide state, not copied
  working state                        → never inherited
```

提议的 sticky default 是不继承；callers 在创建时选择加入。被选中用于复制的 sticky values 来自
current source，而不是 P：sticky state 在 historical snapshot 承诺之外。这是一个与 fork 的自动
rewindable inheritance 分开的选择。

### 4.4 Rewindable lookup 遵循 fork boundary

只有 local changes 需要新的 records。一个 historical fork 不会把每个 scalar version 或 list
prefix 复制进它自己的 storage rows。

```text
A:  plan=false at 40; plan=true at 80
B:  fork A through 60

read B.plan:
  local version? no
  follow source A, capped at 60
  newest version <= 60 is false

B deletes plan:
  local deletion found → absent; do not fall back to A

B sets plan=true:
  local set found → true
```

在每一个 ancestor 处，保留更紧的 cutoff：

```text
readValue(C, address, cutoff):
  local = newest local version at or before cutoff
  if local is a set: return its value
  if local is a deletion: return absent
  if C has no historical-state source: return absent
  return readValue(C.source, address, min(cutoff, C.sourceBoundary))
```

Lists 组合继承的 visible ranges 与 local appends，遵守 clear operations 以及相同的 ancestor
cutoffs。一个 list cursor 标识一个 element position，而不是 array offset。固定的 asOf 加上
cursor/limit 在后续 writes 继续进行时给出稳定的 pages。

Memory/JSONL 使用 indexed arrays；SQLite 使用 indexed version/range queries。成本可能包含 fork
depth，但不包含对无关 session history 的扫描。一个独立初始化的 child 会终止 fallback；该 child
之后的一个 historical fork 会正常继承它的 local history。

### 4.5 Structured state 使用 deltas 与 checkpoints

```text
checkpoint value: { through: 500, state: ... }
delta list:       ... 501, 507, 510, 518 ...

hydrate at P=510:
  read checkpoint visible at P
  read visible deltas after checkpoint.through through P
  apply deltas to privately owned state
```

```text
update, ONE command:
  read/derive from committed state
  append delta batch
  optionally set checkpoint including that batch
commit
publish the updated state
```

consumer 拥有 delta vocabulary、reducer 与 checkpoint cadence。Chord 的 delta machinery 是一个候
选，而不是在此决定的 storage dependency。Storage 不执行 plugin reducers。Checkpointing 只有在
其 cadence 得到维持时才会限制 replay；在仍然支持任意 historical forks 的情况下，它并不授权删除较
旧的历史。一个 live consumer 可以保留它的 current state；它不必在每次 edit 时都 hydrate。

### 4.6 Working state 是带有具名 lifetime 的普通 state

```ts
const work = workingScope(String(taskId));
const frames = list<Frame>("pi.pending.frames", { scope: work });
const checkpoint = value<Checkpoint>("pi.pending.checkpoint", { scope: work });
```

```text
working-only commit:
  append frame
  set checkpoint

main settlement commit:
  append immutable result assembled from working data
  settle task
  retireWorkingScope(work)
```

Working values/lists 在 restart 后仍然存活，直到显式 retirement。它们不是 transcript
entries、rewindable state，也不是一个单独的 scratch-storage API。Keys 区分不同的 attempts，因
此 recovery 不会把更早 request 的 frames 误认为当前 request 的 output。

```text
allowed commit: main writes, including retirement of working scopes
allowed commit: value/list writes in ONE working scope
rejected:       direct main + working writes, or writes in two working scopes
```

这让 JSONL 能把每个 batch 持久化到一个文件。Main retirement 是权威的；unlink 在此之后发
生。SQLite 可以在 main settlement transaction 内删除 working rows。

```text
crash before settlement → task and working data remain recoverable
crash after settlement  → result and retirement both exist; leftover file is invisible
close                   → no retirement
```

在 settlement 之前，停止接收来自该 execution 的 progress，并 drain 已经接收的 writes。Late
callbacks 必须被拒绝，而不是被允许重建已 retired 的 task data。Generic scope names 可以被有意重
用；retirement 结束的是旧的内容，而不是该名称未来所有的使用。Storage 永远不会从一个缺失的
task、task kind 或 owner status 去猜测 retirement。

## 5. Tasks

一个 task 是与一个 conversation 关联的 durable work。它的 definition 提供行为；它存储的 record
提供跨 process lifetimes 所需的 inputs、progress 以及最终 outcome。

### 5.1 Task records 与 lifecycle

```ts
type TaskRole = "ready" | "inflight" | "waiting" | "terminal";

interface Task<State = JsonValue> {
  readonly id: number;
  readonly conversationId: number;
  readonly kind: string;
  readonly status: string;
  readonly role: TaskRole;
  readonly state: State;
  readonly after: readonly number[];
  readonly foreground: boolean;
  readonly spawnedBy?: number;
  readonly ownedConversationId?: number;
}
```

Timing 与 cancellation metadata 在 §6 中加入。State 是经过验证的 JSON，而不是 promise、closure
或 process handle。External handles 必须有一个 recovery 能理解的 durable representation。

| Role | 含义 | 当被一个 drive 覆盖且未在本地执行时的动作 |
|---|---|---|
| ready | 一旦 dependencies 与 timing/permissions 允许即可执行 | Execute |
| inflight | External-effect intent 已被提交；outcome 可能未知 | Recover |
| waiting | 一个 child 或 external observer 提供下一个 transition | 在需要时恢复 observation |
| terminal | Immutable outcome | 无 |

一个 definition 把它的 statuses 映射到这些 generic roles：

```text
generation:
  pending, retry_wait, deferred → ready
  streaming, polling           → inflight
  done, failed, aborted        → terminal

job:
  planned                     → ready
  spawning                    → inflight
  running                     → waiting
  exited, killed, lost        → terminal
```

harness 在验证一次 write 时从 status 推导 role。Storage 持久化/索引那些 generic metadata，因此查
询 live work 时不必解码每个 historical task 的 state，也不必执行 kind code。Role 不能被独立编
辑。Terminal records 不接受任何后续 patches。

### 5.2 Definitions 是可替换的行为单元

```ts
interface TaskDefinition<State> {
  readonly kind: string;
  readonly initialStatus: string;
  readonly roles: Readonly<Record<string, TaskRole>>;
  readonly transitions: Readonly<Record<string, readonly string[]>>;
  validateState(value: unknown): State;
  execute(task: Task<State>, ctx: TaskExecution): Promise<void>;
  recover(task: Task<State>, ctx: TaskExecution): Promise<void>;
  abort(task: Task<State>, ctx: TaskExecution): Promise<void>;
}
```

TaskExecution 提供 execution signal、working scope 与 serialized command access。它的具体
surface 属于 §§6 与 9；它不是另一个 durable object。

```text
registry:
  "generation" → custom generation definition
  "tool"       → built-in tool definition
  "post_tools" → custom exchange policy
  "job"        → application process integration
```

当一个 definition 改变时，scheduler 不会改变。一个替代实现必须理解它 live tasks 所持久化的
statuses/state；不兼容的 durable formats 需要一次显式的 migration。未知的 live kinds 或无效的
live statuses 会在 execution 开始之前拒绝 restoration。

一个 task 按照它的 policy 处理普通的 provider/tool failures。Storage failures 与 invariant
violations 不是普通的 tool errors：它们会让 session fault，而不是被吞掉并无限重试。

### 5.3 Dependencies 意味着 terminal，而不是 successful

这些 traces 假设 T 有一个 ready-role status，并且它的 timing/permissions 允许执行。

```text
T.after = [A, B]

A running, B done    → T blocked
A failed,  B done    → T eligible
A aborted, B done   → T eligible unless T itself was cancelled
```

T 解释它所要求的 outcomes。scheduler 不会沿着 edges 传播 success/failure policy。被引用的
tasks 必须存在，且 dependency edits 必须保持一个有向无环图。Dependencies 停留在同一个
execution-ownership tree 内；独立的 forks 不会仅仅因为另一个 tree 引用了它们就变成可运行的。

```text
spawnedBy = who created this task       // provenance
after     = which tasks must settle    // execution dependency
```

这些是不同的。一个 generation 可以创建一个 collapse task 然后依赖它；那条 provenance link 不会造
成 dependency cycle。

### 5.4 一个 generation 原子地发布 tools 及它们的 join

```text
G returns assistant with calls [A, B]

ONE settlement command:
  append assistant entry
  create tool A
  create tool B
  create P = post_tools, after:[A,B]
  settle G

A settles its own result ─┐
                         ├─ P becomes eligible ─ { settle P; create G2 }
B settles its own result ─┘
```

每个 terminal command 还会记录已知的 usage，并在 working scope 存在时 retire 它。一个 tool 只
settle 它自己：不做 sibling inspection、queue draining 或 next-generation creation。P 拥有
exchange decision，并且即使两个 tools 都已 settle 也仍然保持 foreground。

```text
parallel:
  A; B; C; P.after=[A,B,C]

sequential:
  A; B.after=[A]; C.after=[B]; P.after=[A,B,C]
```

相同的 tools，相同的 join，不同的 dependencies。不需要 tool-specific scheduler lock。

```text
crash before G settlement → G remains live; normal recovery applies
crash after G settlement  → assistant, tools and P all exist
crash after last tool     → P already exists; no tail scan or successor repair
```

一个 final-answer generation 要么在它的 terminal command 中创建它显式的 continuation，要么结束这
条链。一个 idle 的 user-shaped context 不会通过推断来创建工作。

### 5.5 一次 durable wait 不是一个 task-lifetime 承诺

```text
DO NOT:
  create child task
  await child task's entire lifetime inside this effect

DO:
  commit dependency and continuation state
  return from this effect
  execute the continuation when its dependencies become terminal
```

一个委托给 subagent 的 foreground tool 可以复用它自己的 task：

```text
tool execute:
  ONE command:
    create subagent owner S
    set tool status=finishing, after=[S]
  return

S starts child conversation, then returns in waiting status
child final settlement also settles S
existing tool.finishing becomes eligible
  → read S's result
  → run result hooks
  → commit own tool result and terminal status
```

Recovery 使用已存储的 tasks/dependencies，而不是重建出来的 waitFor promise 链。在 cancellation
期间 join 本 process 对同一个 task 的当前执行是不同的；§6 定义了那个顺序，使得 effect 与 abort
handlers 不能并发写入。

### 5.6 Foreground work 与 detached background work

Foreground 是在工作被创建时选择的，而不是从 tool name 或 transcript tail 推断出来的。

```text
local foreground roots:
  generation, its tools, post_tools, automatic collapse

required foreground work:
  those roots + unfinished dependencies
  + required foreground work in their owned conversations

detached background work:
  other live tasks, such as background jobs, schedules and background subagents
```

一个被 foreground dependency 所需的 task 属于那个 required work，即使它不是作为 local
foreground root 创建的。要 detach 一个 launch，就返回它的 ID，而不是创建这样一个 dependency。详
细的 cancellation selection 定义在 §6。

```text
foreground launch:
  { create S; tool finishing after:[S] }
  parent exchange cannot finish until S supplies a result

background launch:
  { create S; tool result contains S.id; settle tool }
  parent exchange can finish while S continues
```

普通的 conversation abort 以 foreground/required work 为目标，而不是 detached background
work。public API 还需要取消一个被选中的 background operation 以及 all-background shutdown；这些
选择的是 cancellation scopes，而不是对 task status 的任意编辑。

### 5.7 Ownership 把一个 task 链接到一个 child conversation

```text
conversation A
  task S ── owns ──> conversation C
                      generation, tools, post_tools, ...
```

```ts
interface Conversation {
  readonly ownerTaskId?: number;
}
```

S.ownedConversationId 与 C.ownerTaskId 是互为对应的，并且一起 commit。Fork provenance 不建立
ownership。Child completion 在适当时在同一条 command 中 settle 它已有的 owner；它不依赖后续的
notification 来制造缺失的工作。

一个普通的 fork 没有 owner，也没有复制的 tasks。一个 task 可以原子地创建一个 child、初始化它所选
定的 state/context、追加它的 prompt 并创建它的第一个 generation。启动上述任一 effect 都会等到那
条 creation command 变为 durable。

### 5.8 每个 definition 必须规定什么

```text
creation      inputs/settings captured; initial status; foreground/dependencies
execution     durable intent before external work; bounded working-state writes
parking       persisted continuation/dependency/observer state; effect returns
settlement    output + usage + terminal state + successors + working retirement
recovery      retry/adopt/interrupted policy for every nonterminal status
cancellation  stop/join own execution; required result/cleanup; no normal successors
```

创建 successor 的普通 commands 在 commit 之前会重新检查当前 task status 与
cancellation。Task-specific cancellation 必须保留所需的结果 records，例如一个未执行 tool call
的 error result。没有任何 definition 可以依赖 scheduler 了解它的 domain semantics。

## 6. Scheduling 与 cancellation

scheduler 执行 durable task records。一次 drive call 选择允许在何处执行；它不创建工作，也不会成
为已经在执行的 tasks 的第二个 owner。

### 6.1 Generic scheduling metadata

```ts
interface Task<State = JsonValue> {
  readonly notBefore?: number;               // earliest execution time
  readonly requiredPermit?: string;          // optional host permission, e.g. deferred polling
  readonly abortRequested?: true;            // durable cancellation membership
}

interface DriveOptions {
  readonly permits?: readonly string[];
  readonly signal?: AbortSignal;             // cancels this caller's wait, not durable tasks
}
```

scheduler 测试的是一个 permit name，而不是某个 provider 的 polling semantics。一次 retry 会在已
有的 task 上存储一个 timestamp，而不是一个必须在 restart 后存活的 promise。

```text
ready to execute = ready role
                   + every after dependency terminal
                   + notBefore reached
                   + requiredPermit supplied by a covering drive
                   + not cancelled or already executing
```

### 6.2 Drive scopes 与 outcomes

```text
conversation.drive() → that conversation and descendants reached through task ownership
harness.drive()      → all independent conversation trees

fork provenance     → never expands a drive scope
```

重叠的 callers 共享一个 scheduler。Permissions 只在 caller 的 scope 内生效；针对一个 tree 的
polling permit 不得授权无关的 trees。

| Outcome | Conversation drive | Session drive |
|---|---|---|
| idle | 其 tree 中没有 required foreground work 或选定的 cancellation 剩余 | 任何地方都没有 live tasks |
| suspended | 仍有 work，但需要一个外部 event/permission | 相同 |
| closed | 在请求的条件达成之前 host 关闭了 | 相同 |

一个未来的 timer 是 local progress：等待它，而不是报告 suspension。一个已安装的 human 或
process observer 可以让 drive 保持 suspended。observer 可以 commit 它 task 的 outcome；后续的
task execution 再次需要一个覆盖它的 drive。

Foreground completion 以所请求的 conversation 为根：一个 detached child 内部的 foreground
tasks 不会让它的 parent 变为 busy。直接 drive 那个 child 确实会等待它自己的 foreground。一个
conversation drive 在 active 期间会服务 background tasks，但不会仅仅为了 detached work 而等
待。监督 background work 的 hosts 会 drive 这个 session，并在相关 external events 之后
resume。

### 6.3 每个 task 一个 execution claim

```ts
interface ExecutionClaim {
  readonly controller: AbortController;
  readonly promise: Promise<void>;
}
const executing = new Map<number, ExecutionClaim>();
```

这个 map 拥有实际的 executions，而不是已存储 tasks 的镜像。Waiting observers 及其 re-arm
markers 只存在于 live waiting phases；在 phase exit、settlement 或 close 时丢弃它们。从 live
task queries 与 ownership ancestor point reads 判断 scope membership，而不是遍历曾经创建过的每一
个已完成的 child conversation。临时的 ancestor lookups 可以在一次 pass 内共享，而不会变成一个永
久的 resident model。

```text
scheduler pass:
  read live tasks in covered scopes, using bounded indexed queries
  signal EVERY affected executing cancellation target
  reconcile cancellation targets under exclusive claims

  for each unmarked, unclaimed task:
    ready    → test dependencies/time/permit; claim and execute
    inflight → claim and recover
    waiting  → if not armed for this waiting phase: claim and recover to re-arm

  derive caller outcomes from committed state
  await commit | execution completion | next timer | outside notification
```

在 launch 之前先 claim。不要在 scan 内部 await 一整个 effect 之后才考虑下一个 task。Initial
execution 可以安装它的 observer；recovery 不得安装一个重复的。一个 waiting owner 如果其 child 会
提供 completion，则不需要 subscription，可以简单地标记 re-arming 完成。

Effects 与 observers 在写入之前在 command line 上重新检查当前 task status、cancellation 以及它
们 execution 的有效性。Events 会唤醒检查；它们不是 durable continuation messages。一个未改变的
ready task 不得在一次意外 exception 之后永远被重新 launch：报告它并让 handle fault。普通的
retry 属于一次已提交的 task transition。

### 6.4 Cancellation 先选择工作，然后 drive cleanup

```text
conversation.abort():
  select current required foreground work (§5.6)

conversation.abortBackground(taskId):
  require a detached background root in this conversation
  select it, unfinished dependencies, and all live work in their owned subtrees

conversation.abortBackground():
  apply that selection to detached background work in this ownership tree
```

background handle 是一个 task ID，但这是 scope cancellation，而不是把一个任意节点 terminalize 或
跳过其 cleanup 的许可。一个当前被 foreground work 所需的 task 不是 detached 的；对那条链使用
conversation abort。进一步的 dependency-sharing policies 仍然是一个 review point。

```text
ONE cancellation command:
  capture selected task IDs; mark every nonterminal target abortRequested
  for foreground abort, cancel currently queued steer/followUp in affected conversations
  keep context-only writes and nextRun input

repeated abort while the same foreground cancellation is outstanding:
  join existing cancellation; do not drain newly arrived input again
```

这些 marks 在 restart 后存活。不要因为更早的 tasks 已 settle 就缩小 selection。新的 foreground
input 会在 cancellation 未完成期间排队；normal successors 与 owned-child creation 不能逃出一个已
标记的 task。Background cancellation 还会阻止其已标记 owner 之下的新工作。

### 6.5 在调用一个 execution 的 abort handler 之前先 join 它

```text
for each marked task:
  keep/acquire ONE exclusive execution claim
  signal and await its current local execution, if any
  report its rejection; storage faults forbid further writes
  re-read committed task
  if already terminal: release claim
  otherwise: invoke definition.abort under the SAME claim
  release only after cleanup returns
```

在对一个慢的执行等待之前，先 signal 所有受影响的 executions。未启动的 tasks 可以在不等待它们正常
的 after dependencies 的情况下 abort。一个不配合的 effect 可以延迟它自己的 cleanup；一个
timeout 不得悄悄允许该 task 的第二个 writer。

一个已标记的 child-conversation owner 只有在它选定的 child work 变为 terminal 之后才
settle。scheduler 等待的是那个条件，而不是一个由 effect 持有的 child-lifetime promise。Child
completion 在发布 success 之前会检查 owner 的 cancellation mark。对一个 owned child 的直接
foreground abort 还必须把它的 owner 作为 cancelled 来完成。那个 child drive 可以在选定的 child
work 变为 terminal 之后完成对它已标记 owning task 的 cancellation，即使 owner record 在 parent
中。它不得启动其他 parent effects；parent-side continuation 需要一个覆盖 parent 的 drive。

```text
post_tools settlement wins:
  { settle P; create G2 } → abort selects G2

abort wins:
  { mark P } → P.abort settles without G2
```

Task-specific error/result records 仍然属于 task handlers。Cancellation 不会在 scheduler 中合
成 provider messages 或解释 tool arguments。

### 6.6 Open、close、shutdown 与 deletion

```text
open:
  open storage; validate live task definitions
  expose inspect(), state and transcript queries
  start no provider, tool or process effects

close:
  seal public/effect admission
  signal local executions; stop observers/progress admission
  wait for cooperative executions and admitted persistence
  release storage; write no cancellation or terminal outcomes

harness.shutdown:
  seal public admission but allow internal cancellation commands
  mark ALL live session work, including background and owned descendants
  cancel all queued inputs, including write/nextRun; preserve their immutable history
  drive selected cancellation to settlement
  close
```

Close 本身不添加任何 outcomes；在它的 barrier 之前已经被接收的 commands 仍然可以完成，包括
terminal settlements。它中断的是 local execution，而不一定是一个之后可以被 adopt 的 external
process。Shutdown 在支持的地方使用每个 kind 的 abort policy 来停止 external work。在 shutdown 期
间发生崩溃会为下一个 owner 留下 durable cancellation marks 去 reconcile。

Observer-wait cancellation 只移除那个 caller 的 drive interest；它永远不会把共享的 executions
signal 成好像这个 conversation 被 abort 了一样。Close 仍然是 cooperative 的，并且可能在一个损坏
的 external integration 上阻塞。Bounded-close/forced-process policies 需要一个显式的 host
contract。

删除一个 conversation 是一个单独的 atomic mutation：当它的 ownership subtree 有 live work 时拒
绝。一旦删除，就在那里拒绝新工作。保留 immutable history 以及独立 forks 所需的 source
metadata；logical deletion 不是擦除它们继承数据的许可。

## 7. Storage

一个 storage interface 回答 entity/state queries 并 commit atomic mutation batches。没有
public journal reader、单独的 read-index interface、scratch store 或 payload-address system。

### 7.1 存储 queries 所需的信息

用它的 historical source 与 context-replacement revision 补全 conversation snapshot：

```ts
interface Conversation {
  readonly source?: { readonly conversationId: number; readonly asOf: number };
  readonly inheritState: boolean;
  readonly prefixRevision: number;
}

interface Entry {
  readonly metadata?: JsonObject;             // small preview/attribution/exchange fields
  readonly key?: string;                      // optional indexed content key, not a state address
  readonly byTaskId?: number;
}
type EntryHeader = Omit<Entry, "content">;
```

Source links 限制 inherited transcript access。Historical forks 还会设置 inheritState=true；独立
初始化的 children 即使在继承 context 时也设置它为 false。Owner links 保持独立。Source 与
ownership identity 不是任意的 mutable configuration。

Current context 是 materialized 的。它的 historical edits 会被保留。Prefix replacement/reset
会 bump prefixRevision；append 不会。Task role、conversation ID 与 scheduling fields 无需解码
kind-specific state 即可查询。Entry metadata 允许在不加载大块 message/image content 的情况下进
行 exchange checks。

### 7.2 Queries，由 callers 驱动

| Caller | Required read | Must not do |
|---|---|---|
| Scheduler | 一个 scope 内的 live tasks；一个 batch 内的 dependency IDs | 加载 terminal task history |
| Generation | 当前的 context IDs，然后在一个 batch 中加载那些 entries | 通过扫描 transcript 重建 context |
| UI | 一个 ID 之前/之后的 transcript page，带一个 limit | 加载整个 conversation |
| Validation | 具名的 task/conversation records 与 entry headers | 加载无关的 message content |
| Fork | Entry commit boundary；historical context/state | 截断今天的 context |
| State consumer | 最新的 value/version；有界的 list range | 重放无关的 journal records |
| Background status | Task 与具名的 result entry | 让一个古老的 task 永远 resident |
| Reopen on SQLite | Live tasks 与所需的 conversations | 重放所有 historical task transitions |

Filters 在 limits 之前应用。Latest matching record 意味着一次 indexed descending query 且
limit=1，而不是加载一个 collection 再取它的最后一项。Conversation batch reads 与 entry、task
batch reads 同样重要。

```ts
interface CursorPage {
  readonly after?: number;
  readonly before?: number;
  readonly order?: "asc" | "desc";
  readonly limit: number;
}
interface Page<T> {
  readonly items: readonly T[];
  readonly asOf: number;
  readonly next?: number;
}
interface ConversationQuery extends CursorPage {
  readonly sourceConversationId?: number;
  readonly ownerTaskId?: number;
}
interface EntryQuery extends CursorPage {
  readonly conversationId: number;
  readonly kind?: string;
  readonly key?: string;
  readonly asOf?: number;
}
interface TaskQuery extends CursorPage {
  readonly conversationIds?: readonly number[];
  readonly live?: boolean;
  readonly role?: TaskRole;
  readonly kind?: string;
  readonly foreground?: boolean;
  readonly abortRequested?: boolean;
}
interface ListQuery extends CursorPage { readonly asOf?: number }
interface StoredValue<T> { readonly seq: number; readonly value: T }
interface ListElement<T> { readonly id: number; readonly value: T }
interface CommitBoundary { readonly first: number; readonly last: number }
```

Transcript queries 返回有效的 inherited prefix 加上 local entries；每个 entry 保留它原本的
conversationId。按那个 query 约定，tasks 永远不会被继承。Historical state 使用 §4 的 capped
source traversal。page cutoff 不是一个适用于每个 data class 的 generic timestamp：sticky state
与 task scans 暴露 current state，而不是 historical snapshots。Transcript/rewindable pages 携带
一个 main boundary；current task/sticky/working pages 携带一个 global observation cutoff，而它不
是 fork target。对 sticky/working addresses 的 historical reads 会被拒绝。一致的 current
multi-page reads 使用 command line；仅凭一个 cursor 不会冻结可变的 sticky contents。

### 7.3 一个 interface，没有第二层 transaction

```ts
interface Storage {
  readonly head: number;                       // global allocator high-water mark
  readonly mainHead: number;                   // last main commit, not another allocator
  commit(batch: CommitBatch): Promise<CommitBoundary>;

  getConversations(ids: readonly number[], asOf?: number): Promise<ReadonlyMap<number, Conversation>>;
  scanConversations(query: ConversationQuery): Promise<Page<Conversation>>;
  getEntries(ids: readonly number[]): Promise<ReadonlyMap<number, Entry>>;
  getEntries(ids: readonly number[], options: { content: false }): Promise<ReadonlyMap<number, EntryHeader>>;
  scanEntries(query: EntryQuery): Promise<Page<EntryHeader>>;
  getTasks(ids: readonly number[]): Promise<ReadonlyMap<number, Task>>;
  scanTasks(query: TaskQuery): Promise<Page<Task>>;

  getValue<T>(address: Value<T>, asOf?: number): Promise<StoredValue<T> | undefined>;
  scanValues(query: ValueQuery): Promise<ValuePage>;
  readList<T>(address: ValueList<T>, query: ListQuery): Promise<Page<ListElement<T>>>;
  close(): Promise<void>;
}
```

ValueQuery 是一个按 address key 排序的有界 scope/namespace scan；它的 cursor 是一个 address
key，而不是一个 numeric entity cursor。ValuePage 返回 addresses 及其当前可见的 values。没有任意
的 predicates、plugin reducers、user comparators 或 general SQL expressions 越过这个
API。State tokens 到达时已绑定它们的 conversation/working identity；scope-specific receiver
shapes 展示在 §9。

每一次 logical read，包括 ancestor traversal，观察一个已提交的 state。session command line 提供
一致的 multi-read operations 与 read-modify-write；不需要第二个 public storage transaction
callback。Historical context reads 影响的是 context，而不是 current sticky state。Tasks 即使在它
们来源的 entries 很旧时也保持 current。

### 7.4 Atomic mutations

```text
main mutation vocabulary:
  createConversation, deleteConversation
  appendEntry, createTask, patchTask
  appendContext, replaceContextPrefix, resetContext
  setValue, deleteValue, appendList, clearList
  retireWorkingScope

working mutation vocabulary:
  setValue, deleteValue, appendList, clearList
```

```ts
interface CommitBatch {
  readonly scope: "main" | { readonly working: string };
  readonly writes: readonly Write[];           // tagged mutations above; each has its final seq
}
```

```text
harness command:
  read committed state; construct mutations and IDs
  validate against committed state + earlier writes in this batch
  no mutations → return builder result without a storage commit
  otherwise persist one batch
  notify observers; resolve caller

storage commit:
  check scope, supplied sequences and structural constraints
  prepare only touched data/index changes
  persist atomically
  publish new query-visible state and heads together
```

Task definitions 验证 status transitions/state；harness 强制执行
ownership、dependency、context 与 admission 规则。Storage 存储经过验证的 generic records，而不运
行 kinds。被拒绝的 construction 不改变任何东西。一次被接收后的 failure 会让 handle
fault（§3.5）。在 persistence admission 之后取消一个 caller 不得放弃 transaction 或暴露半个
batch。

### 7.5 Memory 与 JSONL：相同的 queries，可选的文件

```text
current maps:  conversations, tasks, scoped values/lists
ordered data: entries per conversation, state versions, context edits
lookup maps:  IDs, addresses, live-task membership, source/owner relationships
```

Memory 应用准备好的 changes 而不暴露中间状态。Indexes 可以引用相同的 immutable payload
objects；它们不必复制 content。JSONL 使用那种 representation，并在 open 时完整加载它。

```json
{"first":100,"last":103,"writes":[
  {"type":"appendEntry","conversationId":1,"kind":"user","content":"Inspect"},
  {"type":"appendContext","conversationId":1,"ids":[100]},
  {"type":"setValue","conversationId":1,"namespace":"plugin.plan","value":true},
  {"type":"createTask","conversationId":1,"kind":"generation","status":"pending"}
]}
```

为了便于阅读而跨行展示；文件每个 batch 包含一个完整的行。这是说明性的 encoding，省略了
address/task fields。一个紧凑的 encoding 可以从 first+i 推导出每个已存储的 seq；logical writes
在 encoding 之前就已经携带了它们的 final IDs。

```text
JSONL commit → encode whole batch → write all bytes + newline → publish in-memory changes
JSONL open  → validate complete batches → rebuild maps/indexes → expose queries
```

在 write 完成之前不要 publish in-memory changes。处理 short writes。只丢弃一个未终止的 final
batch；格式错误的完整行会 fail open，而不是悄悄删除历史。

```text
session.jsonl                    main batches
session.scopes/<encoded-id>       working batches for one named scope
```

在 open 时，在 cleanup 之前从所有完整的 main/working batches 计算 global high-water。Main
retirement 通过它的 retirement seq 隐藏该 scope 的 records。之后的有意重用会存活下来；在重用之前
串行化旧的 unlink，这样延迟的 cleanup 就不能删除一个新的 lifetime。只有显式的 retirement 才授
权 cleanup。要求 process-crash durability；fsync/power-loss policy 是一个显式的 backend
option，而不是声称普通 writes 对 power loss 免疫。

### 7.6 SQLite：可查询的 rows，而非强制的 raw-journal replay

```text
conversations / current_context_elements
entries
tasks                                     // current records, including terminal outcomes
current_values / value_versions
list_elements / historical_clear_markers
context_edits
commit_boundaries / session_metadata
```

每个 shared-container key 都以 session ID 开头。建议的 indexed suffixes：

```text
entries             (conversation, id), (conversation, kind, key, id)
tasks               (role, id), (conversation, role, id)
values              (scope, namespace, key)
value_versions      (conversation, namespace, key, seq)
list_elements       (scope, namespace, key, id)
context_edits       (conversation, seq)
conversations       (sourceConversationId), (ownerTaskId)
```

Live scans 还需要 ordered partial indexes，例如 (session_id, id) WHERE role != 'terminal'，这样
跨 nonterminal roles 的扫描就不会对所有 task history 排序。额外的组合遵循实际的 query plans，而
不是为每一种可能的 filter 都建一个 index。

```sql
-- One local step in a rewindable scalar lookup.
SELECT seq, deleted, value
FROM value_versions
WHERE session_id = :session AND conversation_id = :conversation
  AND namespace = :namespace AND key = :key AND seq <= :cutoff
ORDER BY seq DESC LIMIT 1;
```

```text
BEGIN
  validate global head
  insert entry 100 with commit_end=103
  append context element 100; retain context edit 101
  insert rewindable value version 102
  insert current task 103 with indexed role
  record main boundary 103; advance global head
COMMIT
```

每次 append 不做完整的 transcript/context rewrite。Current context 可以使用 ordered element
rows；prefix replacement 移除被选中的 prefix 并插入它的 head，而不重写保留的 suffix。一个
historical fork 存储一条 source link 与它的 initial context，而不是 source entry 或 value/list
inventories 的副本。Sticky updates 覆盖当前 contents；working retirement 在 settlement
transaction 内删除 working rows。只保留 API 所承诺的那些 histories。

### 7.7 Historical context 不是今天的 context 减去后来的 IDs

```text
contextAsOf(C, P):
  start from latest reset <= P, otherwise C's initial context
  page later context edits through P in order
  append  → extend
  replace → replace named prefix, keeping the existing suffix
  reset   → replace whole list
```

一次 replacement 不是一个完整的 checkpoint：它对保留 suffix 更早的 appends 什么也没
说。Baseline replay 可能从 creation/reset 开始跨越；它是正确的，但对古老的 forks 不一定廉
价。Indexed context checkpoints 可以在之后优化它，前提是测量结果证明有必要。Current generation
requests 使用 materialized context，而不是这条 historical path。

## 8. 内置 task flows

这些是 task definitions 与 boundary policies，而不是 scheduler special cases。下面的花括号把一
次 main commit 分组。每一次 attempt outcome 都包含它报告的 usage；terminal outcomes 会 retire 它
们的 working data。Hooks 与 external calls 在 command line 之外运行。

### 8.1 Acceptance、placement 与 result ownership

提议的 input representation：使用一个 immutable admission entry 作为 input identity。Idle
input 可以直接是一个被选中的 user entry；busy input 在被后续的 placement entry 选中之前是
unselected 的。

```text
idle accept A:
  { user A with inline message; select A; G.inputs=[A]; result[A]=running }

busy accept B:
  { unselected input B with inline message; enqueue B; result[B]=queued }

later consume B:
  { user placement U referring to B; select U; dequeue B;
    create G2.inputs=[B]; result[B]=running }
```

placement 是新的，因此 context 保持 transcript 顺序。它的 message 从 B 的 immutable content 解
析，而不是复制到另一个已存储的 payload 中。Projection 会 batch-load 这样的
references；placement references 直接指向 admission entries，绝不是 placement 的链条。UI
rendering 可以区分 arrival 与 placement，而不是把同一条 message 显示两次。

Queues 在 conversation namespaces 下使用普通的 sticky values，每个 queued input 一个 address。不
同的 namespaces 标识 queue modes；固定宽度的 decimal input-ID keys 在有界的 key scans 中保持
numeric admission order。Dequeue 删除当前的 queue value；它不需要重写一个不断增长的 inbox
array，也不需要保留已消费的 queue rows。Session-scoped input-result values 独立于那个 queue 保留
每次 acceptance 的 outcome。

```text
G1.inputs=[A]
B queued while G1 runs
G1 produces final answer R

{ result[A]=done(R); settle G1;
  place B; dequeue B; G2.inputs=[B]; result[B]=running }

result(B) is NOT R just because R was appended after B's admission
```

在一个 tool boundary，新消费的 steering 加入当前 pending input group。一个 yield hook 的
continuation 也保留那个 group。只有完成的 answer/stopping boundary 才会 resolve 它。在 answer 之
后被消费的 follow-ups 会开始一个新的 group。若干 inputs 可以正当地共享一个 answer。把 input
IDs 贯穿 generation/post_tools state，而不是通过一个新的 durable run object。

```ts
type InputResult =
  | { readonly status: "queued" | "running" }
  | { readonly status: "done" | "placed"; readonly entryId: number }
  | { readonly status: "cancelled" | "failed" | "stopped"; readonly reason?: string; readonly entryId?: number };
```

Placed 是 context-only write 的 terminal receipt，而不是 assistant answer。取消一个 queued
input 会记录 cancelled；取消一个 active chain 会在 terminal boundary command 中 resolve 它
pending 的 inputs。Retrying/deferred tasks 让它们保持 running。Session-wide request keys 解析原
始的 admission；把一个 key 重用于另一个 conversation 或不同的 normalized semantic input 会被拒
绝。Harness 生成的 metadata 不属于 input equivalence 的一部分。

这个 representation/result contract 是提议供评审的。它避免了 chronological attribution、一张新
的 input table 以及重复的 message payloads；它确实为 queued input 添加了 placement records。

### 8.2 Queue boundaries

| Input mode | 何时可以被 placed | 会请求 generation 吗？ |
|---|---|---|
| write | 下一个 safe context boundary | 否 |
| steer | 下一个 tool 或 final-answer boundary；显式 idle acceptance | 是 |
| followUp | 正常的 final-answer boundary；显式 idle acceptance | 是 |
| nextRun | 仅下一个显式 idle acceptance | 是 |

```text
idle acceptance:
  place eligible queued items, then new input
  create ONE generation with all selected trigger IDs

post_tools:
  place safe writes and selected steering
  continue current input group unless cancelled/terminated

final-answer generation:
  if yield hook continues: retain current input group
  otherwise resolve current group with this answer
  eligible steer/followUp → place them and create next group/generation

failure/termination:
  resolve current group; do not consume triggers with no successor

foreground abort:
  cancel queued steer/followUp; preserve write/nextRun
```

Steering/follow-up modes 选择所有 eligible items 或每种 mode 中最旧的一个 item。在被选中的
items 之间保留 admission order。Safe write placement 永远不会变成一个隐藏的 run
request。Selection、placement、dequeue、result-state changes 与所需的 generation creation 共享一
次 commit。Queued input 优先于旧的 yield decision；陈旧的 hook preparation 会被丢弃。

### 8.3 Generation

```text
create:
  capture model, thinking, tools, provider options and retry policy
  persist inputs and pending status

pending/retry execution:
  check current status/cancellation and request/exchange exclusion
  completed captured collapse → interpret its outcome once; do not recreate it on every retry
  live collapse → attach dependency and return
  automatic collapse needed → create C and G.after=[C] together; return
  capture main historical context boundary; commit streaming intent
  project context; apply before_request; re-check execution validity
  call provider; persist frames under this attempt's working keys

outcome:
  calls        → { assistant; tool tasks; post_tools with inputs; settle G }
  final answer → { assistant; resolve/continue inputs; settle G; required successor }
  deferred     → { usage; same G.deferred(handle), requiredPermit="deferred-poll" }
  retryable    → { usage; same G.retry_wait, attempt+1, notBefore }
  overflow     → { usage; same G waiting on one captured collapse retry }
  failure      → { partial/error if needed; resolve inputs failed; settle G }
```

一个 generation task 在 preflight/collapse/retry 全程存在。Retries 不会用一个新的 budget 创建一
个替代者。Polling 在 fetch 已存储的 handle 之前记录 intent；另一个 deferred response 会更新同一
个 task。Transitions 会清除不再适用的 permit/timing metadata；一次正常的 retry 不得意外保留一
个 deferred-poll requirement。Poll permits 与 retry timestamps 保持为 generic scheduler
data。Known usage 即使在 failed、deferred 或 discarded attempts 上也会 commit；没有 report 意味
着 cost 未知，既不是零，也不是一个 exactly-once billing guarantee。

```text
recover polling   → deferred; retain handle and budget
recover streaming → committed partial: publish interrupted outcome + required call errors
                    no partial: retry within budget or fail
abort             → drain frames; best-effort provider cancellation; required partial/results;
                    resolve pending inputs cancelled; no tools or normal successor
```

Interrupted-stream policy 与 provider-specific retry/overflow classification 需要 parity
review。不要把 persistence/invariant failures 当作 provider errors 捕获。一个从未启动的
generation 没有编造出来的 assistant response。包含不可用/被截断 calls 的 stop reasons 仍然需要
error results，而不调用那些 tools。

### 8.4 Tool execution 与 post_tools

```text
tool execute:
  validate offered-tool authorization and arguments
  before_tool → allow | block | hold
  allow → commit running intent with effective args and replay policy
          invoke tool with execution signal, identity and bounded sink
  block/truncated/missing → prepare own error result without external invocation
  run after_tool outside line
  { own result; usage; active-tool additions; control intent; settle tool }
```

Registry presence 不是 authorization：generation 必须已经 offer 了该 tool。在 invocation 之前持
久化实际的 arguments/replay decision。普通的 throws 会产生 error results，而不是
cancellation。在 outcome 中捕获 terminate/handoff intent；tool 不会重置 context 或检查
siblings。Foreground delegation 使用 §5.5 中的 finishing phase。

```text
recover → replay only when captured AND current tool policy permit it;
          otherwise interrupted result from checkpoint, no uncertain control side effects
abort   → join own execution; drain working writes; own aborted error result
```

```text
post_tools, ONE command:
  require all calls terminal; re-check its cancellation
  read outcomes and choose exchange policy
  stopped → resolve current inputs stopped/cancelled; no successor
  continue → place eligible writes/steering; apply valid handoff; create G2 with inputs
  settle post_tools

post_tools.abort:
  { resolve its pending input group cancelled; settle post_tools }
  no context edit, trigger consumption or successor
```

一个 new_context tool 返回 handoff intent。join 会追加/选择那个 handoff，并且只有在 exchange 完
成之后才重置 context。普通的 errors 之后仍然可以跟随 generation。草案使用任何 terminate
request 来停止；冲突的 handoffs 会拒绝该 handoff，而不是选择 completion order。这些 policies 可
以独立于 join mechanism 进行评审。

### 8.5 Collapse，包括 speculative completion

```text
create C:
  capture complete prefix, through, prefixRevision, historical context and model/settings
  allow one live collapse per conversation; generation can depend on that existing C

execute:
  commit summarizing intent → call summarizer
  persist complete candidate, including reported usage, in working scope
  { usage; candidate reference/phase identifying that the attempt outcome was recorded }
  editable context + matching prefix → { summary; replace prefix; settle C }
  stale prefix/cancelled             → terminal outcome without context publication
  context busy                      → park C waiting for an editable-context predicate
```

parked task 会恢复一个 observer，它检查已提交的 context/request state，然后让 C ready 以便
publish。Events 只会唤醒那次检查。在 publishing command 中重新检查 prefix 与 editability；不要记
录两次 usage。

**不要等待一个 generation 的 terminal status 来让 context 变为可编辑：** 一次 retry 可以在等待
C 时让同一个 generation 保持存活。那会形成 deadlock。控制 speculative publication 的是 context
predicate，而不是 generation 的 lifetime。

```text
G retry_wait after:[C]   → no provider request in flight
C sees editable context → publish and settle
G becomes eligible      → retry with new context
```

Recovery 复用 durable complete candidate，或在 budget 内 retry。Abort 记录已知 usage 并在没有替
代者的情况下 settle。C 永远不会创建 G。Failed/declined overflow compaction 会结束有界的
overflow retry；threshold/manual failure 可以让 G 使用未改变的 context。

### 8.6 Subagent 与 approval

```text
subagent owner S:
  { child with owner=S; selected initial state; prompt; first generation; S waiting }
  return

child terminal foreground boundary:
  { its output/input outcomes; terminal child task; settle S with result reference }
```

对于 inherited subagent context，提议的 default 是 launching exchange 之前的最后一个
complete-exchange boundary，而不是它未 resolve 的 calls。选定的 initial values 仍然来自
creation command。这是 initialization，而不是一个声称某一个 state/context snapshot 的
historical fork。Recovery 会 drive 已有的 child tasks；它不会重建 child 或等待一个
child-lifetime promise。Cancellation completion 遵循 §6.5，并且不得为一个已标记的 owner 报告
success。

```text
hold tool:
  { create approval A; tool waiting after:[A] }

grant:
  { A granted; matching tool ready with approved arguments }

deny:
  { A denied; matching tool finishing with denial outcome }
  tool runs its result hooks, writes own result and settles
```

Approval recovery 会恢复 human decision surface；它永远不会自动 grant。Cancellation 独立地标记
approval 及其所需的 tool。Grant/deny 与 abort 是串行化的；迟到的 decisions 不能重启 terminal
work。

### 8.7 Jobs 与 schedules

```text
job:
  { spawning intent with durable adoption/log identity }
  spawn or reconcile existing process
  { running with verified process identity }
  install output/exit observers; return

exit:
  drain output → { immutable result; usage if reported; terminal job }
```

Recovery 会 adopt 同一个 process，或者如果它的 outcome 无法恢复就记录 lost。仅凭 PID 不是
identity。Abort 通过它的 host service 停止 process，drain output 并记录 killed。Close 会
detach local observation；一个可 adopt 的 external job 可以在它之后存活。Process launch/exit
reconciliation 与 log retention 是显式的 host capabilities，而不是 storage 的猜测。

一个 recurring schedule 需要一个稳定的 cancellation handle，而不是一串 successor IDs：

```text
schedule S ready at notBefore:
  { create action J; S collecting after:[J] }
  return

J terminal → S collecting:
  { record outcome reference;
    S scheduled with next notBefore and after:[], or terminal if complete }
```

action 可以是一个 job 或 subagent owner。S 仍然是 background root；cancellation 包括它未完成的
dependency J 与 owned work。Recurrence 与 missed-run policy 被持久化；正的 intervals 与有界的
catch-up 防止一次 restart 启动一个无界的 backlog。Recovery 使用已存储的 timestamp/dependency；它
在 collecting 期间不得创建第二个 J。Abort 在没有 recurrence 的情况下 settle S。被捕获的
cancellation marks 让它的 action/owned work 保持被选中，即使 S 先 settle；S 不会在 J 的
lifetime 期间持有一个 abort promise。

### 8.8 Hooks 是 preparation 或 observation，而不是另一个 scheduler

| Point | Decision |
|---|---|
| before_request | 转换已准备好的 request |
| after_response | 观察 provider outcome |
| before_tool | Allow、block 并给出 result，或 hold 以待 approval |
| after_tool | 处理/观察此 tool 的 result |
| on_yield | 停止或请求显式 continuation |
| before_collapse | Allow 并给出 instructions，或 decline |

在 command line 之外运行 hooks，然后在 commit 之前重新验证它们的 decisions。Hooks 可能在一次
crash 之后重复；external hook side effects 需要它们自己的 idempotence。Commit listeners 与
hooks 不同，不得在同一个 serialized line 上 await 另一条 command。

Hook ordering、transformation rights 与 exception policy 需要一个显式的 compatibility
decision；task chain 不会解决这些问题。Cancellation 会抑制 yield/normal successor creation，即使
一个 hook 已经在准备 continuation。

## 9. Public API 与 observation

前面的形态描述的是已存储的 snapshots 与行为。Handles 发出 commands；它们不是已存储的
conversation objects。这些草图组装那些 surfaces，而不需要第二个 state model，也不暴露 backend
layout。

### 9.1 Conversation 与 session handles

```ts
interface Accepted { readonly inputId: number }
type HistoryTarget = { readonly atEntry: number } | { readonly asOf: number };
type DriveOutcome = "idle" | "suspended" | "closed";

interface ConversationHandle {
  readonly id: number;
  snapshot(): Promise<Conversation>;
  accept(input: AgentInput, options?: { requestId?: string }): Promise<Accepted>;
  result(inputId: number): Promise<InputResult | undefined>;
  drive(options?: DriveOptions): Promise<DriveOutcome>;
  prompt(input: AgentInput, options?: { requestId?: string }): Promise<{ inputId: number; result: InputResult }>;

  appendMessage(message: AgentMessage): Promise<Accepted>;  // context only; may queue
  steer(input: AgentInput): Promise<Accepted>;
  followUp(input: AgentInput): Promise<Accepted>;
  nextRun(input: AgentInput): Promise<Accepted>;
  cancelQueued(inputId: number): Promise<"cancelled" | "already_consumed" | "not_found">;

  abort(): Promise<void>;                                  // durable intent; drive performs cleanup
  abortBackground(taskId?: number): Promise<void>;
  collapse(options?: { instructions?: string }): Promise<number>;
  resetContext(ids: readonly number[]): Promise<void>;
  fork(target: HistoryTarget, options?: { sticky?: Initialization }): Promise<ConversationHandle>;
  rewind(target: HistoryTarget, options?: { keepRunning?: boolean; sticky?: Initialization }): Promise<ConversationHandle>;
  spawn(options: SpawnOptions): Promise<number>;            // subagent owner ID; no effect starts here

  getValue<T>(address: ConversationValue<T>, asOf?: number): Promise<T | undefined>;
  setValue<T>(address: ConversationValue<T>, value: NoInfer<T>): Promise<void>;
  deleteValue<T>(address: ConversationValue<T>): Promise<void>;
  appendList<T>(address: ConversationList<T>, value: NoInfer<T>): Promise<number>;
  clearList<T>(address: ConversationList<T>): Promise<void>;
  readList<T>(address: ConversationList<T>, query: ListQuery): Promise<Page<ListElement<T>>>;
  command<T>(build: (tx: ConversationCommand) => T | Promise<T>): Promise<T>;
}

interface Harness {
  root(): Promise<ConversationHandle>;
  conversation(id: number): Promise<ConversationHandle | undefined>;
  conversations(query: ConversationQuery): Promise<Page<Conversation>>;
  inspect(): Promise<{ ready: readonly Task[]; inflight: readonly Task[]; waiting: readonly Task[] }>;
  drive(options?: DriveOptions): Promise<DriveOutcome>;
  entry(id: number): Promise<Entry | undefined>;
  entries(conversationId: number, query: CursorPage): Promise<Page<Entry>>;
  task(id: number): Promise<Task | undefined>;
  getValue<T>(address: SessionValue<T>): Promise<T | undefined>;
  setValue<T>(address: SessionValue<T>, value: NoInfer<T>): Promise<void>;
  deleteValue<T>(address: SessionValue<T>): Promise<void>;
  appendList<T>(address: SessionList<T>, value: NoInfer<T>): Promise<number>;
  clearList<T>(address: SessionList<T>): Promise<void>;
  readList<T>(address: SessionList<T>, query: ListQuery): Promise<Page<ListElement<T>>>;
  command<T>(build: (tx: Command) => T | Promise<T>): Promise<T>;
  command<T>(scope: WorkingScope, build: (tx: WorkingCommand) => T | Promise<T>): Promise<T>;
  watch(conversationId: number, options: { limit: number }, listener: (event: WatchEvent) => void): Promise<() => void>;
  decideApproval(taskId: number, decision: "grant" | "deny"): Promise<void>;
  deleteConversation(id: number): Promise<void>;
  shutdown(): Promise<void>;
  close(): Promise<void>;
}
```

AgentInput 是在 acceptance 时被 normalized 的 string/user-message/message-batch
input。AgentMessage 与 provider model/usage types 复用现有的 agent/pi-ai
boundary。Initialization 是 §4.3 中 typed 的 scalar selection/override shape；SpawnOptions 添
加 prompt 与 fresh/inherit context。这些是提议的 signatures，而不是 provider message types 的新
副本。Direct spawn 创建一个 detached owner；foreground tool delegation 通过它的 dependency 让那
项工作成为 required。

Prompt 接受 input、在观察该 input 的同时 drive，并在它 terminal 或 progress suspended/closed 时
返回它的 result。它永远不会用另一个 input 的 answer 来替代。Rewind 通常会在 forking 之前请
求/drain source foreground cancellation；keepRunning 不碰 source work。在 cancellation 之前验
证 target，这样一次无效的 history request 就不会 abort 本来有效的工作。

### 9.2 Commands 只有在 commit 之后才返回 results

Command 暴露 §7.4 的 mutations 与 read-only storage queries。Creation/list-append methods 在
builder 内部立即返回 final numeric IDs；outer command 只有在 persistence 与 publication 之后才
resolve。ConversationCommand 自动绑定 conversation。WorkingCommand 只暴露 value/list writes，并
针对一个精确的 scope ID 进行检查。

```ts
await conversation.command(async tx => {
  const current = await tx.getValue(plan) ?? false;
  tx.setValue(plan, !current);
});

const entryId = await harness.command(tx => {
  const id = tx.appendEntry(conversationId, "note", content);
  tx.setValue(labelAddress(id), "checkpoint");
  return id;
});
// entryId can escape here, not during the builder
```

Reads 看到的是 command 之前的 committed state；validation 按顺序应用 buffered
mutations。Buffer construction 不执行 external effects 或 publish plugin state。一个抛出异常的
builder 会丢弃它的 mutations。Runtime checks 补充 token typing，以用于 strict JSON、address
policy 与精确的 working-scope identity；改变一个既有 address 的 rewind policy 不是一次隐式的
migration。

### 9.3 Task 与 tool 集成

```ts
interface TaskExecution {
  readonly signal: AbortSignal;
  readonly workingScope: WorkingScope;
  readonly services: TaskServices;
  command<T>(build: (tx: Command) => T | Promise<T>): Promise<T>;
  command<T>(scope: WorkingScope, build: (tx: WorkingCommand) => T | Promise<T>): Promise<T>;
  observe<Event>(
    subscribe: (notify: (event: Event) => void) => () => void,
    reconcile: (event: Event | undefined, ctx: TaskExecution) => Promise<void>,
  ): void;
}

interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;                 // provider-compatible JSON Schema
  readonly replay?: "safe" | "never";
  execute(args: JsonObject, ctx: ToolExecution): Promise<void | ToolDelegation>;
}
```

TaskServices 提供 models、registered tools、hooks 与 host resources。ToolExecution 提供
invocation/call identity、signal 以及使用普通 working values/lists 的有界
output/checkpoint/memo access。tool schema 在 invocation 之前验证 arguments。ToolDelegation 标识
一个 subagent/job launch 以及 foreground/background 选择；它不包含 in-process promise。

```text
tool output surface:
  write text / add image       → durable bounded progress; capped final result
  set details / report usage   → final result/attempt metadata
  addTools / terminate / handoff → control intent interpreted at settlement/boundary
  checkpoint / typed memo      → ordinary working values, retired with that execution
```

Output backpressure 必须是显式的：await 已接收的 progress，或使用一个在 settlement 之前被
drain 的有界 buffer。Delta frames/checkpoints 不得为每一个 token 悄悄重写一整条不断增长的
assistant message。Caps、image handling 与 durable log references 是 tool policy 的一部分。

Observe 安装的是一个 live-phase subscription，而不是另一个 executor。每次 reconciliation 在
effects/recovery/abort 所使用的同一个 per-task claim 下接收一个新的 execution context/signal。在
一次 event=undefined 的 initial reconciliation 之前先注册，这样一个已经满足的条件不会被丢
失。在 claim 期间到达的 events 会在一个有界 policy 内 queue/coalesce。Phase exit/cancellation
会 seal 并 drain 已接收的 callbacks。一个陈旧的 callback 不能通过一个过期的 context 写
入。Waiting recovery 恢复缺失的 subscriptions，而不是重复的。Teardown 与 settlement 是不同的。

### 9.4 无间隙地 watch committed state

```text
ONE serialized step:
  capture main/global observation boundaries
  read conversation, bounded transcript page, live task metadata,
       queued-input state and requested reduced working previews
  register listener

then:
  deliver relevant main commits as whole batches
  deliver committed working previews and transient notifications separately
```

```text
base    { conversation, entries, referencedInputs, tasks, queued, previews, asOf }
commit  { firstSeq, lastSeq, changes:[...] }
preview { taskId, kind, value }
signal  { kind:"fault" | "handler_error" | "idle", ... }
```

这个 union 就是 WatchEvent。Entry pages 使用 immutable IDs 与一个 cutoff 来做
deduplication。Commit filtering 可以省略无关的 changes，但必须保留 batch boundaries；clients
在 reduce 完整交付的 batch 之后 publish。一个 terminal task 及其 successor 不得表现为一个可观察
的 idle gap。

把可见 placement entries 所引用的 admission payloads batch-load 进 referencedInputs；它们不必表
现为额外的 transcript rows。任意的 plugin state 由它显式的 state consumer 来 hydrate，而不是由
transcript watch 自动完成。一个 commit listener 不能在同一个 line 上 await 一条新 command；把它
安排在 delivery 之后。Listener exceptions 不会撤销 commits。Slow-consumer buffering 是有界的；一
个 disconnected/lagging client 可以从一个新的 base 重新绑定。

如果一个 Chord adapter 需要连续的 revisions，那些属于它的 live binding：

```text
main commits 104, 117, 130 → binding updates 1, 2, 3
rebind/rewind              → fresh base, update counter starts again
```

Journal gaps 不是 transport gaps。不要持久化另一个 state-sequence allocator。adapter 只有在
durable commit 之后才 publish，并拒绝来自已 retired bindings 的 events；它的具体 codec 与
private-draft integration 仍有待选择。

### 9.5 端到端用法

```ts
const h = await Harness.open(storage, hostOptions);
const c = await h.root();
const off = await h.watch(c.id, { limit: 100 }, render);

const accepted = await c.accept("Inspect the parser", { requestId: "web-42" });
const outcome = await c.drive();
const result = await c.result(accepted.inputId);
if (result?.status === "done") show(await h.entry(result.entryId));
// suspended: wait for the needed event/permission, then drive again
```

```ts
// Cancellation is durable intent; keep or start a drive for cleanup.
const driving = c.drive();
await c.abort();
await driving;
await c.drive();                              // also covers a previously idle/suspended drive

const child = await c.spawn({
  prompt: "Inspect only tests",
  context: "fresh",
  values: { inherit: [model], set: [setValue(activeTools, ["read"])] },
});
await h.drive();                              // supervise detached work too; may suspend on outside events
console.log(await h.task(child));

const alternate = await c.fork({ atEntry: completedAnswerId });
await alternate.accept("Try a different implementation");
await alternate.drive();                     // source and unrelated forks remain parked

off();
await h.close();
```

Harness.open 接收 storage、task definitions、tools/model services、hooks/resources 与 initial
root values。它只为空 storage 创建 root 加上 initial values。重新打开已有 storage 不会创建新工
作。Host invocation cancellation/telemetry 应当贯穿这些 calls，而不是被替换为一个单独的
tracing 或 cancellation framework。

## 10. Validation、performance 与 review decisions

这是一个设计，而不是对实现或 benchmark parity 的声称。Tests 应当从 committed state 证明行为，然
后 benchmarks 应当在所选定的 guarantees 下测量等价的工作。

### 10.1 从同一个 mutation stream 进行 Backend conformance

```text
validated batches ─┬─ reference replay used only by tests
                   ├─ Memory
                   ├─ JSONL → close → reopen
                   └─ SQLite → close → reopen

compare:
  current objects and generic live-task metadata
  transcript pages and inherited prefixes
  historical contexts, scalar tombstones, list clears/ranges
  input/request mappings and result outcomes
  visible working lifetimes and next allocated sequence
```

Reference replay 是一个 test oracle，而不是一个必需的 public storage API。使用随机的小
histories 与显式的 deep-fork cases。包含 value-only commits、multi-entry commits 与
independent child initialization，这样仅针对 message 的 tests 就不会意外地让一个损坏的 history
implementation 通过。

```text
fork before/after a value delete → correct absence/fallback
fork before/after list clear     → correct inherited ranges
fork before a later summary     → earlier context, not today's filtered context
nested source cutoffs            → no later ancestor version leaks
sticky state                    → unchanged by historical reads; explicit copy on creation
```

### 10.2 Failure 与 concurrency matrix

| Scenario | Required observation |
|---|---|
| Persistence paused after construction | Queries/watchers 仍然看到旧的完整 state |
| Commit durable but caller reply lost | Reopen 看到整个 batch；keyed retry 复用该 input |
| Main + working writes in one batch | 拒绝且没有部分 mutation |
| Torn final JSONL batch | 只丢弃那个不完整的 tail |
| Malformed complete JSONL batch | Fail open，绝不悄悄截断有效的后续 history |
| Retirement committed, unlink fails | 旧的 working contents 保持不可见 |
| Reused scope, delayed old cleanup | 新的 lifetime 存活 |
| Effect returns while abort starts | 一个 claim 覆盖 effect join 与 abort reconciliation |
| Parallel tools settle in either order | 已有的 join 变为 ready；恰好一个 continuation |
| Abort versus join/final settlement | 没有未标记的 successor 逃出所选定的 cancellation |
| Child finishes during owner cancellation | 没有 success outcome 覆盖 cancellation |
| Observer notification during close | 按 admission order drain/reject；没有迟到的 terminal overwrite |
| Two overlapping drives | 每个 task 一个 execution；permissions 保持 scoped |
| One drive caller cancels its wait | 其他 callers 与 durable task intent 不受影响 |
| Queued B precedes A's answer in transcript | B 保持 pending 直到它自己的 group 完成 |
| Provider retry while collapse waits to publish | 没有 generation/collapse dependency deadlock |
| Watch registration races a commit | Base 包含它，或 stream 交付它，绝不会两者都没有 |

使用 faux providers、fake processes/clocks 与 storage barriers。不使用真实的 providers 或付费
tokens。对两种 durable orders 都进行测试，而不是一个恰好每次都赢得同一个 race 的 test。验证
failed/no-op commands 不消耗 IDs，并且旧的 task IDs 在 compaction 之后仍然可查询。

### 10.3 Performance measurements

```text
workloads:
  many short turns, with/without tools
  frequent compaction plus cold reopen
  parallel/sequential tools and held approvals
  large streaming output/checkpoints
  deep forks and repeated historical state reads
  many completed child conversations, few live tasks
  many genuinely live background tasks
  queued input, cancellation and result lookup

measure separately:
  CPU user/system time; wall latency distributions
  process RSS, heap, external/array-buffer memory; peaks and post-GC retained size
  actual main/sidecar/database/WAL/auxiliary-file bytes
  query count, rows decoded, logical mutations and physical bytes written
```

在两个 implementations 上使用相同的 provider messages、tool output、frame cadence、compaction
boundaries、hooks、durability mode 与 observation workload。Warm-up 与 measurement
instrumentation 必须具有可比性。包含 final contract 所要求的 fault handling costs，而不仅仅是一
条 happy-path spike。

Memory/JSONL history 增长是预期的。SQLite 应当避免 full-history JS copies。在每一种情况下，在声
称任何关于 harness working set 的结论之前，先把 backend-owned data、live execution data 与
faux-provider/test bookkeeping 区分开。在报告 total process use 时不要隐藏 backend memory。

导出的 pico2 spike 报告在 2,000 个 faux turns（每 turn 两个 tools）上，lane harness 为 9.7 s
对 35.9 s。这驱动了调查，而不是这个设计的一个经过验证的结果。它的 four-way test 测量 wall time
与 serialized main-mutation character counts；pico2 scratch 与 usage writes 绕过了那个
counter。该 export 没有 SQLite implementation。它的 projection cache 还意味着 timing
difference 不能仅仅归因于 storage interfaces。

有用的教训是廉价的 current/live queries、batched ID reads、小的 mutations，以及在常规执行上避
免 history scans——而不是采用它的 types、residency machinery 或不安全的 shortcuts。

### 10.4 实现之前需要评审的 decisions

| Decision | 当前 proposal / 剩余工作 |
|---|---|
| Historical position | Entry 选择它的整个 commit；拒绝不完整的 exchange targets（§3.3） |
| Sticky conversation inheritance | 只复制显式选中的 current scalars；lists 需要一个经过深思的 policy（§4.3） |
| State/list vocabulary | Set/delete 与 append/clear；structured edits 作为 deltas，而不是任意的 mutable-list operations |
| Input identity and results | Admission/placement entries 加上普通的 result values 与 input groups（§8.1）；最终确定 normalization/queue policies |
| Background dependency sharing | Required dependencies 加入 foreground cancellation；评审与先前 detached work 的交互 |
| Recovery and shutdown | Cooperative close；显式的 external adoption/idempotence 与有界的 host policies |
| Compaction | 先做正确的 historical replay；评审 checkpoints、token budgeting 与 oversized/split turns |
| Hooks and tool policy | 确认 transformation/error rules、effective arguments、termination aggregation 与 conflicting handoffs |
| Observation/replication | 最终确定 bounded buffering、requested-state hydration 与 Chord adapter/codec boundaries |
| Backend details | 具体的 schema/query plans、snapshot ownership 与 power-loss policy；没有推断出的 crash guarantees |
| Old-harness capabilities | 针对 provider options/cache behavior、telemetry、usage adjustments、navigation/import 与 host context 的显式 parity decisions |

不要因为更小的 core 没有提到某个既有 capability 就悄悄移除它。在实现那部分之前，决定它属于一个
task、一个 host integration，还是 public contract。下一步是针对这个设计的反馈，而不是把导出的
spike 复制进 repository。
