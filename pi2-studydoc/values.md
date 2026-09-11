# 带类型的 value 与 list

本文档规定 Session、harness 与 application 所使用的可变存储原语。

公开抽象是一个 **bound typed address**：

- `value<T>(namespace, key?)` 命名一个可替换的 durable value；
- `list<T>(namespace, key?)` 命名一个 append-only 的 durable list，其元素类型为 `T`。

namespace/key 对在 address 构造时绑定一次。之后的每个操作只接收该 address。因此 application 代码写作：

```ts
const state = value<ApplicationState>("my-app.state");
const events = list<ApplicationEvent>("my-app.events");

await session.getValue(state, context);
await session.setValue(state, nextState, context);
await session.readList(events, { limit: 100 }, context);
await session.appendList(events, event, context);
```

它**不会**重复传入第二个未加说明的 key：

```ts
// Not the API.
await session.readList(events, "another-key", { limit: 100 }, context);
```

当 application 确实拥有 keyed instance 时，它为那个 instance 构造 address：

```ts
const workspaceEvents = (workspaceId: string) =>
  list<ApplicationEvent>("my-app.events", workspaceId);

await session.readList(workspaceEvents("pi"), { limit: 100 }, context);
```

Storage 可以物理地把该 address 索引为 `(kind, namespace, key)`，但该表示形式不会泄漏到每次 read 或 write 调用中。Storage、Session、harness 代码与 application 使用相同的 address 词汇。不存在全局 value-type map、dynamic registry、token catalog 或单独的 application-state storage 机制。

## 目标

1. 为一个确切的 durable address 赋予一个 compile-time value type。
2. 让 application 无需 declaration merging 或编辑核心 type map 即可定义 scalar value 与 list。
3. 从 Storage 到 Session 使用相同的 typed address 与 operation 名称。
4. 保留当前 scalar replacement 语义。
5. 追加一个 list element 而不读取或重写既有元素。
6. 为每个 list element 赋予其自身的、既有的 session-global transaction `seq`，用于排序与分页。
7. 把 value 与 list element 与 entry 和 usage 一起原子提交。
8. 在 Memory、JSONL 与 SQLite 上产生相同的逻辑行为。
9. 保持 list 读取有界且显式。
10. 保持 scalar operation 状态具有权威性；auxiliary list 绝不选择 recovery state。

## 非目标

本切片不定义：

- assistant-frame 内容或 reduction 语义；
- tool-progress 语义；
- 对受信任的 in-process value 的运行时校验；
- per-element 或 per-list 的字节上限；
- list truncation 或 per-element deletion；
- 通用的 event log、journal、stream-resumption protocol 或 operation reducer；
- 全局注册 address 对象；
- 向 tool 暴露原始 Session 或 transaction 访问。

consumer 拥有 address 构造、content limit、cleanup point、fork policy、migration policy 与 consumption-time hydration。`assistant-durability.md` 定义了第一个 list consumer。

## Bound address 模型

```ts
declare const storedValueType: unique symbol;

interface StoredAddressBase {
  /** Stable persisted grouping name. */
  readonly namespace: string;
  /** Exact member inside that grouping. Empty is legal. */
  readonly key: string;
  readonly kind: "value" | "list";
}

export interface Value<T> extends StoredAddressBase {
  readonly kind: "value";
  /** Compile-time only and invariant in T. */
  readonly [storedValueType]?: (value: T) => T;
}

export interface ValueList<T> extends StoredAddressBase {
  readonly kind: "list";
  /** T is one element, not the whole list. */
  readonly [storedValueType]?: (value: T) => T;
}

export function value<T>(namespace: string, key = ""): Value<T> {
  validateAddress(namespace, key);
  return Object.freeze({ namespace, key, kind: "value" });
}

export function list<T>(namespace: string, key = ""): ValueList<T> {
  validateAddress(namespace, key);
  return Object.freeze({ namespace, key, kind: "list" });
}
```

phantom function 使 `T` 不变：一个类型的 address 无法静默拓宽为另一个类型。它没有 runtime 字段。

规则：

- `namespace` 必须非空；
- namespace `pi` 以及每个 `pi.*` namespace 依契约为 built-in 保留；
- 构造保留 address 的 application 是有缺陷的受信任 in-process 代码；不存在 runtime privilege split、registry 或 catalog；
- 两个组成部分都不得包含 Memory backend 的内部分隔符（`\u0000`）；
- 空 key 是合法的，并且是一个 application-wide value 或 list 的自然 address；
- object identity 没有 durable 含义；
- 分别构造的、具有相同 `(kind, namespace, key)` 的 address 标识同一个 durable location；
- 用不兼容的 TypeScript 类型构造同一个 durable location 是受信任编程缺陷；
- 在一个 storage version 中，scalar 与 list address 不得共享同一个 `(namespace, key)`；违反这一点是受信任编程缺陷，storage 不执行 cross-kind collision 检查；
- 改变 address 的 namespace、key、kind 或不兼容的 value shape 需要 migration。

这两个组成部分保持分离而非拼接。因此，动态 application key 与 operation ID 除了 storage separator 规则之外不需要任何转义约定。

### 精确的 address，而非 family

一个 address 命名一个 value 或一个 list。当内部代码拥有动态 key 时，它使用小型 constructor：

```ts
export const branchTip = (lane: string) =>
  value<string | null>("pi.branch.tip", lane);

export const operationState = (operationId: string) =>
  value<OperationState>("pi.op.state", operationId);

export const operationToolArgs = (
  operationId: string,
  stepId: string,
  sourceIndex: number,
) => value<Record<string, JsonValue>>(
  "pi.op.tool_args",
  `${operationId}:${stepId}:${sourceIndex}`,
);

export const pendingAssistantFrames = (
  operationId: string,
  responseEntryId: string,
) => list<AssistantMessageFrame>(
  "pi.pending.assistant_frame",
  `${operationId}:${responseEntryId}`,
);
```

这把每种 key 语法封装在其所有者处。call site 接收一个已经绑定的 typed address：

```ts
await reader.getValue(operationState(operationId));
await reader.readList(pendingAssistantFrames(operationId, responseEntryId), options);
```

### 没有全局 value map

删除既有的全局 namespace-to-type map：

```ts
interface RegisterValues { /* delete */ }
interface ListRegisterValues { /* delete */ }
type RegisterNamespace = keyof RegisterValues; // delete
```

类型则属于某个 address constructor：

```ts
export const applicationState = value<MyApplicationState>("my-app.state");
export const applicationEvents = list<MyApplicationEvent>("my-app.events");
```

Application 应使用稳定、抗冲突的 namespace prefix。namespace `pi` 以及完整的 `pi.*` prefix 依契约为 built-in 保留；诸如 `pi2` 这样看起来相似的名称仍然合法。相同的 `value()` 与 `list()` constructor 同时服务于 core 与 application 代码。测试断言每个 built-in address 都使用其保留 prefix。不存在 runtime privilege split、registry 或 catalog。

## Built-in address

built-in constructor 一起位于 `packages/agent/src/harness/session/values.ts` 中，并由 consumer 直接导入。代表性定义：

```ts
export const branchTip = (lane: string) =>
  value<string | null>("pi.branch.tip", lane);
export const laneConfig = (lane: string) =>
  value<LaneConfiguration>("pi.lane.config", lane);
export const laneState = (lane: string) =>
  value<LaneState>("pi.lane.state", lane);
export const operationResult = (operationId: string) =>
  value<OperationResultRecord>("pi.result", operationId);

/** Used only by scanValues() to enumerate Branch names. */
export const branchTipInventoryPrefix = () =>
  value<string | null>("pi.branch.tip");

export const operationMeta = (operationId: string) =>
  value<OperationMeta>("pi.op.meta", operationId);
export const operationState = (operationId: string) =>
  value<OperationState>("pi.op.state", operationId);
export const operationToolArgs = (operationId: string, stepId: string, sourceIndex: number) =>
  value<Record<string, JsonValue>>(
    "pi.op.tool_args",
    `${operationId}:${stepId}:${sourceIndex}`,
  );
export const operationToolMemo = (operationId: string, invocationId: string, name: string) =>
  value<JsonValue>("pi.op.tool_memo", `${operationId}:${invocationId}:${name}`);
export const operationPreparation = (operationId: string, taskId: string) =>
  value<DurableStructuralPreparation>(
    "pi.op.preparation",
    `${operationId}:${taskId}`,
  );

/** Prefix addresses are exported only for namespace-scoped scanValues(). */
export const operationToolArgsPrefix = (operationId: string, stepId?: string) =>
  value<Record<string, JsonValue>>(
    "pi.op.tool_args",
    stepId === undefined ? `${operationId}:` : `${operationId}:${stepId}:`,
  );
export const operationToolMemoPrefix = (operationId: string, invocationId?: string) =>
  value<JsonValue>(
    "pi.op.tool_memo",
    invocationId === undefined ? `${operationId}:` : `${operationId}:${invocationId}:`,
  );
export const operationPreparationPrefix = (operationId: string) =>
  value<DurableStructuralPreparation>("pi.op.preparation", `${operationId}:`);

export const pendingEntry = (entryId: string) =>
  value<PendingEntry>("pi.pending.entry", entryId);
export const pendingToolOutput = (operationId: string, invocationId: string) =>
  value<AgentToolResult<unknown>>(
    "pi.pending.tool_output",
    `${operationId}:${invocationId}`,
  );
export const pendingAssistantFrames = (operationId: string, responseEntryId: string) =>
  list<AssistantMessageFrame>(
    "pi.pending.assistant_frame",
    `${operationId}:${responseEntryId}`,
  );
export const pendingToolOutputPrefix = (operationId: string) =>
  value<AgentToolResult<unknown>>("pi.pending.tool_output", `${operationId}:`);

export const sessionName = value<string>("pi.session.name");
export const entryLabel = (entryId: string) => value<string>("pi.entry.label", entryId);
```

`OperationMeta` 是存储在 `pi.op.meta` 的不可变 acceptance metadata。process-local 的 `Operation` projection 是 `{ meta: OperationMeta, state: OperationState }`，由分开的 metadata 与 state value 组装而成；它绝不存储在单个 address 上。

五个导出的 scan-prefix constructor 是 `branchTipInventoryPrefix`、`operationToolArgsPrefix`、`operationToolMemoPrefix`、`operationPreparationPrefix` 与 `pendingToolOutputPrefix`。它们的 address 只被 `scanValues()` 消费。

Application 直接定义自己的 `value()` 与 `list()` address；不存在内置的 custom application-state namespace 或 custom-state API。`AgentHarnessToolInvocation.getMemo()` 与 `setMemo()` 是作用于 `operationToolMemo(...)` 的 invocation-fenced capability，而不是原始 Session 访问。Invocation memo 保持 operation-owned，并在其 tool outcome 变为 durable 时被删除。

测试断言 built-in constructor 产生文档所述的 kind、namespace 与 key 语法。由于 constructor 可能是动态的，不存在试图枚举每个可能 address 的 runtime catalog。

## 共享 read API

Storage、Session、SessionReader 与 SessionMutator 使用相同的 read 签名：

```ts
export interface StoredValue<T> {
  address: Value<T>;
  value: T;
  seq: number;
}

export interface ListElement<T> {
  /** Global transaction-write sequence assigned by storage. */
  seq: number;
  value: T;
}

export interface ListCursor {
  seq: number;
}

export interface ListReadOptions {
  /** Exclusive cursor. */
  cursor?: ListCursor;
  /** Default: asc. */
  order?: "asc" | "desc";
  /** Query-page size. Default: 1,000. Values above 10,000 clamp to 10,000. */
  limit?: number;
}

interface ValueReader {
  getValue<T>(address: Value<T>): Promise<StoredValue<T> | undefined>;

  /** Internal bounded-prefix operation. The address key is interpreted as a prefix. */
  scanValues<T>(prefix: Value<T>): Promise<StoredValue<T>[]>;

  readList<T>(
    address: ValueList<T>,
    options?: ListReadOptions,
  ): Promise<ListElement<T>[]>;
}
```

`scanValues(prefixAddress)` 扫描具有恰好该 namespace 且 key 以所绑定 key 开头的 scalar address，并按 key 升序返回它们。Core call site 只使用上面导出的 prefix constructor，因此原始 namespace/key 语法保留在 `session/values.ts` 中。Prefix address 只传给 `scanValues()`，绝不传给精确的 get/set/delete 操作。不存在不受限制的 cross-namespace dump。普通的 application 读取使用精确 address。

`Session` 使用相同的 address 暴露直接的单 transition 写入：

```ts
interface Session extends ValueReader {
  setValue<T>(
    address: Value<T>,
    next: NoInfer<T>,
    context: Context,
  ): Promise<void>;
  deleteValue<T>(address: Value<T>, context: Context): Promise<void>;
  appendList<T>(
    address: ValueList<T>,
    element: NoInfer<T>,
    context: Context,
  ): Promise<void>;
  deleteList<T>(address: ValueList<T>, context: Context): Promise<void>;
}
```

诸如 `getName()`、`setName()`、`getLabel()` 与 `setLabel()` 这类特定用途的 helper 可以保留为 built-in address 之上的薄包装。Application 直接定义并使用自己的 scalar/list address。

`SessionMutator` 仍是一个 read capability 加上一个原子性的 `commit(writes)`。它不暴露会分别消耗其唯一 commit 的直接 `setValue()`/`appendList()` method；caller 构造一个 typed write array 并一起提交。

## Typed transaction 写入

写入通过 typed helper 构造。Entry 与 usage constructor 隐藏其 storage discriminant；value/list erasure 只在 helper 检查了 address/value 类型关系之后发生：

```ts
interface EntryWrite {
  kind: "entry";
  entry: NewEntry;
}

interface UsageWrite {
  kind: "usage";
  row: Omit<UsageRow, "seq">;
}

interface ValueSetWrite {
  kind: "value";
  op: "set";
  namespace: string;
  key: string;
  value: unknown;
}

interface ValueDeleteWrite {
  kind: "value";
  op: "delete";
  namespace: string;
  key: string;
}

interface ListAppendWrite {
  kind: "list";
  op: "append";
  namespace: string;
  key: string;
  value: unknown;
}

interface ListDeleteWrite {
  kind: "list";
  op: "delete";
  namespace: string;
  key: string;
}

export function insertEntry(entry: NewEntry): EntryWrite;
export function insertUsage(row: Omit<UsageRow, "seq">): UsageWrite;
export function setValue<T>(address: Value<T>, next: NoInfer<T>): ValueSetWrite;
export function deleteValue<T>(address: Value<T>): ValueDeleteWrite;
export function appendList<T>(address: ValueList<T>, element: NoInfer<T>): ListAppendWrite;
export function deleteList<T>(address: ValueList<T>): ListDeleteWrite;
```

`NoInfer<T>` 使 address 具有权威性。TypeScript 不得从不兼容的 write value 推断出更宽的 `T`。

`Write` 包含全部六种 helper 返回类型。一个 transaction 可以原子地混合每种 write kind。Harness 与 application 代码使用这些 helper，而不是手动构造 storage write shape。

直接的 Session method 与 transaction helper 有意使用相同的 operation 名称。前者执行并提交单个 Session mutation；后者为显式组合的 transaction 构造一个 write。

## Scalar 语义

对于一个 `Value<T>` address：

- `setValue` 替换当前 value；
- `deleteValue` 移除它；
- 删除不存在的 value 是 no-op；
- delete 之后再 set 会重新创建它；
- 不保留 value 历史；
- 当前 value 记录其最近一次 set 的 `seq`；
- 失败的 transaction 既不暴露 scalar write，也不暴露任何 sibling write。

## List 语义

一个 append write 携带一个不可变 element。追加多个 element 的 transaction 包含多个 append write。每个 write 都获得其既有的全局递增 transaction sequence：

```text
TX[
  appendList(frames, A),       // seq 41
  setValue(operationState, X), // seq 42
  appendList(frames, B),       // seq 43
]
```

读取 `frames` 返回 `A`，然后 `B`。来自无关写入的 gap 是预期内的。list element 的 `seq` 是 session-global 的，并且对该已提交 write 唯一；它是 ordering/cursor identity，而不是 application domain ID。需要 domain identity 的 application 将其包含在 `T` 中。

规则：

- append 绝不读取既有元素；
- element 在 commit 之后不可变；
- `deleteList(address)` 移除该精确 address 上的每个 element；
- 删除不存在的 list 是 no-op；
- 在一个 transaction 中先 delete 再 append 会原子地创建一个全新的 list；
- 不存在 per-element 的 update、delete、insertion 或 truncation；
- 准予一个 transaction 所需的所有校验与序列化都在 Memory state 改变之前完成；
- 失败的 transaction 不暴露其任何 list 或非 list write。

“Append-only” 描述的是 list 存在期间的 element。whole-list deletion 是 lifecycle cleanup，而不是 element mutation。

### List 读取

- 升序读取返回 `seq > cursor.seq`；
- 降序读取返回 `seq < cursor.seq`；
- 结果在应用 `limit` 之前依据 `order` 排序；
- 不存在与空都返回 `[]`；
- caller 以最后返回的 element 的 `seq` 继续；
- 空 page 结束迭代；
- `limit` 只是 query-page size：它必须是正的 safe integer，默认 1,000，超过 10,000 的值会被 clamp 到 10,000；它绝不限制 list 的总长度或字节数。

```ts
let cursor: ListCursor | undefined;
while (true) {
  const page = await reader.readList(events, { cursor, order: "asc", limit: 100 });
  if (page.length === 0) break;
  consume(page);
  cursor = { seq: page[page.length - 1]!.seq };
}
```

cursor 是 sequence filter，而不是 snapshot 或 list-incarnation token。并发发生的后续 append 可能出现在之后的升序 page 上。whole-list deletion 可能使 cursor 变 stale；读取只是把其 sequence 比较应用于当前存活的 element。

不要添加无界的 “read the whole list” helper。

## Assistant partial frame

assistant partial durability 是第一个 built-in list consumer：

```ts
const frames = pendingAssistantFrames(operationId, responseEntryId);
```

`AssistantMessageFrame`、`AssistantMessageFrameEncoder` 与 `reduceAssistantMessageFrames()` 来自 `@earendil-works/pi-ai`。不要定义第二个 frame codec 或 reducer。

对于每个可转换的非 terminal provider event，assistant procedure：

```text
convert event to frame
→ synchronously enqueue appendList(frames, frame) on the Session mutation line
→ attach the ordinary harness-fault observer to that returned promise
→ replace the process-local latestFrameWrite reference
→ emit and await the existing message event
→ consume the next provider event
```

provider loop 不会为每个 frame await storage。同步 enqueue 保持 provider-event 顺序。替换 latest-promise reference 绝不会让更早的 rejection 未被观察到，因为每个 promise 都收到 fault observer。有界的 output 限制了排队的 work。在 stream settlement 时，procedure 停止 frame admission，并在 `after_response` 之前 await latest append promise；Session mutation FIFO 意味着其完成意味着每个更早的 append 都已完成。不存在 timer、batcher、coalescer 或 flush API。

scalar assistant 的 `effect_pending` 保持权威。每个 append 在其 mutation 执行时校验同一个 operation、attempt 与 response ID 仍拥有该 lane。Frame 绝不证明 request admission、completion、success 或 failure。

final 或 synthetic assistant settlement 把该精确 list 与其不可变 response、usage、Branch tip 以及 next scalar state 一起原子删除：

```text
TX[
  insert final assistant entry,
  insert usage,
  deleteList(frames),
  setValue(operationState(operationId), nextState),
]
```

`assistant-durability.md` 定义了 frame conversion、unknown-outcome synthesis、cancellation、deferred polling、snapshots 与 event ordering。

## Restore policy

Scalar operation 状态仍是唯一的 restart authority：

1. 从必需的 scalar value 构造受信任的 lane/operation projection；
2. 信任已提交的 typed value，而不是审计每个被引用的 payload 或 phase 关系；
3. 当 procedure 或 snapshot 消费 auxiliary state 时，从当前 typed scalar state 推导出其精确的 bound address；
4. 只 hydrate 该 consumer 所需的有界 scalar value 或 list page。

缺失的 auxiliary list 是合法的，除非其 consumer 显式需要一个 element。List 内容绝不证明 external effect 已完成。Live mutation 仍校验当前 operation、phase、attempt 与 reserved identity 作为 concurrency fencing；那不是 restore validation。

Base restore 不枚举 list。对于 assistant frame，snapshot 或 recovery 只在消费 typed assistant/deferred 的 `effect_pending` 状态时推导 `pendingAssistantFrames(operationId, responseEntryId)`。

每个 list consumer 定义：

- address 语法；
- element 与 total-byte 上限；
- page/hydration budget；
- cleanup transition；
- fork 与 migration policy。

## Memory backend

Memory 可以为当前 value 与 list element 保留单独的 map：

```ts
const scalarValues = new Map<string, StoredValue<unknown>>();
const listValues = new Map<string, ListElement<unknown>[]>();

function physicalKey(address: StoredAddressBase): string {
  return `${address.namespace}\u0000${address.key}`;
}
```

- scalar set 替换一个 map value；
- scalar delete 移除它；
- list append push 已经分配 sequence 的 element；
- list delete 移除完整数组；
- list read 依据 exclusive cursor 过滤，并 slice 到经校验的 limit；
- transaction preparation 在 entry、value、list、usage 或 stats mutate 之前完成。

JSONL/fork 工具使用的 storage snapshot 包含当前 scalar value 与存活 list element，并保留原始 sequence number。

## SQLite backend

逻辑 schema 有一个 current-value table 与一个 list-element table：

```sql
CREATE TABLE scalar_values (
  namespace TEXT NOT NULL,
  key       TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  value     TEXT NOT NULL,
  PRIMARY KEY (namespace, key)
) WITHOUT ROWID;

CREATE TABLE list_values (
  namespace TEXT    NOT NULL,
  key       TEXT    NOT NULL,
  seq       INTEGER NOT NULL,
  value     TEXT    NOT NULL,
  PRIMARY KEY (namespace, key, seq)
) WITHOUT ROWID;
```

WP01 原地替换未完成的 format-4 schema：编辑 `sqlite/migrations/001_initial.sql`，把物理的 `registers` table 重命名为 `scalar_values`，添加 `list_values`，并保持 `SQLITE_STORAGE_VERSION = 1`。此 WIP 实现中没有 migration runner，且 pre-WP01 的 SQLite 文件不受支持。不要在此 package 中添加 migration 机制。

List 操作：

```sql
INSERT INTO list_values(namespace, key, seq, value) VALUES (?, ?, ?, ?);

SELECT seq, value FROM list_values
WHERE namespace = ? AND key = ? AND seq > ?
ORDER BY seq ASC LIMIT ?;

SELECT seq, value FROM list_values
WHERE namespace = ? AND key = ? AND seq < ?
ORDER BY seq DESC LIMIT ?;

DELETE FROM list_values WHERE namespace = ? AND key = ?;
```

对于缺失的 cursor，省略 sequence predicate。每个 write 都参与既有的 `BEGIN IMMEDIATE` transaction；可写 Session ownership 属于 host lifecycle，而不是 SQLite storage。用 `EXPLAIN QUERY PLAN` 断言分页使用 primary key 且没有临时排序。

## JSONL backend

逻辑 record 携带 bound address 的物理组成部分：

```jsonl
{"kind":"list","op":"append","seq":41,"namespace":"pi.pending.assistant_frame","key":"O:R","value":{"type":"text_delta","contentIndex":0,"delta":"hi"}}
{"kind":"list","op":"delete","seq":52,"namespace":"pi.pending.assistant_frame","key":"O:R"}
```

Scalar record 使用 `kind:"value"` 与 `op:"set"|"delete"`。WP01 保持 JSONL format 4 与 storage version 1，但原地替换未完成的 record 拼写；pre-WP01 的 format-4 文件不受支持，且不保留 legacy `kind:"register"` decoder。

Replay 把 record 折叠进 Memory state：

- scalar set 替换当前 address；
- scalar delete 移除它；
- list append 添加 `{ seq, value }`；
- list delete 移除完整 list。

一个 transaction 仍是一行物理 JSONL，用数组表示多个 write。因此 torn-tail 处理在没有新 framing 的情况下保持原子。

### Snapshot compaction

Compaction 写入每个存活 list element 及其原始 `seq`，并按 sequence 顺序与存活 entry、scalar value 与 usage row 合并。不要把某个 live list 折叠为单个 synthetic element 或分配新的 sequence number；任一改动都会破坏 cursor 与 backend equivalence。

已删除的 list 不产生 snapshot record。Snapshot rewrite 把 `nextSeq` 持久化在 format-4 header 中，因此丢弃最近的 delete 不会允许 sequence 复用；普通的 append-only 文件可以省略该字段，并从 replay 的 write 推导它。

## Fork 与 rewrite

Fork 与 precise-rewrite 代码按具体的 address 语法决定 policy：

- operation-owned 的 `pi.op.*` scalar value 不会被复制进 idle fork；
- 不可变的 `pi.result` operation record 不会被 fork 复制；
- `pi.pending.entry`、`pi.pending.tool_output` 与 `pi.pending.assistant_frame` 的 value/list 不会被复制；
- lane 与 semantic session value 遵循其既有的 scope 规则；
- application 定义的 value/list 不会被 generic fork 复制；消费 feature 必须在依赖已复制的 application state 之前添加显式的 address-specific policy。

保留 list element 的 precise rewrite 会保留其 `seq` 值，除非它显式重映射整个 destination sequence space。

## Schema evolution

bound address 的 namespace、key 语法、kind 与 value type 是 durable schema：

- 改变 namespace 或 key 语法需要显式的 address migration；
- 把 scalar 改为 list 或把 list 改为 scalar 需要显式 migration；
- storage 绝不从观察到的 record 推断或强制转换 kind；
- 当旧的已存储 value 不兼容时，改变 TypeScript value shape 需要完整的 value migration；
- list migration 按 sequence 顺序对 element 分页，并在保留 `seq` 的同时映射它们，或删除完整 list；
- migration 不得一次加载无界的 logical list。

添加 generic list storage 会原地替换当前的 WIP backend schema。构造一个没有持久化 value 的新 application address 不需要 migration。

## Instrumentation 与 telemetry

instrumented storage decorator 暴露基于 address 的 read API，并按确切的 transaction 顺序记录已提交的 erased write。

Telemetry 的 session-write item kind 区分 scalar-value write 与 list write。当 telemetry schema 允许时，namespace/key 名称可以是 attribute，但 value、assistant frame、prompt 与 tool output 绝不进入 telemetry。

append-path test 证明在 append commit 之前不会发生任何 `readList` 调用。frame-persistence promise 总是收到 harness fault observer，即使更早的 promise 不再是 latest settlement-order reference。

## Invariant

1. 一个 bound address 在一个 storage version 中拥有一个稳定的 namespace/key/kind 与一个受信任的 value type。
2. Address object identity 没有 durable 含义。
3. namespace `pi` 与每个 `pi.*` 依契约保留；每个 built-in namespace 都以 `pi.` 开头，application 使用它是受信任编程缺陷。
4. 恰好五个 built-in prefix constructor 封装 Branch inventory 与 operation cleanup 语法；它们的结果只被 namespace-scoped 的 `scanValues()` 消费。
5. scalar 与 list address 不得占据相同的物理 location；这是受信任编程规则，而不是 runtime cross-kind collision 检查。
6. Typed read 与 helper 构造的 write 保留 `T`。
7. Scalar helper 拒绝 list address；list helper 拒绝 scalar address。
8. Session/Storage 操作在 address 构造之后绝不要求第二个 key。
9. 每个 list element 都是不可变的，并携带其全局唯一的 committed write `seq`。
10. 一个 list address 上的 element 在每个 backend 上都按 sequence 顺序返回。
11. Append 不读取目标 list。
12. Scalar/list write 与 entry 和 usage 在同一 transaction 中原子。
13. Whole-list delete 不在该 address 上留下任何 element。
14. 缺失与空的 list 都读取为 `[]`。
15. Base restore 只依赖必需的 scalar state，且绝不枚举 auxiliary list。
16. Auxiliary list 绝不确立 effect completion 或选择 restart state。
17. JSONL compaction 保留存活 element 的 sequence。
18. Terminal cleanup 不留下 operation-owned 的 scalar value 或 list。

## 必需的测试

### Address typing 与 identity

- `value<T>()` 与 `list<T>()` 不变地保留其声明的 `T`；
- scalar read 推断 bound address 的 value type；
- list read 推断其 element type；
- `setValue` 在 compile time 拒绝不兼容的 value；
- `appendList` 在 compile time 拒绝不兼容的 element；
- scalar helper 拒绝 list address，list helper 拒绝 scalar address；
- 独立构造的相等 address 访问同一个 durable location；
- 同一个物理 address 的不兼容定义被记录/测试为编程缺陷；
- 空 key 可用，而空 namespace 与包含分隔符的组成部分会被拒绝；
- core 与 application 代码使用相同的 `value()` 与 `list()` constructor，不存在 private constructor、privilege token、registry 或 catalog；
- built-in address constructor 产生确切的 `pi.branch.tip`、`pi.lane.*`、`pi.op.*`、`pi.pending.*`、`pi.session.name` 与 `pi.entry.label` 的 namespace/key/kind 三元组；
- 每个 built-in namespace 都以 `pi.` 开头，而 application fixture 使用非保留的 namespace；
- `branchTipInventoryPrefix()` 绑定空 key 的 `pi.branch.tip` inventory prefix，且只用于通过 `scanValues` 枚举 Branch；
- tool-args prefix 覆盖一个 operation 以及可选的一个 step，tool-memo prefix 覆盖一个 operation 以及可选的一个 invocation，preparation 与 tool-output prefix 恰好覆盖一个 operation；
- 每个 prefix constructor 的结果只被 `scanValues` 使用，且没有 inventory 或 cleanup 调用构造原始保留 namespace；
- application address 无需 declaration merging 或 core catalog 即可工作；
- 没有 Storage 或 Session 操作接受额外的 key argument。

### Scalar 回归

- set/get/delete/recreate 行为不变；
- replacement 只保留最新的 logical value 与最新的 set `seq`；
- typed write helper 保留混合的 transaction 顺序；
- prefix scan 把 bound address key 解释为 prefix，并保持 namespace-scoped；
- 新的 scalar JSONL/SQLite 文件只使用 value/list schema；pre-WP01 的 WIP 文件显式不受支持。

### List conformance

扩展共享的 backend conformance suite：

- 追加一个 element 并对其分页；
- 在一个 transaction 中向一个 address 多次 append；
- 被无关 write 分隔的 append 保持 per-list 顺序；
- 每个 element 都获得其自身的 global write `seq`；
- 升序与降序的 exclusive cursor；
- default、explicit、invalid 与 capped 的 limit；
- 缺失的 list 返回 `[]`；
- whole-list delete 与对缺失 list 的 delete；
- 在一个 transaction 中先 delete 再 append；
- 当后续 write 无效时 rollback；
- 原子性的 list + entry + usage + scalar transaction；
- 在 Memory、JSONL 与 SQLite 上产生相同的 page 与 cursor；
- JSONL torn multi-write transaction 不暴露任何 list element；
- JSONL replay 与 compaction 保留 cursor；
- SQLite 分页使用 primary key 且没有临时排序；
- append 不执行 list 读取；
- base restore 在不读取 list 的情况下构造受信任的 scalar projection，随后进行有界的 consumption-time hydration；
- close 拒绝后续读取，并履行已准入的 commit。

### Application surface

- application-wide 的 scalar value 在 get/set 时不需要额外的 key；
- application-wide 的 list 在 read/append 时不需要额外的 key；
- application 可以显式构造动态的 per-workspace address；
- Storage 与 Session 接受相同的 address object 并推断相同的类型；
- 直接的 Session write 序列化并提交一次；
- 显式的 `Session.mutate()` 可以把 typed value/list write 与 entry 和 usage 原子地组合。

### Assistant-frame integration — 推迟到 WP01 之后

- 每个已转换的非 terminal frame 都在确切的 bound effect-pending response address 下 append；
- terminal `done`/`error` event 不 append 任何内容；
- append 同步 enqueue，且不施加 provider backpressure；
- 每个 frame-write promise 都有被观察的 fault path；
- 只为 settlement ordering 保留 latest promise reference；
- await latest promise 意味着每个更早的 append 都已完成；
- reduced page 重建出与不间断 streaming 相同的 partial message；
- 缺失的 list restore 为没有 durable partial；
- final/synthetic settlement 原子地删除 frame list；
- unknown-effect recovery 只读取从当前 scalar state 推导出的有界 list；
- external finalization 删除 operation-owned 的 list；
- idle fork 不包含 frame list；
- backend 字节增长是 append-linear 的，而不是 repeated-snapshot 增长。

## 实现映射

预期的主要变更：

- 用包含 address、constructor、typed write helper 与 built-in address constructor 的 `packages/agent/src/harness/session/values.ts` 取代 `session/registers.ts`；
- 从 `session/types.ts` 中移除 `RegisterValues`、namespace union、register token type 与原始 namespace/key read 签名；
- 通过 Storage、SessionReader、SessionMutator 与 Session 暴露 `ValueReader`；
- 在 Session 上使用 bound address 暴露直接的 application scalar/list method；
- 更新 Memory state、JSONL codec/storage、snapshot、fork/rewrite 代码、instrumentation 与 conformance suite；
- 用 `scalar_values` 与 `list_values` 原地替换 SQLite 未完成的 initial schema；保持 storage version 1 且不添加 migration runner；
- 更新 telemetry schema 源并重新生成 `telemetry-schema.md`；不要手动编辑该生成文件。

WP01 在 generic address/storage 与 projection-only restore 覆盖之后停止。`assistant-durability.md` 规定了后续的消费 lifecycle；assistant execution、deferred polling、recovery、snapshot hydration、memo/checkpoint capability 与 operation cleanup 只在各自的 runtime work package 中落地。
