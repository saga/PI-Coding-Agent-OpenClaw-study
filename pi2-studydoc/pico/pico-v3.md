# pico v3

一个针对 agent harness 的设计：session 如何被存储、工作如何被调度，以及内置
agent 行为如何由这些组合而成。本文档中的代码用于说明该模型；它不是 package
export。在代码片段中，`call` 是当前的 `Call`（Chord Context，§6.5），在异步的
public/runtime 操作上是必需的；`runtime` 是 task/tool 能力对象。transaction
builder 不接受另一个 Call。

## 1. 目标

**概念少，行为可替换。** 一个 session 就是 conversations、不可变 entries、持久
tasks 与 scoped state。Agent 行为（generate、run tools、compact、delegate）以
task kinds 的形式编写。scheduler 理解 task 生命周期、依赖与取消，对 prompts 或
summaries 一无所知。Storage 理解对象与原子批次，对 tasks 一无所知。替换一个 task
kind，你就改变了行为；scheduler 与 storage 保持不变。

**每个 session 一个 writer。** 执行是并发的；写入不是。每一次 mutation，包括
working-state 写入，都经由一个 owner，它一次只运行一个 commit。一个 commit 读取
已提交的 state，构造其写入及其 id，把它们作为一个批次提交，然后发布。不同的
sessions 可以有不同的 owners，并共享一个 SQLite 文件。崩溃之后，一个新的 owner
从持久 state 恢复；它绝不能与旧的 owner 并行运行。

**持久工作，显式 recovery。** 被接受的工作能在崩溃后存活，包括尚未开始的工作。打
开一个 session 不启动任何东西。一个 task 在做任何外部事情之前先记录它的 intent，
并把 outcome 连同接下来应当发生的事情一起提交。中途的崩溃留下的是不确定性，而不
是"什么都没发生"的证明；每个 task kind 自行决定如何 recovery：retry、adopt，或报
告 interruption。没有任何东西承诺 exactly-once 的外部 effects。

**没有 residency 层的长 sessions。** 旧的 entries 和已完成的 tasks 可查询，但绝
不因为曾经被看到过而被保留。常规执行读取当前 context 与 live tasks；它从不扫描累
积的历史。后端使用什么内存是后端的选择：memory 与 JSONL 保留所有已加载的内容；
SQLite 只保留查询返回的内容。

**度量。** 在每种 harness 与后端上跑相同 workload：CPU、进程内存、磁盘上的字节数
（包括 sidecars）。小写入、带索引的读取、批量查找。更快的原型是去看一看的理由，
而不是证明它的捷径应当属于这里的证据。

## 2. Conversations

一个 session 持有 conversations。一个 conversation 有三样东西：

- 一个 **transcript**：一个仅追加的不可变 entries 列表（messages、tool results、
  summaries、plugin 定义的 entries），即实际发生过的事情；
- **tasks**：作用于它的持久工作单元，例如一次 generation 或一次 tool call，每
  个都有一个随运行而变化的 status（§5）；
- **state**：plugins 与 harness 读写的有键值与 lists，例如正在使用的 model 或
  一个 plan-mode 标志（§4）。

model 看到的东西，即 context，由一条固定规则从 transcript 推导而来。Tasks 与
state 本身从来不是 model 输入。

### 2.1 Entries 及其 kinds

```ts
type Id = number;                  // a session sequence number; one alias so the representation can change

type ContextEdit =
  | { readonly target: Id; readonly action: "omit" }
  | { readonly target: Id; readonly action: "replace"; readonly messages: readonly Message[] };

interface EntryIdentity {
  readonly id: Id;                 // its sequence number
  readonly conversationId: Id;
  readonly kind: string;
  readonly byTaskId?: Id;          // which task wrote it
}

interface EntryBase extends EntryIdentity {
  readonly key?: string;           // optional indexed key, e.g. the tool call a result answers
}

interface EntryData<Data extends JsonValue = JsonValue> {
  readonly data: Data;             // kind-specific durable data; never model input by itself
}

interface ModelProjection<Model extends Message = Message> {
  readonly model: readonly Model[]; // provider-neutral messages materialized at append
}

interface ContextHead {
  readonly head: Id;               // first retained transcript entry, inclusive
}

interface ContextEdits {
  readonly edits: readonly ContextEdit[];
}

type Entry = EntryBase & Partial<
  EntryData & ModelProjection & ContextHead & ContextEdits
>;

type UserEntry = EntryBase & ModelProjection<UserMessage>;
type AssistantEntry = EntryBase & ModelProjection<AssistantMessage>;

interface SummaryData { readonly summarizedThrough: Id }
type SummaryEntry = EntryBase & EntryData<SummaryData> & ModelProjection<UserMessage> & ContextHead;
```

facets 会组合。一个 user entry 可以只是
`EntryBase & ModelProjection<UserMessage>`；一个 tool result 还可以为其 renderer
携带非 message 的 `EntryData<ToolResultData>`；一个 summary 有 data、一个 model
projection 和一个 head；一次 reset 只需要一个 head。Entries 追加，且绝不被 patch、
重排或重新编号。Ids 按 transcript 顺序递增，但不必连续。

`model` 是 writer 所选择的、精确的 provider-neutral message projection。它不是最
终的 provider 请求：context 选择、edit folding、tool-exchange normalization 与
provider 转换仍然按请求发生。`data` 是可选的、任意的 kind-specific JSON，用于
typed 逻辑与渲染。没有任何东西隐式地从一方推导出另一方，因此同时存储二者永远不需
要复制一条 message。

一个 entry kind 只是一个名字与类型见证：

```ts
interface EntryKind<E extends Entry = Entry> {
  readonly kind: string;
  is(entry: Entry): entry is E;
}
```

一个 plugin 通常把 append-time 构造放在一个 typed helper 里。它可以在调用
`Tx.entry` 之前从自己的 data 计算出 `model`、`head` 和 `edits`，但这样的计算既不
会注册到 kind 上，也不会在读取时运行。异步输入在进入 commit line 之前就已准备好。

存储的 `head` 是包含式的第一个被保留 entry id。该列的存在把该 entry 标记并索引为
一个 head。`Tx.entry` 为 reset 与 handoff 草稿接受 `"self"`，并存储铸造出的
entry id。每一个新 head 必须满足：

```text
newHead.head >= previousVisibleHead.head
```

commit line 直接从存储的 entries 验证这一点。一个 head 不能把 context 向后移动。
它的边界也不得切开一个 exchange，无论谁追加它：compaction 遵循同一条规则（§2.3），
该规则被应用到 plugin heads 上，因此一个 head 永远不能让 tool results 失去它们的
call。较旧的 heads 是控制项，不是被保留的 context entries：最新的 head 取代它们，
并携带它仍然需要的任何前驱 summary 信息。

存储的 `edits` 省略或替换较早可见 entries 的 model projection。任意 edits 不得以
受管理的 `system` entries 为目标：它们可能使 model instructions 与规范的
prepared section state（§8.2）不一致，因此 commit 会拒绝。唯一的例外是
generation preparation 追加一个完整的新鲜 baseline，并带有对被取代的受管理
baselines/deltas 的 omission edits。那些控制项及其替换指令一起提交（§8.2）。
Edits 按 transcript 顺序折叠；针对某个 target 的最新适用 edit 胜出。target entry
永远不被改动，而 target 落在所选范围之外的 edit 是一个 no-op。被保留的 edit
entries 在后续 turns 上会再次生效。Tool-result pruning 与 shortening 都是 edits。
"总是只保留最近 N 个 exchanges"这类动态策略不受支持；当 context 应当改变时，代码
追加一个新的 head 或 edit。没有 `compose` 回调，也没有 read-time 的 entry-kind
行为。

内置的有 `user`、`assistant`、`tool_result`、`system`、`notice`、`summary`、
`handoff` 与 `reset`。它们的 writers 在追加时物化 model messages。`reset` 不存储
model；`handoff` 存储其 message 并开启一个 context；受管理的 `system` entries 存
储在其 transcript 位置上准备好的、精确的 pi-ai `SystemMessage`。它们记录的是规范
的 prepared instructions，而不是某个 provider 收到了它们的证明。Pi-ai 拥有
provider 转换与 best-effort 的 cache 保留；仅靠不可变 entries 并不保证 wire
prefix 不变：

```ts
type SectionChange =
  | { readonly key: string; readonly action: "set"; readonly value: JsonValue; readonly rendered: string }
  | { readonly key: string; readonly action: "remove" };

interface SystemData {
  readonly baseline?: true;              // complete prepared section state (§8.2)
  readonly sections?: readonly SectionChange[];
}

type SystemEntry = EntryBase & EntryData<SystemData> & ModelProjection<SystemMessage>
  & Partial<ContextEdits>;               // fresh baseline may omit superseded managed entries
```

一个 baseline 把完整有序的 section state 存储为 set records。一个 delta 存储变更
的 sets 与显式 removals。Payloads 是 JSON；null 是合法的 payload，不是删除。
`rendered` 是最终的 section text，因此缺失的 renderer 永远不会妨碍 replay 或构造
一个新鲜 baseline。按 key、payload 与 rendered text 做 diff；仅重排不产生任何输
出。仅 payload 的变化仍然持久化一个 section-state delta，但不需要 instruction
message（`model: []`）。Rendered 变化与 removals 会产生物化的 system messages。
绝不要解析散文来重建 section state。

完整的 tool definitions 只存储在 SystemMessage 的 `toolsAdded`/`toolsRemoved` 字
段中，不在 `data` 中重复。Added definitions 是按 name 的 upserts，包括同名
schema 变更；removals 包含先前的完整 definitions。在 additions 之前应用 removals。
Section 与 tool names 在各自的 change lists 中唯一；结构化比较忽略偶然的 JSON
object-key 顺序。当 model 不应看到 plugin 定义的 entries 时，它们省略 `model`。
kind 负责类型化读取与写入；存储的对象在 wire validation（§7.3）之后即被信任，而
改变其 data shape 的 kind 会附带一个 migration。

```ts
type ToolResultEntry = EntryBase & EntryData<ToolResultData> & ModelProjection<ToolResultMessage>;
const toolResultKind = defineEntryKind<ToolResultEntry>("tool_result");

tx.entry(toolResultKind, conversationId, { data: resultData, model: [message], key: callId });
const e = await harness.getEntry(summaryKind, id, call);                  // SummaryEntry | undefined
const any = await harness.getEntry(id, call);                             // Entry | undefined
if (summaryKind.is(any)) any.data.summarizedThrough;                // narrowed
```

没有 kind 时，一次读取返回未类型化的 entry。对另一个 kind 的 typed 读取返回
`undefined`，与 entry 缺失时相同；批量读取会省略它。session 记录不同的 kind 字符
串，而无需扫描 entries。Open 报告未注册的 entry kind 但不拒绝：存储的 `model`、
`head` 与 `edits` 保留 context，只有 kind-specific 的类型化与渲染不可用。

### 2.2 Context 是推导出来的，而非存储的

generation 从 transcript 推导 context：

```text
H       = newest entry with stored `head` visible at the request/fork target
from    = no H → transcript start; otherwise H.head
range   = fork-aware transcript entries from `from` through target, inclusive
controls= fold stored `edits` in transcript order
context = no H → eligible range entries
          H exists → H, then eligible range entries excluding every head
          omitted targets disappear; replaced targets keep their id and use replacement messages
messages= concatenate stored `model` arrays; normalize tool exchanges for the selected model
```

没有 `model` 的 entry 不贡献任何 messages。一个 edit entry 可以独立地拥有一个
model projection。既有的 tool results 按 call 顺序与它们的 calls 放在一起。对于
一个成功的 assistant 在其所有 results 之前被切断的情况，request-local 的 pi-ai
转换会补齐缺失的 results；超出 fork cutoff 的 results 以及 source tasks 永远不会
被继承。Error/aborted 的 assistant 输出被排除在后续请求之外，且永远不会创建 tool
tasks/results。

不存储任何 context list，因此没有任何东西会与 transcript 发生漂移。一个
conversation handle 保留一个可选的 process-local cache，缓存当前推导出的 entries、
candidate membership 与 winning edits。`contextEntries(through)` 加载它一次，用
其 cursor 之后的 entries 追赶它，在新 head 到来时从存储的边界切片，并折叠存储的
edits。Generation tasks 接收那个 handle；`ConversationView` 暴露由此得到的
context ids。比 cache 更旧的历史 target 会被单独推导，且不会回退它。每个请求接收
一个不可变 snapshot。

在一个冷 handle 上，成本是 fork-aware 的候选范围加上 edit folding 与 fork depth，
而不必是最终 projected-message 的数量。Memory 与 JSONL 从它们的内存索引作答；
SQLite 执行带索引的 head/range 读取。热 handles 只处理追加的 entries。cache 是
handle 拥有的便利设施，可以随它一起被垃圾回收；transcript 才是真相。Generation
preparation 持久化 `state.requestThrough`，并在完整批次持久化后的那一行捕获其
effective context snapshot（§8.2）。snapshot 复制所选的 reference 数组，而不是不
可变的 entry bodies。后续的 cache 更新永远不变更那个数组或其 effective
replacement projections；request-local 的 normalization/hooks 复制它们所修改的内
容。历史 cutoff 的重建不会回退 live cache，且仅请求使用的 references 在使用后被
释放。

### 2.3 Compaction 与 reset

**Compaction** 追加一个带存储 model projection 与 head boundary 的 summary：

```text
transcript  [10 user, 20 asst, 30 user, 40 asst]         context [10, 20, 30, 40]
append      50 summary { model:[summary], head:30 }
scan        [30 user, 40 asst, 50 summary]
context     [50 summary, 30 user, 40 asst]
```

这个 summary 比 30 和 40 更新，但在它们之前投影。被摘要的前缀必须结束于一个完整
的 exchange，位于当前 context 之内，并包含前一个 head 的信息。跨 head 被保留的受
管理 system entries 由下一个 prepared baseline 显式取代（§8.2）；这不会切开被保
留的 tool exchange，也不会给通用 projection 添加隐藏的过滤。一个针对旧 context
准备的 summary 仍可能稍后落地：在它运行期间追加的普通 entries 位于其 prepared
retained boundary 处或之后，因而留在范围内。只有竞争性的 head 会使它失效；其间的
context edits 不会（§8.4）。

**Reset** 追加一个带 `model` 的 `handoff` head，或不带它的 `reset` head。两者都
向 `Tx.entry` 传入 `head: "self"`，它把新 entry id 存储为边界。transcript 保留一
切。Reset 本身既不取消 tasks，也不请求响应。

### 2.4 Forks 共享历史，但不共享未来的变化

一个 fork 是一个新的 conversation，其 transcript 起初是其 source 的一个前缀，按
引用共享：下面 entries 10 和 20 保留它们的 ids 与其所属的 conversation；没有任何
东西被复制。

```text
A: 10 ─ 20 ─ 30 ─ 40 ─ 50 ─ 70
          └──────────── 90 ─ 100     B, forked at 20
B transcript: [10, 20, 90, 100]
```

因为 context 是从 transcript 推导的，B 的 context 就是 A 的 context 在 fork 点时
的样子：`[10, 20, ...]` 中最新的 head 就是当时存在的那个，而 A 后来添加的任何
head 都不可能被看到。A 中后来的 appends、compaction 与 resets 无法影响 B。Live
tasks 不被继承；继续 B 是新的工作。

### 2.5 历史与所有权是不同的关系

```ts
interface Conversation {
  readonly id: Id;
  readonly parent?: { readonly conversationId: Id; readonly at: Id };   // forked from, at entry
  readonly owner?: Id;                                                       // task that created it
}
```

```text
history:    A ── fork at P ──> B         B: parent = A at P, no owner; independent
ownership:  A ── task T ── owns ──> C    C: owner = T; a child, e.g. a subagent's conversation
```

一个 fork 永远不会进入其 source 的 drive 或 cancellation scope。一个被拥有的
conversation 会，通过拥有它的 task。一个 child 可以用 fresh 或继承的 context 开
始；这与它用哪个 state 初始化是分开的（§4.3）。

## 3. 身份与 commits

### 3.1 Ids 在构建 commit 时铸造

一个 session 范围的 sequence 为每一次 mutation 排序。一次创建的 sequence number
就是该对象的 id。

```ts
// last committed: 99
const entryId = await conv.commit(tx => {
  tx.value(planMode).set(true);                                             // 100
  const id = tx.entry(userKind, { model: [message] });                      // 101
  tx.task(generationKind, { state: { status: "pending", input: id } });     // 102
  return id;
}, call);
// one batch [100–102] persisted and published; entryId === 101 here
```

一个 commit 可以引用它刚刚铸造的 ids。它不能在批次持久化之前把它们交给外部
service 或返回给调用者。被拒绝的 commit 不消耗任何东西：下一个 commit 又从 100
开始。数字是正的安全整数；没有 uuids，没有保留区间。

### 3.2 在 entries 之前可回退的 conversation state

一个 commit 可以把可回退的 conversation state 与一个 entry 一起写入（一个打开
plan mode 并写入其结果的 tool），而在该 entry 处的 fork 必须包含那个 state。它不
得包含稍后提交的 state：在一次回答之后做出的 `/model` 变更属于在那之后进行的
fork，而不是在回答处的 fork。因此边界恰好就是该 entry 的 commit，而在没有字段、
没有 stamp、没有查找的情况下知道它的方式就是写入顺序：**在一个 commit 中，可回退
的 conversation value 与 list 写入先于 entries。** Sequence order 就是 call
order，因此该 state 编号在 entries 之下，而在 entry X 处的 fork 会选择 fork 可见
的 transcript 与截至 X 的可回退 conversation 历史：

```ts
// tool settlement, one commit
await runtime.commit(tx => {
  tx.value(planMode).set(true);                             // 300
  const result = tx.entry(toolResultKind, { data: resultData, model: [message] }); // 301
  tx.settle(task, "done", { call: task.state.call, assistant: task.state.assistant, output, result });   // 302
}, call);

await conv.value(model).set("claude-opus-5", call);               // 303, a later commit

const b = await conv.fork({ at: 301 }, call);      // has the result and plan mode; does not have the new model
```

如果可回退的 conversation value/list 写入跟在 entry 之后，builder 会抛出；plan
在持久化之前失败，且不消耗 ids。Session state 与 sticky conversation state 可以
出现在任何位置，因为 forks 不重建它们的历史，所以它们可以引用同一 commit 中较早
铸造的 ids。Tasks 也可以出现在任何位置；它们不被 forks 继承，通常出现在它们所命
名的 entries 之后。历史读取（§4）以一个 entry 作为其位置；"第一个 entry 之前"是
空位置。任何 transcript entry 都是合法的 fork point，包括一次 assistant call 或
若干个 tool results 之一。Projection 仅为该请求修复由此产生的成功的、不完整的
exchange；它永远不继承或执行 source tasks。

### 3.3 准入之前与之后的失败

Validation 失败：没有写入，不消耗 ids，session 继续工作。不确定的持久化：停止使
用此 handle，重新打开，恢复最后一个完整批次及其 `lastSeq`，从那继续。没有
observer 会看到半个 commit。一个 effect 不得把不确定的写入当作以新 ids 重做同一
外部动作的许可。

### 3.4 Request keys 命名 acceptances

每一个被接受的输入都有一个 `inputId`，即其 `pi.inbox` list 元素的 id（§8.1）。调
用者也可以提供一个不透明的 request id。Acceptance 原子地把一个 session value 从
该 key 存储到新的身份：

```text
400  append pi.inbox item                         inputId = 400
401  inputResult[400] = queued or placed
402  request["req-42"] = { conversationId, inputId:400 }
```

`harness.acceptance(requestId, call)` 返回该 receipt，供那些 accept 响应可能已丢
失的调用者使用。一个 request key 在 session 的整个生命周期内命名一次 acceptance：
第二次用同一个 key 的 `accept` 或 `queueInput` 不写入任何东西，并返回存储的
`inputId`，无论其 payload 或 mode 是什么。不做任何比较，因此不为该目的保留任何内
容或 digest；一个把 key 复用于不同输入的客户端会拿回第一次 acceptance，而
`result(inputId, call)` 说明它后来变成了什么。没有 request id 时，不写入任何映射。
该映射是 session state，因此它可以跟随并引用新铸造的 inbox 元素。

## 4. State

State 的寻址独立于 transcript。它的写入共享 sequence，因此一个位置（一个 entry，
§3.2）同时选择 context 与可回退 state。

### 4.1 Scopes

| Scope | Rewind | Lifetime |
|---|---|---|
| Session | Sticky：一个当前值 | 该 session |
| Conversation | Rewindable 或 sticky，按 address 选择 | 该 conversation 及其 fork 历史 |
| Scratch | 永不回退，永不继承 | 一次 live execution，直到 settlement |

```ts
const sessionName = sessionValue<string>("pi.session.name");
const plan        = conversationValue<boolean>("plugin.plan", { rewind: true });
const expanded    = conversationValue<boolean>("ui.expanded", { rewind: false });
const moves       = conversationList<Move>("game.moves", { rewind: true });
```

```ts
type Scope   = { session: true } | { conversation: number } | { scratch: number /* task id */ };
interface Address { readonly scope: Scope; readonly namespace: string; readonly key?: string; readonly rewind: boolean }
interface Value<T> extends Address { readonly __value?: T }     // phantom: the payload type
interface List<T>  extends Address { readonly __list?: T }
```

一个 address 绑定 namespace、key、scope 与 rewind policy，并携带其 payload 类型。
上面的构造器为一个 scope 生成 `Value<T>`/`List<T>`；一个 conversation handle 自
己绑定 `conversation: id`，因此 plugin 代码写 `conversationValue("plugin.plan")`，
而从不写 id。Values 是严格的 JSON；读取返回副本。一个 conversation address 不能
用作 session address。Storage 持久化 scope 与 policy；没有任何东西依赖于 address
对象在重启后存活。

### 4.2 词汇

```text
value:  tx.value(addr).get(), .set(v), .delete()
list:   tx.list(addr).append(v) → element id, .remove(id), .clear(), .read(cursor, limit)
```

一个可回退历史读取的是某个 entry 时的样子（§3.2）：一个在 40 和 50 追加、在 60
被 clear、在 70 又被追加的 list，在 entry 55 处读取为 `[A, B]`，在 65 处为 `[]`，
在 75 处为 `[C]`。一次 remove 隐藏一个元素，其方式与一次 clear 隐藏全部元素相同。
Clear 是隐藏；它不擦除更早的 fork 所需的东西。删除一个可回退 value 会记录其缺失。
Sticky state 只暴露其当前内容，因此被移除的 sticky list 元素可以被物理丢弃。

### 4.3 初始化是显式的；forks 继承

一个新的 child conversation（一个 subagent）独立于其 context 选择其初始 state：

```ts
spawn({ prompt, context: "inherit",
        values: { inherit: [generationKind.config.model, generationKind.config.thinking],
                  set: [[generationKind.config.selectedTools, ["read", "grep"]]] } })
```

一个 commit 创建该 child、复制所选的当前 values、应用 overrides、追加 user
prompt、创建第一次 generation；那次 generation 从 `system_instructions`（§8.2）
写入该 child 的第一个 `system` entry。未被选中的 values 在该 child 中不存在。除
非某个 policy 如此规定，lists 不被复制。

一个历史 fork 的继承方式不同：fork 位置处所有的可回退历史、除非被选中否则没有
sticky state、相同的 session state、没有 scratch。

### 4.4 有上限的 source 查找

一个 fork 不存储副本。在从 A 于某个 entry 处 fork 出的 B 中读取一个可回退
address：

```text
read(B, addr, at):                             // at = an entry id
  local version ≤ at?  set → value; delete → absent
  no parent? absent
  read(B.parent.conversationId, addr, min(at, B.parent.at))
```

Lists 以相同方式把继承的区间与本地 appends 结合起来，并在每一层都尊重 clears。成
本是 fork depth，而绝不是无关的历史。一个通过复制初始化的 child（§4.3）有一个
owner 但没有 `parent`，因此查找在那里停止。

### 4.5 结构化 plugin state

具有结构化 state 的 plugins 在 values 与 lists 之上构建它：一个 checkpoint value
`{ through, state }` 加上一个 delta list；通过在某个位置读取可见的 checkpoint 及
其之后的 deltas 来 hydrate。plugin 拥有其 delta 词汇表与 reducer；storage 不运行
任何东西。

### 4.6 Scratch

Scratch 是一个 task 在运行期间的工作 state：streamed frames、一个 checkpoint、一
个 memo。每个 task 一个 scope，其中可以有任意数量的 addresses，跨重启持久，task
settle 时消失。

```ts
import { AssistantMessageFrameEncoder, type AssistantMessageFrame } from "@earendil-works/pi-ai";

const frames     = scratchList<AssistantMessageFrame>("frames");
const checkpoint = scratchValue<Checkpoint>("checkpoint");

// a new attempt starts clean; then each frame is one small scratch commit
await runtime.scratch(sc => { sc.list(frames).clear(); }, call);
const { context: streamCall, cancel } = withCancel(call);
const stream = runtime.models.stream(model, request, streamCall);
const encoder = new AssistantMessageFrameEncoder();
try {
  for await (const event of stream) {
    const frame = encoder.encode(event);
    if (frame !== undefined) {
      await runtime.scratch(sc => { sc.list(frames).append(frame); }, streamCall);
    }
  }
} finally {
  cancel();                    // stop this producer on any early exit, not only a task abort
  await stream.result();       // join it; iterator exit alone is not provider completion
}

// after a restart, recover reads what made it to disk
const partial = await runtime.scratch(sc => sc.list(frames).read(), call);

// settlement: the result becomes an entry; settle retires the scope in the same commit
await runtime.commit(tx => {
  const id = tx.entry(assistantKind, { model: [assemble(partial)] });
  tx.settle(task, "done", { inputs: task.state.inputs, assistant: id });
}, call);
```

持久化紧凑的 frames，而不是每个 token 都带一个不断增长的 `partial` snapshot 的原
始 provider events。encoder 存储 content deltas 与必要的 start/end metadata；
terminal outcome/usage 被单独记录。Tool/job scratch 同样追加显式的 output
operations 或有界 checkpoints。这些是普通 lists 中的应用记录，而不是 Chord
storage codec。

三条规则：

- 一个 scratch commit 只写一个 task 的 scratch，不写别的；一个 main commit 永
  不写 scratch。在 JSONL 上，这使每个 commit 恰好是一个文件（§7.4）。
- `settle` 在同一个 commit 中删除该 task 的 scratch。在 settle 之前崩溃：task
  与 scratch 都在那里，可供 recovery。之后：两者都没了。
- 一个 task 在 settle 之前停止写 scratch。一个迟到到达的 frame 无法重建 settle
  已删除的东西。

一次 retry 是同一个 task（§5.3），因此一次 attempt 在开始 streaming 之前清空
scratch；磁盘上的内容始终是当前 attempt 的。Scratch 永不被继承、永不回退、从不在
transcript 中；一个想要保留某些东西的 task 在 settlement 时写入一个 entry 或一个
value。

## 5. Tasks

一个 task 是属于一个 conversation 的持久工作。它的 kind 提供行为；它的 record 提
供必须跨进程存活的 inputs、progress 与 outcome。

### 5.1 The record

```ts
type TaskRole = "start" | "inflight" | "terminal";

type TaskStateBase = JsonObject & { readonly status: string };   // state is strict JSON with a status
type TaskRoles<S extends TaskStateBase> = Readonly<Record<S["status"], TaskRole>>;

interface Task<State extends TaskStateBase = TaskStateBase> {
  readonly id: Id;
  readonly conversationId: Id;
  readonly kind: string;
  readonly role: TaskRole;              // materialized from the kind's roles map on every write
  readonly state: State;                // a tagged union; the status is its discriminant
  readonly after: readonly Id[];        // dependencies, fixed at creation
  readonly background?: true;           // fixed at creation; absent = foreground (§5.6)
  readonly turn?: true;                 // materialized from the kind; this task drives a turn (§5.8)
  readonly owns?: readonly Id[];        // conversations this task created (§5.7)
  readonly abort?: true;                // durable cancellation mark (§6.3)
}
```

**State 是一个以 status 为标签的 tagged union。** 一个 kind 为每个 status 声明一
个 variant，精确携带该 status 下存在的字段，因此没有任何东西是 reader 不得不去猜
的可选项，而一个 dependent 会 narrow 而不是去探查：

```ts
type ToolStates =
  | { status: "planned";  call: ToolCall; assistant: Id }
  | { status: "running";  call: ToolCall; assistant: Id; args: JsonObject; replay: "safe" | "never";
                          jobId?: Id; cancelJobOnAbort?: boolean }
  | { status: "done";     call: ToolCall; assistant: Id; output: ToolOutputState; result: Id }
  | { status: "aborted";  call: ToolCall; assistant: Id; output: ToolOutputState; result: Id };
```

status 只存在于 `state.status` 中。Storage 在写入 record 时把它抽取到一个带索引
的列中，因此一次 scan 从不解码 state，而 `role` 位于 record 上，因为一个未注册
kind 的 reader 无法从该 kind 的 map 计算出它。`Tx` 在每次写入时推导 role。每个
variant 共有的字段必须在各个 variant 中具有相同的类型。

一个 kind 把它的 statuses 映射到三个 roles：

```text
start      the driver may call execute        generation: pending, retry_wait, deferred
inflight   intent was committed; call recover  generation: streaming;  job: running
terminal   done; never patched again           generation: done, failed, aborted
```

`Tx.task`、`patch` 与 `settle` 从已注册 kind 的 status map 推导 role，并在每次写
入时持久化它。Storage 使用 role 索引选择 live rows，而无需检查 task state 或运行
kind 代码。加载它们的完整 records 可能会解码 state；terminal history 不会被解码。
调用者不能独立编辑 role。

**`orphaned` 是推导出来的，而非声明的。** 一个 kind 永远不写它，也永不列出它。
harness 给每个 state union 添加一个 terminal variant，携带该 kind 自身所有
variants 共有的字段：

```ts
type CommonPayload<S extends TaskStateBase> = Pick<S, Exclude<keyof S, "status">>;
type Orphaned<S extends TaskStateBase> = CommonPayload<S> & { readonly status: "orphaned" };
type ToolState = ToolStates | Orphaned<ToolStates>; // orphaned carries only call and assistant
```

`keyof S` 选出每个 union member 中都存在的键；`Pick` 保留它们的类型与可选性。这
是字段名的交集，而不是 variants 的 TypeScript 交集（后者会把不兼容的 status 字面
量交叉成 `never`）。Kind definition 拒绝共有字段的不一致类型或可选性，并拒绝用户
声明的 `orphaned` status。在每个 variant 中都可选的字段在 orphaned 上仍然可选；
variant-specific 的字段不会被暴露。

它只被写入一种情形：在 open 时，针对一个 live foreground task，其 kind 在本进程
中未注册（§6.4）。存储的 record 保留它原本拥有的任何字段；类型只承诺共有字段，而
这就是一个 dependent 可以依赖的全部，因为该 kind 从未运行它的 cleanup。未注册
kinds 的 background tasks 则被 parked，并在它们的 kind 回归时通过 `recover` 恢复。
这是 harness settle 一个它并不拥有的 task 的唯一情形。

### 5.2 Kinds

```ts
declare const taskType: unique symbol; // compiler-only witness; never populated or serialized
interface TaskType<S extends TaskStateBase, R extends TaskRoles<S>> {
  readonly [taskType]?: { readonly state: (state: S) => S; readonly roles: R };
}
type TypedTask<S extends TaskStateBase, R extends TaskRoles<S>> = Task<S> & TaskType<S, R>;
interface TaskDefinition<S extends TaskStateBase, R extends TaskRoles<S>> extends TaskType<S, R> {
  readonly kind: string;
  readonly roles: R;
}

interface TaskKind<States extends TaskStateBase, Hooks extends HookPoints = {}, Config extends ConfigSpec = {},
                   Preview = never, R extends TaskRoles<States> = TaskRoles<States>> extends TaskDefinition<States, R> {
  readonly initialStatus: StatesWithRole<States, R, "start">["status"]; // helper in §9.2
  is(task: Task | undefined): task is ReadTask<States, R>;
  readonly turn?: true;                             // this kind drives a turn (§5.8)
  readonly hooks?: HookSpecs<Hooks>;                // the points this kind runs (§8.7)
  readonly config?: Config;                         // the values this kind reads (below)
  preview?: {                                       // what UIs see while the task runs (§9.4)
    init(scratch: ScratchReader): Preview;          //   built once, on attach or reopen, from durable scratch
  };                                                //   afterwards the kind mutates runtime.preview.state in place
  execute(task: TypedTask<States, R>, runtime: TaskRuntime, call: Call): Promise<void>;
  recover(task: TypedTask<States, R>, runtime: TaskRuntime, call: Call): Promise<void>;
  abort(task: TypedTask<States, R>, runtime: TaskRuntime, call: Call): Promise<void>;
}

type ReadTask<S extends TaskStateBase, R extends TaskRoles<S>> =
  TypedTask<S | Orphaned<S>, R & { readonly orphaned: "terminal" }>;
type TaskState<K> = K extends TaskDefinition<infer S, infer R> ? S | Orphaned<S> : never;
```

`Task` 仍然是原始的存储 record。`TypedTask` 只为完整 state union 与字面 role map
添加一个编译期见证，因此 narrow `task.state` 不会丢失其他 transition targets。
Typed 读取包含 `orphaned`；execute/recover/abort 只接收该 kind 声明的 variants。
该见证不是运行时能力：invocation identity 与当前持久 state 仍然在那一行上决定写
入权限。

使用 `defineTaskKind<States>()({ ... })`：第一次调用绑定所声明的 union（以及可选
的 hook、config 与 preview 类型）；第二次从 definition 推断出字面 roles。它为每
个声明的 status 检查一个精确的 role-map 条目、一个 start-role 的 initial status
以及共有字段的兼容性。它的返回类型保留 `TaskDefinition<States, R>`，包括仅编译期
的 state 见证；否则 kind-witnessed 读取可以从 roles 推断出 statuses，但会丢失它
们的 payload 类型。在使用 typed mutations 时，不要把结果 widen 成泛型的
`TaskKind<States>`，也不要把它的 roles widen 成 `TaskRoles<States>`：那会丢弃区
分 patch 与 settle 所需的信息。

一个读取 config 的 kind 声明它，因此它所依赖的 values 就在该 kind 上而不在别处、
是 typed 的，并可被初始化一个 conversation 的调用者使用：

```ts
type ConfigSpec = Record<string, Value<any>>;

const generationKind = defineTaskKind<GenerationState>()({
  kind: "generation",
  config: {
    model:         conversationValue<ModelId>("pi.model", { rewind: true }),
    thinking:      conversationValue<ThinkingLevel>("pi.thinking", { rewind: true }),
    selectedTools: conversationValue<string[]>("pi.tools.selected", { rewind: true }),
    profile:       conversationValue<string>("pi.prompt.profile", { rewind: true }),
    budgetMs:      conversationValue<number>("pi.tool.budget", { rewind: false }),
  },
  ...
});

await c.config(generationKind).set({ model: "claude-opus-5" }, call);     // or c.settings.set(...) for the generation
const cfg = await runtime.config(generationKind, call);                         // { model, thinking, ... } typed, read on the line
await c.spawn({ prompt, values: { inherit: [generationKind.config.model],
                                  set: [[generationKind.config.selectedTools, ["read", "grep"]]] } }, call);
```

`runtime.config(kind, call)` 在一次批量读取中读取每个声明的 value。一个 UI 可以
通过遍历已注册 kinds 的 `config` 来列出某个 conversation 被配置成什么样。plugin
为自身定义的 values 以同样方式声明在它自己的 kind 上。

`TaskRuntime` 是一次 execution 从 driver 得到的东西：

```ts
interface TaskRuntime {
  readonly taskId: Id;
  commit<T>(plan: (tx: ConversationTx) => T | Promise<T>, call: Call): Promise<T>;
  scratch<T>(plan: (sc: ScratchTx) => T | Promise<T>, call: Call): Promise<T>;
  readonly preview: Tracker<Preview>;              // flushed after successful scratch commits
  now(): number;                                  // injected clock, not Date.now() in task code
  sleep(untilMs: number, call: Call): Promise<void>;
  config<C extends ConfigSpec>(kind: { readonly kind: string; readonly config?: C }, call: Call): Promise<ConfigValues<C>>;
  conversation(id: Id, call: Call): Promise<ConversationHandle | undefined>;
  abortTask(id: Id, call: Call): Promise<void>;
  waitForTask(id: Id, options: { budgetMs?: number } | undefined, call: Call): Promise<boolean>;
  getTask(id: Id, call: Call): Promise<Task | undefined>; // typed/batched reads also available
  getEntry(id: Id, call: Call): Promise<Entry | undefined>;
  value(addr) / list(addr)                         // session state handles; async methods take Call
  readonly models: ModelRegistry;                  // stream/deferred operations take Call
  readonly tools: ToolRegistry;
  hooks<H extends HookPoints>(kind: { readonly kind: string; readonly hooks?: HookSpecs<H> }): HookRunner<H>; // run(point, input, call)
  readonly env: ExecutionEnv;                      // existing Context-final methods; no wrappers
}
```

registry 把 kind names 映射到 kinds；一个 replacement 必须理解其 live tasks 的持
久 statuses 与 state。Open 无论如何都会读取 live tasks（`inspect`），因此一个未
注册的 live kind 在那里被处理，而不是拒绝该 session（§5.1、§6.4）；一个已被遗忘
kind 的 terminal tasks 只有在以 typed 方式读取时才是个问题。

Typed 访问以 kind 作为见证。Public/runtime 读取是异步的并需要 Call；transaction
读取使用 transaction view，不需要另一个 Call：

```ts
// public/runtime
getTask<S extends TaskStateBase, R extends TaskRoles<S>>(
  kind: TaskDefinition<S, R>, id: Id, call: Call): Promise<ReadTask<S, R> | undefined>;
getTasks<S extends TaskStateBase, R extends TaskRoles<S>>(
  kind: TaskDefinition<S, R>, ids: readonly Id[], call: Call): Promise<ReadonlyMap<Id, ReadTask<S, R>>>;
// inside Tx: same asynchronous typed reads, but no additional Call
getTask<S extends TaskStateBase, R extends TaskRoles<S>>(
  kind: TaskDefinition<S, R>, id: Id): Promise<ReadTask<S, R> | undefined>;
getTasks<S extends TaskStateBase, R extends TaskRoles<S>>(
  kind: TaskDefinition<S, R>, ids: readonly Id[]): Promise<ReadonlyMap<Id, ReadTask<S, R>>>;
```

getter 返回 `ReadTask<S, R>` 而无需 cast，或者当该 task 缺失或属于另一个 kind 时
返回 `undefined`；不带 kind 时它返回未类型化的 task。`kind.is(task)` narrow 到相
同的 read 类型。一个裸的数字 id 不为 typed mutation 提供 state/role 见证；先带它
的 kind 去读它。

### 5.3 一次 execution 可以做什么

四条规则，它们就是全部契约：

1. 在任何外部 effect 之前提交一个 inflight status。在此之前崩溃会从头重跑
   execute；在此之后崩溃则走 recover。
2. 你可以在世界上阻塞：一个 provider stream、一个进程、hook 内的一个人、一个
   你创建的 conversation。driver 并发地运行 executions；被阻塞的那个不会拖住任何
   东西。
3. 在返回之前做出一个持久的 status transition 或 settle，除非
   cancellation/close 解开了该 invocation。driver 检查一个 status epoch（§6.1），
   而不是 final-status 相等。
4. 对于前置工作，优先使用固定的 `after` dependencies。Child conversations 使
   用 `drive(call)`；单独运行的 jobs 可以使用有界的 `waitForTask` API（§8.3）。
   已知的 self/dependency waits 会被拒绝（§6.2）；绝不要为了释放一个 invocation
   slot 而放弃一个未完成的 effect。

时序是 task 自己的事：一次 retry 把 `notBefore` 存进它的 state 并在它自己的
execute 中 sleep（`runtime.sleep`，它观察 Call cancellation）。信号上的东西并非
都会抛出：pi-ai 可能返回 `stopReason: "aborted"`。该 kind 正常处理其领域 outcome；
如果持久的 abort mark 胜出，它尝试的 commit 会被拒绝，driver 运行新的 abort
handler（§6.3）。一个 recurring job 设置其下一个 `notBefore` 并以一个 start
status 返回。scheduler 没有 timers。

一个 task 是一个逻辑 operation，而不是一次 attempt。它声明的 status graph 可能包
含环：一次 generation 在 retries 与 deferred polls 之间重访 `streaming`，而一个
schedule 在一个稳定的 id 之下从 `planned` 经 `running` 循环回 `planned`。
Recovery 只使用当前 status、state、role 与 scratch；它不重建走过的路径。在中间有
已提交 transitions 之后返回到起始 status 是合法的。不经过任何 transition 就返回
是契约违例；transitions 不是 progress 的通用证明，也不是对坏环的诊断。

### 5.4 Dependencies 意味着 terminal，而不是 successful

`after` 列出的是在本 task 开始之前必须为 terminal 的 tasks。是 terminal，不是
done：一个依赖 failed 或被 aborted 的 task 仍然会启动，并自行决定那意味着什么。
Dependencies 在创建时设定，引用同一 ownership tree 中既有的 tasks，不形成环，且
永不被编辑。一个 task 可以在其 settlement commit 中创建一个 `after` 包含它自身的
后继者；它不能为自己添加新的 dependencies。一个位于某个 attached subtree 之外的
dependency 可能需要另一次显式的 drive；attach 一个 scope 永远不会隐式地执行一个
兄弟 scope。

一个 foreground task 可以依赖一个 background task，而它在等待时是 live 的，因此
它的 conversation 保持 busy，且 `drive` 直到该 dependency settle 才 resolve。这
正是 overflow chain 想要的（`G' after: [C]`）。对于可能永不 settle 的工作，这是
一个陷阱：一个依赖 recurring schedule 的 foreground task 会让它的 conversation
永远 busy。依赖会结束的工作，或者在 task 自己的 execute 内部等待。

### 5.5 post_tools 加入一个 exchange

generation 的 settlement 原子地发布该 exchange：

```ts
await runtime.commit(tx => {
  const assistant = tx.entry(assistantKind, { model: [message] });    // calls [A, B]
  const tools = message.calls.map(call =>
    tx.task(toolKind, { state: { status: "planned", call, assistant } }));
  tx.task(postToolsKind, {
    after: tools,
    state: { status: "waiting", assistant, tools, inputs: task.state.inputs },
  });
  tx.settle(task, "done", { inputs: task.state.inputs, assistant });
}, call);
```

每个 tool 执行并 settle 自身：hooks、execution、result entry、terminal variant。
它不看兄弟、队列或 context。post_tools 在两者都为 terminal 时启动，用 typed
getter 读取它们，narrow 它们的 status，并决定接下来发生什么：

```ts
async execute(task, runtime, call) {
  await runtime.commit(async tx => {
    const tools = await tx.getTasks(toolKind, task.state.tools);            // Map<id, ReadTask<ToolStates, typeof toolKind.roles>>
    const outcomes: ToolOutputState[] = [];
    for (const t of tools.values()) {
      switch (t.state.status) {
        case "done": case "aborted": outcomes.push(t.state.output); break;   // both wrote their result entry
        case "orphaned":                                                     // kind unregistered at open (§5.1)
          tx.entry(toolResultKind, unavailableResult(t.state.call)); break;
        default: throw new Error(`tool ${t.id} still live in post_tools`);
      }
    }
    if (outcomes.some(o => o.terminate)) {
      for (const inputId of task.state.inputs) {
        const r = await tx.value(inputResult(inputId)).get();
        if (r?.status !== "placed") throw new Error(`Invalid active input ${inputId}`);
        tx.value(inputResult(inputId)).set({ status: "unanswered", requestId: r.requestId, entry: r.entry,
                                             reason: "terminated" });
      }
      return tx.settle(task, "stopped", { assistant: task.state.assistant, tools: task.state.tools });   // no successor
    }
    const added = outcomes.flatMap(o => o.addedTools ?? []);
    const selectedTools = added.length ? [...current, ...added] : current;
    if (added.length) tx.value(generationKind.config.selectedTools).set(selectedTools);
    const handoff = outcomes.find(o => o.handoff);
    if (handoff) tx.entry(handoffKind, {
      data: { text: handoff.handoff }, model: [handoffMessage(handoff.handoff)], head: "self",
    });
    const inputs = await landPostToolsInbox(tx, task.conversationId, task.state.inputs); // writes + steer (§8.1)
    tx.task(generationKind, { state: { status: "pending", ...nextGeneration(task, { selectedTools, inputs }) } });
    tx.settle(task, "done", { assistant: task.state.assistant, tools: task.state.tools, inputs });
  }, call);
}
```

上面的 `inputResult(id)` 是该 input 的 sticky conversation value address（§8.1），
不是 driver operation。abort handler 以 reason `aborted` 把同样的 owned inputs
resolve 为 `unanswered`，并在一个 commit 中 settle。runtime 会在 marked execute
commit 的闭包运行之前拒绝它；正常的 settlement 中不需要任何分支。上面的
inbox-placement helpers 恰好实现 §8.1 中的 mode table。

Sequential tools 是同一机制，只是 `B after: [A]`。

```text
crash before generation settles → generation live; recover
crash after it settles          → assistant, tools and post_tools exist; nothing to repair
crash after the last tool       → post_tools exists and is startable; nothing to infer
```

### 5.6 Foreground 与 background

一个 task 是 foreground 的，除非以 `background: true` 创建；该标志在创建时固定。
Generations、tools、post_tools 与自动 collapses 是 foreground；jobs、schedules、
spawned subagents 与手动 collapses 不是。一个 conversation 的 foreground 集合是
它的 live foreground tasks，再加上——通过任何拥有某个 conversation 的 live
foreground task——该 conversation 的 foreground 集合。Abort 与"这个 conversation
是否 busy"就定义在该集合上。Detached 工作由它自己的 handle 取消。

### 5.7 所有权

一个创建 conversation 的 task 把它加入 `owns`；该 conversation 记录 `owner`。两
者都在创建 commit 中写入。一个 task 可以拥有多个（一个 fan-out tool 驱动三个
children）；一个 conversation 只有一个 owner。Ownership 定义 drive scope 与
cancellation reach。Fork provenance 是另一条链接（§2.5），不创建 ownership。

### 5.8 Turn tasks 与追加 entries

一个驱动 turn 的 kind 声明 `turn: true`；`Tx` 像 `role` 一样把它物化到 task 上，
storage 为它建立索引。内置的 generation、tool、post_tools 与 collapse kinds 声明
它；一个驱动自己 turn 的 plugin kind 也声明它。这给出一个谓词，从索引计算而来，
无需解码 state 或知道任何 kind name：

```text
inTurn(conversation) = live tasks in it with turn: true
```

它之所以存在，是因为一个隐患。一个带 `model` 的 entry 若被追加在一次 assistant
的 tool calls 与其 results 之间，就会改变下一个请求重放的 prefix：校验 message
顺序的 providers 会拒绝它，而 Anthropic thinking signatures 会失效。lane harness
通过在 streaming 期间延迟 custom messages 来维持同一 invariant；pico 用 `inTurn`
来维持它。

`tx.entry` 立即追加并返回 id，这正是 turn task 所需要的（generation 的 assistant
entry、一个 tool 的 result、一个带 `"self"` 的 head）。它只在恰好一种情况下拒绝：

```text
reject if  the entry has a `model`
       and the committing task is not turn: true, or there is no committing task
       and inTurn(entry's conversation) is not empty
```

因此一个没有 `model` 的 entry 永不被阻塞，一个写入自己 exchange records 的 turn
task 永不被阻塞，而在一个没有 live turn task 的 conversation 中没有任何东西被阻
塞。该拒绝会点名 `tx.write`。

`tx.write(kind, draft)` 是从一个 turn 之外写入 model-visible entries 的门：当
`inTurn` 为空时它立即追加，否则作为 `write` mode 排队（§8.1），在下一个
post_tools 或 final-answer 边界落地。它返回一个 `inputId`，而不是一个 entry id，
因为该 entry 可能尚不存在。`ConversationHandle.write` 是同一东西包在一个 commit
里。

`inTurn` 也是 UI 眼中"busy"的诚实定义：一个 foreground subagent tool 在其中，因
为它是一个 tool；一个 background job 不在其中。

## 6. 调度与取消

### 6.1 commit line 就是 scheduler

每一个 driver 决策都在与 commits 相同的串行线上运行。只有 task methods、signal
listeners、watcher callbacks 与 telemetry callbacks 在该线之外运行。没有 polling
loop、`Wake`、effect-admission gate、worker pool 或第二个 scheduler。

进程 state 由以下组成：

| State | Purpose |
|---|---|
| `live: Map<Id, { task, statusEpoch }>` | 仅当前非 terminal 的 tasks |
| `running: Map<Id, Invocation>` | 每个 task id 一个 execute/recover/abort call |
| `byConversation`, `dependents` | live-task membership 与反向 live dependency edges |
| ownership links | live tasks 所需的不可变 ancestry、outstanding calls 与 attached roots |
| attached roots | 稳定的 conversation ids 或一个 session-wide 标志 |
| waiters | 临时的 drive/task waiters，按其 scope 或 target 建立索引 |
| phase | open、stopping、closing、faulted、closed |

Open 在构建 readiness indexes 之前播种完整的 live map，但不启动任何 task。在一个
成功的批次之后，该线在调度或测试 idle 之前把每一项 task 变更应用到这些索引上。一
次 settlement 移除该 task 及其 dependency edges；在同一批次中创建一个后继者永远
不会暴露 idle gap。`statusEpoch` 在每次实际的已提交 status 变更时推进，包括一个
最终 status 等于其初始 status 的批次中的中间变更。仅 state 的 patches、abort
marks、same-status patches 与失败的 commits 不会推进它。

正常执行不会在每个 task 返回后扫描 storage：

```text
task commit on line:
  persist whole batch
  update live/dependency/conversation indexes
  reconsider changed tasks, affected dependents and waiters
  reserve eligible calls in running
  publish complete state; leave line
  dispatch calls/signals/listeners outside line

invocation completion on line:
  validate the invocation object matches running[taskId]
  inspect that task in live (absence means it already settled)
  check outcome and statusEpoch; remove its running slot
  reconsider that task and affected waiters
  reserve eligible calls; leave line
  dispatch outside line
```

只有当前 invocation 可以改变它所拥有的 task 的 state/status 或 settle 它。Host
cancellation 可以设置 abort mark，但 host 或兄弟的 status 写入不能掩盖一个损坏
invocation 的 progress guard。Task 代码接收一个 snapshot；之后的权限是针对该线的
live record 与 invocation identity 检查的，而不是针对那个 snapshot。此检查不需要
额外的 storage 读取。

一个 task 只有在它被服务、live 且尚未处于 `running` 中时才能被预留：

```text
marked                    → abort, irrespective of after
unmarked, role=start      → execute when every dependency is terminal
unmarked, role=inflight   → recover
```

既有的 dependency ids 在创建时被验证。一旦完整的 live map 被播种，一个不在其中的
合法 dependency 就是 terminal。Dependency settlement 只唤醒它的 live dependents。
新的 attachments 可以检查当前 live map 一次；普通 completions 不扫描所有 tasks。
一个 outstanding invocation 即使已经提交 terminal status，也保留它的 slot，直到
它的方法真正返回。不同 task ids 并发执行。保留该 slot 就是 abort join：不存在另
一个单独的 invocation 去等待或覆盖它当前的 owner。

一个正常返回的 execute/recover 必须已经 settle 或推进其捕获的 `statusEpoch`。
`planned → running → planned` 是合法的；不经过任何已提交 status transition 就返
回则不合法。Cancellation/close 的解开是例外。一个 abort handler 必须在返回前
settle。driver 不会诊断任意"在变但有问题"的环。

意外的 task-contract errors 会让 session fail-stop，而不是毒化单个 tasks 并让它
们的 dependents 永远等待。立即拒绝所有 pending drives 并以该 fault 关闭；停止
admission 与 claims，在该线之外向 owned calls 发信号，join 它们并 close。不要制
造 terminal outcomes。报告包含 task id、kind、method 与 error。Reopen 不启动任何
东西：host 可以先 inspect 并 mark 一个 task 再 drive，或者用一个理解并 settle 其
存储 state 的新 kind 替换损坏的 kind。普通的 provider/tool failures 是由它们的
kinds 处理的领域 outcomes，而不是 driver faults。

### 6.2 Attachments 与 waiters

`conversation.drive(call)` attach 一个稳定的 conversation id；
`harness.drive(call)` attach 该 session。每次调用注册一个独立的临时 waiter。重复
drive 永远不会保留另一个 scope 对象。Resolve 或 cancel 一个 waiter 会移除它及其
signal listener，但保留该 attachment，因此 background 与 recurring 工作继续。
Session attachment 涵盖 serving filters；单独的 conversation waiters 仍然保留它
们自己的 idle predicate。

Serving 遵循 ownership，而绝不遵循 fork provenance。一个 conversation attachment
服务它拥有的所有 descendants，即使它们的 owner task 已经 settle。Discover
membership 从拥有 live tasks 的 conversations 开始，向上走
`conversation.owner → owner task's conversationId`。通过 `getConversations` 与
`getTasks` 批量读取被点名的 ancestors，并且只缓存抽取出的不可变 links；绝不要枚
举历史 children 或保留 terminal owner payloads。 Owner liveness 始终来自 `live`，
而不是 ancestry cache。当没有 live task、 outstanding invocation 或显式
attachment 需要它时，释放未使用的 ancestry。

```text
100,000 completed children; 2 live tasks
→ open reads 2 live tasks and only their required ancestry
→ later task completions use current indexes
→ no traversal of the 100,000 historical children
```

Idleness 是在该线上针对当前索引决定的：

- Conversation：该 conversation 中没有直接的 live foreground task。要触达
  foreground descendants 需要 root 中有一个 live foreground owner，因此这等价于
  一个空的 foreground set。
- Session：任何地方都没有 live foreground task，包括 detached children 中的
  foreground tasks。

两者都 resolve `"idle"`，或在 close 胜出时 resolve `"closed"`。Session faults 会
reject，而不是 resolve idle。一个 full-quiescence wait，如果被单独暴露，可能因一
个 recurring task 而永不完成。

Drive 使用 `call.abortSignal` 只取消实际注册的 waiter，而不取消持久工作。在该线
上注册并检查 cancellation；一个 signal listener 入队移除。每种 outcome 都恰好一
次地移除该 waiter 与 listener。不要把一个不可取消的 drive promise 与一个外层
promise 竞速。在 acceptance 之后取消 `prompt` 也会让它被接受的 input 保持持久。

Task-bearing calls 会拒绝已知的 self-waits：一个 foreground task 不能 drive 它自
己的 foreground scope，也不能等待一个其未解决 dependency path 指回它的 task。后
者也能捕获一个 background task T 以 `after:[T]` drive 一个 foreground D 的情况。
在 prompt acceptance 之前应用这些检查，并拒绝会引入此类 indexed wait cycle 的新
工作。通过一个已 settled/background 的 owner 触达的 foreground ancestor 不会自动
成为调用者的 foreground scope。隐藏在 plugin promises 中的任意环仍然是 task 作者
的责任。ownership tree 中别处的 dependencies 可能需要另一次显式 attachment；绝不
要静默地扩大 drive scope。

### 6.3 Cancellation 是一个请求，然后是一次 abort invocation

```text
abortTask(id, call)  mark one live task; reject terminal
conversation.abort(call)
  one commit: mark its current foreground ownership closure;
  withdraw queued steer/followUp in affected conversations; keep write/nextRun
```

`abort: true` 是一个持久请求，而不是 terminal status。当该 mark 提交时，当前
execute/recover invocation 立即失去 mutation 权限。它之后的主写入与 scratch 写入
会在该线上、在运行它们的 builders 之前以 `TaskCancelled` 被拒绝。这是正常的控制
流，而不是 kind bug。信号在离开该线之后被派发；标准 effects 与 waits 协作地观察
它。不需要新的 admission gate。一个 effect 可能在信号送达之前的间隙中开始，然后
被取消；cancellation 既不回滚它，也不承诺 exactly-once I/O。

```text
100 task streaming; execute invocation A owns it
110 abort=true commits; A's mutation authority revoked
    line releases; A's signal fires
    stream returns/throws; execute finishes local finally cleanup and returns
    A's completion enters line; remove A, reserve fresh abort invocation B
    line releases; kind.abort(task, runtime, callB) runs
120 partial/error outcome and unanswered(aborted) input results, if the kind needs them
121 task terminal aborted; scratch retired in the same commit
    abort method returns; remove B
```

正常的 execute/recover settlement 不需要 mark 检查，也不需要 `tx.origin` 分支。
如果它的 settlement 先胜出，该 task 已经是 terminal，稍后的 abort 会拒绝。如果
mark 先胜出，整个正常 settlement 被拒绝，driver 运行 `abort`。provider 的带内
`stopReason: "aborted"` 本身不是持久 mark：没有 mark 时，kind 必须提交它的
failure/retry outcome；有 mark 时，它尝试的领域 commit 会以 `TaskCancelled` 被拒
绝，cleanup 在新的 invocation 中运行。一个只因 task-local deadline 而被取消的
invocation 仍然可以提交它的领域 result。

driver 识别它自己的 `TaskCancelled` 以及该 invocation 已知的 cancellation reason，
包括与 mark/close 相关联的受支持 cancellation errors。一个任意异常不会仅因为某个
信号触发了就变得无害。Hooks 传播 cancellation，而不是把它当作一个普通的
fail-open/fail-closed 决策。预期的 close/stale callback rejections 在它们的边界
处被处理；不确定的持久化仍然会让 session fault。

`abort()` 接收一个新的身份、telemetry span 与初始活跃的 controller。重复 marks
永远不会取消一个已经在运行的 abort handler。只有 close/fault 会取消它。Abort 忽
略 `after`，可以执行 cleanup effects 并写入 outcomes，但不能创建后继
tasks/conversations，也不能通过 accept/nextRun 排队未来工作。一个既没有 owned
call 也没有 attached scope 的 target 在被 drive 之前保持 marked；mark 它不会隐式
地 attach 无关工作。

新的 cleanup 只能使用持久 records。一个创建可取消 background job 的 tool 在同一
commit 中把 job id 及其 cancellation policy 记录在它自己的 task 上。它的 abort
handler 使用那些 references，绝不使用 execute 的 locals，也不使用试图另做一次
mutation 的 post-mark catch。Child conversation ownership 已经是持久的。内置
cleanup 只 mark child 的 live foreground tasks；它不调用同样会撤回 queued inputs
的 public conversation abort operation。这个 task-only cleanup policy 适用于每一
次 abort invocation，包括 crash/reopen 之后，因此 shutdown 不会在 recovery 期间
意外丢弃被保留的队列。Cleanup 的 cancellation request 把一个已经 terminal 的
target 视为已完成，内部使用一个原子的 mark-if-live 操作，或处理那个特定的 public
terminal result；read-then-mark 无法消除该竞态。

mark 之前的 scratch 是权威的。Harness-owned sinks/progress bridges 拥有并处理它
们的 pending scratch promises，丢弃迟到的 cancelled output，并在 invocation
completion 之前 drain callbacks。Task 代码必须 await/catch 它自己的 scratch
writes；不允许没有错误处理的 `void runtime.scratch(...)`。不要把被拒绝的 scratch
变成一个成功的 no-op，也不要竞速掉一个未完成的 tool/hook。如果代码忽略该信号且永
不返回或触达一个会拒绝的 harness operation，abort/close 可能永远等待。isolate
kill boundary 是未来的工作；仅靠 RPC cancellation 不是强制终止。

### 6.4 Open、close、shutdown、delete

**Open** 报告未注册的 entry kinds，播种 live/ownership indexes，暴露
inspection/queries，并且不启动任何东西。一个 kind 未注册的 live task 无法运行：
background 的那个被 parked（不启动、不 recover、不计入 idleness），并在其 kind
回归时通过 `recover` 恢复；foreground 的那个会让它的 conversation 永远 busy，因
此 open 以推导出的 `orphaned` variant settle 它（§5.1）并报告它。`inspect` 把这
些单独返回。Unknown entries 通过存储的 facets 保留 context。

**Close** 运行一个非持久的 line operation，它进入 `closing` 并停止 admission 与
claims。所有更早的 line operations 都已经完成。之后的 storage operations 会
reject；内部 invocation completion messages 仍然被接纳。在该线之外，向每一个
owned call 发信号并 join 它们，包括方法仍在解开的 terminal tasks，然后 close
storage。不写入新的 abort marks 或 outcomes。绝不要在 await 一个可能自身正在
await 一个 line operation 的 task 时持有该线。

**Shutdown** 运行一个 line operation：进入 `stopping` 并提交一个 mark 所有 live
tasks 的批次。Queued inputs 及其 queued result records 保持不被触碰，包括在 idle
conversations 中。没有 inbox sweep，也没有特殊的 storage query。在此批次之后，只
有 abort cleanup mutations 被接纳；一个已经在运行的 abort handler 仍然被授权。被
取消的 execute/recover mutations 会 reject。Abort handlers resolve 它们已经在运
行的 input groups，但内置 child cleanup 只 mark tasks，绝不 drain queues（§6.3），
包括重启之后。在整个 session 范围内 serve cancellation；一旦 live tasks 与
running invocation slots 都为空，就 close。一个失败的 abort handler 会让 session
fault 并拒绝 shutdown，而不是留下一个永恒的 drain。被保留的 queues 在
reopen/drive 时不通过推断创建任何工作；之后的一次 acceptance 会把合格的 queued
input 放在定义的边界处。

重复的 lifecycle calls 共享完成。带 task-token 的 close/shutdown/session-wide
drive 会 reject，而不是等待它们自己的 invocation。Close 无论其调用者的 signal 如
何都会 join；一旦 shutdown 被接纳，调用者的 cancellation 就无法放弃 marking、
joining 或 closing。显式 close 可以中断 shutdown；shutdown 随后 reject，剩余的
marked tasks 稍后 recover。Lifecycle entry points 是普通 admission 的例外，因此
在已经在 closing 时重复 close 仍然可行。

**Delete** 在 subtree 中仍有 live tasks 或 outstanding invocation slots 时
reject，然后拒绝新工作。被独立 forks 继承的 entries 永不被擦除。

### 6.5 Call、telemetry 与 storage version

`Call` 是 Chord `Context` 的一个别名，而不是第二个 context 实现。driver 在其
signal 之外安装一个私有的 typed identity；span/budget 推导保留它而无需 casts：

```ts
import type { Context } from "@earendil-works/chord";
import { createContextKey, withAbortSignal, withContextValue } from "@earendil-works/chord/context";

export type Call = Context;

interface Invocation {
  readonly taskId: Id;
  readonly method: "execute" | "recover" | "abort";
  readonly controller: AbortController;
  readonly initialStatusEpoch: number;
}

const invocationKey = createContextKey<Invocation>("pico.invocation"); // private

// parentWithoutCallerCancellation retains the host telemetry parent, not the drive waiter's signal.
const call: Call = withContextValue(invocationKey, invocation, withAbortSignal(
  invocation.controller.signal, parentWithoutCallerCancellation,
));
const identity = call.value(invocationKey); // Invocation | undefined, no assertion
```

该线用 `running.get(identity.taskId)` 比较对象身份。`TaskRuntime` 绑定到它期望的
invocation，并拒绝缺失/外来/过期的 identities；public host calls 在 session 打开
时可能没有 token。返回的普通 conversation handles 也在每个异步操作上接收 Call，
因此它们无需 task-specific facade 就能保留归因。捕获一个 public handle 并刻意提
供 `BACKGROUND_CONTEXT` 仍然是一个进程内协作式逃逸，而不是隔离。

每一个异步 Harness/Conversation/TaskRuntime 方法都接受一个必需的末尾
`call: Call`，包括读取、等待与 mutations。它之前的选项在未使用时以 `undefined`
传入。纯 accessors、同步 registration/disposal 与 Tx 内部的操作不需要 Call。
`TaskRuntime` 与 `ToolRuntime` 命名能力；`call` 命名
cancellation/telemetry/identity；model context 保持其既有含义。没有
`TaskContext`、`CallContext`、admission helper 或注入信号的 facade。

driver 为每次 execute/recover/abort invocation 启动一个 telemetry span，独立于
drive 调用者的 cancellation。Commits 使用所提供 Call 的当前 telemetry parent；嵌
套的 provider/tool/hook spans 推导并转发一个 Call。既有的接收 Context 的 env、
provider 与 hook 边界解释该 signal，而不仅仅是携带它。没有可中断 API 的 Node 操
作只能前后检查；hooks 与 plugin 代码必须协作。Commit admission 使用 lifecycle、
mark、method 与 identity，而不是一刀切的 signal 检查：cancellation 永不放弃已接
纳的持久化。

RPC 传输 cancellation 与选定的 telemetry metadata，绝不传输 invocation 对象。一
个受信任的 host-side binding 为远程 task calls 重新 attach 本地 identity。一个被
取消的 RPC waiter 不能证明远程代码已停止；在 completion 或真正的 kill boundary
确认之前，不释放任何 slot。

Telemetry schema 的 names/attributes 是一个独立的实现包；host 提供 tracer，且没
有 spans 被存储在 session data 中。Storage metadata 携带一个 version；不匹配会
reject，并且一个 backend 在 open 之前暴露 migration。这些机制都不需要可续期的
session lease。

## 7. Storage

一个接口：点读取、批量读取、有界索引扫描、一个原子 commit。没有 journal reader，
没有第二层 transaction，没有 residency API。

### 7.1 存储什么

Conversations（forks 的 `parent`、owned children 的 `owner`）、entries、tasks（带
索引的 role 与 scheduling 字段）、values 及其可回退 versions、list elements 与
clear markers、scratch scopes。Context 不被存储（§2.2）。

### 7.2 Queries，从调用者一侧看

| Caller | Reads | Never |
|---|---|---|
| Driver open/attach | 完整的 live-task seed 与点名的 owner records；然后是 committed-batch index updates | 调用后重复的全量扫描、历史 child 遍历 |
| Shutdown | 当前 live-task index | inbox sweep、历史 conversation 遍历 |
| Context | 某个 target 处最新的 head；从它返回的边界开始的 fork-aware range | 无关的 transcript 历史 |
| post_tools | 按 id 取 tool tasks | 兄弟扫描 |
| UI | 某个 id 之前/之后的一页 transcript，带一个 limit | 整个 conversation |
| Validation | 点名的 task/conversation records 与按 id 的完整 entries | 无关 records |
| Fork | ≤ 该 entry id 的 transcript 与可回退 conversation 历史 | 被过滤后的今日 state |
| State consumer | 按索引的最新 version；一个有界的 list range | 对无关 records 的重放 |
| Reopen (SQLite) | live tasks 及它们所需的 conversations | 每一次历史 transition |

"Latest" 是一个 limit 为 1 的带索引降序查询，绝不是 load-and-take-last。Filters
在 limits 与解码之前应用。Entries 不可变且整体读取；没有单独的 header 或
projection API。点名的 owner-task 查找使用既有的批量 `getTasks`，即使 owner 是
terminal 的。

```ts
interface Page<T> { readonly items: readonly T[]; readonly next?: Id; readonly readAt: Id }

interface Cursor { readonly after?: Id; readonly before?: Id; readonly limit: number }
interface ConversationQuery extends Cursor { readonly parent?: Id; readonly ownedFrom?: Id }
interface EntryQuery        extends Cursor { readonly conversationId: Id; readonly kind?: string; readonly key?: string;
                                             readonly from?: Id; readonly through?: Id } // inclusive logical range
interface TaskQuery         extends Cursor { readonly conversationIds?: readonly Id[]; readonly live?: boolean;
                                             readonly role?: TaskRole; readonly kind?: string; readonly abort?: boolean }
interface ListQuery         extends Cursor { readonly at?: Id }                   // at = an entry id (§3.2)
interface ValueQuery        { readonly scope: Scope; readonly namespace: string; readonly after?: string; readonly limit: number }  // keys, ordered

interface Version<T>  { readonly seq: Id; readonly value: T }
interface Element<T>  { readonly id: Id; readonly value: T }

interface Storage {
  readonly lastSeq: Id;                                   // last committed sequence
  commit(batch: CommitBatch): Promise<{ first: number; last: number }>;

  getConversations(ids: readonly Id[]): Promise<ReadonlyMap<Id, Conversation>>;
  scanConversations(q: ConversationQuery): Promise<Page<Conversation>>;

  getEntries(ids: readonly Id[]): Promise<ReadonlyMap<Id, Entry>>;
  scanEntries(q: EntryQuery): Promise<Page<Entry>>;                            // full entries, fork-aware
  newestHead(conversationId: Id, at: Id): Promise<Entry | undefined>;             // full entry, target-capped, fork-aware

  getTasks(ids: readonly Id[]): Promise<ReadonlyMap<Id, Task>>;
  scanTasks(q: TaskQuery): Promise<Page<Task>>; // omitted conversationIds: entire session

  getValue<T>(addr: Value<T>, at?: Id): Promise<Version<T> | undefined>;         // at = an entry id
  scanValues(q: ValueQuery): Promise<Page<{ key: string; version: Version<JsonValue> }>>;
  readList<T>(addr: List<T>, q: ListQuery): Promise<Page<Element<T>>>;

  close(): Promise<void>;
}
```

`Value<T>`、`List<T>`、`Address` 与 `Scope`（session / conversation / scratch）
是 §4.1 的 address 类型； `Conversation`、`Entry`、`Task` 与 `TaskRole` 是 §§2
与 5 的 records； `CommitBatch` 是 §7.3。

Pages 携带一个 cursor 以及它们被读取时的 sequence。Transcript 读取是逻辑
conversation 读取：它们把每个 fork 的有上限 source prefix 与本地 entries 结合起
来，递归地携带每一个 ancestor cutoff。`from` 与 `through` 是该逻辑 transcript 中
包含式的 entry 位置；fork point 之后的 source entries 永不出现。
`newestHead(conversationId, at)` 应用相同的 cutoffs，并返回在 `at` 处或之前的、
带 `head` 的最新可见 entry。可回退的 conversation state 遵循相同的 ancestor
cutoffs。Session state 保持当前；sticky conversation state 只在 fork 显式选择它
时才从当前 state 复制。Tasks 永不被继承。对 sticky 或 scratch addresses 的历史读
取会 reject。Coherent 的多读取操作在该线上运行；仅一个 cursor 并不能冻结可变
state。

### 7.3 Batches

```ts
type StateWrite =
  | { type: "value.set"; addr: Address; value: JsonValue }
  | { type: "value.delete"; addr: Address }
  | { type: "list.append"; addr: Address; value: JsonValue }
  | { type: "list.remove"; addr: Address; element: number }
  | { type: "list.clear";  addr: Address };

type MainWrite =
  | StateWrite
  | { type: "createConversation"; conversation: Conversation }
  | { type: "deleteConversation"; id: number }
  | { type: "entry";   entry: Entry }
  | { type: "task";    task: Task }
  | { type: "patch";   id: Id; role: TaskRole; state: TaskStateBase; abort?: true }
  | { type: "settle";  id: Id; role: "terminal"; state: TaskStateBase };  // also retires scratch

type CommitBatch =
  | { readonly kind: "main";    readonly writes: readonly MainWrite[] }
  | { readonly kind: "scratch"; readonly task: number; readonly writes: readonly StateWrite[] };
```

一个 scratch batch 按类型只能携带 state writes；`ScratchTx`（§4.6）只暴露那些。
写入 *i* 获得 sequence `lastSeq + 1 + i`。

Tx 在它启动时读取 `lastSeq`，并从那里为其写入编号；该线保证其间没有任何东西落地，
因此 storage 从它自己的 `lastSeq + 1` 编号会产生相同的 ids。携带 id 的 records
（`entry`、`task`、一个 list element）让 storage 免费检查这一点。harness 针对已
提交 state 加上该批次中更早的写入进行验证（kinds 验证 status transitions；
harness 强制 ownership、dependencies、exchange rules 与 admission；没有人验证
payload shapes：存储的对象被信任，而 schema validation 属于 wire boundaries）。
对于一个带 `head` 的 entry，validation 要求存储的 id 可见，且处于或晚于前一个
fork 可见 head 的存储边界。存储的 edit targets 必须是更早的可见 entries；受管理
system targets 被限制为 baseline supersession（§2.1）。Input-result transitions
被验证，terminal results 不能改变，而消费/取消一个 inbox element 会在同一批次中
写入它的 result。没有任何 entry-kind 代码运行。Storage 检查 scope、sequences 与
structure，只准备被触碰的数据，原子地持久化，然后发布。一个没有写入的 commit 不
写入任何东西。

### 7.4 Memory 与 JSONL

memory backend 持有当前 maps（conversations、tasks、values）、每个 conversation
的有序 entries、version histories，以及 lookup indexes（ids、addresses、
live-task membership、parent 与 owner links）。Indexes 引用相同的不可变 payloads。
JSONL 是 memory backend 加上每个批次一行：

```json
{"first":100,"writes":[
  {"type":"value.set","conversationId":1,"namespace":"plugin.plan","value":true},
  {"type":"entry","conversationId":1,"kind":"user","model":[{"role":"user","content":"Inspect","timestamp":0}]},
  {"type":"task","conversationId":1,"kind":"generation","state":{"status":"pending"}}]}
```

先写入所有字节，然后才发布内存中的变更，绝不提前。针对进程崩溃的 durability 是必
需的；fsync policy 是 backend 选项。

**整体 values，普通 list 操作。** 每个 `value.set` 都存储完整提供的 value，就像
lane harness 一样。对一个 value 没有自动 diff、Chord encoding 或隐藏的 replay
chain。Lists 存储 append/remove/clear 操作。反复设置一个不断增长的整体 value 可
能写入二次方数量的字节；对 streaming 使用紧凑的追加 frames/output operations 或
有界 checkpoints。Chord deltas 只用于 preview/watch delivery（§9.4），而不用于
storage serialization。

**Scratch** 写入 `session.scratch/<task id>`，每个 task 一个文件，使用相同的普通
batch 格式。主文件中的 retirement 是权威的；unlink 在其后发生。Task ids 永不被复
用。一次 retry 保留它的 task 并通过一个持久化的 list operation 清空其 scratch，
而不是删除其最新 sequence 的唯一记录。

**跨文件 recovery。** Main 与 scratch commits 共享同一个 session sequence，因此
任何一个文件内部的间隙都是正常的：

```text
main:       100 create generation
scratch:    101–150 frame appends
crash before settlement
reopen:     main says generation live; replay its scratch; lastSeq=150; next write=151

alternatively:
main:       151 settle generation, retire scratch
crash before unlink
reopen:     generation terminal; ignore old scratch; lastSeq=151
```

在 open 时：

1. 重放完整的 main batches，重建 task liveness 与 scratch retirement。
2. 只为存活的 live tasks 重放 scratch files。完全忽略 retired scratch，即使它
   是畸形的；它不能影响 state 或 sequence high-water mark。
3. 验证递增、不重叠的 retained batch ranges 以及 task/scope references。
   Per-file gaps 是合法的；不要要求 main log 包含被丢弃的 scratch positions。
4. 把 `lastSeq` 设为跨 main 与存活 scratch files 的最大完整批次端点，包括
   scratch clear/remove writes。一个 retired scratch file 的 sequences 已经低于
   它之后的 main settlement，因此删除它不会丢失任何 high-water 信息。
5. 只丢弃被重放文件中未终止的末尾行，并在再次追加之前物理移除那些撕裂的后缀。
   任何畸形的完整 main 或存活 scratch batch 都会使 open 失败。

不需要新的 index、journal 或跨文件 transaction：每个 commit 仍然恰好写入一个文件。

### 7.5 SQLite

Tables：conversations、entries、tasks（包括 terminal 的当前 records）、values 与
value_versions、list_elements 与 clear_markers、scratch、commit_boundaries、
kinds（每个不同的 entry kind 一行）、session_metadata（storage version，§6.5）。
一个 entry row 有可为 null 的 JSON 列用于 `data`、`model` 与 `edits`，外加一个可
为 null 的整数 `head`；storage 理解这些核心字段，但绝不理解 plugin 的 data shape。
Keys 以 session id 开头。Indexes 遵循 query table：entries 按 (conversation, id)、
(conversation, kind, key, id) 以及一个 head 非 null 的部分索引 (conversation,
id)；tasks 按 (role, id) 与 (conversation, role, id)，并对非 terminal roles 建一
个部分索引；value_versions 按 (conversation, namespace, key, seq)；conversations
按 parent 与按 owner。一个 commit 就是一个 transaction：从 `lastSeq + 1` 开始为
写入编号，插入行，记录边界，推进 `lastSeq`。每次 append 都不做任何东西的全量重写；
没有 shutdown 专用的 inbox index。

Values 整体存储，当前与历史都是：一次点读取绝不能变成一条 replay chain，而磁盘比
那更便宜。Scratch 是 `scratch` 表中以 (task, address) 为键的行，在 task 自己的小
transactions 中写入，并在 settlement transaction 内由
`DELETE ... WHERE task = ?` retire：与 result 和 terminal status 原子，无需
unlink。Reopen 读取 live tasks 以及它们引用的点名 records（包括 terminal owners），
而不是累积的历史。一旦 ownership links 被抽取，terminal owner payloads 无需继续
常驻。

## 8. 内置 flows

是 task kinds，而不是 scheduler special cases。大括号把一次 commit 分组。每次
attempt 都记录其 usage；每次 settlement 都 retire 其 scratch。Hooks 与外部调用在
该线之外运行，而它们的决策在该线之内被重新验证。

### 8.1 接受 input

Queued input 是一个 conversation-scoped sticky list，`pi.inbox`。它的 list
element id 就是稳定的 `inputId`；它的 value 携带完整的 entry draft，因此一个 UI
无需再读一次就能渲染排队的 text 或 images：

```ts
type UserInput = string | readonly (TextContent | ImageContent)[];

type QueuedInput =
  | { readonly mode: "steer" | "followUp" | "nextRun"; readonly input: UserInput; readonly requestId?: string }
  | { readonly mode: "write"; readonly kind: EntryKind<E>; readonly entry: EntryInput<E>; readonly requestId?: string };

type InputResult =
  | { readonly status: "queued";     readonly requestId?: string }
  | { readonly status: "placed";     readonly requestId?: string; readonly entry: Id }
  | { readonly status: "done";       readonly requestId?: string; readonly entry: Id; readonly answer?: Id }
  | { readonly status: "unanswered"; readonly requestId?: string; readonly entry?: Id;
      readonly reason: "terminated" | "aborted" | "failed"; readonly detail?: string };
```

要求一个 turn 的三种 modes 携带 user content；一个 `write` 携带它自己的 entry
kind 与 `Tx.entry` 所接受的相同 `EntryInput<E>`（§9.2），并且不要求任何东西。
`inputResult(id)` 表示 namespace 为 `pi.inputResult`、key 为 `String(id)`、类型
为 `InputResult` 的 sticky conversation Value address。它是普通的存储 state，而
不是 driver callback。

`accept({ input, requestId?, whenBusy? }, call)` 就是"用户按下了回车"：当
conversation 处于 idle 时，它在一个 commit 中放置该 entry 并创建一次 generation；
当它 busy 时，它排队，默认 `followUp`，如果调用者这么说则为 `steer` 或 `reject`。
两种方式都返回一个 `inputId`，而 `result(inputId, call)` 说明发生了哪一种。
`queueInput(input, call)` 是针对特定 mode 的显式形式，而
`abortInput(inputId, call)` 撤回一个排队项。

| Mode | Placement | 对 answer group 的影响 |
|---|---|---|
| write | 下一个 post_tools 或 final boundary | 无；它的 result 是 `done`，没有 `answer`（§5.8） |
| steer | 下一个 post_tools 或 final boundary | 在 post_tools 处加入活跃 group；在 final answer 之后启动下一个 group |
| followUp | final-answer boundary | 启动下一个 group |
| nextRun | 下一个显式 idle 的 `accept` | 加入由那次 acceptance 启动的 group |

一次 generation 及其 `post_tools` 携带 `inputs: Id[]`。Generation-with-calls 在
它的 settlement commit 中创建 tools 以及恰好一个带相同 group 的 `post_tools`。
`post_tools` 放置 writes，按 admission order 放置被选中的 steering，用那些 steer
ids 扩展 group，创建 continuation generation 并 settle。在一个 final answer 处，
generation 把每一个当前 input resolve 到那个 answer，放置 writes，然后把被选中的
steer/followUp 项放进一个新 group 并创建它的 generation。一个 `on_yield`
continuation 保留当前 group。没有 tail scan 来归因 results。

Placement 在一个 commit 中追加 entry、移除 list element 并写入 `placed`；一个
`write` 在同一 commit 中被 place 且 `done`，因此对它而言 `placed` 永不可观察。只
有 generation 与 `post_tools` 会 transition 一个 group：一个 final answer 记录
`done` 及该 answer 的 entry id；harness 放弃时记录 `unanswered` 及 reason
`failed`；一个 tool 的 `terminate` 记录 `terminated`；对 run 的 abort，或对一个
排队项的 `abortInput`，记录 `aborted`。Foreground abort 撤回排队的 steer 与
followUp，同时保留 write 与 nextRun。Failure 与 terminate 可以放置安全的 writes，
但不消费需要后继者的 queued inputs。恰好一个 live generation 或 `post_tools` 拥
有一个活跃 group，而 ownership 在 settle 前一个 owner 的同一 commit 中转移。

该 list 被存储为 append/remove/clear 操作，而不是一个被重写的数组。Inbox watch
events 携带相同的操作；一个 idle 的同 commit append/remove 不发出任何事件。
Memory 与 SQLite 可以丢弃一个被移除的 sticky element；JSONL 保留它的 append
record，因此任何之后被复制进 transcript entry 的 payload 都会在磁盘上出现两次，
包括一次 idle acceptance。一旦一个未放置项被撤回，它的 draft 就不再可查询；
`inputResult` 只保留它的 terminal status 与可选 request id。

### 8.2 Generation

```text
create:      capture inputs, the kind's declared config (model, thinking, selected tools, profile;
             §5.2, rewindable values), provider options and retry policy, so a retry uses what the
             attempt used
execute:     if a collapse is needed by threshold: { create collapse C; create generation G' after:[C]; settle }
             desired = seed typed section draft from durable prepared values/rendered text;
                       run system_instructions handlers, then touched renderers/wrappers outside line;
                       capture complete desired tool definitions; no discovery/cache callbacks in storage
             { inspect current head and effective managed system entries;
               if no valid current-epoch baseline: append full baseline plus stored omission edits;
               else if prepared state differs from desired: append materialized section/tool delta;
               capture requestThrough = exact resulting transcript tip; status streaming }
             project at requestThrough, not the later tail; before_request with Call on a request copy
             validate messages-only mode and capture actually offered tools; stream; frames to scratch
outcome:
  calls        { assistant; tools; post_tools carrying inputs; settle done }
  final        { assistant; resolve every current input; place next-group inbox items and successor if any;
                 settle done }
  deferred     { status deferred, handle }         → execute again: poll with sleeps until final
  retryable    { status retry_wait, attempt+1, notBefore } → execute again: sleep, then stream
  overflow     { settle failed(overflow); create collapse C; C's settlement creates G' }
  failure      { retain partial/error outcome for display if useful; resolve inputs unanswered(failed);
                 settle failed; no tools/results }
  aborted      provider returns in-band: attempt domain failure/retry commit;
                 durable mark present → TaskCancelled; execute unwinds; driver calls abort below
```

**持久的配置，准备好的 instructions。** Config 变更立即作为普通 scoped value 写
入而持久化：model/thinking/selected tools/profile 随 forks 一起回退，而其他每个
address 保持其声明的 policy。Host files 与 catalogue 实现不作为配置存储。
`system_instructions` hook 使用 generation 捕获的 config 来产出 desired sections
与完整的 selected tool definitions。它的答案在该线之外准备。一个 system entry 记
录为某个请求准备的规范 instructions，而不是送达或外部确认的证明。

**Typed section definitions 与一个可变 draft。** 一个 token 标识一个 JSON
payload 类型与一个 append-time renderer。它不是 entry kind、discovery callback
或 read-time projection hook：

```ts
interface SystemSection<T> {
  readonly key: string;
  render(value: T): string;
}

interface SystemSectionDraft {
  get<T>(section: SystemSection<T>): T | undefined; // owned copy; call set to change the draft
  set<T>(section: SystemSection<T>, value: T): void;
  delete(section: string | { readonly key: string }): void;
  wrap<T>(section: SystemSection<T>, transform: (text: string) => string): void;
}

interface SkillInfo { name: string; description: string }
const skillsSection = defineSystemSection<SkillInfo[]>({
  key: "pi.skills",
  render: skills => skills.map(skill => `- ${skill.name}: ${skill.description}`).join("\n"),
});
```

内置 definitions 通过 `systemSections` 导出：identity 携带一个 string，
environment 携带诸如 `{ cwd: string }` 的结构化数据，而 skills 携带 typed skill
descriptions。Plugins 可以定义其他的。Payloads 必须可 JSON 表示。Typed getters
使用已注册 definition 的 payload contract；plugins 不需要 casts。Registration 拒
绝重复 keys；替换一个 definition 必须保留持久化的 payload shape 或迁移它。
Payload shape validation 属于 wire boundaries，如同其他 typed stored values 一样，
而不是属于任意的 renderer casts。

每一次 preparation 都从持久的 section values 与 rendered text 播种一个私有的有序
draft。Hooks 按 registration order 编辑同一个 draft，harness-wide 的在前，最内层
scope 的在后。在 skip-failed-handler policy 下，丢弃那个 handler 的
mutations/wrappers，同时保留更早的变更；一次失败的 refresh 绝不能发布一次部分删
除。`set` 就地替换一个既有 payload；一个新的 key 则追加。`delete` 显式移除一个
key（即使在其 renderer 不可用时也可通过 string 进行）。`get`/`set`/`wrap` 需要一
个已注册的兼容 definition。因此一个更晚的 plugin 可以通过 get-and-set 过滤或追加
typed skills，而不是解析 rendered prose。Hooks 只返回可选的完整 desired `tools`；
最后提供的 list 胜出，省略则保留更早 handler 的 list，而完全没有提供 list 意味着
没有 desired tools。

在 hooks 之后，在该线之外渲染被触碰的 sections。`wrap` 在 section renderer 之后
按 registration order 组合 text transforms，而不改动共享的 token。Wrappers 只存
在于这个 draft 中；只有它们的最终 text 被存储。未被触碰的 seeded sections 保留它
们存储的 rendered text，包括当它们的 contributor 或 renderer 缺席时。一次显式的
set/wrap 或兼容的 renderer 替换会重新计算该 text。刷新一个 base 会有意重建它的
wrappers；在这种刷新中保留一个缺失的 wrapper 并未被承诺。在 preparation 之后冻结
/丢弃该 draft；之后泄漏的 callbacks 无法改动已提交的 snapshot。

**没有意外的累积。** Host hooks 应当在 transformation plugins 运行之前每次都设置
完整的权威 base payloads。否则组合出的 transformation chain 在被应用到它自己的前
一个输出时必须到达一个 fixed point；每个 handler 各自幂等是不够的。每次
preparation 都盲目地追加到一个 seeded array/text 会累积重复项。Registration
order 提供组合，而不是对任意 payloads 的自动去重。

按 key 对最终 JSON payloads 与 rendered text 做 diff，忽略偶然的 object-key 顺序。
即使渲染完全相同，也持久化变更的 payloads；那些变更可以是 data-only 的 system
entries（`model: []`）。payload 相同但渲染变化也会发出一次 instruction update，
包括 renderer/wrapper 变更。Baselines 与同时发生的变更使用 draft order；纯粹的重
排是一个 no-op。没有单独的 order option、order-change message 或通用的
source-renderer 框架。

**持久的 seed，独立于 model retention。** 通过把受管理 `system` entries 读回最新
baseline，然后向前折叠它们的 section records，来穿过 fork-visible target 重建规
范 section state。使用既有的 indexed kind scans 与一个可选的 per-handle
prepared-state cache。一个新鲜 baseline 为完整 state 打 checkpoint。这个折叠独立
于 model heads 与 projection edits：一个被省略的历史 model message 不会擦除它持
久化的 section payload。这就是一个不可用 plugin 的 instructions 如何在一次丢弃其
旧 baseline 的 compaction 中存活下来。不需要额外的 full-state value、blob store
或 storage API。

单独检查 effective model projection，以决定它是否有一个可用的 current-epoch
baseline。以受管理 system entries 为目标的任意 edits 会 reject（§2.1）；改变
instructions 使用 section draft 代替。由当前 baseline 写下的 supersession
omissions 不会触发又一次 rebaseline。一个新鲜 baseline 使用规范 payload/rendered
seed 加上本次 preparation 的变更，即使前一个 model baseline 落在 retained range
之外。

Hook-private 的 discovery/cache state 留在闭包或 host services 中，而不在
section records 中。通过 filesystem events 或有界 polling 刷新 skills，而不是每
次 hook call 都做远程扫描。一次失败的 refresh 不是删除：保留最后一次成功的
snapshot；在声称一个 base 之前先播种首次使用。缺失 hook registration 也不是删除；
使用 draft 的显式 delete 操作。

从所有 projected messages 折叠有效的 pi-ai system-message tool 字段，包括受管理
entries 之外的声明。按 name 对完整 definitions 做结构化 diff。Additions 与同名
replacements 发出 `toolsAdded`；removals 在 `toolsRemoved` 中发出先前存储的
definition。Tools-only 变更可以使用空 content。渲染兼容性通知的是 adapter，而不
是 pico。

```text
100 user
110 system baseline: identity + plan_mode; toolsAdded=[read, write]
120 assistant
125 config commit: plan_mode=true; selectedTools=[read, grep]       (not a transcript entry)
130 user
140 system delta: replace plan_mode; toolsRemoved=[write]; toolsAdded=[grep]
150 assistant
```

在 125 与 140 之间崩溃会保留该 config；下一次 generation 准备缺失的变更。在 140
之后但在 provider call 之前崩溃也会保留那个 entry。一个未变的 hook answer 不产生
重复的 delta。两个事件都不能证明 provider 看到了那些 instructions。一个 fork 使
用它可见的 prefix 与继承的可回退 config；重启时变化的 host sources 可能导致一个
新的 delta，但不能重写旧的 messages。

**Head 变更与新鲜 baselines。** 一个 current-epoch baseline 是在 transcript 顺序
上位于最新可见 head entry 之后的受管理 baseline（而不是在它的 retained boundary
之后）。若没有，则追加一个完整 baseline，携带对受取代的 retained managed system
entries 的普通 omission edits。把旧 baselines 以及 deltas 都包括进去，但绝不包括
无关的 system notices。把 omissions 存储在那个同一 baseline entry 上，而不是存储
在 head 上，这样任意的 head writers 保持通用，且一个 fork 不可能落在 replacement
instructions 与其 omission controls 之间。

```text
10 user; 11 baseline; 20 assistant; 30 user; 31 system delta; 35 job notice; 40 assistant; 50 user
60 summary, head=30
context at 60: [60 summary, 30 user, 31 delta, 35 notice, 40 assistant, 50 user]
70 assistant
80 user
81 system { baseline:true, full sections, full desired toolsAdded,
            edits:[{ target:31, action:omit }] }
context at 81: [60 summary, 30 user, 35 notice, 40 assistant, 50 user, 70 assistant, 80 user, 81 baseline]
```

baseline 停留在它被追加的位置，即在 retained tail 之后。在 preparation 之前，旧
的 retained system entries 仍然可见；通用 context derivation 从不偷偷压制它们。
每个请求都先经过 preparation。重复的 heads 使用同一条规则。Reset/handoff 常常在
retained range 内不留下任何旧的受管理 entries，因此新 baseline 不需要 omission
targets。在计划的 omissions 之后计算剩余的 tool fold：一个 baseline 添加完整的
desired tool set，并显式移除仍留在其他 effective system messages 中的不需要的声
明。`baseline:true` 是 pico metadata，而不是 pi-ai 理解的魔法 reset。

**冻结的 request cutoff 与 cache。** generation 存储以下 request-specific 字段：

```ts
// Request fields on the streaming variant; other generation variants/fields are omitted.
interface GenerationStreamingState {
  readonly status: "streaming";
  readonly inputs: readonly Id[];
  readonly requestThrough: Id; // inclusive transcript entry cutoff, required after preparation
}
```

在该线之外运行 hooks/renderers 之前，捕获持久的 section-state cursor 与已注册
definitions。Preparation 保留那个 definition snapshot；之后的 registrations 影响
后续的 preparations。在该线上，验证没有并发的 managed section-state 写入改动了
seed；如果有，则在该线之外重跑 preparation。一个仅 head 的变化不会使 section
seed 过期。然后检查当前 head 与 effective model state，选择 baseline 还是 delta，
并在需要时持久化新的 system entry 以及 generation 的 inflight intent 与
`requestThrough`。cutoff 是最终得到的 transcript tip，即使不需要 system entry 也
是如此。Deferred variants 为其准备好的请求保留该 cutoff；一个未准备的 pending
variant 没有 cutoff。在持久化之后、仍在该线上时，追赶该 handle 的 context cache，
并捕获一个单独的不可变数组，包含所选 entry references 与 effective replacement
projections。这就是 request snapshot；entry bodies 不可变且可以被共享。绝不要分
发可变的 cache bookkeeping，也不要改动一个已发布的 replacement。Request-local 的
normalization/hooks 复制它们所修改的对象。

```text
prepare through 51 → requestThrough=51, snapshot captured
head 60 lands     → live cache advances; request snapshot stays unchanged
request streams   → uses snapshot through 51
next preparation  → sees head 60; writes a fresh baseline if required
```

如果某个 head 在 hook 运行期间落地，preparation 会看到新的 head 并选择一个
baseline。如果它在 preparation 之后落地，已捕获的请求不受影响。当 live cache 已
经推进时，通过 `requestThrough` 的历史/recovery 读取会独立地从 storage 推导；它
们不会回退它。使用后释放仅请求使用的 references；不保留历史 cache versions 的
registry。该 cutoff 标识的是规范 transcript 输入，而不是任意的 request-local
hook 变更。

**Pi-ai 拥有 provider 转换。** Pico 只传递 `{ messages }`，既不传顶层
`systemPrompt` 也不传 `tools`，即使没有选中的 tools 也是如此。两个字段都缺席才会
选择约定好的 pi-ai system-message mode；显式空字符串/数组不算缺席。Adapters 为它
们的 provider/model 转换存储的 message history，尽可能保留 cache prefixes。不受
支持的对话中途 instruction/tool 变更会回退到位于其历史位置的 `<system>` 括号
user messages，以及 adapter 推导出的批量 wire tool declarations。Pico 从不提升一
个 baseline、把历史变更压平成一个被重写的 prompt，或发送一个平行的顶层 tool list。
Fallback user messages 没有原生 system 优先级；cache 复用是 best-effort 的，而不
是普遍的。

pi-ai `SystemMessage` 的形状来自
[PR #9116](https://github.com/earendil-works/pi/pull/9116)；
[PR #9117](https://github.com/earendil-works/pi/pull/9117) 覆盖 coding-agent
prompt/tool deltas。在审查这份契约时它们是 open 的。Messages-only mode 及其
adapter fixtures 是一个外部集成要求，而不是声称当前 main branch 已经实现了它们。

**Request-local overrides。** `before_request` 接收一个私有 request 副本，并且可
以转换它。之后验证它仍然保持 messages-only。这类转换既不改动存储的 entries，也不
改变下一次 generation 的规范 section fold。精确的 transformed-request audit 需要
单独的可选捕获；仅 transcript 只记录规范 preparation。针对转换后实际提供的
definitions，加上 implementation 与 permission 检查，来验证返回的 tool calls——而
不是针对今天的 catalogue 或未经转换的 tool set。

一个 task 历经 retries 与 deferral 而存活；retries 共享一个携带在 state 中的
budget。Overflow 不会让 generation 保持存活：它 settle 并把 retry 交给 collapse
的 settlement，携带 attempt count，因此没有任何 live 的东西会等待那个 collapse。

```text
recover streaming:  frames in scratch → retain/publish the partial for display; settle without tools/results
                    no frames → retry within budget, else fail
recover deferred:   execute again; the handle is in state
abort:              fresh invocation after execute/recover returned:
                    read committed scratch; optionally retain partial for display, excluded from requests;
                    in one commit resolve owned inputs unanswered(aborted), record known usage, settle aborted;
                    no tool tasks/results; settlement retires scratch
```

Usage 也会为 failed、deferred 与 discarded 的 attempts 记录；缺失的报告是未知成
本，而不是零。一份仅在 cancellation cutoff 之后才收到的报告可能没有到达 scratch，
因此对新的 abort cleanup 而言是未知的。该 record 是一个 session list，
`pi.usage`，每次 attempt 一个 element（conversation、task、model、tokens、cost），
在 settlement commit 中连同 session value `pi.usage.totals` 的一次更新一起追加，
因此 stats 是一次点读取，而绝不是一次折叠。Tools 与 jobs 通过 sink 的 `usage` 以
相同方式追加。Persistence 与 invariant failures 不是 provider errors：它们会让
session fault。

### 8.3 Tools 与 post_tools

```text
tool execute:
  resolve the tool in the registry (the loadout may have changed since the turn started);
  validate the model's arguments against its schema
  before_tool → allow(args) | block(reason, terminate?)     (a human approval waits inside the hook)
  block / invalid / unknown tool → own error result, no invocation
  { status running; effective args; replay policy }
  invoke tool(callId, params, out, runtime, call); the sink owns its scratch promises (§9.3)
  after_tool outside the line
  { result entry from the folded sink; usage; settle done with result id and ToolOutputState }
```

该 tool 从不触碰 context、siblings 或 queues。一个抛出的 `before_tool` 会 block
该 tool。一次普通的 tool throw 是一个 error result，而不是一次 cancellation。

```text
recover:  replay only if the stored policy allows; else an interrupted result from the checkpoint
abort:    previous invocation already returned; read durable scratch and cleanup references;
          mark owned child foreground tasks/non-detached jobs, without touching child queues;
          write aborted error result; settle
```

post_tools 就是 §5.5 中的代码：读取 tool tasks，遇到 terminate 就停止，如果被请
求了就写入 handoff，放置 writes 与 steering，把扩展后的 input group 带入下一次
generation，然后 settle。它的 abort 把它的 input group resolve 为 `unanswered`
且 reason 为 `aborted`，并在没有后继者的情况下 settle。

**Blocking budget。** 一次 tool call 不能无限期地阻塞一个 turn。运行进程或 child
conversations 的 tools 先创建一个 job（或一个 conversation），并用该 budget 等待
它；如果 budget 用完，该 call 用它所拥有的东西、`out.delegate(job)` 与一个 diag
立即 settle，而工作作为该 job 继续：

```ts
const job = await runtime.commit(async tx => {
  const task = await tx.getTask(toolKind, runtime.taskId);
  if (task?.state.status !== "running") throw new Error("Expected a running tool");
  const { status, ...payload } = task.state;
  const id = tx.task(jobKind, { background: true,
    state: { status: "planned", cmd, cwd, origin: { tool: "bash", task: runtime.taskId, callId: toolCallId } } });
  tx.patch(task, status, { ...payload, jobId: id, cancelJobOnAbort: true }); // complete running payload
  return id;
}, call);
const done = await runtime.waitForTask(job, { budgetMs: runtime.budgetMs }, call);
const output = await runtime.jobOutput(job, call);
out.replace(output.text); out.capture(output.truncation);
if (!done) {
  out.delegate(job);
  out.diag("info", `still running as job ${job}; use job wait / status / stop`, "budget");
}
```

该 budget 是 generation 的 config（`budgetMs`，默认为几分钟）；tool kind 把它作
为 `runtime.budgetMs` 传入。`waitForTask` 观察 Call cancellation 并注销它的
waiter。一个被 mark 的 tool 不能从它的 execute catch 中做 mutation；它新的 abort
handler 读取存储的 job reference 并取消 non-detached 工作。显式的 backgrounding
记录一个不同的 cancellation policy。成功的 delegation settlement 原子地记录该
job 是 detached 的，并请求它的 completion notice；如果该 job 已经结束，那个
transaction 自己放置该 notice。使用一个单独的 sticky notification record，而不是
从它前一个 owner 去 patch 一个正在运行的 job 的 state。

**剩余的 budget 集成问题：** 在 timeout 之后采纳任意非 delegating 的 tool 工作，
需要在 source invocation 释放它的 slot 之前显式转移 effect 与 sink ownership。竞
速并放弃该 tool promise 不是正确的实现。把这一能力留给一个单独的 ownership 设计；
crash recovery 保持为 `lost`。上面的 job-first 路径不需要 promise adoption，是初
始的实现路径。

`new_context` 是一个调用 `out.handoff(message)` 的 tool；reset 在这里发生，在
exchange 完成之后，绝不在 tool 内部，因为一个在 exchange 中途落地的 head 会把它
切成两半。冲突的 handoffs 会 reject，而不是挑选一个顺序。

一个 final answer 的 continuation 在 generation 的 settlement 中决定。`on_yield`
可以请求一个保留当前 input group 的显式 continuation。否则该 answer resolve 那个
group，然后合格的 steer/followUp 项被放进一个新 group 及其 generation。一个
owned conversation 的 final answer 仍然 resolve 它自己的 inputs；它的 owner tool
在 drive 它时观察那个 result（§8.5）。一个 tail 是 user entry 的 idle
conversation 不通过推断创建任何工作。

### 8.4 Collapse

```text
create:   capture the prefix to replace (ending on a complete exchange), its first retained entry,
          the newest head id, context and settings; one live collapse per conversation
execute:  { status summarizing }
          before_collapse (may decline or supply the summary); call the summarizer; candidate to scratch
          { if no head newer than the captured one:
              append summary { model:[summary], head:firstRetained }; settle done
            else: settle failed(stale) }
```

在它运行期间落地的 entries 保持在 prepared retained boundary 处或之后，因此它们
无需任何人做任何事就留在 context 中。其间落地的 context edits 影响活跃
projection，但不使该 summary 失效或重算它。一个 summary 可以在一次 generation
streaming 时落地，因为该 stream 已经投影了它的 context，而被替换的 prefix 是旧的。
自动 collapses（threshold、overflow）是 foreground；手动的则是 background。除通
过 §8.2 的 settlement chain 之外，一次 collapse 永不创建 generation。Abort 记录
usage 并在不发布的情况下 settle。Prefix pruning/windowing 追加另一个带存储 head
的 entry；对单个 retained entries 的 pruning 或替换使用 edit entries（§2.1）。动
态 `compose` policies 不受支持。

### 8.5 Subagents

一个 subagent 就是一个 conversation。没有 subagent task，只有一个 tool，
`subagent`，其参数是一个 command：

```ts
type SubagentCommand =
  | { command: "run";    prompt: string; context?: "fresh" | "inherit"; tools?: string[] }   // foreground
  | { command: "spawn";  prompt: string; context?: "fresh" | "inherit"; tools?: string[] }   // background
  | { command: "send";   id: Id; text: string }
  | { command: "status"; id: Id }
  | { command: "wait";   id: Id }
  | { command: "stop";   id: Id };
```

```text
run:     { create child conversation (this task owns it); initial values; accept prompt → inputId; first generation }
         await child.drive(call)                   // cancels this waiter, not the child
         child.result(inputId, call); { result entry; settle }
         recover: the child exists; drive it again with the fresh Call
         abort: mark child's foreground tasks only, preserve its queues; write own error result and settle

spawn:   the same creation commit; settle at once with the child's id
send:    child.accept({ input: text }, call) → queued if the child is busy
status:  the child's tail and live tasks
wait:    await child.drive(call); child.result(lastInputId, call); settle    (recover: drive again)
stop:    child.abort(call)
```

`id` 就是 `spawn` 返回的任何东西，由 model 传回；该 tool 用
`runtime.conversation(id, call)` resolve 它。没有单独的 subagent registry 需要在
重启后重建。在 `spawn` 与 `wait` 之间，驱动 parent tree 的任何东西也驱动该 child。
一个被 spawn 的 child 由一个已经 terminal 的 task 拥有，因此它不在 parent 的
foreground set 中，abort parent 也不会动它；`stop` 是取消它的方式。一个 child 继
承的 context 是 parent 在启动它之前最后一个完整 exchange 处的 context。

### 8.6 Jobs 与 schedules

一个 job 是一个运行进程的 background task。它的 state：

```ts
type JobInput = {
  cmd: string; cwd: string; limits?: ShellOutputLimits;
  origin?: { tool: string; task: Id; callId: string }; // originating call, for UIs
  every?: number; notBefore?: number; rerun?: "safe"; // recurrence and recovery policy
};
type JobState = JobInput & (
  | { status: "planned" }
  | { status: "running"; startedAt: number }
  | { status: "exited"; output: ToolOutputState; exitCode: number }
  | { status: "killed"; output: ToolOutputState }
  | { status: "lost" }
);
```

启动一个 job 就是创建该 task；一个 tool 在它的 execute 中做这件事（§8.3），一个
UI 则在一个 commit 中做：

```ts
const jobId = await conv.commit(tx =>
  tx.task(jobKind, { background: true, state: { status: "planned", cmd: "npm test", cwd, every: 6 * 3600_000 } }), call);
```

```text
states:  planned { cmd, cwd, every?, notBefore? } | running { …, startedAt } |
         exited { …, output, exitCode } | killed { …, output } | lost { … }
roles:   planned=start; running=inflight; exited/killed/lost=terminal
execute: sleep until notBefore with Call; { status running; startedAt = runtime.now() }
         env.exec(command, options, call), with bounded capture and spill
         harness progress bridge owns scratch writes, handles cancellation and drains callbacks
         after process and progress bridge return:
           { if notification requested: append notice and consume notification request;
             if recurring: status planned, notBefore = runtime.now() + every;
             otherwise: settle exited with bounded output and exitCode }
         a post-mark write rejects TaskCancelled; no in-band killed settlement
recover: safe rerun policy → execute again with the fresh Call
         otherwise { consume pending notice request; append lost notice if requested; settle lost }
abort:   previous invocation and its process/progress callbacks have returned
         read committed output from scratch;
         { consume pending notice request; append killed notice if requested; settle killed }
```

progress bridge 是 harness-owned 的 sink plumbing（§6.3），不是 plugin 创建的
detached promise。它观察每一个 scratch result，只抑制预期的 cancellation/close
rejections，报告 persistence faults，并与进程执行一起被 join。Notification
requests 是按 job id 键控的当前 sticky state；消费它们并发布 notice 在每一条
terminal path 上都是原子的，包括 exited、lost 与 killed。如果 delegation 在
settlement 之后进行，delegation 改为发布同一个 outcome。两种顺序都不得改变
notification 行为。

`runtime.env` 是 harness 的 `ExecutionEnv`（`FileSystem & Shell`）；`exec` 运行
命令，通过 `onUpdate` 捕获输出（这里是写入 scratch，因此 watcher 可以实时显示它），
并在它退出或信号触发时返回。`running` 是 inflight，因此重启会走 `recover`；由于
shell 不交出一个可采纳的进程，如果该 job 声明了那是安全的，recover 就重跑，否则
settle 为 `lost`。一个 recurring job 是同一个 task 循环
`planned → running → planned`；`abortTask(id)` 在它所在之处结束它。输出在它运行
期间留在 scratch 中，之后留在 terminal state 中，在那里 `jobOutput`、`job` tool
与 UIs 读取它；没有 result entry，因为一个已经等待过的 call 已经携带了该输出。一
个其 call 提前返回的 job 在结束时追加一个带存储 `SystemMessage` 的 `notice`
entry，因此下一次 generation 无需 polling 就能得知它。Interval 与 catch-up
policy 在 state 中，因此重启永远不会启动一个 backlog。

### 8.7 Hooks

Hooks 属于 kinds。一个 kind 声明它的 points 及其类型；plugins 按 kind 与 point
注册 handlers；harness 只做路由：

```ts
type HookPoints = Record<string, { input: unknown; output: unknown }>;

interface GenerationHooks extends HookPoints {
  system_instructions: { input: { conversationId: number; config: GenerationConfig; sections: SystemSectionDraft };
                         output: void | { tools?: readonly Tool[] } }; // sections mutate one shared preparation draft
                         // handlers run sequentially; new keys append; set replaces; delete is explicit
  before_request: { input: { request: ProviderRequest }; output: { request?: ProviderRequest } };
  after_response: { input: { response: AssistantMessage; usage: Usage }; output: void };
  on_yield:       { input: { answer: AssistantEntry }; output: { continue?: string } };
}
interface ToolHooks extends HookPoints {
  before_tool: { input: { toolCallId: string; toolName: string; args: JsonObject };
                 output: { args?: JsonObject; block?: { reason: string; terminate?: boolean } } };
  after_tool:  { input: { toolCallId: string; output: ToolOutputState }; output: void };
}
interface CollapseHooks extends HookPoints {
  before_collapse: { input: { reason: "manual" | "threshold" | "overflow"; entries: readonly Entry[] };
                     output: { decline?: boolean; instructions?: string; summary?: string } };
}

const generationKind = defineTaskKind<GenerationState, GenerationHooks>()({ ..., hooks: { before_request: {}, after_response: {}, on_yield: { failClosed: false } } });
const toolKind = defineTaskKind<ToolStates, ToolHooks>()({ ..., hooks: { before_tool: { failClosed: true }, after_tool: {} } });

// a plugin registers a handler
harness.hooks.on(toolKind, "before_tool", async ({ toolName, args }, call) => {
  if (toolName === "bash" && !(await ui.approve(args, { signal: call.abortSignal }))) return { block: { reason: "denied" } };   // may wait for a human
});

// the kind runs it
const decision = await runtime.hooks(toolKind).run("before_tool", { toolCallId, toolName, args }, call);
```

一个 handler 可以被 scoped 到一个 conversation 而不是整个 harness；对
`system_instructions` 而言这是常态，因为一个 subagent 是另一个 agent：

```ts
root.hooks.on(generationKind, "system_instructions", hostInstructions, { subtree: true });  // root and what it owns
child.hooks.on(generationKind, "system_instructions", investigatorInstructions);           // this child only; overrides for it
```

Scoped handlers 对同一个 point 在 harness-wide handlers 之后运行，最内层的
conversation 最后，因此一个 child 的 sections 按 key 胜出。Registration 是进程
state，不是持久的；一个 presentation 在它 attach 时注册。

Handlers 按 registration order 运行，每个看到截至目前合并后的 output；kind 决定
如何处理结果。一个 handler 在该线之外运行，而它的决策在一个 commit 之内被应用，
该 commit 的 runtime 验证当前 invocation authority。Handlers 接收一个必需的末尾
Call，把它转发给 waits/effects，并且必须在它们的 parent task invocation 释放
ownership 之前返回。Cancellation control errors 绕过普通的 hook failure policies。
Handlers 可能在一次崩溃后再次运行，因此它们的外部副作用需要自己的幂等性。
`failClosed` 说明一次 throw 意味着什么：对 `before_tool`，一次 throw 会 block 该
tool；对其他，一次 throw 被报告并跳过。`before_tool` 可以想等多久就等多久（人类
批准就是一个会等待的 hook）；与此同时该 task 仍然是 `planned`，而一次崩溃只是再
问一次。一个 plugin kind 以相同方式声明它自己的 points，而一个替换内置 kind 的
plugin 保留它的 hook names，因此既有的 handlers 继续工作。Commit listeners 不是
hooks：它们只观察，从不决策，也从不 await 同一条线上的一个 commit。

## 9. API

### 9.1 Handles

```ts
interface ConversationHandle {
  readonly id: Id;
  snapshot(call: Call): Promise<Conversation>;
  accept(options: { input: UserInput; requestId?: string;
                    whenBusy?: "followUp" | "steer" | "reject" }, call: Call): Promise<{ inputId: Id }>;
  prompt(options: { input: UserInput; requestId?: string;
                    whenBusy?: "followUp" | "steer" | "reject" }, call: Call): Promise<AssistantEntry | undefined>;
  result(inputId: Id, call: Call): Promise<InputResult | undefined>;
  drive(call: Call): Promise<"idle" | "closed">;
  queueInput(input: QueuedInput, call: Call): Promise<{ inputId: Id }>;      // §8.1
  write<E extends Entry>(kind: EntryKind<E>, input: EntryInput<E>, call: Call): Promise<{ inputId: Id }>;   // §5.8
  abortInput(inputId: Id, call: Call): Promise<"aborted" | "not_found">;
  abort(call: Call): Promise<void>;
  collapse(options: { instructions?: string } | undefined, call: Call): Promise<Id>;
  reset(options: { handoff?: string } | undefined, call: Call): Promise<void>;
  fork(options: { at: Id | "start"; abort?: boolean; values? }, call: Call): Promise<ConversationHandle>;
  spawn(options, call: Call): Promise<Id>;
  value(addr) / list(addr) // async reads/writes take a final Call
  config<C extends ConfigSpec>(kind: { readonly kind: string; readonly config?: C }): { get(call: Call): Promise<ConfigValues<C>>; set(partial: Partial<ConfigValues<C>>, call: Call): Promise<void> };
  readonly hooks: { on(kind, point, handler, o?: { subtree?: boolean }): () => void };   // scoped to this conversation (§8.7)
  readonly settings: ConfigHandle<GenerationConfig>;   // sugar: config(generationKind)
  commit<T>(plan: (tx: ConversationTx) => T | Promise<T>, call: Call): Promise<T>;
}

interface Harness {
  readonly entryKinds: EntryKindRegistry; // mutable registration (§9.6)
  readonly taskKinds: TaskKindRegistry;
  readonly sections: SystemSectionRegistry;
  root(call: Call): Promise<ConversationHandle>;
  conversation(id: Id, call: Call): Promise<ConversationHandle | undefined>;
  conversations(query, call: Call): Promise<Page<Conversation>>;
  acceptance(requestId: string, call: Call): Promise<{ requestId: string; conversationId: Id; inputId: Id } | undefined>;
  inspect(call: Call): Promise<{ start: Task[]; inflight: Task[]; orphaned: Task[]; parked: Task[] }>;
  drive(call: Call): Promise<"idle" | "closed">;
  getEntry(id, call); getEntry(kind, id, call); getEntries(ids, call); getEntries(kind, ids, call);
  entries(conversationId, page, call);
  getTask(id, call); getTask(kind, id, call); getTasks(ids, call); getTasks(kind, ids, call);
  abortTask(id: Id, call: Call): Promise<void>;
  value(addr) / list(addr) // session state handles; async methods take Call
  commit<T>(plan: (tx: Tx) => T | Promise<T>, call: Call): Promise<T>;
  watch(conversationId: Id, options: { tail: number; values?: Address[]; raw?: boolean }, call: Call): Promise<WatchHandle<ConversationView, ConversationEvent>>;
  watch(call: Call): Promise<WatchHandle<SessionView, SessionEvent>>;
  deleteConversation(id: Id, call: Call): Promise<void>;
  shutdown(call: Call): Promise<void>;
  close(call: Call): Promise<void>;
}
```

`Call` 定义于 §6.5。`call.abortSignal` 取消 drive 调用者的等待，而不是工作本身。
`fork({ at, abort: true }, call)` 在创建该 fork 的同一 commit 中 mark source 的
foreground set，用于"回到那个点"；UI 把哪个 conversation 视为当前是 UI 的事。
`prompt` 只在其 input 的 result 是带 `answer` 的 `done` 时才返回 answer entry；
`unanswered`，或 drive 返回时 input 仍为 `placed`，给出 `undefined`。
`result(inputId, call)` 是一次 sticky-value 点读取，绝不是一次 transcript scan。
在一次不确定的远程响应之后，`acceptance(requestId, call)` 恢复 conversation 与
input 身份，或者调用者干脆用同一个 request key 重试并拿回相同的 `inputId`（§3.4）。

### 9.2 Commits

```ts
const entryId = await harness.commit(tx => {
  tx.value(planMode).set(true);                              // state first (§3.2)
  const id = tx.entry(noteKind, conversationId, {
    data: { text: "plan accepted" },
    model: [{ role: "user", content: "<note>plan accepted</note>", timestamp: 0 }],
  });                                                       // final id, inside the closure
  tx.task(reminderKind, { background: true, state: { status: "scheduled", about: id } });
  return id;                                                // any value; resolved after commit
}, call);
```

```ts
type EntryInput<E extends Entry> =
  Omit<E, keyof EntryIdentity | "head"> &
  (E extends ContextHead ? { readonly head: Id | "self" } : { readonly head?: never });

interface EntryDraft {
  readonly key?: string;
  readonly data?: JsonValue;
  readonly model?: readonly Message[];
  readonly head?: Id | "self";
  readonly edits?: readonly ContextEdit[];
}

// Distribute over the declared variants; orphaned is never a public write target.
type StatesWithRole<S extends TaskStateBase, R extends TaskRoles<S>, Role extends TaskRole> =
  S extends TaskStateBase
    ? S["status"] extends "orphaned" ? never : R[S["status"]] extends Role ? S : never
    : never;

// Keep status and payload correlated, even when callers pass unions.
type WriteArgs<S extends TaskStateBase> = S extends TaskStateBase
  ? [status: S["status"], payload: Omit<S, "status">]
  : never;
type ExactWrite<S extends TaskStateBase, A extends WriteArgs<S>> = A & [
  status: A[0],
  payload: Record<Exclude<keyof A[1], keyof Omit<Extract<S, { status: A[0] }>, "status">>, never>,
];

interface Tx {
  // reads (committed state)
  getEntry(id) / getEntry(kind, id) / getEntries(...) / getTask(id) / getTask(kind, id) / getTasks(...)
  value<T>(addr: Value<T>): { get(at?): Promise<T | undefined>; set(v: T): void; delete(): void };
  list<T>(addr: List<T>): { append(v: T): Id; remove(id: Id): void; clear(): void; read(q): Promise<Page<Element<T>>> };
  // writes; rewindable conversation state before entries (§3.2)
  entry<E extends Entry>(kind: EntryKind<E>, conversationId: Id, input: EntryInput<E>): Id;   // §5.8
  write<E extends Entry>(kind: EntryKind<E>, input: EntryInput<E>): Id;   // inputId; appends now or queues (§5.8)
  queueInput(input: QueuedInput): Id;                                     // inputId (§8.1)
  task<S extends TaskStateBase, R extends TaskRoles<S>>(kind: TaskDefinition<S, R>,
    spec: { state: S; after?: Id[]; background?: true; owns?: Id[] }): Id;
  patch<S extends TaskStateBase, R extends TaskRoles<S>,
        A extends NoInfer<WriteArgs<StatesWithRole<S, R, "start" | "inflight">>>>(
    task: TypedTask<S, R>, ...args: A & NoInfer<ExactWrite<StatesWithRole<S, R, "start" | "inflight">, A>>): void;
  settle<S extends TaskStateBase, R extends TaskRoles<S>,
         A extends NoInfer<WriteArgs<StatesWithRole<S, R, "terminal">>>>(
    task: TypedTask<S, R>, ...args: A & NoInfer<ExactWrite<StatesWithRole<S, R, "terminal">, A>>): void;
  createConversation(spec): Id;  deleteConversation(id: Id): void;
}
```

两个操作都接收一个显式的 target status 及其**不含 status 的完整 payload**：

```ts
tx.patch(task, "running", { call, assistant, args, replay });
tx.settle(task, "done", { call, assistant, output, result });

// Same-status update: narrow, remove the tag, then supply the full replacement.
if (task.state.status === "running") {
  const { status, ...payload } = task.state;
  tx.patch(task, status, { ...payload, jobId });
}
```

没有 status-free 或 partial-merge 的重载。两个写入都用 `{ ...payload, status }`
替换存储的 state；来自前一个 variant 的字段不会被隐式保留。`patch` 接受
start/inflight targets，`settle` 接受 terminal targets 并 retire scratch。两者都
不允许 `orphaned`；只有 open 的内部 orphan handling 写入它。Same-status
replacement 仍然合法，但不推进 `statusEpoch`。Creation 仍然接收完整的初始 tagged
state。一个 invocation 的 task snapshot 在 patch 之后不改变；当一个稍后的
replacement 需要那个 snapshot 之后提交的 state 时，重新读取，或者携带显式构造的
下一个 payload。

`WriteArgs` 是 status/payload 元组的 union：一个 union 取值的 status 与一个无关
的 payload 不能证明是一个合法配对。`NoInfer` 阻止参数 widen 该 task 已知的
union/role map。`ExactWrite` 拒绝在变量或 spread 中可见的多余顶层键，而不仅仅是
对象字面量，包括重复的 status。这些是静态检查，不是运行时 schema validation：
casts、被擦除的多余字段与嵌套结构化类型仍然遵循 TypeScript 的限制。Wire
boundaries 验证不受信任的 payloads；line validation 检查当前 liveness、
invocation ownership 与允许的 roles。

下面的实现展示被擦除的 runtime signatures；public signatures 在上面。它边写边编
号，保持那一条排序规则，并把一个批次交给 storage；storage 从它自己的 `lastSeq`
编号并得到相同的 ids（§7.3）。

```ts
class Tx {
  private writes: MainWrite[] = [];
  private seq: number;
  private sawEntry = false;
  constructor(private storage: Storage, private kinds: Kinds) { this.seq = storage.lastSeq; }

  private push(w: MainWrite): number { this.writes.push(w); return ++this.seq; }
  private state(w: StateWrite): void {
    if (this.sawEntry && "conversation" in w.addr.scope && w.addr.rewind)
      throw new Error("rewindable conversation state must precede entries (§3.2)");
    this.push(w);
  }

  value<T>(addr: Value<T>) {
    return {
      get: (at?: number) => this.storage.getValue(addr, at).then(v => v?.value),   // committed state
      set: (value: T) => this.state({ type: "value.set", addr, value }),
      delete: () => this.state({ type: "value.delete", addr }),
    };
  }
  list<T>(addr: List<T>) {
    return {
      append: (value: T) => { this.state({ type: "list.append", addr, value }); return this.seq; },
      remove: (element: number) => this.state({ type: "list.remove", addr, element }),
      clear: () => this.state({ type: "list.clear", addr }),
      read: (q: ListQuery) => this.storage.readList(addr, q),
    };
  }

  entry(kind: EntryKind, conversationId: number, draft: EntryDraft): number {
    this.sawEntry = true;
    const id = this.seq + 1;
    const { head, ...fields } = draft;
    const entry: Entry = {
      id, conversationId, kind: kind.kind, ...fields,
      ...(head === "self" ? { head: id } : head === undefined ? {} : { head }),
    };
    this.push({ type: "entry", entry });
    return id;
  }
  task<S extends TaskStateBase, R extends TaskRoles<S>>(
    kind: TaskDefinition<S, R> & { readonly initialStatus: S["status"]; readonly turn?: true }, spec: {
    conversationId: Id; state: S; after?: Id[]; background?: true; owns?: Id[];
  }): Id {
    const id = this.seq + 1;
    if (spec.state.status !== kind.initialStatus) throw new Error(`initial status must be ${kind.initialStatus}`);
    const role = getOrThrow(kind.roles[spec.state.status]);
    this.push({ type: "task", task: { id, kind: kind.kind, role, turn: kind.turn, ...spec } });
    return id;
  }
  patch(task: Task, status: string, payload: JsonObject) {
    if (Object.hasOwn(payload, "status")) throw new Error("payload must not include status");
    const role = this.roleFor(task.id, status);
    if (role === "terminal") throw new Error(`${status} requires settle`);
    this.push({ type: "patch", id: task.id, role, state: { ...payload, status } });
  }
  settle(task: Task, status: string, payload: JsonObject) {
    if (Object.hasOwn(payload, "status")) throw new Error("payload must not include status");
    if (this.roleFor(task.id, status) !== "terminal") throw new Error(`${status} is not terminal`);
    this.push({ type: "settle", id: task.id, role: "terminal", state: { ...payload, status } });
  }
  private roleFor(id: Id, status: string): TaskRole {
    /* kind from transaction view; reject unknown status and reserved orphaned */
  }

  getTask = this.storage.getTask; getTasks = this.storage.getTasks;   // reads: committed state
  getEntry = this.storage.getEntry; getEntries = this.storage.getEntries;

  batch(): CommitBatch { return { kind: "main", writes: this.writes }; }
}

// The line owns admission, persistence, indexes and decisions; callbacks run afterward.
async commit<T>(plan: (tx: Tx) => T | Promise<T>, call: Call): Promise<T> {
  const completed = await this.line.run(async () => {
    const invocation = call.value(invocationKey);
    this.checkAdmission(invocation);               // phase, exact running identity, method and mark (§6.3)
    const tx = new Tx(this.storage, this.kinds);
    const result = await plan(tx);
    const batch = tx.batch();
    this.validate(batch, invocation);              // whole-batch authority and structural invariants
    if (batch.writes.length === 0) return { result, actions: [] };
    await this.storage.commit(batch);
    const actions = this.driver.applyBatch(batch); // apply ALL writes; then reserve affected work/waiters
    this.publishState(batch, actions);             // fold views, enqueue delivery; no listener execution
    return { result, actions };
  });
  this.dispatch(completed.actions);                // start effects, signal controllers, deliver callbacks
  return completed.result;
}
```

`ConversationTx` 是同一东西，只是 `conversationId` 已绑定。`ScratchTx` 是
`value`/`list` 那一半，批次被标记为 `scratch`。Builders 可以是异步的，以便在该线
上 await storage reads；没有其他 line operation 可以插入。读取（包括
Tx/ScratchTx 的 value/list/entry/task 读取）返回 Promises；写入是同步的、被缓冲
并按顺序验证。绝不要在 builder 内部 await 一个外部 effect、一个 driver waiter 或
另一个 line operation。Ids 在被返回时就是最终的，而一次 throw 会丢弃一切。外层
promise 在持久化与发布之后以闭包的值 resolve，那时 ids 才可以逃逸。
`ConversationHandle.commit` 绑定该 conversation；`TaskRuntime.commit` 对 task 代
码是同一东西。

### 9.3 Task 与 tool 集成

```ts
interface Tool<TParams, TDetails extends JsonValue> {
  readonly name: string; readonly description: string; readonly parameters: JsonSchema<TParams>;
  readonly output?: ShellOutputLimits;               // retained window for text output
  readonly replay?: "safe" | "never";
  execute(toolCallId: string, params: TParams,
          out: ToolOutput<TDetails>, runtime: ToolRuntime, call: Call): Promise<void>;
}

// the sink; everything a tool produces goes through it (mobile-handoff/01-harness/04-tool-output)
interface ToolOutput<TDetails extends JsonValue> {
  write(text: string): void;                         // append to the text block
  image(image: ImageContent): void;                  // images are never windowed
  replace(text: string): void;                       // replace the retained text wholesale
  capture(metadata: ShellOutputMetadata): void;      // truncation totals / spill path, no text resent
  readonly details: TDetails;                        // the tool's own details object; mutate it
  usage(usage: Usage): void;                         // accumulates
  addTools(names: string[]): void;                   // replaces; post_tools updates selected tools (§5.5)
  terminate(value: boolean): void;                   // replaces; orthogonal to how execution ended
  handoff(message: string): void;                    // replaces; new_context asks for a reset (§8.3)
  delegate(job: Id): void;                           // this call's work continues as that job (§8.6); generic, so UIs can follow it
  diag(severity: "info" | "warn" | "error", message: string, code?: string): void;   // commentary, see below
}

interface ToolRuntime {
  readonly taskId: Id;                               // the tool task; identity for origin/for links
  readonly budgetMs: number;                         // blocking budget (§8.3)
  readonly env: ExecutionEnv;                        // FileSystem & Shell
  commit<T>(plan: (tx: ConversationTx) => T | Promise<T>, call: Call): Promise<T>;
  conversation(id: Id, call: Call): Promise<ConversationHandle | undefined>;
  abortTask(id: Id, call: Call): Promise<void>;
  waitForTask(id: Id, options: { budgetMs?: number } | undefined, call: Call): Promise<boolean>;
  jobOutput(id: Id, call: Call): Promise<ShellOutputView & { exitCode?: number }>;
}

// what the live sink folds to; recorded on the tool task and used to build the result entry
interface ToolOutputState {
  content: (TextContent | ImageContent)[];
  details: JsonValue;
  usage?: Usage;
  addedTools?: string[];
  terminate: boolean;
  handoff?: string;
  delegated?: Id;
  diags: readonly { severity: "info" | "warn" | "error"; message: string; code?: string }[];
  truncation: ShellOutputTruncation;                 // totals over everything ever written
}

type ToolResultData = Omit<ToolOutputState, "content">;
```

`execute` 不返回任何东西，并通过抛出报告失败；harness 在它 reject 时设置
`isError`，而一个 tool 可以抛出任何东西。`terminate` 与执行如何结束正交，因此一
个失败的 tool 仍然可以停止该 turn（`out.terminate(true); throw error`）。Usage
与 `addTools` 通过 sink 而不是通过返回值传递，这样一次被重放的 tool 可以从持久
state 播种。sink 拥有它的 scratch promises：它处理预期的 post-mark/close
rejections，报告真正的 persistence errors，并在 invocation 返回之前 drain
pending callbacks。原始 plugin scratch writes 必须被 await/catch。sink 的 text
ops（`write`、`replace`，以及 env 为一个移动的 tail 发出的 `slide`）就是 scratch
与 watch stream 所携带的内容，因此一个 UI 无需该 tool 做任何事就能实时显示输出。

**Diagnostics 是一个通道，不是 text。** 关于一次 call 的评论（它被截断了、输出
spill 到了文件、路径被以不同方式 resolve、文件自读取以来在磁盘上发生了变化、搜索
在 500 个匹配处停止）通过 `out.diag` 传递，绝不进入 model 作为该 tool 的 data 所
读取的 text。harness 发出它自己拥有的那些：sink 在它截断或 spill 时自己调用
`diag`，path resolver 在它纠正路径时，blocking budget 在一次 call 作为 job 继续
时。一个 tool 只添加它独自知道的东西。Tool settlement 先渲染 data，然后在其后渲
染 diagnostics，带分隔，并把该 message 存储在 result entry 上：

```text
…last line of the file
<harness>
[warn] output truncated: 2,000 of 51,204 lines shown; full output at /tmp/pi/out-4421.log
</harness>
```

因此 model 可以把 tool output 作为 data 解析，一个 plugin 可以后处理它而无需剥离
它不认识的 notices，而一个 UI 按 severity 把 diagnostics 渲染为 callouts。
`isError` 说明该 call 是否失败；一个 `warn` diag 不会改变它。Tool settlement 把
精确渲染出的 result 存储为 entry `model`；`ToolOutputState` 的非 message 字段成
为 `ToolResultData`，用于 typed 逻辑与渲染。因此 transcript 精确记录了 model 所
看到的评论，而无需把该 message 复制进 `data`。

### 9.4 Watch

传输层是 commit stream，无间隙且可重放。接口是由 harness 从它派生的 typed events，
以及一个 harness 保持为最新的 view，因此客户端只渲染而从不解析 commits：

```ts
interface WatchHandle<View, Event> {
  readonly view: View;                     // captured on the line at watch(); folded before each event is delivered
  start(listener: (event: Event) => void): void;   // delivers everything since the capture, then live
  resnapshot(call: Call): Promise<View>;   // fresh capture, same subscription (when lagging)
  unsubscribe(): void;
}

interface ConversationView {
  readonly conversation: Conversation;
  readonly entries: readonly Entry[];      // the last `tail` entries; older ones via entries(id, { before })
  readonly context: readonly Id[];         // the derived context, as ids
  readonly tasks: readonly Task[];         // live tasks, typed by kind (retry attempt, deferred handle, ToolOutputState ... in state)
  readonly inbox: readonly Element<QueuedInput>[];
  readonly values: ReadonlyMap<Address, JsonValue>;   // every value the registered kinds declare in config, plus any asked for
  readonly previews: ReadonlyMap<Id, JsonValue>;      // per live task: the kind's tracked preview (§5.2)
  readonly faulted: boolean;
  readonly readAt: Id;
}

type InboxOp =
  | { readonly type: "append"; readonly item: Element<QueuedInput> }
  | { readonly type: "remove"; readonly id: Id }
  | { readonly type: "clear" };

type ConversationEvent =
  | { type: "entry";        entry: Entry }
  | { type: "task_start";   task: Task }
  | { type: "task_update";  task: Task; previous: Task }
  | { type: "task_end";     task: Task }
  | { type: "task_output";  task: Id; ops: readonly DeltaOp[] }           // ops on the task's preview; applied to view.previews
  | { type: "value";        addr: Address; value: JsonValue | undefined }
  | { type: "inbox";        ops: readonly InboxOp[] }
  | { type: "context";      ids: readonly Id[] }                  // a head or edit changed derived context
  | { type: "fault";        error: unknown } | { type: "closed" };

const w = await h.watch(c.id, { tail: 100, values: [myPlugin.config.mode] }, call);
render(w.view);
w.start(event => render(w.view, event));    // w.view is already folded when the listener runs
```

view 是权威的，而 events 是唤醒：一个 renderer 是 `apply(view)`，与它上一次绘制
的内容做 diff（entries 按 id 键控，tool components 按 task id 键控），并且它可以
忽略一个 event 的 payload 而仍然正确。payload 用于在热路径上跳过工作（`task_output`：
从一个 component 的 preview 重绘它），以及用于 logs 与 tests。

因为每一块工作都是一个已知 kind 的 task，这四个 task events 携带了 lane harness
需要为每种情况命名一次的东西，并覆盖 plugin kinds 而无需任何人添加：

| lane event | v3 |
|---|---|
| run_start / run_end | `generationKind.is(task)` 处的 task_start / task_end |
| retry_scheduled, run_suspend | task_update，state 中带 status `retry_wait`（attempt, notBefore）/ `deferred`（handle） |
| message_update | generation 上的 task_output；`view.previews` 持有 partial assistant message |
| tool_start / tool_update / tool_end | tool task 上的 task_start / task_output / task_end；state 中有 `ToolOutputState` |
| compaction_start / compaction_end | `collapseKind.is(task)` 处的 task_start / task_end；state 中有 reason 与 summary id |
| navigation_start / end | 一个被创建的 conversation（session watch）；带 `abort` 时，source 上 task_end aborted |
| config_update, value_update | value |
| queue_update | inbox |
| entry_added, message_end | entry |

Events 按 commit 交付，按 commit order，一个 commit 的所有 events 都在下一个的任
何 events 之前，因此一个 terminal task 与其后继者永远不会显示为 idle gap。
`watch` 在该线上的一个串行步骤中捕获 view 并注册 subscription，因此没有东西落在
两者之间。Task-output watch events 只作为 Chord delta ops 传输；持久 scratch 使
用普通 records（§7.4）。对于 watch delivery，折叠后的 preview 存在于 view 中，绝
不在 event 中。`resnapshot` 在 delivery tail 上标记一个 barrier，同时该线持有新
的 capture，因此从 listener 内部调用它既不会死锁，也不会重新折叠过期的 state。
Buffering 是有界的；一个落后的客户端得到一个 `fault` 并调用 `resnapshot`。一个
listener 从不在同一条线上 await 一个 commit。

Events 与它们的变更成正比，而 view fold 是一个通用 reducer，
`applyEvent(view, event)`，由 harness package 导出且不需要 kinds：追加 entry，
upsert task，把 task-output ops 应用到 `previews[task]`，应用 inbox ops，设置
value。Inbox 操作在一个 commit 内被折叠后才交付，因此一次 idle acceptance 的同
commit append 与 remove 不发出 inbox event。harness 用它维护 `w.view`，而另一个
进程中的 UI 在相同的 events 上运行相同的 reducer；没有任何东西为 wire 重新 diff：

```ts
// worker                                                    // ui process
const w = await h.watch(c.id, { tail: 100 }, call);                on("view",  m => { view = m.view; ui.apply(view); });
send({ type: "view", view: w.view });
w.start(e => send({ type: "event", event: e }));             on("event", m => { applyEvent(view, m.event); ui.apply(view, m.event); });
```

复制契约，以便另一种语言中的 reducer 不会漂移：一个 commit 的 events 作为一条
message 传输；一个 `Address` 序列化为一个规范 string key；而 preview ops 是
Chord delta ops（`packages/chord/src/delta`，mobile-handoff `01-delta`）：`r`
replace、`s` set、`d` delete、`a` append、`t` truncate、`p` splice，其中 wire
codec 的 interning 对瘦客户端是可选的。那个 applier 已经是 mobile port；reducer
在它之上添加它的十个 cases，而 harness package 的实现是参考实现，通过先移植
`delta.test.ts` 来测试。

`task_output.ops` 是对该 task 的 *preview* 的操作，preview 是一个 Chord delta
tracker，kind 就地修改它（`runtime.preview.state`）：generation 把每个 stream
event 应用到一个被追踪的 partial message，tool 的 preview 是 sink 的被追踪 state，
job 的也一样。harness 在每次 scratch commit 之后 flush 该 tracker；一个 streamed
token 是一个 `["a", path, delta]`，由 dirty paths 与一次 memcmp 计算而来，绝不是
一个被重算的对象（一个被重新赋值的 preview 会作为一次完整 replace 被 flush）。在
attach 或 reopen 时，harness 用 `preview.init(scratch)` 构建一次 preview，而第一
次 flush 就是 base。向多个进程内 watchers 的 fan-out 使用 `applyImmutable` 或复
制该批次，因为 `apply` 会采纳 `r` payloads。

lane 形状的 snapshot（`operation`、`runningTools`、`retry`、`deferred`、
`streamingMessage`）是 `view.tasks` 与 `view.previews` 的纯函数；想要它的
renderer 自己计算它。`h.watch(c.id, { raw: true })` 交付 commits 本身，供一个拥
有 harness 并运行该 fold 的接收者使用。

有一个 session-level watch，用于不属于单个 conversation 的东西：

```ts
interface SessionView {
  readonly conversations: readonly Conversation[];
  readonly values: ReadonlyMap<Address, JsonValue>;     // session-scoped: pi.usage.totals, pi.session.name, ...
  readonly faulted: boolean;
  readonly readAt: Id;
}
type SessionEvent =
  | { type: "conversation"; conversation: Conversation; change: "created" | "deleted" }
  | { type: "value";  addr: Address; value: JsonValue | undefined }
  | { type: "usage";  row: UsageRow; totals: Usage }
  | { type: "report"; task?: Id; kind?: string; method?: string; error: unknown } // hook/task errors
  | { type: "fault";  error: unknown } | { type: "closed" };
harness.watch(call: Call): Promise<WatchHandle<SessionView, SessionEvent>>;
```

### 9.5 End to end

```ts
const h = await Harness.open(storage, options, call);
const c = await h.root(call);
const w = await h.watch(c.id, { tail: 100 }, call);  render(w.view);  w.start(e => render(w.view, e));

const answer = await c.prompt({ input: "Inspect the parser" }, call);

const driving = c.drive(call);  await c.abort(call);  await driving;      // durable intent, then cleanup

const child = await c.spawn({ prompt: "Inspect only tests", context: "fresh",
                              values: { inherit: [model] } }, call);
await h.drive(call);                                                  // drives the child too
console.log(await h.conversation(child, call));

const alt = await c.fork({ at: answer.id }, call);
await alt.prompt({ input: "Try a different implementation" }, call);        // source remains untouched

w.unsubscribe(); await h.close(call);
```

```ts
const h = await Harness.open(storage, {
  models,
  tools: [readTool, writeTool, bashTool, ...pluginTools],     // subagent and job tools are built in
  kinds: { entry: pluginEntryKinds, task: pluginTaskKinds },  // added to the built-ins
  replace: { generation: myGenerationKind },                  // swap a built-in by name; same statuses, hook names
  rootValues,
}, call);
h.kinds.generation;  h.kinds.tool;  h.kinds.postTools;  h.kinds.collapse;  h.kinds.job;   // whatever is registered under the name
```

内置的 entry kinds（`user`、`assistant`、`tool_result`、`system`、`notice`、
`summary`、`handoff`、`reset`）与 task kinds（`generation`、`tool`、`post_tools`、
`collapse`、`job`）由 `open` 自身注册，因为 `accept`、`prompt`、`queueInput` 与
`collapse` 需要它们来写入并类型化新 records。读取 context 不需要 entry kinds。一
个 task-kind replacement 以内置者的名字注册，并且必须理解它持久化的 statuses 并
保留它的 hook names，这样既有的 handlers 继续工作；一个委托给原始者的 wrapper 是
通常的形态。`h.kinds.<name>` 是 handles 与 plugins 引用当前已注册者的方式，因此
`c.settings` 是正在使用的 generation kind 的 config，而不是某个特定 import 的。

`Harness.open` 接收 storage、models、tools、额外的 kinds、replacements、section
definitions 与初始 root values。它只为空 storage 创建 root，并在同一 commit 中初
始化 `rootValues`；在 reopen 时它忽略那些初始 values 并保留持久配置。Tool
registration 永远不会隐式地选择 tools。host 为一个全新的 root 显式提供
model/thinking/selectedTools，或在 generation 之前配置它；缺失必需的配置会报告一
个错误。Children 只继承其 spawn policy 所选中的 values；历史 forks 在其 entry
cutoff 处继承可回退 values。Reopen 从不通过推断创建工作。

### 9.6 可变的 kind 与 section registration

构造时接受初始的 `kinds: { entry: [...], task: [...] }` 与 `sections: [...]` 集
合。内置 section tokens 在初始时被注册；它们的内容由 host hooks 提供。这些是初始
值，而不是不可变 registries：

```ts
await h.entryKinds.register(noteKind, call);
await h.entryKinds.replace(noteKindV2, call);
await h.entryKinds.remove(noteKind.kind, call);

await h.taskKinds.register(reminderKind, call);
await h.taskKinds.replace(reminderKindV2, call);
await h.taskKinds.remove(reminderKind.kind, call);

await h.sections.register(policySection, call);
await h.sections.replace(policySectionV2, call);
await h.sections.remove(policySection.key, call);
```

registry 方法保留所提供的 kind/section generics。`register` 拒绝一个已存在的
name；`replace` 要求一个已存在的兼容 definition（否则迁移）；`remove` 移除的是代
码，而不是存储的 entries/tasks/section values。所有变更在该线上串行化。既有的
task calls 与 section preparations 保留它们捕获的实现；未来的使用当前
registrations。显式的 section-renderer replacement 把该 section 标记为在稍后的
preparation 中重算；绝不要重写旧的 entries，也不要从一个更旧的 preparation 清除
一个更新 replacement 的 pending work。

移除一个 section definition 不会移除它的 instructions。历史读取与未被触碰的
seeded sections 使用存储的 rendered text 而无需该 renderer。再次注册它会恢复
typed editing。只有在 preparation draft 上的 `sections.delete(tokenOrKey)` 才请
求持久 section removal。稳定的 string keys 跨重启；function objects 与 token
identity 不会被序列化。可变 draft 是一个本地 hook API，不是 JSON wire DTO；一个
最终的 remote-plugin adapter 必须提供一个显式的 contribution/edit protocol，而不
是序列化 token renderers 或 draft callbacks。

Task-kind removal 在该 kind 的 live tasks 存在时会 reject。在 open 时，缺失的
task kinds 遵循 §6.4：foreground tasks 变成 terminal `orphaned`；background
tasks 保持 parked，直到 registration 恢复它们的 recovery implementation。
Registration 不会复活 orphaned 或其他 terminal tasks，也不会隐式 attach 一个
drive scope。

## 10. Validation

### 10.1 Backend conformance

一个经过验证的 mutation stream 被重放进 memory、JSONL（close、reopen）与 SQLite
（close、reopen），在以下方面比较：当前 objects 与 live-task metadata、
transcript pages 与继承的 prefixes、若干边界处的 derived contexts、value
tombstones 与 list clears、request keys、scratch lifetimes、下一个被分配的
sequence。随机化的小历史加上显式的 deep-fork 情形：delete 前后 fork、clear 前后
fork、更晚的 summary 之前 fork、嵌套 source cutoffs、不被历史读取触碰的 sticky
state。

### 10.2 Failure 与 concurrency

| Scenario | Required |
|---|---|
| 构造之后持久化暂停 | readers 看到旧的完整 state |
| Accept commit 持久化，回复丢失 | `acceptance(requestId)` 返回原始的 conversation/input id |
| 一个批次中有 main 与 scratch 写入 | reject，不写入任何东西 |
| JSONL 末行撕裂 | 只丢弃那一行 |
| 畸形的完整行 | open 失败；不静默截断 |
| Retirement 已提交，unlink 失败 | 旧 scratch 不可见 |
| effect 在 abort 开始时返回 | 每个 task 一个 invocation；只有返回之后才有新的 abort |
| Post-mark 的 main/scratch 写入 | 在 builder 之前 reject；sinks 处理 cancellation 并 drain callbacks |
| Status cycle 回到初始 status | epoch 计入中间已提交的变更；不产生虚假 fault |
| Host patch 一个 owned task | reject lifecycle/state mutation；abort marks 仍然允许 |
| 100,000 个历史 children，两个 live tasks | 只查询 live seed/所需 ancestry，不遍历历史 |
| 重复 drive 与被取消的 waiter | 一个 attachment；恰好一次移除 waiter/listener |
| 已知的 dependency self-drive | 在 acceptance 或创建环的 admission 之前 reject |
| Close 与 task commit | 更早的 commit 完成；更晚的 mutation reject；completion 仍被接纳 |
| Shutdown 与 accept / idle nextRun inbox | 在 mark batch 之前 accept 或 reject；queued items/results 被保留 |
| Shutdown 在 child cleanup 之前崩溃 | 重新打开后的 abort 只 mark tasks；child queues 保持不变 |
| Main 100，live scratch 到 150，崩溃 | reopen 恢复 lastSeq=150；下一次写入=151 |
| Retired scratch 仍在磁盘上 | 即使畸形也忽略它；之后的 main settlement 覆盖它的 sequences |
| Parent cleanup 与已 terminal 的 job | 已经结束就是成功的 cleanup |
| 损坏的 abort handler | reject drives/shutdown，signal/join 并 close；在 recovery 前替换 kind |
| 并行 tools 以任一顺序 settle | post_tools 只启动一次 |
| Abort 与 post_tools settlement | 没有 unmarked 的后继者 |
| Child 在其 owning tool 被 mark 时结束 | tool settle 为 aborted，而不是 done |
| 两个重叠的 drives | 每个 task 一次 execution |
| 一个 drive 调用者取消它的等待 | 其他调用者与 tasks 不受影响 |
| Summary 在竞争性 head/reset 之后落地 | 作为 stale 被拒绝；其间的 edits 不会使它 stale |
| 同一个 inbox item 的 withdraw 与 land | 在该线上一个胜出；一个 terminal input result |
| Abort 与 generation/post_tools group transfer | 每个活跃 input 恰好 resolve 一次；没有 unmarked owner 逃逸 |
| 若干 inputs 共享一次 generation | 每个 result 都指向同一个 final answer entry |
| Overflow retry 与 collapse 运行 | 没有 live task 等待该 collapse |
| Watch registration 与一次 commit 竞速 | base 包含它，或 stream 交付它 |

Faux providers、fake processes 与 clocks、storage barriers；每一场竞速的两种顺序；
失败的 commits 不消耗 ids；旧的 task ids 在 compaction 之后仍然可查询。

### 10.3 Performance

Workloads：许多带 tool 与不带 tool 的短 turns；频繁 compaction 加上 cold reopen；
并行与串行 tools；大的 streaming output；带重复历史读取的 deep forks；许多已结束
的 child conversations 而只有少量 live tasks；许多 live background tasks；
queued input 与 cancellation。度量 CPU、wall latency、RSS 与 heap、磁盘上的字节
（包括 scratch 与 WAL）、query counts 与 rows decoded。把 backend-owned memory
与 live execution data 分开报告；JSONL 随历史增长是预期的，SQLite 不得保留一份全
历史副本。

pico2 原型在 2,000 个 faux turns 上 9.7 s 对 35.9 s，是用同样的方式度量这个设计
的理由，而不是它的结果。它的教训就是上面那些：廉价的 live queries、批量读取、小
写入、热路径上不做历史扫描。
