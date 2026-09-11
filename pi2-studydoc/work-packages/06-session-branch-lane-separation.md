# WP06 — Session、Branch、Lane 分离

**状态：已在 WP05 M4 之前实现。** WP05 M3 仍保持完成。Retry/deferred 工作在本包所落地的 composition、mutation 和 ownership 边界上恢复。

本包用四个明确的概念替换混合的 `SessionTree`/隐式 main 继承设计：

```text
Session       global durable data + one mutation line
Branch        one path through the entry tree, with a movable tip
AgentLane     Branch data surface + agent operations/configuration
AgentHarness  manager of AgentLanes; never a lane itself
```

---

## 0. 必读

编辑之前请完整阅读：

1. `packages/agent/docs/harness.md`。
2. `packages/agent/docs/work-packages/05-direct-durable-drive.md`。
3. `packages/agent/src/harness/session/types.ts`。
4. `packages/agent/src/harness/session/session.ts`。
5. `packages/agent/src/harness/session/memory.ts`。
6. `packages/agent/src/harness/session/jsonl/repo.ts` 和 `jsonl/storage.ts`。
7. `packages/session-backends/sqlite-node/src/sqlite/session.ts`、`storage.ts` 以及 repo 实现。
8. `packages/agent/src/harness/runtime/lane.ts`、`harness.ts`、`restore.ts` 和 `types.ts`。
9. `packages/agent/src/harness/agent-harness.ts`。
10. `packages/agent/src/harness/session/fork.ts` 以及 repository conformance tests。
11. §8 中命名的每一个测试（在修改它之前）。

不要检查已删除的 runtime 实现或 Git 历史。当前源代码、`harness.md`、WP05 以及本包是唯一的真相来源。

---

## 1. 问题

### 1.1 `SessionTree` 混合了不相关的 ownership

`SessionTree` 当前包含：

```ts
interface SessionTree {
	// Lane/path data.
	getLeafId(...): Promise<string | null>;
	findEntriesOnBranch(...): Promise<Entry[]>;
	findEntryOnBranch(...): Promise<Entry | undefined>;
	appendMessage(...): Promise<string>;
	appendCustomEntry(...): Promise<string>;

	// Session-global data that is not lane- or branch-owned.
	getEntry(...): Promise<Entry | undefined>;
	getStats(...): Promise<SessionStats>;
	findEntries(...): Promise<Entry[]>;
	findEntry(...): Promise<Entry | undefined>;
	getValue(...): Promise<StoredValue<unknown> | undefined>;
	setValue(...): Promise<void>;
	readList(...): Promise<ListElement<unknown>[]>;
	appendList(...): Promise<void>;
	getName(...): Promise<string | undefined>;
	setName(...): Promise<void>;
	getLabel(...): Promise<string | undefined>;
	setLabel(...): Promise<void>;
}
```

一个被选中的 tree view 只改变某个全局写入进入哪一条 mutation queue。它不改变 durable address。因此两个 view 可以在不同的 lane line 下读取同一个全局值，并提交一次丢失更新（lost update）。

### 1.2 `Session` 静默地意味着 `main`

`Session extends SessionTree`。它继承的 branch 方法和高层写入静默地委托给 `main` lane。`session.setValue(...)` 实际上就是 `setValueForLane("main", ...)`。一个新的 repository session 在任何 harness 存在之前就创建了一个部分的隐式 main lane。

### 1.3 `AgentHarness` 静默地意味着 `main`

`AgentHarness extends AgentLane`，而 runtime 的 `Harness extends Lane`。manager 对象被作为 `main` 插入到它自己的 lane map 中。诸如 `harness.prompt(...)`、`harness.watch(...)` 或 `harness.getModel(...)` 的调用都静默地指向 main。

### 1.4 按 lane 的 mutation queue 解决的是错误的问题

Storage 已经序列化原子提交，并为每次写入分配一个 session 范围的 `seq`。按 lane 的 mutation queue 允许有用的准备重叠，但这个 runtime 现在不需要那种复杂度：所有 harness mutation 回调都执行有界的 storage 读取、准备一个 write set、至多提交一次、发布进程本地状态，然后返回。Providers、tools、hooks、timers 以及异步事件投递都在 mutation 回调之外。

获批的第一个实现使用一条 Session mutation line。如果 profiling 证明全局 line 是瓶颈，以后可以添加带 key 的 line；那个未来的改动需要一次 mutable-ownership 审计，但不需要重新设计公共 API。

---

## 2. 获批的术语与 ownership

### Session

拥有：

- session metadata；
- 全局 entry 与 usage 查询；
- application values 与 lists；
- session name 与 entry labels；
- Branch discovery/creation；
- 对每一个受支持 mutation 的一条进程本地 mutation line；
- 一个打开的 storage/backend 生命周期。

一个 Session 不实现 Branch，也没有隐式 branch。

### Branch

仅数据的 capability，描述通过不可变 entry tree 的一条命名路径。

仅拥有：

- 它当前的 tip；
- branch 相对的 entry 查询；
- 用 message 或 custom entry 直接扩展它的 tip。

一个 Branch 没有 model configuration、queues、operation state、drive、hooks 或 agent policy。

### AgentLane

一个 Branch 加上 agent configuration 与 operations。它直接暴露 Branch 方法，而不是暴露一个嵌套的 `Branch`、tree、store、view 或 access 对象。

空闲时，`AgentLane.appendMessage` / `appendCustomEntry` 直接扩展 tip。在一次 active run 期间，它们保留现有的 deferred-write 语义：预留 entry id，持久化 `pendingEntry(id)`，并将该 id 入队到 operation inbox 以便 checkpoint 放置。一次原始的 Branch append 始终是一次直接数据 append；当某个 Harness 拥有对应 lane 时进行原始 Branch mutation 是 trusted-programming 缺陷。

### AgentHarness

拥有全局 registries/configuration、hooks、events、lifecycle，以及一个 AgentLane 的 map。它不是 AgentLane，也不暴露任何隐式 main 的 operation 方法。

---

## 3. 目标公共类型

### 3.1 Session reader 与 mutation

```ts
export interface SessionReader {
  getEntries(ids: string[], context: Context): Promise<Map<string, Entry>>;
  getValue<T>(
    address: Value<T>,
    context: Context,
  ): Promise<StoredValue<T> | undefined>;
  scanValues<T>(prefix: Value<T>, context: Context): Promise<StoredValue<T>[]>;
  readList<T>(
    address: ValueList<T>,
    options: ListReadOptions | undefined,
    context: Context,
  ): Promise<ListElement<T>[]>;
  scanBranch(query: StorageBranchScan, context: Context): Promise<Entry[]>;
}

export interface SessionMutation extends SessionReader {
  /** Exactly zero or one attempt. A second call rejects, including after failure. */
  commit(writes: Write[], context: Context): Promise<CommitResult>;
  /** Wait for any admitted commit, invalidate the capability, and release the Session line. */
  end(context: Context): Promise<void>;
}

export type SessionMutator = Omit<SessionMutation, "end">;

export type SessionMutationCallback<TResult> = (
  mutator: SessionMutator,
  context: Context,
) => TResult | Promise<TResult>;
```

`beginMutation()`/`SessionMutation.end()` 仍然是当前 remote Session protocol 所使用的可传输 scope。它们无 key，且不携带 lane 字段。正常的 local/harness 代码使用 `mutate()`；没有调用方选择 mutation key。

### 3.2 Branch

```ts
export interface Branch {
  readonly name: string;
  getTipId(context: Context): Promise<string | null>;
  findEntries(
    query: BranchScan | undefined,
    context: Context,
  ): Promise<Entry[]>;
  findEntry(
    query: BranchScan | undefined,
    context: Context,
  ): Promise<Entry | undefined>;
  appendMessage(message: AgentMessage, context: Context): Promise<string>;
  appendCustomEntry(
    customType: string,
    data: JsonValue | undefined,
    context: Context,
  ): Promise<string>;
}
```

因为接收者本身已经是一个 Branch，公共名称为 `findEntries` 和 `findEntry`，而不是 `findEntriesOnBranch` 和 `findEntryOnBranch`。

### 3.3 Session

```ts
export interface Session<
  TMetadata extends SessionMetadata = SessionMetadata,
> extends SessionReader {
  readonly metadata: TMetadata;
  readonly idGenerator: IdGenerator;

  // Direct reads. No mutation-line acquisition.
  getEntry(id: string, context: Context): Promise<Entry | undefined>;
  getStats(context: Context): Promise<SessionStats>;
  findEntries(
    query: EntryQuery | undefined,
    context: Context,
  ): Promise<Entry[]>;
  findEntry(
    query: EntryQuery | undefined,
    context: Context,
  ): Promise<Entry | undefined>;
  getName(context: Context): Promise<string | undefined>;
  getLabel(targetId: string, context: Context): Promise<string | undefined>;

  // Existing Branch acquisition performs durable I/O and therefore receives Context.
  branch(name: string, context: Context): Promise<Branch | undefined>;
  createBranch(
    name: string,
    at: string | null,
    context: Context,
  ): Promise<Branch>;

  // Transportable explicit scope; RemoteSession maps begin/read/commit/end over RPC.
  beginMutation(context: Context): Promise<SessionMutation>;

  // Trusted sharp edge. The callback holds the sole Session mutation line.
  mutate<TResult>(
    mutation: SessionMutationCallback<TResult>,
    context: Context,
  ): Promise<TResult>;

  // One-write conveniences implemented through mutate().
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
  setName(name: string | undefined, context: Context): Promise<void>;
  setLabel(
    targetId: string,
    label: string | undefined,
    context: Context,
  ): Promise<void>;

  close(context: Context): Promise<void>;
}
```

`mutate()` 保持 public。Plugins 被信任不会保留 mutator、调用嵌套的 public writer、执行 effects，或跨无界工作持有 line。误用可能会阻塞该 Session 中的每一次 mutation，属于 plugin 缺陷。`beginMutation()` 的存在是为了 transport/lifecycle 集成，而不是普通的 plugin 工作；每一个直接调用方都必须在 `finally` 中调用 `end()`。

### 3.4 AgentLane

`AgentLane` 保留它的 operation/configuration/observation 方法，并直接加上 Branch surface：

```ts
export interface AgentLane {
  readonly name: string;

  getTipId(context: Context): Promise<string | null>;
  findEntries(
    query: BranchScan | undefined,
    context: Context,
  ): Promise<Entry[]>;
  findEntry(
    query: BranchScan | undefined,
    context: Context,
  ): Promise<Entry | undefined>;
  appendMessage(message: AgentMessage, context: Context): Promise<string>;
  appendCustomEntry(
    customType: string,
    data: JsonValue | undefined,
    context: Context,
  ): Promise<string>;

  getLastResult(context: Context): Promise<LaneLastResult | undefined>;
  accept(
    request: OperationRequest,
    context: Context,
  ): Promise<OperationAdmissionResult>;
  drive(options: DriveOptions, context: Context): Promise<DriveResult>;
  requestAbort(
    operationId: string,
    context: Context,
  ): Promise<AbortRequestResult>;
  inspectExecution(context: Context): Promise<LaneExecutionInfo>;
  // Existing convenience, queue, configuration, idle, and watch methods remain.
}
```

删除 `AgentLane.sessionTree`。

### 3.5 AgentHarness

```ts
export interface AcquireLaneOptions {
  /** Used only when the AgentLane does not exist. Defaults to null. */
  createAt?: string | null;
}

export interface AgentHarness<
  TContext extends object | undefined = object | undefined,
> {
  lane(name: string, context: Context): Promise<AgentLane>;
  lane(
    name: string,
    options: AcquireLaneOptions,
    context: Context,
  ): Promise<AgentLane>;
  lanes(context: Context): Promise<LaneInfo[]>;

  // Session-global metadata wrappers preserve existing value_update events.
  getName(context: Context): Promise<string | undefined>;
  setName(name: string | undefined, context: Context): Promise<void>;
  getLabel(targetId: string, context: Context): Promise<string | undefined>;
  setLabel(
    targetId: string,
    label: string | undefined,
    context: Context,
  ): Promise<void>;

  // Existing global tools/resources/options/settings/hooks/events/watchSession/close surface.
}
```

`AgentHarness` 不继承 `AgentLane`。删除 `createLane`；`lane()` 是原子的 get-or-create。已存在的 lane 忽略 `createAt`。缺失的 lane 使用 `createAt ?? null`。并发的 acquisition 返回同一个已发布的 AgentLane。非法名称和未知的非 null target 会以现有的 tagged errors 拒绝；close/fault 以它们现有的 lifecycle errors 拒绝。

一个新的 Session 和新的 Harness 不包含隐式 main Branch 或 AgentLane。`await harness.lane("main", context)` 完整地创建 main。`lanes()` 可以返回 `[]`。

---

## 4. Mutation 与 read 语义

### 4.1 一条 Session mutation line

用一个单一的 `MutationLine` 替换 `LaneMutationLine`：

```ts
export class MutationLine {
  private tail: Promise<void> = Promise.resolve();
  private sealedError: Error | undefined;

  run<TResult>(operation: () => TResult | Promise<TResult>): Promise<TResult>;
  seal(error: Error): Promise<void>;
}
```

`StorageBackedSession.beginMutation()` 获取该 line 并返回一个明确的、无 key 的 capability；只有 `end()` 释放它。`mutate()` 是由 begin/end 构建的回调便捷方式，并且总是在 `finally` 中结束。回调可以读取、准备、提交一次、发布进程本地状态、同步绑定事件接收者，然后返回。`close()` 封闭 admission，并等待每一个已获取的 scope 结束后再关闭 Storage。

高层 Session 写入、Branch 创建/append、每一次 `Lane.command`、progress 写入、需要一致性的 restore snapshots，以及 Harness lane acquisition 都调用同一个 `Session.mutate()`。

### 4.2 Reads 绕过 line

普通的 Session 和 Branch 读取直接调用 Storage。它们观察到每次读取执行时最新的、完全应用的原子 storage commit：

- 一个已排队/规划中/未应用的 mutation 是不可见的；
- 没有部分提交是可见的；
- 一旦 Storage commit resolve，即使在 mutation 回调仍在发布进程本地状态时，直接读取也可能观察到它；
- 在一次 `mutate()` 之外的多次读取不是 snapshot；
- 一致的 read-decide-write/CAS 使用 `Session.mutate()`。

### 4.3 Effects 留在外面

一个 mutation 回调不得执行或 await：

- providers 或 deferred fetch/cancel；
- tools；
- hooks；
- timers；
- 异步事件投递；
- idle 回调或 Drive 完成；
- 嵌套的 Session/Branch/AgentLane mutator。

回调可以在发布之后同步调用 `emitBatch` 以绑定接收者，并保留它的 delivery promise。public operation 在 `mutate()` 返回后 await delivery。

### 4.4 Storage 保持独立原子

Storage 保留它的单 session commit serializer，并为每次写入分配一个全局 `seq`。Session mutation line 保护 read-decide-commit-publication 过程；Storage queue 保护原子 transaction 应用、sequence 分配、fork snapshots 以及 backend 调用方。不要合并这两个抽象。

---

## 5. Branch 与 lane 的 durable 形态

### 5.1 没有隐式 main

Repository 的 `create()` 只写 session metadata/header/catalog 状态。它不写任何 branch tip、lane configuration 或 lane state。从 Memory 和 JSONL 创建以及 SQLite 初始化中移除 main seeding。

Legacy coding-agent v3 规范化仍可能产生一个 main Branch，因为导入的 transcript 只有一条选中路径。

### 5.2 Branch 完整性

一个 Branch 恰好在其必需的 tip value 存在时存在。`createBranch(name, at, context)` 校验 name、absence 和 non-null target，然后在一次 mutation 中写入 tip。它不写任何 model configuration 或 operation state。

在源代码中使用 Branch 术语。本包把 typed constructor 和 public 概念重命名为 `branchTip`/`tipId`。持久化的 namespace 与 durable field 拼写决定必须在所有 backend 和文档中保持一致：

- 使用 `pi.branch.tip`，并把 format-4 字段从 leaf 重命名为 tip，而不是保留误导性的 new-code aliases；
- format 4 和新的 harness 是 WIP，所以就地替换它们的 schema 和字段名：不做 storage-version bump、migration、compatibility decoder 或 old-format rejection path；
- legacy coding-agent v3 import 仍受支持：它把选中的 main leaf 映射到 main Branch tip，并遍历那条选中的物理 ancestry，独立地重建最近的 `model_change`、`thinking_level_change` 和 `active_tools_change`；不支持的最近值不会回退到更早的历史；
- 当 importer 能够重建一个完整配置时，它在返回 Session 之前写入普通的 `laneConfig("main")` 加上全新的 idle `laneState("main")`；缺失的 active-tools 历史规范化为 `[]`，因为 v3 没有持久化初始 tool inventory；
- 如果必需的 model 或 thinking configuration 缺失或不受支持，importer 留下一个仅数据的 main Branch，而不是持久化部分兼容状态；
- 更新 legacy active-tools record type 以读取它编码的 `activeToolNames` 数组；
- 更新同一包中公共 `tipId` 字段的 protocol schemas 和 experimental adapters。

Inventory 使用 `branchTipInventoryPrefix()`。Legacy import 只发出普通的 Branch/Lane values；没有临时 compatibility address 或 attachment-time migration。

### 5.3 AgentLane 完整性

一个 AgentLane 向一个已存在的 Branch 添加完整的 `laneConfig`、`laneState`、可选的 `laneLastResult`，以及可选的 current operation values。

`harness.lane(name, options?, context)` 执行一次 Session mutation，并精确处理这些情况：

| Durable 状态                                               | 结果                                                                                                                                                                        |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch 缺失；lane values 缺失                           | 校验 `createAt`，提交 Branch tip + 不可变的 `AgentHarnessOptions` seed config + idle lane state，发布一个 AgentLane 以及 `lane_created { at: createAt ?? null }` |
| Branch 存在；lane config/state 缺失且没有 last result | 在已存在的 tip 提交不可变的 seed config + idle lane state，发布一个 AgentLane 以及 `lane_created { at: existingTip }`                                          |
| Branch 和完整的 lane values 存在                     | 返回 restored/published AgentLane；无 commit/event                                                                                                                      |
| 任何部分或矛盾的组合                    | 作为 storage corruption fault                                                                                                                                                   |

提交的回调把新的 Branch/AgentLane 发布到进程本地 map 中，并在从 `Session.mutate()` 返回之前同步调用 `emitBatch(lane_created, context)`。事件投递在 line 释放之后被 await。

`AgentHarness.create()` 恢复每一个完整的 durable AgentLane 和 open operation，但不创建任何东西，也不要求 main。一个仅数据的 Branch 保持为 Branch，直到 `harness.lane(name, ...)` 附加 agent state。

### 5.4 Append 行为

`Branch.appendMessage` / `appendCustomEntry` 总是提交一个以当前 tip 为父的不可变 entry，并在同一 transaction 中移动 tip。

`AgentLane.appendMessage` / `appendCustomEntry` 保留 harness 语义：

- idle：立即 append 并移动 tip；
- active run：staging `pendingEntry(id)` 并 enqueue `inbox.writes`；
- active structural operation：当该 surface 落地时保留现有的 wait/re-evaluate 契约；
- pending assistant messages 在提交前拒绝。

两者都返回在它们 mutation 之前预留的 entry id。

---

## 6. Runtime composition

### 6.1 Harness

用 composition 替换继承：

```ts
export class Harness<
  TContext extends object | undefined,
> implements AgentHarness<TContext> {
  readonly session: Session;
  readonly models: Models;
  readonly hooks: HookRegistry;
  readonly events: HarnessEventBus;
  readonly lanesByName = new Map<string, Lane<TContext>>();
  // global config/lifecycle fields
}
```

构造函数把每一个 restored Lane 构建为普通对象。它从不调用 `super("main", ...)`，也从不把 `this` 插入 `lanesByName`。

Fault 和 close 遍历普通的 Lane 对象。全局 getters/setters 只存在于 Harness 上。Coding-agent experimental services 和 workers 必须在调用 lane operations 之前显式 acquire/cache `main`。

### 6.2 Lane

`Lane.command` 和 `commandDriveOwned` 调用无 key 的 `session.mutate(plan, context)`。活跃的 `Lane.state` 仍然是权威的进程 projection。精确的 Drive fencing 仍然紧邻 commit admission。

Lane 直接实现 Branch 的 query/append 名称。它可以持有一个 package-private 的 Branch 实现用于直接数据读取，但不会公开暴露任何嵌套 Branch。

### 6.3 Restore

Restore 不再进入一条命名 mutation line。`AgentHarness.create()` 拥有 Session attachment interval，并执行一次有界的、无 key 的 `Session.mutate()` 回调来 inventory/restore 每一个完整的 AgentLane，然后才发布 Harness；只有当需要一次有意的 attachment 规范化时它才提交。一致的 live watch/inspection 同样使用 `Session.mutate()` 作为一个 no-commit 回调。

Restore 将完整的 AgentLane 与仅数据的 Branch 分开 inventory。缺失 main 是合法的。

---

## 7. Repository、backend 与 fork 要求

### Memory/JSONL/SQLite

所有 Session facades：

- 从 begin/mutate capabilities 中移除 lane arguments 和 lane fields；
- 为 local lifecycle 和 remote transport 保留显式的 `beginMutation(context)` / `SessionMutation.end(context)` 转发；
- 保持显式 scope 被 admitted 直到 `end()`，并保持回调 `mutate()` 通过其隐式 finally/end 被 admitted；
- 暴露 Branch acquisition/creation；
- 让直接读取保持在 line 之外；
- 保持 Storage commit sequencing 不变。

SQLite 和未来的 SQL backends 仍然在 Storage 中序列化 sequence-allocating commits。Session mutation line 有意地只在一个打开的 Session owner 内序列化完整的回调；不同的 sessions 保持并发。

### Forks

保留一个一致的源 Storage snapshot。把术语从 lane leaf 更新为 Branch tip。

- branch-scope fork 在复制的路径上创建目标 Branch `main`；
- 如果未提供显式的 source entry，则源 `main` 必须存在，否则 fork 拒绝；
- branch scope 复制源 main 的 configuration，并且**当且仅当**源 main 是一个完整配置的 AgentLane 时，一同写入 idle lane state；未配置/仅数据的源 main 只产生一个仅数据的目标 main Branch；
- tree scope 复制每一个 Branch tip；每一个完整配置的源 AgentLane 一同复制它的 configuration 加上全新的 idle lane state，而每一个仅数据的 Branch 保持仅数据；
- operation values、pending values/lists、last results 和 usage rows 保持被排除；
- destination sessions 不会获得一个无关的隐式 main；
- 保留显式的 begin/commit/end fork-ordering seam：必须在开始一次 fork snapshot 之前 admit 一次 commit 的代码调用无 key 的 `beginMutation()`、调用 `commit()`、仅在 commit admission 之后开始 repository snapshot，并在 `finally` 中调用 `end()`；Storage 将源 snapshot 与 commits 一起排队，以选择一个一致的边界。

---

## 8. 实现阶段与文件清单

Public drive 保持禁用。在恢复 WP05 M4 之前完成本包。

### Phase A — Session mutation 与 Branch

**重命名**

- `src/harness/session/lane-mutations.ts` → `mutation-line.ts`。

**修改**

- `src/harness/session/types.ts` — `Branch`、无 key 的 `Session.mutate` 和无 key 的 begin/end transport scope、没有 `SessionTree`、Session-global 方法。
- `src/harness/session/session.ts` — 一条 line、Branch 实现、没有隐式 main 委托、直接 Branch append；把 lane-creation 校验错误重命名为 Branch 术语。
- Memory/JSONL/SQLite format-4 schema 和 codecs — 就地替换 WIP leaf/lane 拼写；不要添加 version gate 或 migration。
- `src/harness/session/memory.ts`。
- `src/harness/session/jsonl/repo.ts`、`jsonl/legacy-v3.ts` 以及相关的 open/create facade 文件。
- `packages/session-backends/sqlite-node/src/sqlite/session.ts` 和 repo creation。
- `src/harness/session/fork.ts`。
- `src/harness/session/index.ts` 和 package exports。
- storage/repository benchmarks 和 conformance call sites。

**重命名测试**

- `test/harness/session-tree.test.ts` → `branch.test.ts`。
- `test/harness/session-create-lane.test.ts` → `session-create-branch.test.ts`。

**修改测试**

- `test/harness/storage-backed-session.test.ts`。
- `test/harness/memory-session-repo.test.ts`。
- `test/harness/jsonl-session-repo.test.ts`。
- `test/harness/memory-conformance.test.ts`。
- `src/harness/session/testing/conformance/session-repo.ts`。
- SQLite repo/storage tests。
- compaction/branch-summarization type fixtures。

### Phase B — Harness/Lane composition

**修改**

- `src/harness/agent-harness.ts`。
- `src/harness/runtime/harness.ts`。
- `src/harness/runtime/lane.ts`。
- `src/harness/runtime/restore.ts`。
- `src/harness/runtime/types.ts`，其中 `leafId` 变为 `tipId`。
- `src/harness/session/values.ts` 以及用于 Branch tip 命名的 durable state types。
- 所有已存在的 runtime drive modules（`checkpoint`、`generation`、`recovery`、`terminal`、`progress`），仅在名称/签名改变之处。
- `src/harness/compaction/branch-summarization.ts`。
- `packages/protocol/src/harness.ts`。
- `packages/coding-agent/src/experimental/services/agent-controller-provider.ts`。
- `packages/coding-agent/src/experimental/services/models-provider.ts`。
- `packages/coding-agent/src/experimental/session-worker.ts`。
- experimental harness wire/session worker tests。

**修改聚焦测试**

- 每一个使用 keyed mutate、隐式 Harness-as-main、`sessionTree`、`leafId` 或 `createLane` 的 `test/harness/runtime/*.test.ts` helper/call site；
- `test/harness/types.test.ts`；
- `test/harness/branch-summarization.test.ts`；
- protocol 和 coding-agent experimental tests。

Phase A 和 B 是一次原子落地。移除 `SessionTree`、keyed mutate 和 Harness 继承无法作为分别提交的兼容阶段编译，而本包有意不添加任何临时 aliases。

### Phase C — 规范性文档

完整且一致地更新 `packages/agent/docs/harness.md`：

- orientation/system model 和 worked examples；
- 绑定的 Branch tip addresses；
- Branch、Session metadata、queries、forks 和 repository boundary；
- operation metadata/result/snapshot 的 `tipId` 术语；
- Parts 3–5 中的一条 Session mutation line；
- 没有必需 main 的 attachment；
- public Branch、AgentLane、AgentHarness 和 Session surfaces；
- Session line 下的事件/watcher ordering；
- 移除旧的第二条 harness-settings-line 的 lock-order 叙述：harness-global settings 和每一次 durable lane mutation 现在在需要一致 snapshot 时都通过唯一的 Session line 序列化；纯同步的 registry 读取保持直接；
- work-package table、invariants、races、backend conformance 和 glossary。

在 M4 之前更新 WP05：

- 替换 `SessionTree`/lane-line/inheritance 假设；
- 在新类型名要求之处替换 `leafId` 源码示例；
- 保留所有 M0–M3 历史行为和 M4–M8 durable requirements；
- 说明 WP06 是 M3 与 M4 之间的基础。

更新每一份其公共名称或 ordering 陈述发生变化的当前支撑文档：

- `docs/assistant-durability.md` 和 `docs/tool-durability.md` — Session-line FIFO 和 `branchTip` 术语；
- `docs/values.md` — Session-global value/list surface、Branch tip addresses，以及没有 `SessionTree`；
- `docs/telemetry.md` — receiver inventory 和 Session mutation spans；
- `docs/plugins.md` — 移除 `sessionTree`；plugin 的 AgentLane 直接提供 Branch 方法，而一个 scoped Session-data facet 提供全局 value/list/name/label/query 方法，并排除原始 `mutate`、`idGenerator`、close 和 backend authority；
- `docs/extensions/pi-extensions-v2.md` 和 `docs/extensions/pi-server-artifact/index.md`，在示例/类型使用已变更 surface 之处；
- 已完成的 WP00–WP04，仅在某条前瞻性/当前状态陈述否则会声称已移除的 API 仍然存在之处。

保留当前 remote Session mutation 契约，并将其从一条命名 lane line 更新为唯一的 Session line：worker `RemoteSession.mutate()` 执行无 key 的 begin RPC → 带 remote reads/一次 remote commit 的 local callback → 本地 post-commit publication → end RPC。Server 在 commit 和 publication 期间持有 Session line，直到 end acknowledgment。Disconnect/timeout 在现有 hosting policy 下终止该 scope。更新当前 remote protocol/vertical-slice 文档以及 dev 上存在的每一个实现/测试；不要删除或延迟该行为。

不要重写已发布的 changelog 章节。在非 main/非 PR 的开发分支上不要添加 changelog 条目。

---

## 9. 必需测试

### Session mutation line

- 并发的 `mutate()` 回调全局序列化，包括从不同 AgentLane 调用的回调；
- 第二个回调在第一个回调于 commit/publication 之后返回之前不会进入；
- 直接读取不会等待尚未提交的回调；
- 直接读取观察到一次完全落地的 commit，即使该 mutation 回调在 commit 之后仍保持打开；
- 没有任何直接读取观察到一次部分的多 write commit；
- 两个 read-modify-write counter mutation 产生 `1`，然后 `2`；
- 分开的直接 `getValue` + `setValue` 调用保持有意地非原子；
- zero-commit 回调是合法的；
- 无 key 的 `beginMutation()` 在 `end()` 之前排除所有其他 mutation，commit 不会释放它，end-without-commit 是合法的，重复 end 是幂等的，close 等待 end；
- RemoteSession begin/read/commit/publication/end 保留同样的 scope；
- 第二次 commit 尝试拒绝，包括在第一次尝试失败之后；
- 来自 mutation 回调的嵌套 public write 被记录为无效，并根据所选的 guard 确定性地 block/reject；
- close-first 拒绝 mutation；mutation-first 完成且 close 等待；一个永不返回的 trusted 回调可以阻塞 close；
- Storage commit `seq` 和 stats 行为不变。

### Session 与 Branch

- 新的 Session 有零个 Branch，且没有 main tip value；
- 对被替换的 WIP format-4 schema，不添加任何 storage-version bump、migration、compatibility decoder 或 rejection path；
- 当存在有效的 model/thinking 历史时，legacy coding-agent v3 import 在返回之前重建普通的完整 main-lane configuration 加上 idle state；否则返回一个仅数据的 main Branch；
- legacy config 测试覆盖完整和不完整的历史、非法 legacy 字段，以及只有选中 main 路径上的改动才生效的分支历史；
- `branch(name, context)` 对缺失返回 undefined，并在读取时接收精确的 Context；
- `createBranch` 原子地校验 name、target 和 duplicate；
- 两个并发 create 只有一个赢家；
- Branch 查询默认以它的 tip 为目标，并保留 scan/filter/cursor 行为；
- 直接的 Branch message/custom append 原子地扩展它的 tip；
- 带缺失 data 的 custom entry 仍然有效；
- pending assistant append 拒绝；
- Session 的全局 values/lists/name/labels/global queries 不再依赖 branch；
- 所有 pre-close Branch 对象在 close 之后拒绝；
- branch-scope fork 当且仅当源 main 已配置时一同复制 config + idle state；tree scope 对每个已配置 lane 独立地做同样的事；仅数据的 Branch 保持仅数据；
- 显式的无 key begin/commit/end 保留 commit-before-fork-snapshot ordering，并捕获一个 Storage 序列化的 snapshot boundary。

### AgentHarness 与 AgentLane

- Harness 在类型或 runtime 上没有 AgentLane 方法；
- Session 在类型或 runtime 上没有 Branch 方法；
- AgentLane 直接拥有 Branch 方法，且没有 `sessionTree`/嵌套 Branch 属性；
- 新的 Harness `lanes()` 为空；
- `lane("main")` 原子地创建完整的 main；
- 缺失的命名 lane 默认为 null tip；`createAt` 锚定创建；
- 已存在的仅数据 Branch 变成一个完整的 AgentLane，而不移动它的 tip；
- 对已存在完整 AgentLane 的 acquisition 不提交任何东西，也不发出创建事件；
- 并发 acquisitions 返回同一个对象，并恰好发出一次 `lane_created`；
- 创建 commit 在释放 `Session.mutate` 之前发布 Lane 并绑定接收者；
- 非法 name/unknown anchor 不提交任何东西；
- restored 的完整 lanes/open operations 在不创建 main 的情况下被 inventory；
- 部分 Branch/config/lane-state 组合 fault；
- Harness 全局 metadata wrappers 保留 commit → publication → `value_update` delivery；
- AgentLane idle append 移动 tip；active-run append staging 一个 deferred write 并保留权威状态；
- close/fault 封闭每一个普通 Lane，而不依赖 Harness 继承。

### 回归

- M2 exact-Drive ABA fence 仍然在 commit admission 之前立即检查；
- M3 generation intent/frame/settlement 写入除重命名的 durable/public 字段外逐字节相同；
- frame FIFO 在唯一 Session line 下仍然正确；
- watch 只有 snapshot-first 或 publication-first 结果；
- usage totals 跨 lanes 保持 commit-boundary 精确；
- Context 自始至终保持 trailing 且 source-identical；
- Memory、JSONL 和 SQLite 的 repository/storage conformance 通过。

---

## 10. 排除项

不要添加：

- keyed mutation lines、任意 lock names、resource locks、multi-lock ordering、versions 或 optimistic retries；
- 一个 scheduler、transaction framework、action interpreter 或通用 post-commit task system；
- AgentLane 上的嵌套 Branch/tree/store/access 属性；
- `SessionTree`、`view`、隐式 Session main 方法、Harness lane 方法或 `createLane` 的 compatibility aliases；
- keyed/named begin/end RPC scopes，或移除当前无 key 的 RemoteSession mutation transport；
- `Session.mutate()` 内部的 effects；
- 第二套 Storage commit/sequence 机制；
- 从 `AgentHarness.create()` 或 `harness.lane()` 自动开始工作；
- WP05 M8 之前的 public drive。

不要修改 provider/tool 行为、durable execution phases、retry/deferred policy 或 assistant-frame 语义，超出本包所要求的 signature/name propagation。

---

## 11. 验证

运行每一个修改过的聚焦测试，然后：

```bash
git diff --check
npm run check
./test.sh

rg -n "SessionTree|sessionTree|\.view\(|LaneMutationLine|extends AgentLane|extends Lane" \
  packages/agent/src packages/agent/test packages/agent/docs \
  packages/session-backends packages/protocol packages/coding-agent/src/experimental \
  packages/coding-agent/test/experimental*

rg -n "beginMutation\([^)]*,|mutate\([^)]*,[^)]*," \
  packages/agent/src packages/agent/test packages/session-backends packages/coding-agent/src/experimental

rg -n "session\.mutate\([^)]*\"|\.mutate\(\s*[a-zA-Z_$][a-zA-Z0-9_$]*\s*," \
  packages/agent/src packages/agent/test packages/session-backends
```

预期第一次 grep 只匹配本包的问题陈述、显式历史的 work-package API 描述、negative type assertions，以及不相关的 coding-agent tree-widget 名称（如 `SessionTreeNode`）；不再有任何当前 harness 的 `SessionTree` 概念残留。keyed-mutate grep 在手动检查误报之后必须为空。

在提交之前与 Fable 一起审查完整的实现和规范性文档更新。没有用户明确批准不得提交。

---

## 12. 停止条件

当以下条件满足时 WP06 完成：

- Session 有一条无 key 的 mutation line；回调 `mutate()` 和显式 begin/commit/end remote transport 共享它，且两者都不接受 lane key；
- 直接读取绕过该 line，且只暴露完全应用的 Storage commits；
- `SessionTree` 和隐式 main 的 Session 行为已消失；
- Branch 是仅数据的 path/tip 抽象；
- AgentLane 直接暴露 Branch 方法，并保留 operation-aware append 语义；
- AgentHarness 是 composition-only，没有 AgentLane 方法，并原子地 get/create lanes；
- 新的 Session/Harness 不需要 main；
- 所有进程本地 publication 和 event-binding 边界保持正确；
- 所有三个 backend 和聚焦 race tests 通过；
- `harness.md` 和 WP05 一致地描述新模型；
- 最终 Fable 审查报告无发现；
- WP05 M4 可以恢复。
