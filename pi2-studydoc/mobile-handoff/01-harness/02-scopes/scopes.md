# Session Storage：Scopes

> **状态：** 设计证据。可执行的 Step 1 契约是 [`implementation-handoff.md`](implementation-handoff.md)，它在 sequence 分配、可复用 scope ID、retirement 权威/记录、sidecar 布局、实现顺序，以及把 JSONL encoding 分离到 Step 2 上取代本文档。
>
> **Scope：** `packages/agent/src/harness/session/`，加上 §10 中列出的
> `runtime/` 中的调用点。
>
> **依赖 [01-delta](../01-delta/delta.md)**，以获取 pending state 所存储在其中的已落地 Chord op 词汇表（§2、§11）以及记录编码所携带的 `WireOp` 形态（§12）。二者
> 在其他方面是独立且叠加的：encoding 缩小每一次写入，scopes
> 把一类写入完全移出 main log。
>
> 这里的每一项主张都已对照 `runtime/lane.ts`、`runtime/progress.ts`
> 和 `runtime/drive/*.ts` 检查过。§6 中的类型级强制用
> `tsc --strict` 验证过，包括 mixed-scope commit 是它*唯一*
> 拒绝的东西。

## 1. 问题

Operation state — pending tool output、pending assistant output — 只在
operation 运行期间才重要。它是崩溃恢复的脚手架，不是历史。

JSONL 日志是 append-only 的，所以它无论如何都会持久化。更糟的是，删除它*增加*
记录：`deleteValue` 和 `deleteList` 各写一行，而那些行也会
持久化。今天只有一次完整的 snapshot 重写才能回收空间，而且不存在原地
compaction（`jsonl/storage.ts` 有 `createFromSnapshot`，用于 fork）。

在 20 个 operation 上测量，每个 operation 400 个 assistant frame 加上 2 个 tool，在
一个 50 KB 窗口的 60 个 checkpoint 上：

| | 大小 |
| --- | --- |
| 总 JSONL | 93.89 MB |
| 已 settle 的 transcript entry — 真正是历史的那部分 | **0.06 MB** |

这个文件有三个数量级都是已完成 operation 的脚手架。

**两个独立的修复，它们不是替代方案：**

- **Encoding**（[delta.md](../01-delta/delta.md)）：value 写入携带 Chord ops 而不是整值，且地址被 intern。把同样的工作负载降到**单文件 5.32 MB**，原子性不变。op 词汇表和 flush 时 tracker 已落地；storage 集成尚未。
- **Scopes**（本文档）：pending state 完全离开 main log，所以它
  从一开始就永远不是历史。

先做 encoding。Scopes 值得做，因为每 20 个 operation 仍有 5.32 MB 的死重
在累积，而且没有 compaction pass 来回收它。

## 2. 地址上的 Scope

Scope 有两个不得混淆的一半：一个不携带任何
数据的**类型级 tag**，和一个命名文件的**运行时 scope id**。

```ts
export type SessionScope   = { readonly kind: "session" };
export type EphemeralScope = { readonly kind: "ephemeral" };
export type Scope = SessionScope | EphemeralScope;

// Passing a scopeId is what makes an address ephemeral.
export function value<T>(namespace: string, key: string): Value<T, SessionScope>;
export function value<T>(namespace: string, key: string, scopeId: string): Value<T, EphemeralScope>;

export function list<T>(namespace: string, key: string): ValueList<T, SessionScope>;
export function list<T>(namespace: string, key: string, scopeId: string): ValueList<T, EphemeralScope>;

/** A main-log record retiring an ephemeral scope. See §5. */
export function retireScope(id: string): Write<SessionScope>;
```

后缀不是装饰：`Session` 已经命名了
`harness/session/types.ts` 中的 session 接口，复用它会产生 `TS2440`/`TS2484` 以及
来自 `session/index.ts` 的一个有歧义的 re-export。

```ts
interface Value<T, Sc extends Scope = SessionScope> extends ScopedAddress<Sc> {
  readonly namespace: string;
  readonly key: string;
  /** Present iff Sc is Ephemeral. Routes the write and names the sidecar. */
  readonly scopeId?: string;
}
```

id 是一个普通的运行时字符串，因为它是一个 operation id — 在
运行时生成，类型系统无法获得。这恰恰是为什么 §6 能
静态地区分*session 与 ephemeral*，但无法区分*两个
不同的 ephemeral scope*：tag 在类型里，id 不在。

```ts
// Durable lists carry encoded batches; one encoder/decoder pair belongs to each value stream.
export const pendingToolOutput = (operationId: string, invocationId: string) =>
  list<WireOp[]>("pi.pending.tool_output", `${operationId}:${invocationId}`, operationId);

export const pendingAssistantOutput = (operationId: string, entryId: string) =>
  list<WireOp[]>("pi.pending.assistant_output", `${operationId}:${entryId}`, operationId);

export const operationToolMemo = (operationId: string, invocationId: string, name: string) =>
  value<JsonValue>("pi.op.tool_memo", `${operationId}:${invocationId}:${name}`, operationId);

// unchanged — no scopeId, so Session by inference
export const laneStateValue = (lane: string) => value<DurableLaneState>("pi.lane.state", lane);
```

**Scope 就是文件。** 一个 session-scoped 写入进入 main log；
一个 ephemeral-scoped 写入进入 `<session>.<scopeId>.jsonl`。

其他 backend 完全不需要 sidecar：in-memory 丢弃一个以 scope id 为键的 `Map`，
SQLite 发出一个 `DELETE ... WHERE scope = ?`。Scope 对它们只在作为
生命周期提示时才有意义。需要文件拆分的是 JSONL，而 §4 和 §5 中的
约束正来自那里。

## 3. 哪些地址是 scoped 的，以及为什么

边界是由**写入隔离**划定的，而不是由生命周期。

以“它随 operation 消亡”为理由把 `pi.op.*` 下的一切都划定 scope
看起来对，但其实错了。`lane.ts` 说明了为什么：**每一个** operation commit 都把
`operationState` 与 `laneState` 捆绑在一起。

```ts
// lane.ts:405/431, 659/660, 749/750, 1071/1072 — the same shape each time
writes: [
  ...decision.writes,
  setValue(operationStateValue(operationId), decision.operationState),
  setValue(laneStateValue(this.name), durableLaneState(...)),
]
```

这一对是协调 state：lane state 说 operation 处于第 N 步，
operation state 持有第 N 步的数据。把它们拆到不同文件会让一次
崩溃产生一个 lane，它认为自己处在数据不支持的位置。

**批量**值的行为不同。`openProgress` 恰好 commit 一次写入
（`runtime/progress.ts:51`），而 `pendingToolOutput` / `pendingAssistantFrames`
在多写入事务中只作为*delete*出现。

| | 地址 |
| --- | --- |
| **ephemeral (sidecar)** | `pi.pending.tool_output`、`pi.pending.assistant_output`、`pi.op.tool_memo` |
| **session (main log)** | `pi.lane.state`、`pi.op.state`、`pi.op.meta`、`pi.result`、`pi.pending.entry`、`pi.branch.tip`、`pi.op.tool_args`、`pi.op.preparation` |

`operationToolMemo` 是 ephemeral 的，这样 `harness-tools.md` §7.5 中的
memo-plus-checkpoint 捆绑就是一个单文件事务。`terminal.ts:34` 已经
把 `operationToolMemoPrefix` 和 `pendingToolOutputPrefix` 当作同一个 cleanup
类，所以这与代码已经看待它们的方式一致。

把 `operationState` 留在原处不影响大小的收益：实际上 §1 中
93.89 MB 全都是 pending tool 和 assistant output。

## 4. 两个文件不是原子的

在 Session 行上串行化给出的是**顺序，而不是原子性**。对两个描述符的两次
`write()` 调用，两次 fsync，没有跨越它们的 journal。其间的崩溃
会让文件不一致，而 JSONL 没有什么可以修复它。

所以本设计不试图让跨文件事务工作。它确保不存在
跨文件事务：

> **一个事务中的所有写入共享一个 scope。**

这是可实现的，因为代码已经如此 — 审计见 §5。

*不*需要跨文件 commit 的两个后果：

- **不需要文件之间的写入顺序。** 如果没有任何事务跨越文件，
  commit-record 模式（先 sidecar，fsync，然后一条 main-log 记录确认它）就是不必要的。
  没有任何东西需要确认。
- **仅 sidecar 写入不需要 commit marker。** 一个诱人的设计是为
  `openProgress` 加一条小的 main-log 记录，因为没有任何东西确认它的写入。它
  不需要：那个事务是一个文件中的一次写入，已经是原子的。被撕裂的
  尾部与 main log 中的处理方式相同 — 每一行都是一个完整的 op
  或一个完整的 batch，所以读者在最后一个完好的行处停止。

剩下的是一个**durability** 选择，而不是一致性选择：如果 sidecar 的
fsync 不那么激进，最近的 checkpoint 可能丢失。这与 checkpoint 间隔已经接受的
有界丢失相同，但它应该是一项刻意的策略，
而不是偶然。

## 5. 审计：现有代码满足该规则吗？

`lane.ts` 中的每一个 commit（12 处）以及
`runtime/drive/*.ts` 中的每一个 `writes:` 生产者（32 处）都被读过了。

**结果：是的，需要一处调整。** 没有事务写入两个文件。那些
跨越的情况全都是与 main-log 写入捆绑在一起的 ephemeral state 的*delete*：

- `response.ts:340` — settle commit：`insertEntry`、`insertUsage`、
  `setValue(branchTip)`，加上 `deleteList(pendingAssistantFrames(...))`。
- `terminal.ts:50` `operationCleanupWrites` — 把 main-log delete 与
  `toolMemos` 和 `toolOutputs` 的 delete 捆绑，返回到与
  `operationResultValue` 和 `laneStateValue` 相同的数组中。
- `tools.ts:230, 257` — 带 main-log 写入的 `deleteValue(pendingToolOutput)`。
- `deferred.ts:157` — `deleteList(pendingAssistantFrames)`。

**调整：retirement 变成一条 main-log 记录。**

```ts
retireScope(operationId): Write<SessionScope>
```

日志是真相；sidecar 文件是缓存。Recovery 读取 retire 记录
并忽略 — 然后移除 — sidecar。commit 之后急切地 unlink 是纯粹的
优化；失去 unlink 只会花磁盘，永远不会损失正确性。

这使上面所有四处都变成单 scope，因为那些单独的 ephemeral
delete 消失了。它还*简化*了 `operationCleanupWrites`：对
`operationToolMemoPrefix` 和 `pendingToolOutputPrefix` 的 `scanValues`
调用被一个 `retireScope` 取代。

而且它让 open 时 sweep 变得有原则而不是启发式。一个 sidecar
是死的当且仅当 main log retire 了它或它的 operation 不存在 — 不从
operation status 推断。

### 5.1 一个事务中的两个 ephemeral scope 不可能出现

一个 lane 持有 `operation: { meta, state } | null` — **单数**。每一个 write set
使用一个 `operationId`，要么是 `drive.operationId`，要么是
`startOperation` 中新创建的那个，后者断言没有 operation 处于活跃。Retire 和 start 始终是
单独的事务：`lane.ts:427` 和 `response.ts:339` 处的 settle commit
把 lane state 设为 `null`。

并发是跨 **lane** 的，而每个 lane 至多有一个活跃的 operation，所以
两个 ephemeral scope 永远不会在一次 commit 中相遇。§6 中的运行时断言是
针对未来变更的防御，而不是一个现存的缺口。

## 6. 静态强制

> **`scopes.variance.ts` 与本文档一同交付**，并且是
> 本节的可执行形式：`npx tsc --noEmit --strict --lib es2023 scopes.variance.ts`。
> 静默意味着规则成立。它的三行 `@ts-expect-error` 如果哪天开始通过类型检查，就会让
> 编译失败，所以它既能捕获强制被削弱，也能捕获强制被破坏。


两个 phantom 类型，区别只在于 `Sc` 出现的位置。这个区分是
承重的，也是这里最容易搞错的单一之处。

```ts
declare const storedScopeType: unique symbol;

/** Addresses: COVARIANT — Sc only in return position. */
export interface ScopedAddress<Sc extends Scope> {
	readonly [storedScopeType]?: () => Sc;
}

/** Writes: INVARIANT — Sc in both parameter and return position. */
export interface Scoped<Sc extends Scope> {
	readonly [storedScopeType]?: (scope: Sc) => Sc;
}

export interface Value<T, Sc extends Scope = SessionScope>
	extends StoredAddressBase, ScopedAddress<Sc> { … }

export interface ValueSetWrite<Sc extends Scope> extends Scoped<Sc> { … }
```

**它们为什么不同。** 读取一个地址在任何 scope 都是安全的 — `getValue` 不
关心一个值住在哪个文件里，所以在期望 `Value<T, Scope>` 的地方
`Value<T, SessionScope>` 必须可用。形成事务在任何 scope 都*不*安全，
因为两个文件不是原子的，所以一次 commit 必须确切钉住一个。

因此强制属于形成事务的地方，而不是读取地址的地方。
`setValue<T, Sc>(address: Value<T, Sc>, …): Write<Sc>` 是桥梁：它
从一个协变地址推断 scope，并把它盖到一个不变的写入上。

> **搞错这个代价很高。** 把地址也变成不变的会破坏每一个
> reader — `getValue`、`scanValues`、`readList` 以及下游的一切 — 并
> 在那些没有做错任何事的 storage backend 上产生了 36 个错误的级联。
> 那个诱人的变通方法，即让每个 reader 对 `Sc` 泛型以表示“任意
> scope”，会把一个类型参数传播穿过整个 storage 栈，来表达
> variance 免费给出的东西。

用 `tsc --noEmit --strict` 验证过。读取在两种 scope 下都通过：

```ts
getValue(laneState);        // Value<T, SessionScope>
getValue(pendingOutput);    // Value<T, EphemeralScope>
```

单 scope commit 通过：

```ts
commit([setValue(laneState, a), setValue(operationState, b)]);
commit([setValue(toolMemo, m), setValue(pendingOutput, o)]);
commit([setValue(laneState, a), retireScope("op_1")]);
```

Mixed-scope commit 失败，并且是*唯一*失败的东西：

```ts
commit([setValue(laneState, a), setValue(pendingOutput, o)]);   // ERROR
commit([setValue(pendingOutput, o), retireScope("op_1")]);      // ERROR
```

### 6.1 类型系统无法捕获的东西

两个不同的 ephemeral scope 都类型化为 `Write<EphemeralScope>`，因为 id
是一个运行时字符串（§2）。commit 时的一个运行时断言覆盖了它 — 比较
所有写入的 `scopeId` — 而根据 §5.1 它应该永远不会触发。

## 7. Recovery 与 sweep

在 open 时，与 main log 一同枚举 sidecar 并加载它们。它们的记录
像 main-log 记录一样参与 replay。

一个 sidecar 在 main log 为它持有一条 `retireScope` 记录时，或在
它的 operation 不存在时被移除 — 这是 commit 和 unlink 之间的崩溃。Torn-tail 语义
不变：每一行都是自包含的，所以写入中途崩溃恰好丢失
尾部那一行。

## 8. Sequence 号

Scoped 写入每个 scope 获得自己的 sequence 空间。scope 之外的任何东西
都不与它的内容排序，把它们分开意味着 main
header 中的 `nextSeq` 不需要计入那些将被删除的文件所消耗的号。

共享编号会在若干 operation settle 之后留下大的 gap，而
high-water mark 将需要单独的持久化。

## 9. 实测效果

与 §1 相同的工作负载：

| | 大小 | 占今天的 |
| --- | --- | --- |
| 今天，单 JSONL | 93.89 MB | — |
| ops + interned addresses，单 JSONL | 5.32 MB | 5.7% |
| **加上 scopes — main log** | **0.06 MB** | **0.06%** |
| — sidecar，settle 时退休 | 5.26 MB | 每个 operation 峰值 0.26 MB |

5.7% 这个数字是**依赖速率的，不得单独引用**：它在每个 checkpoint
2 KB tool output 时成立，并在超过上限时反转，那里整值
替换胜出。

scope 结果**不**依赖速率。main log 无论编码如何都持有已 settle 的 entry，
而那才是支配 session 文件增长的数字。

## 10. 现有代码中有什么变化

编译器会为你找到这些：一旦地址携带 scope 且 `Write<Sc>` 是
不变的，每一个在一个事务中混合 scope 的地方都无法通过类型检查。
这个列表是一次完整遍历所发现的，所以你知道什么时候做完了。

**新增，在 `session/values.ts` 和 `session/types.ts` 中**

`SessionScope` / `EphemeralScope` / `Scope`；§6 中的两个 phantom；
`Value<T, Sc>` 和 `ValueList<T, Sc>`；地址上的 `scopeId`；`value` /
`list` 重载；`retireScope`；保留 scope 的 `setValue` / `deleteValue` /
`appendList` / `deleteList`；`Write<Sc>`，其中 entry、usage 和 retirement
在构造上就是 session-only 的。

**泛型化**

`CommitDecision<TResult, Sc>`、`lane.command<TResult, Sc>`、`Storage.commit<Sc>`。
给 `Sc` 一个 `SessionScope` 的默认值：条件类型不是推断位置，
所以没有默认值时，一个混合数组会回退到约束 `Scope`，每一个
调用点都会失败。`settleOperation` 和 `continueOperation` 保持**非**泛型 —
见 §5。

**Committed 写入**

`CommittedScopeRetireWrite`，以及贯穿 committed shape 携带的 `scopeId`，以便
`JsonlStorage` 可以据此路由。

**必须改变的调用点** — 每一个当前都在一个事务中混合 scope：

| 位置 | 它今天做什么 | 它变成什么 |
| --- | --- | --- |
| `drive/terminal.ts` `operationCleanupWrites` | 通过 `scanValues` 枚举 tool memo 和 tool output，与 session delete 一起删除每一个 | 一个 `retireScope(operationId)`；它的四个扫描中有两个消失 |
| `drive/response.ts`（settle） | `deleteList(pendingAssistantOutput)` 与 operation state 捆绑 | 丢弃它 — sidecar 在 retire 时被丢弃 |
| `drive/deferred.ts`（superseded response） | 相同 | 相同 |
| `drive/tools.ts`（tool settle） | session 写入数组中的 `deleteValue(pendingToolOutput)` 加上 memo delete | 丢弃它们 |
| `drive/tool-placement.ts` | `deleteValue(pendingToolOutput)` | 丢弃它 |

处处模式相同：**ephemeral state 的 operation 内 cleanup
是不可能的**，因为那些 commit 也写入 operation 和 lane state。
sidecar 在 retire 时被整体丢弃。代价是一个多轮 operation
在 settle 之前持有被取代的 pending output — 以轮次为界，且永远不会
到达 main log。

**Storage**

`JsonlStorage.commit` 中的 sidecar 路由（断言每个事务一个 scope id，
路由 append），在 commit **之后**对一条 `scope` 记录 unlink，以及一个
open 时 sweep，它加载 sidecar 并移除 main log 已经退休的任何 sidecar。
In-memory 丢弃一个以 scope id 为键的 `Map`；SQLite 发出一个
`DELETE ... WHERE scope = ?` 并把一条 retire 记录当作 no-op，因为它
没有 sidecar，而 terminal 事务显式删除 scoped value。

**预期的测试变动**

九个测试断言旧的 cleanup write set，会失败 — `drive-terminal`（3）、
`drive-retry-deferred`（2）、`drive-tools`、`drive-reconcile`、`drive-generation`，
以及一个钉住 reserved namespace 的。它们期望六或七个单独的 delete，
而新代码发出更少的 delete 加一个 `retireScope`。那是这次变更落地，
不是回归。

## 11. List tag 与停止条件

被跟踪的 state 存储为一个 op batch 的列表（`delta.md` §9）。Recovery 需要“自
最后一个 base batch 以来的 batch”，而不解包每一行，这是 list 今天无法
表达的：`ListReadOptions` 只有 `cursor`、`order` 和 `limit`。

`BranchScan` 已经为 entry 解决了同样的问题，而它的词汇表
就是要照抄的那个 — `stopAtType` / `stopAtId` 用于终止符，普通字段名
用于过滤器。

```ts
appendList<T, Sc>(address: ValueList<T, Sc>, element: T, tag?: string): ListAppendWrite<Sc>;

export interface ListElement<T> {
  seq: number;
  value: T;
  tag?: string;
}

export interface ListReadOptions {
  cursor?: ListCursor;
  order?: "asc" | "desc";
  limit?: number;
  /** Include elements up to and including the first carrying this tag, then stop. */
  stopAtTag?: string;
  /** Return only elements carrying this tag. */
  tag?: string;
}
```

**`stopAtTag` 是一个页内的停止条件，而不是一个保证。** 它只能比
`limit` 更早地结束一页；它永远不覆写它。如果被标记的元素
不在页中，消费者看不到被标记的元素，并用 cursor 再次翻页 —
与 `readAssistantFrames` 已经运行的循环相同。两个界之间没有排序
问题，也没有“未找到”错误。

为了让那个循环工作，`readList` 必须在每个元素上返回 tag。否则
消费者无法在不解析值的情况下区分“页在 tag 处结束”与“页在 limit 处
结束”，而 tag 存在正是为了避免解析值。

**是生产者设置 tag，而不是 storage。** 对于一个被跟踪的值，调用者
已经知道，因为 `isBase(ops)` 是对第一个 op 的 token 比较
（`delta.md` §2）：

```ts
const ops = tracker.flush();
if (ops.length === 0) return;
writes: [appendList(address, enc.encode(ops), isBase(ops) ? "base" : undefined)];
```

Storage 永远不得检查一个元素来推导 tag。这正是让 op
batch 对 storage 层不透明的东西，也是让
`EntryScan.type` 工作的同一个性质：判别符是一个存储的列，而不是从
payload 推导出的东西。

**tag 位于 storage record 上**，在 `seq` 和 `value` 旁边：

```jsonc
["l",7,9,[["r",{…}]],"base"]        // per §12.1
```

Storage 永远不得解析一个元素来求值一个谓词。这正是让
ops 对 storage 不透明、让 durable 路径没有领域知识的东西
（`harness-tools.md` §7.7）。这也是 `EntryScan.type` 工作的原因：判别符
是一个存储的列，而不是从 payload 推导出的东西。

`order` 保持为 `"asc" | "desc"`，而不是 `BranchScan` 的
`"newestFirst" | "oldestFirst"`。Branch 顺序是语义性的 — 从 tip
穿过一棵树的遍历。List 顺序是基于 `seq` 的。借用 branch 的词会暗示一种
并未发生的遍历。

Backend：SQLite 得到一个 `tag` 列和一个真正的谓词。JSONL 已经把 list 持有在
内存中，所以它向后扫描并检查一个字段 — 不比今天差。
In-memory 同样。

这个原语泛化到 frame 之外：任何想要“自最后一个
checkpoint 以来的尾部”的 list 都能得到它。

## 12. JSONL 记录编码

两层中的两个字典。它们是同一个技巧且相互独立：**address**
字典基于记录上的 `namespace` + `key`；**path**
字典基于一个值的 ops *内部*的路径（`delta.md` §4）。

### 12.1 记录

```
["@", addrId, namespace, key]              address definition
["v", addrId, seq, wireOps]                value write   — WireOp[], delta.md §4
["l", addrId, seq, element, tag?]          list append   — element is WireOp[]
                                             for a tracked value
["x", addrId, seq]                         delete (value or list)
["!", addrId, seq]                         retire an ephemeral scope
```

**记录动词和 op 动词是在不同层级读取的独立词汇表**，
但它们不得看起来相似。retire 用 `!` 而不是 `r`：`r` 是 delta 的
replace op，而扫描文件的读者不应该为了知道一个元组的含义而必须记住
自己处在哪个嵌套层级。

Retire 像其他一切一样接受一个 address id，由一个 `["@", id, …]`
定义，其 namespace 是 scope。这为整个文件保持一条 interning 规则，
而不是为一条记录搞特例。

Entry 和 usage 行保持它们当前的 keyed 形式：它们只写一次，从不
重复一个地址，并由与 ops 无关的机制读取。

一个地址在它的**第二次**使用时被定义，与 path interning 一致 —
对一个只写一次的地址来说，定义是纯粹的开销，而一个 session 有许多
这样的地址。

### 12.2 完整示例

跨两个地址的四次写入，之前和之后。

```jsonc
// today — 1250 bytes
{"kind":"value","op":"set","seq":7,"namespace":"pi.op.state","key":"01a04cf6-…","value":{"at":"starting","control":{…},"settings":{…},"latestAssistantEntryId":null}}
{"kind":"value","op":"set","seq":8,"namespace":"pi.lane.state","key":"main","value":{"currentOperationId":"01a04cf6-…",…}}
{"kind":"value","op":"set","seq":9,"namespace":"pi.op.state","key":"01a04cf6-…","value":{"at":"checkpoint",…}}
{"kind":"value","op":"set","seq":12,"namespace":"pi.op.state","key":"01a04cf6-…","value":{"at":"assistant.ready",…}}
```

```jsonc
// with both dictionaries — 547 bytes
["@",0,"pi.op.state","01a04cf6-…"]
["v",0,7,[["r",{"at":"starting","control":{…},"settings":{…},"latestAssistantEntryId":null}]]]
["@",1,"pi.lane.state","main"]
["v",1,8,[["r",{"currentOperationId":"01a04cf6-…",…}]]]
["v",0,9,[["#",0,["at"]],["s",0,"checkpoint"]]]
["v",0,12,[["s","assistant.ready"]]]
```

| 行 | 之前 | 之后 |
| --- | --- | --- |
| address definition | – | 61 |
| op.state -> `starting`（base batch） | 353 | 256 |
| address definition | – | 31 |
| lane.state（base batch） | 181 | 114 |
| op.state -> `checkpoint` | 355 | **48** |
| op.state -> `assistant.ready` | 361 | **37** |
| **总计** | **1250** | **547**（44%） |

形态比总数更重要。Base batch 几乎不缩小 — 353 到 256 只是
信封，因为值无论如何都完整发送。转换塌缩约 8 倍，因为它们携带一个
变化的字段，而不是整个 state，包括那个从不变化的 `settings` 块。

两个字典都出现在第 5 行：`["v",0,9,…]` 中的 `0` 是一个 **address** id，
而 `["#",0,["at"]]` 在值的 ops 内部定义一个 **path** id。同一个技巧，
不同层级，独立的表。第 6 行随后完全丢弃路径 — arity
省略，因为它以该 batch 中前一个 op 的同一路径为目标。

**不要把 44% 当作文件级节省来引用。** 字典条目是一次性的，所以
一个真实 operation 的约 11 次 op.state 写入会摊薄它们，比率会改善；但
transcript entry 不受影响，它们在一次 67 KB 的重工具运行中占 18 KB。
应用到那里，这会影响约 27 KB 的 value 写入，并把文件降低
大约五分之一，而不是一半。

### 12.3 读取

读者在 replay 时构建两个表，所以一个被撕裂的尾部恰好损失
尾部那些行，且不需要重写 header。一次 snapshot 重写从全新的
表开始，并自然地重新发出定义。

一个从未见过其定义的数字 `addrId` 是一个损坏的文件，而不是一个
可恢复的 state — 不同于缺失的 path id，后者不可能发生，因为 path
定义与它们的第一次使用在同一条记录内。

## 13. 未决问题

- 跨并发 lane 的文件句柄压力，每个都有一个活跃的 sidecar。可能
  没问题，未测量。
- sidecar 的 fsync 策略（§4）— 与 main log 匹配，还是鉴于
  内容是有界丢失的脚手架而放宽。
- 一个长时间运行的 operation 是否应该轮换它的 sidecar。`rebase()`
  （`delta.md` §3.2.3）限制 *recovery* 长度，但不限制文件大小，所以一个
  运行数小时的命令仍然无界地增长它的 sidecar。
- 是否无论如何都值得为 main log 构建一个原地 compaction pass。
  `createFromSnapshot` 加上原子替换就是机制；scopes 减少需求，
  但没有移除它，因为被取代的 session-scoped 值仍在累积。
