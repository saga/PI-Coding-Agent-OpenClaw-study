# Scoped storage Step 1 — 可执行的实现 handoff

**状态：可执行，尚未实现。**

**编写基于：** `c4b0e35ab`（`dev`）。如果实现基线发生重大变化，请重新审计所列的源文件。

这个 handoff 只实现 storage scopes。**在 [`scopes.md`](scopes.md) 之前先读本文件。** 它取代那里有冲突的细节，尤其是 per-scope sequence space、从 operation 推导出的 orphan 检测、一次性 scope ID、raw-string scope 参数、以 `.jsonl` 结尾的 sidecar、所提议的 interned retirement tuple，以及把 JSONL delta/address encoding 捆绑进同一变更。`scopes.md` 中更广泛的动机和测量仍然是设计证据；在本文件与之不同的地方，它的签名和实现顺序已不是最新的。

Step 2 — Chord-encoded JSONL values、address interning、compact tuple records 及其测量 — 是一个单独的包。在 Step 1 经过测试、审查、由用户明确批准、commit 并 push 之前，不要开始 Step 2。

## 0. 交付协议

这个包有一个强制的用户检查点：

1. 只实现 Step 1。
2. 运行每一个必需的 focused test、`npm run check` 和 `./test.sh`。
3. 审查完整 diff 并报告结果。委托的 review（如果使用）以 provider `anthropic` 和 model `claude-fable-5` 运行。
4. **停下来等待用户明确批准。**
5. 批准后，只 commit 这个包的文件并 push 该 commit。
6. 在设计或实现 Step 2 之前确认已 push 的 commit。

不要把 Step 1 和 Step 2 的 commit 合并。批准之前不要 commit 或 push。

## 1. 必读

编辑之前完整阅读：

1. `packages/agent/docs/harness.md` §§0.2–0.9、1.1–1.7、2.7–2.8、3.7–3.8、3.13、4.4–4.8、5.4、Part 7、Part 9。
2. `packages/agent/docs/values.md`。
3. `packages/agent/docs/mobile-handoff/README.md`。
4. [`scopes.md`](scopes.md)，在二者冲突的地方使用本 handoff。
5. `../01-delta/delta.md`，仅用于词汇表归属；Step 1 不存储 Chord ops。
6. `../04-tool-output/harness-tools.md` §§7.1–7.7，用于后续消费者的上下文；不要在这里实现它的 output 重新设计。
7. `../05-assistant-output/message-update.md` §7，用于后续消费者的上下文；不要在这里实现它。
8. `packages/agent/src/harness/session/{types,values,commit,in-memory-storage-state,memory,session,index}.ts`。
9. `packages/agent/src/harness/session/jsonl/` 下的每个文件，以及 `packages/agent/src/harness/{types,env/nodejs}.ts` 中的 `FileSystem` 声明/实现。
10. `packages/agent/src/harness/runtime/{progress,lane}.ts`、`runtime/drive/{terminal,response,deferred,tools,reconcile,structural,boundary}.ts`，以及 `operationCleanupWrites` 的每一个调用者。通过 grep 审计检查 `tool-placement.ts`，但当前源码在那里没有 scoped delete。
11. `packages/session-backends/sqlite-node/src/{index,sqlite/index}.ts`、`sqlite/{storage,repo}.ts`、`migrations/001_initial.sql`，以及 `session/{values,session-sequences}.ts`。
12. 共享的 storage/repository conformance 以及 §9 中列出的每一个 focused test。
13. `scopes.variance.ts`，仅用于 covariant-address/invariant-write phantom 机制。它当前无 ID 的 `EphemeralScope` 和 `retireScope(id: string)` 签名被 §2 取代，必须在 Slice A 中更新。

不要用 `dist/` 作为实现输入。Format 4 仍然是 WIP；这个包不包含 R11 migration。

## 2. 固定的 scope 契约

### 2.1 运行时 scope 身份

一个 scope ID 是一个可复用的逻辑生命周期名，而不是一个全局一次性的 token：

```ts
export type SessionScope = { readonly kind: "session" };

export interface EphemeralScope {
	readonly kind: "ephemeral";
	readonly id: string;
}

export type Scope = SessionScope | EphemeralScope;

export function ephemeralScope(id: string): EphemeralScope;
```

`ephemeralScope(id)` 要求一个非空且良构的 Unicode 字符串，并返回一个冻结的值。相等的 ID 标识同一个物理 scope；对象身份没有意义。JSONL 用 `encodeURIComponent` 编码 ID。编码后的分量必须至多 180 个 ASCII 字符；拒绝更长的 ID 和孤立代理项输入。物理文件名始终有一个固定的 `scope-` 前缀，所以编码后的 `.`/`..` 值不能成为 path segment。不要把未编码的调用者输入直接插值进路径。

不存在 create/open-scope 事务。第一次 scoped value/list 写入创建物理状态。之后的一次 `retireScope(scope)` 通过其被分配的全局 sequence 结束该 scope 中的一切。retirement 之后在同一个 ID 下的写入开始一个新的逻辑生命周期。

Harness operation scope 使用 `ephemeralScope(operationId)`。通用应用 scope 可以使用稳定的名字。Storage 永远不会把 scope ID 解析为 operation ID，也永远不会读取 Harness operation state 来决定生命周期。

### 2.2 复用与 retirement 边界

全局 sequence 顺序定义可复用的世代：

```text
seq 10  scoped write S
seq 20  scoped write S
seq 30  retireScope(S)
seq 40  scoped write S       # new lifetime
```

对于给定的 scope ID，只有 `seq` 大于其最新已 commit 的 retirement sequence 的 scoped 记录是活的。Memory 和 SQLite 通过在 retirement 时删除当前行/map 并允许之后的写入重新创建它们来实现这一点。JSONL 使用 retirement sequence 作为它的 replay 边界（§6）。

Retirement 在 storage 意义上是幂等的：retire 一个没有当前状态的 scope 是合法的，并推进边界。之后的写入仍然开始一个新的生命周期。Storage 不维护一个全时段 used-ID registry，也不拒绝复用。

因此，一个在 retirement 之后到达 commit line 的 scoped 写入是一个新生命周期的写入。Harness invocation fencing 和 settlement drain 必须继续确保一个迟到的 assistant/tool progress job 无法在 terminal retirement 之后重新创建 operation output。为这个边界添加显式测试。

### 2.3 显式 retirement 是唯一的权威

```ts
export function retireScope(scope: EphemeralScope): Write<SessionScope>;
```

Storage 永远不从不存在的 operation、namespace、当前状态或缺失的 owner 推断 orphanage。唯一有效的生命周期边界是一次已 commit 的 `retireScope` 写入。如果一个 owner 从不 retire 它的 scope，那是 owner 缺陷，scope 保持存活。

崩溃行为：

- 在 retirement 事务 commit 之前崩溃：scope 保持存活并重新打开；
- 在 retirement commit 之后但 JSONL unlink 之前崩溃：replay 看到 retirement 边界，忽略边界前的 sidecar 记录，并重试物理删除；
- 在之后一个复用的生命周期中崩溃：最新 retirement 之后的记录正常重新打开。

Repository deletion 单独移除属于被删除 Session 的每一个物理 sidecar。它不需要 operation 语义。

### 2.4 地址与写入类型

地址携带一个协变的 scope tag；写入携带一个不变的 scope tag。独立地保持值类型不变性：

```ts
interface Value<T, Sc extends Scope = SessionScope> { /* existing fields + scope */ }
interface ValueList<T, Sc extends Scope = SessionScope> { /* existing fields + scope */ }

declare function value<T>(namespace: string, key?: string): Value<T, SessionScope>;
declare function value<T>(namespace: string, key: string, scope: EphemeralScope): Value<T, EphemeralScope>;
declare function list<T>(namespace: string, key?: string): ValueList<T, SessionScope>;
declare function list<T>(namespace: string, key: string, scope: EphemeralScope): ValueList<T, EphemeralScope>;
```

一个 session-scoped 地址没有运行时 scope ID。一个 ephemeral 地址携带它的 scope ID。Scope 是物理身份的一部分：session scope 和 ephemeral scope 中，或在两个不同 ephemeral ID 中，namespace/key 相等的地址是不同的。

`setValue`、`deleteValue`、`appendList` 和 `deleteList` 在 `Write<Sc>` 中保留地址 scope。Entry 和 usage 写入是 session-scoped 的。`retireScope` 是 session-scoped 的，即便应用它会删除 ephemeral state。

一个普通事务中的所有写入都有一个静态 scope。一个 session 事务可以包含 session values、entries、usage 以及一个或多个 `retireScope` 写入。它不得包含直接的 ephemeral set/delete/append。一个 ephemeral 事务只能包含 value/list 写入。在运行时，一个事务中的每一个 ephemeral 写入都必须携带同一个 scope ID；两个不同的 ID 具有相同的 TypeScript tag，需要这一断言。

做最小的泛型改动，以便通过 `Write`、`CommittedWrite`、`Storage.commit`、Session mutation 能力、`CommitDecision` 和 lane command 保持这一点。遵循 `scopes.variance.ts` 中的 variance 证明；不要让 reader 变成不变的，也不要在只读 API 中传播不必要的 scope 类型参数。

### 2.5 一个全局 sequence 空间

Memory、JSONL main record、JSONL sidecar record 和 SQLite row 共享一个 Session 全局的 sequence 空间。每一个被接纳的 commit 保持串行化，并按接纳顺序接收递增的 sequence。Gap 保持合法。

- Memory 继续使用一个 `nextSeq`。
- SQLite 继续在写事务内从 `sessions.next_seq` 分配。
- JSONL main 和 sidecar append 共享一个 commit queue 和一个常驻 `nextSeq`。

JSONL open 在删除或忽略已退休的物理文件**之前**，从 main header 和每一个匹配 sidecar 中的每一条完整记录计算 high-water mark。一个已退休 sidecar 的 sequence 之后可能变成 gap，但永远不能被复用。被撕裂的未 commit 最终事务不会推进 durable high-water mark。

不允许 reservation record、per-scope sequence counter 或 range allocator。

## 3. List tag

Step 1 只添加后续 tracked-output recovery 所需的机制：

```ts
export interface ListElement<T> {
	seq: number;
	value: T;
	tag?: string;
}

export interface ListReadOptions {
	cursor?: ListCursor;
	order?: "asc" | "desc";
	limit?: number;
	stopAtTag?: string;
}

export function appendList<T, Sc extends Scope>(
	address: ValueList<T, Sc>,
	element: NoInfer<T>,
	tag?: string,
): ListAppendWrite<Sc>;
```

Tag 在存在时是非空字符串。Storage 存储并返回该 tag，而不解释元素。

读取语义：

1. 应用地址 scope、排他的 cursor 和 order。
2. 最多检查规范化后的 `limit` 个元素。
3. 在第一个携带 `stopAtTag` 的元素处停止并包含它。
4. 返回那个可能被缩短的页。

`stopAtTag` 永远不会搜索超出页 limit 的范围。如果页中没有，调用者从最后返回的 sequence 再次翻页。**不要**添加草案中的 `tag` 过滤器；当前没有消费者需要它，而且把过滤与现有 cursor 形态结合是模糊的。

SQLite 可以获取被索引的 `limit` 行，并在 TypeScript 中于第一个返回的 tag 处截断；storage 仍然永远不解析 payload。保持现有的主键查询计划，不进行临时排序。

## 4. Step 1 的 durable payload 保持不变

这个包改变生命周期和路由，而不改变 output 表示：

- `pendingToolOutput` 保持为 `Value<AgentToolResult<unknown>, EphemeralScope>`；
- `pendingAssistantFrames` 保持为 `ValueList<AssistantMessageFrame, EphemeralScope>`；
- `operationToolMemo` 保持为一个 `JsonValue` 标量；
- JSONL 事务记录保持为可读的 keyed object；
- assistant progress 仍然每个被接受的 frame append 一个 frame；
- tool checkpoint 仍然替换整个 snapshot；
- `message_update` 和 `tool_update` 的 event 形态不变；
- safe replay 保留它当前的 checkpoint 行为，包括那个由后续 tool-output 包负责的已知 delete-before-replay bug。

不要重命名 `pendingAssistantFrames`、引入 `pendingAssistantOutput`、存储 `WireOp[]`、添加 Chord tracker/codec、重新设计 `AgentHarnessTool`，或在这里改变 output cadence。

## 5. 运行时所有权与清理

### 5.1 被移到 operation scope 的地址

用 `ephemeralScope(operationId)` 构造这些地址：

- `operationToolMemo(operationId, invocationId, name)`；
- `pendingToolOutput(operationId, invocationId)`；
- `pendingAssistantFrames(operationId, responseEntryId)`。

所有其他当前 built-in 保持 session-scoped。特别是 `pi.op.state`、`pi.op.meta`、`pi.op.tool_args`、`pi.op.preparation` 和 `pi.pending.entry` 留在 main scope，因为它们的写入与 lane/operation state 原子地协调。

### 5.2 没有跨文件 cleanup 事务

从同时写入 session state 的事务中移除直接的 ephemeral delete：

- assistant response settlement；
- deferred-response supersession；
- `drive/tools.ts` 中的 tool outcome staging；
- cancellation/recovery decision；
- terminal per-address cleanup。

当前的 `drive/tool-placement.ts` 没有 ephemeral delete；不要在那里发明一个改动。

`operationCleanupWrites` 停止扫描 tool memo 和 tool output，并停止构造一个 state 导向的 assistant-frame delete。它保留 session-scoped 的 operation/meta/args/preparation/pending-entry cleanup，并在通用的 terminal 后缀中恰好添加一个 `retireScope(ephemeralScope(operationId))`。

在移除当前的 staging/terminal 扫描之后，移除 `operationToolMemoPrefix` 和 `pendingToolOutputPrefix`；当前源码没有其他生产消费者。把规范性的导出 prefix-constructor 数量从五更新为三，并更新精确的 constructor 测试，而不是保留死的 inventory API。

一个仅 ephemeral 的 delete 仍然合法。例如，当前的 safe-replay checkpoint delete 保留，因为它的事务不包含 session 写入；修复它的行为属于后续的 tool-output 包，而不是 scoped storage 或 JSONL 优化。

### 5.3 不可达的 scoped residue

在一个 response settle、一个 deferred response 被 supersede，或一个 tool 到达 `outcome_ready` 之后，它先前的 frame/checkpoint/memo 可能仍然在仍处于活跃的 operation scope 内物理上和逻辑上可寻址。当前的标量 operation state 不再引用它们；没有 recovery 或 snapshot 路径扫描该 scope 来推断权威。terminal retirement 删除整个 scope。

称之为 **unreachable scoped residue**，而不是 orphanage。更新 `harness.md` 中当前要求一次 `outcome_ready` 调用没有物理存在的 memo/checkpoint 的 invariant。替代的 invariant 是：已 settle 的子 state 永远不消费或暴露 residue，而 terminal retirement 与 operation 完成原子地移除所有 scoped state。

Close 和 fault 是受控崩溃，永远不 retire 该 scope。Reopen 只通过从当前权威 operation state 推导出的地址恢复 scoped progress。

## 6. JSONL sidecar

### 6.1 物理布局

主 session 文件保持不变，除了已 commit 的 scope-retirement 记录。每一个 main 文件在 `${mainPath}.scopes` 拥有一个已知的 sidecar 目录；这不需要 dirname API 或 `FileSystem` 扩展。用 `createDir(..., { recursive: true })` 惰性地创建它。用 `listDir` 在那个确切的路径上发现 scope。一个 sidecar 文件名恰好是 `scope-${encodeURIComponent(scope.id)}.scope`，受 §2.1 的 180 字符编码分量限制约束。后缀不以 `.jsonl` 结尾，而 sidecar 目录本身是一个目录，所以 repository listing 永远不会把二者误认为一个 Session。

一个 sidecar 以这个确切的 header 开头：

```ts
interface JsonlScopeHeader {
	v: 4;
	kind: "scope_header";
	sessionId: string;
	scopeId: string;
	storageVersion: 1;
}
```

在 replay 之前验证确切的 session/scope 身份。通过在 `${mainPath}.scopes` 内的一个临时文件加上原子 rename 创建第一个 header。临时文件名以 `.tmp` 结尾，永远不会被发现为 sidecar。使用现有的 `FileSystem` 能力；不要添加 dirname 方法、扩展 `JsonlStorageOptions`，或向 agent core 添加 Node 专用的文件系统访问。

Step 1 的 sidecar 写入保留当前的对象记录拼写，并在 committed shape 中携带/验证它们的 scope ID。每一个物理事务保持为一条完整的行或一条数组行。Sidecar 事务只能包含该确切 scope 的 value/list 写入。

### 6.2 Retirement 记录

main log 记录一次显式的 committed write：

```ts
interface CommittedScopeRetireWrite {
	kind: "scope";
	op: "retire";
	seq: number;
	scopeId: string;
}
```

它的 Step 1 JSON 表示是对应的可读对象。不要使用草案中的 `['!', addrId, seq]`：一个 scope 不是一个 interned 的 value/list 地址。Compact tuple 拼写属于 Step 2，必须在那里设计。

应用一次已 commit 的 retirement 会移除该 scope 中的常驻 value/list。在完整的 main 事务 durable 之后，JSONL 在同一个 commit queue 上同步地串行化生命周期清理：关闭任何拥有的 sidecar 资源，尝试 unlink，然后释放队列。unlink 失败对已经 commit 的业务事务是非致命的；sidecar 在逻辑上仍被 retirement sequence 界定，删除会在 reopen 时重试。

### 6.3 Replay 与可复用 ID

Open 在接纳写入之前执行这些逻辑阶段：

1. 读取/修复 main 文件并解析完整的 main 事务。
2. 发现并验证匹配的 sidecar；忽略不相关的文件。
3. 解析完整的 sidecar 事务并修复被撕裂的最终事务。
4. 从 header 和**所有**完整的 main/sidecar 记录计算全局 sequence high-water mark，包括稍后被 retirement 排除的记录。
5. 从 main 事务确定每个 scope 最新的 retirement sequence。
6. 保留其 sequence 大于该 scope 最新 retirement 的 sidecar 写入。
7. 按全局 sequence 合并保留的 main 和 sidecar 事务，并按全局顺序 replay 它们，保持事务边界并拒绝重复/非单调的 sequence。
8. 推进到预先计算的 high-water mark。
9. 移除在其最新 retirement 之后没有记录的 sidecar；cleanup 失败不会让已退休的内容变为活的。

Main 事务在 sidecar 事务发生的地方有 sequence gap。Sidecar 在其他 scope/main commit 发生的地方有 gap。二者都保持合法。

一个在 retirement 之后包含记录的 sidecar 是一个活跃的复用生命周期，不得被删除。把 retirement cleanup 与之后的写入串行化，这样一次旧的 unlink 无法竞争并移除一个新复用的 sidecar。

活跃 sidecar 中格式错误的内部记录或身份不匹配是 storage corruption，会 fail open。一个被撕裂的最终事务被整体丢弃。被中断的原子创建留下的临时文件是 cleanup artifact，永远不会成为 sidecar。

### 6.4 Legacy v3

Legacy v3 没有 scope。一个普通的 Harness operation 在任何 progress 写入之前 commit session-scoped acceptance，所以它在正常路径中先升级。仍然要定义并测试当第一个调用者写入是 ephemeral 时的通用 storage 行为：在全局 commit queue 下完成现有的 v3-to-v4 main rewrite/usage 调整，然后 commit scoped 事务而不把它放进 main 文件。在 sidecar append 之前崩溃不会留下已 commit 的调用者事务，并可能复用其未 commit 的 sequence。

### 6.5 Repository 与 fork 行为

- Repository `list()` 通过其现有的非文件/`.jsonl` 过滤忽略 `${mainPath}.scopes` 目录及其文件。
- Repository `delete()` 通过其当前路径移除 main 文件，然后用 `force: true` 递归移除 `${mainPath}.scopes`；scope 目录 cleanup 失败会在 main 文件结果已知之后拒绝删除，而不推断 Harness state。缺失的 scope 目录是合法的。
- `JsonlStorage.close()` 像今天一样排空它已接纳的 main/sidecar commit；`JsonlSessionRepo.close()` 保留它当前的生命周期行为，因为 repository 所有权是一个单独的包。不会仅仅因为一个 handle 关闭就 retire 任何 progress scope。
- 完全保留当前的 fork allowlist。不要向任一 fork scope 添加通用应用 value 或 list。确保 source snapshot 和 backend fork reader 忽略所有 ephemeral value/list，无论 namespace 是什么；当前 destination 在逻辑上保持不变，只是 ephemeral state 无法泄漏。
- Fork destination 不包含 sidecar 或 retirement state。
- WP08 可能稍后替换 fork materialization，但必须保留这个 scope 策略。

J1 compaction 被排除。当 J1 最终落地时，只有在失去该边界无法使任何物理 sidecar 变为活的之后，它才可以省略一条历史 retirement 记录。

## 7. Memory backend

用 scope 扩展 `InMemoryStorageState` 的物理 value/list 身份。Session scope 和每一个 ephemeral ID 都是不同的。保留一个全局 `nextSeq` 和当前的 stats 行为。

应用 `CommittedScopeRetireWrite` 在周围事务的同一次同步应用中删除该 scope 中的每一个 scalar/list。它不删除 entry 或 usage，它们不能是 ephemeral。之后的 scoped 写入在同一个 ID 下重新创建 state。

Snapshot 暴露 scope，以便 fork 代码可以拒绝 ephemeral state，但 `createForkSnapshot` 保留它当前的 built-in allowlist，且不得开始复制通用的 session-scoped 应用 value 或 list。Instrumentation 仍然必须报告确切的 committed write 顺序，包括 retirement。

## 8. SQLite backend

原地更改 WIP schema，不做 migration：

```sql
scalar_values(
  session_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  seq INTEGER NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY(session_id, scope_id, namespace, key)
) WITHOUT ROWID;

list_values(
  session_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  seq INTEGER NOT NULL,
  value TEXT NOT NULL,
  tag TEXT,
  PRIMARY KEY(session_id, scope_id, namespace, key, seq)
) WITHOUT ROWID;
```

对 session scope 使用 `scope_id = ''`，否则使用确切的 scope ID。每一个 point read、prefix scan、set/delete、append/delete、snapshot 和 query-plan 断言都包含 scope 身份。

在同一个 `BEGIN IMMEDIATE` 事务内，一次 retirement 写入执行：

```sql
DELETE FROM scalar_values WHERE session_id = ? AND scope_id = ?;
DELETE FROM list_values   WHERE session_id = ? AND scope_id = ?;
```

它仍然通过 `sessions.next_seq` 消耗其被分配的全局 sequence，即便没有已退休 scope 的 tombstone 行残留。之后在同一个 ID 下的写入自然地重新创建行。Retirement rollback 必须恢复 scoped 行和所有同级 main 写入。

Fork 路径只复制 `scope_id = ''`。Shared-container deletion 保持 Session-scoped，并与其他 Session 行一起移除所有 value/list，无论 scope 是什么。

## 9. 必需的测试

在每个实现 slice 之前或与之同时移植测试。从拥有该测试的包使用 repository 的 Vitest 二进制。不要直接运行完整的 Vitest 套件。

### 9.1 类型与 constructor 测试

- Session 地址默认是 `SessionScope`。
- Ephemeral 重载保留 `EphemeralScope`，同时保持不变的 `T`。
- 地址 scope 对读取是协变的；写入 scope 是不变的。
- 同 scope 的 session 事务通过类型检查。
- 同 scope 的 ephemeral 事务通过类型检查。
- Session 写入加上 `retireScope` 通过类型检查。
- 一个事务中直接的 session + ephemeral 写入以 `@ts-expect-error` 失败。
- 两个 ephemeral ID 逃避静态区分，但使运行时的同 ID 断言失败。
- Scope 对象身份无关紧要；相等的 ID 访问同一个 state。
- 空的和过长的编码 ID 被拒绝；分隔符/Unicode 编码而不发生路径逃逸。
- namespace/key 相等的 session 和 ephemeral 地址不互为别名。

### 9.2 共享 backend conformance

在 Memory、JSONL 和 SQLite 上以相同方式运行：

- ephemeral scalar set/get/replace/delete；
- ephemeral list append/page/whole-list-delete；
- namespace/key 相等的独立 scope；
- session scope 独立于相等的 ephemeral 地址；
- 混合 session/ephemeral 事务在 mutation 之前被拒绝；
- 一个事务中的两个 ephemeral ID 在 mutation 之前被拒绝；
- retirement 删除确切 scope 中的每一个 value/list，且不删除其他 scope；
- retirement 与 session 同级写入原子；
- 对不存在的 state 的 retirement 是合法的；
- retirement 之后的写入重新创建一个新生命周期；
- 重复 retirement 推进边界而不使之后的写入消失；
- main、scope A、scope B、retirement 和 reused-A 的 commit 按接纳顺序接收全局递增的 sequence；
- 已退休/删除的物理元素留下合法的 gap，且 reopen 后的第一次 commit 分配在所有完整先前记录之上；
- list tag 往返，页 limit 保持有界，且升序/降序的 `stopAtTag` 包含该 marker；
- stats 忽略 scoped value/list 和 retirement；
- close 排空已接纳的 scoped commit，并拒绝之后的读/写。

### 9.3 JSONL focused test

- 第一次 scoped 写入恰好创建一个有效的 sidecar，且不创建 main value/list 记录；
- 一个 scoped 事务中的若干写入保持为一条物理 sidecar 行；
- main 和多个 sidecar 按全局 sequence 顺序 replay；
- header `nextSeq` 和所有完整的 sidecar 记录贡献 reopen high-water；
- 被撕裂的 sidecar 最终事务被整体丢弃并修复；
- 格式错误的内部活跃 sidecar 和 header 身份不匹配 fail open；
- retirement 之前崩溃让 scoped 数据保持存活；
- main retirement 之后但 unlink 之前崩溃让数据在逻辑上缺失，且 cleanup 重试；
- unlink 失败不会拒绝已经 commit 的 terminal 事务；
- retirement 之后的复用只 replay 最新 retirement sequence 之后的记录；
- 多个 retirement/reuse 循环选择最新的边界；
- retirement cleanup 被串行化，所以之后的复用不会被更早的 unlink 删除；
- 被忽略的边界前记录仍然阻止 sequence 复用；
- sidecar 和临时文件永远不出现在 repository listing 中；
- repository deletion 移除所有 sidecar；
- fork 排除通用应用拥有的 ephemeral value/list；
- legacy-v3 第一次 session 写入和第一次 scoped 写入路径都产生有效的 v4 state；
- close/reopen 保留活跃的 operation progress 且不 retire 它。

### 9.4 SQLite focused test

- schema 和 query helper 包含 `scope_id`；list 行保留可为空的 tag；
- 一个事务原子地删除 scoped scalar/list 行并写入 terminal main state；
- scope 删除后的强制失败回滚删除和同级写入；
- retirement 之后的复用在同一 scope ID 下重新创建行；
- `sessions.next_seq` 为 retirement 推进；
- list paging plan 仍然使用 scoped 主键，没有临时 b-tree；
- per-file 和 shared-container 布局都隔离 Session 和 scope ID；
- fork 和 Session deletion 正确地排除/移除 scoped 行。

### 9.5 Harness 集成

更新现有的 exact-write 测试，而不是削弱它们：

- assistant/deferred settlement 丢弃 mixed-scope frame delete；
- tool outcome staging 丢弃 mixed-scope checkpoint/memo delete；
- 在拥有它的子项 settle 之后，unreachable residue 永远不会被 snapshot/recovery 消费；
- safe-replay 当前的 ephemeral-only delete 保持有序且被 fence；
- 每一个 terminal 叶子在文档化的 cleanup 位置发出一次 retirement；
- close/fault 不发出 retirement，且 reopen 恢复当前的 frame/checkpoint/memo；
- cancellation 和 unknown-outcome recovery 只在 terminal 完成时 retire；
- 迟到的排队 assistant/tool progress 无法在 terminal retirement 之后 commit 或重新打开 scope；
- terminal cleanup 不再扫描 memo/output 前缀；
- §12 的 old-delete/prefix grep 找到的每一个 focused test 和 fixture 都被刻意更新；不要依赖历史数字测试计数；
- 通过 `drive/{response,reconcile,structural,boundary}.ts` 中的 `operationCleanupWrites` 调用者到达的每一条 terminal 路径都被覆盖，包括每一个 operation family 和 cancellation。

可能的 focused 文件包括：

```text
packages/agent/test/harness/values.test.ts
packages/agent/test/harness/{memory,jsonl}-storage*.test.ts
packages/agent/test/harness/{memory,jsonl}-session-repo*.test.ts
packages/agent/test/harness/runtime/drive-{terminal,retry-deferred,tools,reconcile,generation}.test.ts
packages/session-backends/sqlite-node/test/{storage,storage-conformance,repo,repo-conformance}.test.ts
```

使用编译器和 grep guard 找出其他受影响的测试，而不是假设这个列表是详尽的。

## 10. 实现 slice

### Slice A — 契约、类型、Memory reference、list tag

主要文件：

```text
CREATE packages/agent/src/harness/session/scope.ts for `SessionScope`, `EphemeralScope`, `Scope`, `ephemeralScope`, scope phantoms/helpers, and runtime scope-ID validation
MODIFY packages/agent/src/harness/session/{types,values,commit,in-memory-storage-state,memory,session,index}.ts
MODIFY packages/agent/src/harness/session/testing/{conformance/storage,instrumented-storage,storage-decorator,gating-storage}.ts
MODIFY packages/agent/test/harness/{values,memory-conformance,memory-storage,storage-backed-session}.test.ts
MODIFY packages/agent/docs/mobile-handoff/01-harness/02-scopes/scopes.variance.ts
```

1. 添加 scope value/address/write variance 和可复用 ID 语义。
2. 添加 retirement committed write 和单 scope 事务验证。
3. 添加 tag/`stopAtTag` 行为。
4. 实现 Memory 物理身份、retirement、全局 sequence、snapshot。
5. 在继续之前通过类型测试和 Memory conformance。

### Slice B — SQLite

主要文件：

```text
MODIFY packages/session-backends/sqlite-node/src/sqlite/migrations/001_initial.sql
MODIFY packages/session-backends/sqlite-node/src/sqlite/{storage,repo}.ts
MODIFY packages/session-backends/sqlite-node/src/sqlite/session/{values,session-sequences}.ts
MODIFY packages/session-backends/sqlite-node/test/{storage,storage-conformance,repo,repo-conformance}.test.ts
```

1. 添加 scoped schema/query 身份和 tag。
2. 实现原子的 `DELETE ... WHERE scope_id` retirement。
3. 保留全局 sequence 分配、stats、branch index、shared-container 行为。
4. 从 fork 中排除 ephemeral 行。
5. 在继续之前通过 SQLite focused/conformance 测试。

### Slice C — JSONL sidecar

主要文件：

```text
CREATE packages/agent/src/harness/session/jsonl/scope-files.ts for fixed directory/file naming, exact header parsing/serialization, discovery, atomic first creation, torn-tail parsing/repair, and recursive cleanup helpers
MODIFY packages/agent/src/harness/session/jsonl/{types,codec,storage,repo,legacy-v3,index}.ts
MODIFY packages/agent/test/harness/jsonl-{storage,storage-conformance,session-repo,session-repo-conformance,v3-migration}.test.ts
```

1. 添加 sidecar 命名/header/创建/发现。
2. 在全局分配的同时把 scoped commit 路由到 sidecar。
3. 持久化 main retirement 记录和串行化的 unlink。
4. 实现多文件 high-water 计算和带可复用边界的全局有序 replay。
5. 处理被撕裂的尾部、corruption、v3、listing、delete、close 和 fork。
6. 在 runtime migration 之前通过所有 JSONL 测试。

### Slice D — Harness migration

主要文件：

```text
MODIFY packages/agent/src/harness/session/values.ts
MODIFY packages/agent/src/harness/runtime/{progress,lane}.ts to propagate scoped write generics through progress channels and lane commands
MODIFY packages/agent/src/harness/runtime/drive/{terminal,response,deferred,tools,reconcile,structural,boundary}.ts
INSPECT packages/agent/src/harness/runtime/drive/tool-placement.ts; current source needs no scoped cleanup change
MODIFY all focused runtime tests found by the §12 greps
```

1. 按 operation ID 对 memo/tool/frame 地址划定 scope。
2. 移除 mixed-scope delete 和 cleanup 扫描。
3. 在通用后缀中添加 terminal retirement。
4. 保留当前的 output/replay/event 行为。
5. 证明 late-write fencing 和每一条 terminal/close/recovery 路径。

### Slice E — 文档与最终验证

更新当前的规范性/参考文档：

```text
packages/agent/docs/harness.md
packages/agent/docs/values.md
packages/agent/docs/post-wp05-roadmap.md
packages/agent/docs/mobile-handoff/README.md
packages/agent/docs/mobile-handoff/01-harness/02-scopes/scopes.md
packages/session-backends/sqlite-node/README.md
packages/agent/src/harness/telemetry.ts and generated `packages/agent/docs/telemetry-schema.md`: add the `scope` session-write item kind without implementing spans
```

不要重写历史的 WP00–WP07 handoff 或已发布的 changelog 章节。在 `dev` 上，根据 repository 的 main-only 规则，不要添加 changelog 条目。

运行：

```bash
npm run check
./test.sh
```

在每个 slice 之后也运行每一个被修改的 focused test。为批准检查点记录完整的命令结果。

## 11. 排除项

不要包含：

- Chord `Op`/`WireOp` storage 集成；
- JSONL address/path interning 或 compact tuple 记录；
- pending-output 地址重命名；
- `ToolOutput`、tool API 变更、replay seeding、memo/checkpoint 原子性、progress cadence、rate limiting、exec-env 变更；
- compact `message_update`、assistant 增量 reducer 变更，或 protocol replication 变更；
- J1 main-log snapshot compaction；
- 超出从当前 fork 排除 ephemeral state 范围的 WP08 fork 重新设计；
- repository 生命周期契约变更；
- 超出保持已声明 schema 对新写入 kind 准确的 telemetry 实现；
- 针对更旧 WIP format-4 SQLite schema 的 migration 或兼容性；
- 应用层的自动 scope 所有权、从 operation 推导出的 orphan 推断、lease、TTL 或后台 scope 收集。

如果实现需要某个被排除的项，停下来并在扩大 scope 之前修订这个 handoff。

## 12. Grep guard

在最终 review 之前，检查每一个剩余的匹配：

```text
operationToolMemoPrefix
pendingToolOutputPrefix
deleteList(pendingAssistantFrames
deleteValue(pendingToolOutput
scopeId
retireScope
stopAtTag
```

预期结果：

- 没有 session-scoped 事务直接删除一个 ephemeral 地址；
- 没有 terminal 路径省略 retirement；
- 没有 backend point read/write 省略 scope 身份；
- 没有 fork 复制 ephemeral state；
- 没有 JSONL sidecar 被当作一个 Session 文件；
- 不存在 per-scope sequence counter；
- storage 中不存在 operation-state/orphan 推断。

## 13. 退出条件

Step 1 在以下情况下实现完成：

- scope/address/write 类型拒绝 mixed-scope 事务，且运行时验证拒绝一个事务中的两个 ephemeral ID；
- ID 通过最新 retirement 的全局 sequence 边界可复用，没有历史 ID registry；
- Memory、JSONL 和 SQLite 共享一个全局 sequence 空间并通过共同的 conformance；
- SQLite retirement 与 terminal state 原子地删除确切的 scoped 行；
- JSONL 只把 ephemeral value/list 写入 sidecar，只在 main log 中记录 retirement，按全局顺序 replay 所有文件，保留 high-water mark，并在不做 operation 推断的情况下删除已退休的 sidecar；
- list tag 和有界的 `stopAtTag` 在各个 backend 上以相同方式工作；
- 当前的 tool/assistant payload 和 event 格式不变；
- 每一条 terminal 路径 retire 一次，而 close/fault 保留活跃的 scope recovery；
- fork 和 repository listing/deletion 正确处理 sidecar；
- focused test、`npm run check` 和 `./test.sh` 通过；
- 最终 review 没有 blocker；
- 完整的 diff 和结果已经呈现给用户，且实现已经停下来等待批准。

只有在明确批准之后，Step 1 才可以 commit 和 push。Step 2 只在那次 push 被确认之后开始。
