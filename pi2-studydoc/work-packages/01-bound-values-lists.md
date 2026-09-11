# WP01 — Bound values 与 lists

## 状态

完成。`harness.md` 具有规范性。[`values.md`](../values.md) 提供了详细的 address、backend 与 conformance 设计。

## 目标

在 Session、Memory、JSONL、SQLite、instrumentation、tests 以及公开 application 访问中，将保留下来的 register/custom-state 存储表面替换为 bound 的 `Value<T>` 与 `ValueList<T>` addresses。在 runtime execution consumers 之前停止。

## 本 package 确定下来的决策

1. **Core 与 application namespaces。** 每个 core address 都使用文档中确切规定的 `pi.*` namespace。Applications 通过相同的公开 `value()` / `list()` constructors 使用它们自己的非保留 namespaces。`fact.custom` 及其 API 被删除，而不是重命名为某个内建 custom namespace。
2. **Forks。** 通用 forks 只复制被显式处理的 core addresses：Branch tip/lane configuration 加上 fresh lane state、session name，以及那些目标会被复制的 labels。它们不复制任何 `pi.op.*`、`pi.pending.*`、list、ledger 或任意的 application address。后续的 application feature 必须先添加 address-specific 的 fork policy，才能依赖被复制的 application state。
3. **Trusted kind discipline。** 将同一个 `(namespace, key)` 同时用作 value 和 list 是一种 trusted-programming 缺陷。Backends 不添加 cross-kind 冲突检查、triggers、registries 或 catalogs。
4. **Operation names。** 保留源中的 `OperationMeta` 用于不可变的 acceptance metadata，保留 `Operation` 用于 process-local 的 `{ meta: OperationMeta, state: OperationState }` projection。`operationMeta(id)` 绑定 `Value<OperationMeta>`；该 composite 永远不会作为一个 value 被持久化。
5. **Query ordering 与 bounds。** `scanValues()` 返回 key 升序的结果。`readList()` 只限制一个 query page，而绝不限制 list 的总长度或字节数：拒绝非正数或不安全的 limits，默认 1,000，并将更大的值 clamp 到 10,000。
6. **不做 WIP 兼容。** 就地替换未完成的 format-4 storage schema。JSONL 仍为 format 4/storage version 1，但只接受新的 value/list records。SQLite 保持 `SQLITE_STORAGE_VERSION = 1`，就地编辑 `001_initial.sql`，将 `registers` 重命名为 `scalar_values`，并添加 `list_values`。不支持 WP01 之前的 format-4 JSONL 与 SQLite 文件。不添加 migration runner 或 legacy decoder。
7. **仅通用基础设施。** WP01 定义所有内建 value/list constructor，包括未来的 assistant/tool addresses，但不实现它们的 runtime consumers。

## Public 与 storage contract

添加 `packages/agent/src/harness/session/values.ts`，包含：

- invariant 的 `Value<T>` 与 `ValueList<T>` address types；
- 通用的 `value<T>(namespace, key?)` 与 `list<T>(namespace, key?)` constructors；
- 仅做 namespace/key 校验：namespace 非空且不含 `\u0000` 组件；
- `StoredValue<T>`、`ListElement<T>`、`ListCursor` 与 `ListReadOptions`；
- 使用 `NoInfer<T>` 的带类型 `setValue`、`deleteValue`、`appendList` 与 `deleteList` 写入 helpers；
- `values.md` 中每一个确切的 built-in constructor 以及五个 scan-prefix constructors。

在全部位置替换旧 API：

```ts
getRegister(namespace, key)       -> getValue(address)
listRegisters(namespace, prefix) -> scanValues(prefixAddress)
register set/delete writes        -> typed value helpers
```

Storage 以及历史性的 Session reader、mutator、tree-view 和 repository 表面暴露相同的 bound-address reads：

```ts
getValue<T>(address: Value<T>): Promise<StoredValue<T> | undefined>;
scanValues<T>(prefix: Value<T>): Promise<StoredValue<T>[]>;
readList<T>(address: ValueList<T>, options?: ListReadOptions): Promise<ListElement<T>[]>;
```

历史性的 tree-view 与 Session 表面还额外暴露 one-commit direct writes：

```ts
setValue<T>(address: Value<T>, next: NoInfer<T>): Promise<void>;
deleteValue<T>(address: Value<T>): Promise<void>;
appendList<T>(address: ValueList<T>, element: NoInfer<T>): Promise<void>;
deleteList<T>(address: ValueList<T>): Promise<void>;
```

`SessionMutator` 保留一个显式的 `commit(writes)`，且不会获得 direct committing 方法。每个 write array 都会将 helper 构造的 value/list writes 与 entries 和 usage 组合在一起。

将 `getName` / `setName` 和 `getLabel` / `setLabel` 保留为 `sessionName` 与 `entryLabel(id)` 之上的 wrappers。删除 `getCustomFact` / `setCustomFact`。将公开的 passive metadata event 从 `fact_update` 重命名为 `harness.md` 已经规定的 `value_update` shape；它只覆盖 session-name 与 entry-label wrappers，而不覆盖任意的 application writes。

## 文件

### 添加

- `packages/agent/src/harness/session/values.ts`
- `packages/agent/test/harness/values.test.ts`
- `packages/session-backends/sqlite-node/src/sqlite/session/values.ts`

### 删除或重命名

- 在将其 scalar 行为迁移到 `values.ts` 之后，删除 `packages/session-backends/sqlite-node/src/sqlite/session/registers.ts`；
- 从 `packages/agent/src/harness/session/types.ts` 中移除所有 register/global-map/custom-fact 声明。

### Agent 源码

- `packages/agent/src/harness/agent-harness.ts`
- `packages/agent/src/harness/session/types.ts`
- `packages/agent/src/harness/session/commit.ts`
- `packages/agent/src/harness/session/storage-state.ts`
- `packages/agent/src/harness/session/memory.ts`
- `packages/agent/src/harness/session/session.ts`
- `packages/agent/src/harness/session/fork.ts`
- `packages/agent/src/harness/session/index.ts`
- `packages/agent/src/harness/session/jsonl/storage.ts`
- `packages/agent/src/harness/session/jsonl/repo.ts`
- `packages/agent/src/harness/session/testing/storage-decorator.ts`
- `packages/agent/src/harness/session/testing/instrumented-storage.ts`
- `packages/agent/src/harness/session/testing/types.ts`
- `packages/agent/src/harness/session/testing/conformance/storage.ts`
- `packages/agent/src/harness/session/testing/conformance/session-repo.ts`
- `packages/agent/src/harness/session/testing/benchmark/storage.ts`
- `packages/agent/src/harness/session/testing/benchmark/session-repo.ts`
- `packages/agent/src/harness/session/testing/index.ts`
- `packages/agent/src/harness/runtime2/restore.ts`
- `packages/agent/src/harness/runtime2/harness.ts`
- `packages/agent/src/harness/runtime2/lane.ts`
- `packages/agent/src/harness/telemetry.ts`
- `packages/agent/src/index.ts` 与 `packages/agent/src/node.ts`，仅在验证新的 public exports 所需时改动；不要添加第二条 export path。

### Agent 测试与生成的文档

- `packages/agent/test/harness/memory-storage.test.ts`
- `packages/agent/test/harness/memory-conformance.test.ts`
- `packages/agent/test/harness/memory-session-repo.test.ts`
- `packages/agent/test/harness/jsonl-storage.test.ts`
- `packages/agent/test/harness/jsonl-storage-conformance.test.ts`
- `packages/agent/test/harness/jsonl-session-repo.test.ts`
- `packages/agent/test/harness/jsonl-session-repo-conformance.test.ts`
- `packages/agent/test/harness/storage-backed-session.test.ts`
- `packages/agent/test/harness/session-tree.test.ts`
- `packages/agent/test/harness/session-create-lane.test.ts`
- `packages/agent/test/harness/instrumented-storage.test.ts`
- `packages/agent/test/harness/types.test.ts`
- `packages/agent/test/harness/telemetry.test.ts`
- `packages/agent/test/harness/runtime2/harness.test.ts`
- `packages/agent/test/harness/runtime2/lane.test.ts`
- `packages/agent/test/harness/runtime2/restore.test.ts`
- 重新生成的 `packages/agent/docs/telemetry-schema.md`

### SQLite backend

- `packages/session-backends/sqlite-node/src/sqlite/migrations/001_initial.sql`
- `packages/session-backends/sqlite-node/src/sqlite/repo.ts`
- `packages/session-backends/sqlite-node/src/sqlite/session.ts`
- `packages/session-backends/sqlite-node/src/sqlite/storage.ts`
- `packages/session-backends/sqlite-node/src/sqlite/index.ts`，若重命名后的 module 需要
- `packages/session-backends/sqlite-node/test/storage.test.ts`
- `packages/session-backends/sqlite-node/test/storage-conformance.test.ts`
- `packages/session-backends/sqlite-node/test/repo.test.ts`
- `packages/session-backends/sqlite-node/test/adapter.test.ts`
- `packages/session-backends/sqlite-node/test/sql.test.ts`

### Coding-agent consumer

- `packages/coding-agent/test/experimental-session-support.ts`
- 验证 `packages/coding-agent/test/experimental-remote-runtime.test.ts`
- 验证 `packages/coding-agent/test/experimental-server-replacement.test.ts`

如果最终的 old-API grep 识别出另一个被保留的 source/test call site，它属于 WP01；不要为了回避改动它而添加 compatibility shim。

## 工作，按顺序

1. **添加 address vocabulary。** 实现 `values.ts`，通过现有的 session/root 路径导出它，并添加聚焦的 compile-time/runtime address tests。在迁移 callers 之前，先加入确切的 built-in namespace/key/kind tests 与 prefix-constructor tests。
2. **一次性切换共享 API。** 替换 `types.ts`/`commit.ts` 中的 register types 与 writes；将 `StorageState` 拆分为 current scalar values 与 surviving list elements；实现 Memory reads/writes、有序 prefix scans、分页 list reads、transaction validation/application、snapshots 以及 direct Session methods。移除 custom-fact APIs，并迁移 name/label wrappers。
3. **迁移 JSONL 与通用 fork/snapshot 代码。** 只编码 `kind:"value"` 与 `kind:"list"`；重放 set/delete/append/delete；保留 transaction-line 的 torn-tail 原子性；将 surviving list elements 连同原始 `seq` 按全局 sequence 顺序合并后序列化；保留 sequence high-water mark。这仅扩展现有的 snapshot serialization——不要添加新的 compaction trigger 或 precise-rewrite feature。Forks 复制 Decisions 第 2 条中固定的 core 集合，像今天一样在复制 entries 之后对 destination scalar values 重新编号 sequence，并且不复制任何 lists。
4. **迁移 instrumentation、conformance 与 benchmarks。** storage decorator 暴露全部三种 reads；instrumented storage 按精确顺序记录 erased value/list writes，但不记录 content telemetry。在 backend-specific assertions 之前先扩展 shared conformance。
5. **迁移 runtime2 shell call sites。** 用 built-in constructors/helpers 替换 lane/harness 的 raw writes。`restore.ts` 使用 `scanValues(branchTipInventoryPrefix())` 加上精确的 `getValue` lookups，且不执行任何 `readList()` 调用。不要添加 acceptance、drive、hydration 或 cleanup 行为。
6. **替换 SQLite WIP schema 与 adapter。** 就地编辑 `001_initial.sql`，在 `session/values.ts` 中实现 scalar operations 以及带索引的 list append/delete/paging，将所有写入保持在现有的 `BEGIN IMMEDIATE` writer-lease transaction 之内，更新两条 fork snapshot 路径，并保留当前 `dev` 中所有的 entry/usage/branch/lease 行为。
7. **迁移 public events、tests 与 coding-agent helper。** 移除旧的 type assertions 与 raw namespaces。将 `fact_update` 改为 `value_update`。基于现有的 WP00 理由，保持两个 remote prompt tests 处于跳过状态；WP01 不得改动 runtime execution。
8. **更新 telemetry 与 documentation。** 将 `pi.session.write` 的 item kinds 从 `register` 改为 `value` 和 `list`，重新生成 `telemetry-schema.md`，运行 old-API sweeps，并记录任何 branch-policy-deferred 的 changelog 要求。除非 `gramps` 成为 pull-request branch 或用户要求，否则不要编辑其上的 changelog。

## Backend 要求

### Memory

- 在改动 entries、values、lists、usage 或 stats 之前，先准备并校验完整的 transaction；
- current scalar 替换只存储最新的 value 与 set `seq`；
- list append 不执行任何 list read，并存储每次全局写入的 `seq`；
- list delete 移除整个确切的 key；
- snapshots 包含 current scalar values 与 surviving list elements。

### JSONL

- 保持 format 4/storage version 1，不做 legacy register decode；
- 一个 single-write object 或 multi-write array 仍然是一行原子 line；
- replay 产生与 Memory 相同的逻辑状态；
- torn final lines 不暴露任何部分 transaction；
- snapshot serialization 保留 surviving list-element sequences 与 next-sequence high-water mark。

### SQLite

使用：

```sql
CREATE TABLE scalar_values (
  namespace TEXT NOT NULL,
  key       TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  value     TEXT NOT NULL,
  PRIMARY KEY (namespace, key)
) WITHOUT ROWID;

CREATE TABLE list_values (
  namespace TEXT NOT NULL,
  key       TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  value     TEXT NOT NULL,
  PRIMARY KEY (namespace, key, seq)
) WITHOUT ROWID;
```

升序与降序的 list queries 使用 primary key，配合 exclusive sequence predicate 和 `LIMIT`。添加 `EXPLAIN QUERY PLAN` assertions，证明没有 table scan 或临时排序 b-tree。不要更改 storage version、添加 migrations 或削弱当前的 lease/fence/fork 行为。

## 必需的覆盖

### Address 与 type 测试

- invariant address typing 以及推断出的 scalar/list 结果类型；
- `NoInfer` 拒绝不兼容的 set/append values；
- scalar helpers 拒绝 list addresses，list helpers 拒绝 scalar addresses；
- 独立构造的相等 addresses 解析到同一位置；
- empty key 可用；empty namespace 与 `\u0000` 组件被拒绝；
- 确切的 built-in namespaces/key grammars 以及恰好五个 prefix constructors；
- application-wide 与动态的非保留 addresses 不需要第二个 operation-time key；
- 没有 registry、catalog、privilege constructor、global value map 或 runtime `pi.*` gate。

### Shared scalar/list conformance

- scalar set/get/delete/delete-absent/recreate 以及 latest set `seq`；
- namespace-scoped、key-ascending 的 prefix scans；
- 追加一个与若干元素，包括在一个 transaction 中多次 append；
- 被无关写入分隔的 appends 仍保持 per-list 顺序与全局 element sequences；
- ascending/descending exclusive cursors；
- default、explicit、invalid 与 clamped 的 query-page limits；
- absent list、whole-list delete、delete-absent 与 delete-then-append；
- atomic entry + usage + value + list transactions；
- 当任何 sibling write 无效时 rollback；
- append 时不做 list read；
- close 拒绝之后的 reads，而已 admit 的 commits 继续 drain。

不要添加 value/list collision test：cross-kind 误用是有意不强制执行的 trusted-programming 缺陷。

### Backend 与 repository 测试

- 完全一致的 Memory/JSONL/SQLite pages 与 cursors；
- JSONL single/multi-write replay、torn-tail 行为以及保留 sequence 的 snapshot 输出；
- SQLite query plans 与 writer-lease transaction 行为；
- branch/tree forks 复制 session name、eligible labels 以及带 fresh lane state 的 lane configuration/Branch tip；
- forks 排除 operation/pending values、所有 lists、application addresses、last results、queues 和 ledger rows；
- repository parent metadata、entry IDs、stats、branch indexes、v3 normalization、UUIDv7/follower IDs 以及当前 SQLite lease/fork 场景保持不变；
- runtime2 restore 通过那一个 prefix constructor 枚举 lanes，且不读取任何 list。

## Deferred consumers

以下 `values.md` 要求明确不属于 WP01 的覆盖范围：

- assistant frame conversion、append scheduling、settlement、recovery、cancellation、snapshot hydration 以及 byte-growth tests（R2/R3/R6/R12）；
- invocation `getMemo` / `setMemo`、tool-output checkpoint writes、outcome cleanup 以及 prefix-driven operation cleanup（R4/R6）；
- 任何 consumption-time 的 list hydration，除证明 base restore 不读取任何 list 之外；
- runtime acceptance、driving、provider/tool effects 或 operation-state 重新设计。

WP01 仍然导出 `pendingAssistantFrames`、`operationToolMemo`、`pendingToolOutput` 以及每一个 cleanup prefix，以便后续 packages 不必重新设计 storage。

## Removal checks

以下内容在保留的 source/tests 中必须零匹配，不包括不可变的已发布 changelog 历史与归档的散文：

```bash
rg -n 'getRegister\(|listRegisters\(|RegisterValues|RegisterNamespace|RegisterSetWrite|\bRegister<' \
  packages/agent packages/session-backends/sqlite-node packages/coding-agent \
  --glob '!**/dist/**' --glob '!**/CHANGELOG.md' --glob '!**/docs/**'

rg -n 'kind: "register"|getCustomFact\(|setCustomFact\(|fact\.(name|label|custom)|fact_update' \
  packages/agent packages/session-backends/sqlite-node packages/coding-agent \
  --glob '!**/dist/**' --glob '!**/CHANGELOG.md' --glob '!**/docs/**'

rg -n '"(branch\.tip|lane\.(config|state|lastResult)|op\.(meta|state|tool_args|preparation)|pending\.entry)"' \
  packages/agent packages/session-backends/sqlite-node packages/coding-agent \
  --glob '!**/dist/**' --glob '!**/CHANGELOG.md' --glob '!**/docs/**'

rg -n '\bregisters\b' packages/agent/src/harness/session packages/session-backends/sqlite-node/src \
  --glob '*.ts' --glob '*.sql'

rg -n '"register"' \
  packages/agent/src/harness/telemetry.ts \
  packages/agent/test/harness/telemetry.test.ts \
  packages/agent/docs/telemetry-schema.md
```

不要把无关的 model/provider/hook registration 术语当作 storage API 残留。

## 验证

直接运行每个创建或修改的 test file，并迭代直到全绿。至少：

```bash
# From packages/agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run \
  test/harness/values.test.ts \
  test/harness/memory-storage.test.ts \
  test/harness/memory-conformance.test.ts \
  test/harness/memory-session-repo.test.ts \
  test/harness/jsonl-storage.test.ts \
  test/harness/jsonl-storage-conformance.test.ts \
  test/harness/jsonl-session-repo.test.ts \
  test/harness/jsonl-session-repo-conformance.test.ts \
  test/harness/storage-backed-session.test.ts \
  test/harness/session-tree.test.ts \
  test/harness/session-create-lane.test.ts \
  test/harness/instrumented-storage.test.ts \
  test/harness/types.test.ts \
  test/harness/telemetry.test.ts \
  test/harness/runtime2/harness.test.ts \
  test/harness/runtime2/lane.test.ts \
  test/harness/runtime2/restore.test.ts

# From packages/session-backends/sqlite-node
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run \
  test/adapter.test.ts \
  test/repo.test.ts \
  test/sql.test.ts \
  test/storage.test.ts \
  test/storage-conformance.test.ts

# From packages/coding-agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run \
  test/experimental-remote-runtime.test.ts \
  test/experimental-server-replacement.test.ts
```

然后从 repository root 运行：

```bash
cd packages/agent && npm run check:telemetry-docs
cd "$(git rev-parse --show-toplevel)"
node_modules/.bin/tsgo --noEmit -p packages/agent/tsconfig.build.json
node_modules/.bin/tsgo --noEmit
git diff --check
npm run check
./test.sh
```

永远不要运行不受限制的 Vitest、`npm test`、paid-provider tests 或 `npm run build`。

## 停止条件

当每一个保留的 backend 与 Session 表面都使用 bound values/lists；所有 core addresses 都使用确切的 `pi.*` grammar；任意 application addresses 可用但 generic forks 会排除它们；旧的 register/fact/custom-state APIs 与物理名称都已不存在；base restore 不执行任何 list read；上述 schema/compatibility 决策都已实现；focused、conformance、TypeScript、telemetry-doc、diff 以及 repository checks 都通过时停止。报告最终的 schema 与 fork 行为。不要开始 runtime acceptance、assistant/tool consumers 或任何后续 work package。
