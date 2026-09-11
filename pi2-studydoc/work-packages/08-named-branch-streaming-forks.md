# WP08 — 具名 branch 与带 streaming copies 的 tree forks

**状态：进行中 — 正在实现 Slice C。**

本包替换 fork 契约：`ForkOptions` 获得一个强制的 scope 和一个强制的具名 source branch，branch forks 校验一个完整配置的 source AgentLane 和 ancestry membership，tree forks 复制完整的不可变 tree 加上当前的 application values/lists，并且所有三个 backends 用有界内存的 streaming copies 替换物化的 source snapshot arrays。JSONL fork 从不修复或修改它的 source。一个封闭的 core classifier 拥有每个 namespace 的 fork disposition。

WP07 是一个硬依赖，并保持不变地保留：no-create database modes、canonical `(containerPath, sessionId)` identity、用于 external/live-worker sources 的独立 read-only WAL reader、repository-local deletion reservation，以及 all-settled close。本包仅取代 roadmap 的 "SQLite fork cost" 性能项。

## 0. 必读

编辑之前请完整阅读：

1. `packages/agent/docs/harness.md` §§0.6、1.3–1.7、2.3、2.7–2.9、Part 9（invariants 3–5、13、16；ledger completeness）。
2. `packages/agent/docs/values.md`，尤其是 "Forks and rewrites" 和 backend 章节。
3. `packages/agent/docs/post-wp05-roadmap.md`（SQLite fork cost、repository lifecycle context）。
4. 已完成的 WP06 §7 和 WP07（历史性的；不要编辑它们）。
5. `packages/agent/src/harness/session/fork.ts`、`types.ts`（`ForkOptions`、`SessionRepo`）、`values.ts`、`in-memory-storage-state.ts`、`memory.ts`、`session/index.ts`。
6. `packages/agent/src/harness/session/jsonl/repo.ts`、`jsonl/storage.ts`、`jsonl/codec.ts`、`jsonl/legacy-v3.ts`、`jsonl/types.ts`。
7. `packages/session-backends/sqlite-node/src/sqlite/repo.ts`、`storage.ts`、`session/values.ts`、`session/entries.ts`、`session/branch-entries.ts`、`types.ts`。
8. `packages/agent/src/harness/session/testing/conformance/session-repo.ts` 以及 §5 中命名的每一个测试。
9. `packages/agent/src/harness/session/testing/benchmark/session-repo.ts` 和两个 `session-repo.bench.ts` 文件。

不要把 `dist/` 输出用作实现输入。WP00–WP07 文档和已发布的 changelog 章节在本包中不可变。

## 1. 固定架构

### 1.1 公共契约

```ts
export type ForkOptions =
	| { scope: "branch"; branch: string; entryId?: string; position?: "before" | "at"; id?: string }
	| { scope: "tree"; id?: string };
```

`scope` 是必需的。branch scope 必需 `branch`。没有默认 scope，没有隐式 `main`，也没有 compatibility alias。

**Branch scope** 要求一个完整配置的 source AgentLane：`pi.branch.tip/{branch}`、`pi.lane.config/{branch}` 和 `pi.lane.state/{branch}` 必须全部存在。缺失的 tip 拒绝（`unknown branch`）；一个仅数据的 Branch（tip 但没有 config/state）拒绝。Forking 不审计无关的 lanes 或格式错误的 lane records：受支持的 writers 原子地创建 lane state，因此 branch validation 只检查所选 Branch 的必需 tip、config 和 state。`entryId` 在提供时必须是该 Branch 当前 tip ancestry（含）上的一个 entry；tree 中其他位置的 entry 拒绝。省略 `entryId` 意味着当前 tip。`position` 默认为 `"at"`；`"before"` 选中 target 的 parent，并可能产生一个 `null` destination tip（在 root entry 之前，或一个没有 `entryId` 的 `null` source tip）—— 合法。Destination 恰好包含一个同名的 Branch、选中的 tip、复制的 `LaneConfiguration`，以及全新的 idle lane state `{ currentOperationId: null, lastOperationId: null, inbox: [] }`。Destination 中不存在其他 Branch 或 lane。

这有意地使仅数据 Branch 的 branch forks 不可用 —— 包括 legacy v3 imports，其 main 缺少可重建的 model/thinking 历史。对那些 source 而言 tree scope 仍然可用。

**Tree scope** 复制：每一个不可变 entry，包括从每一个当前 Branch tip 都不可达的 entries；每一个 Branch tip 原样；每一个已配置 lane 的 config 加上同名的全新 idle lane state；仅数据的 Branches（tip 存在，config/state 缺失）作为仅数据的 Branches。Forking 不对 lane records 执行 corruption audit；受支持的 writers 原子地创建有效的 lane state。

**两个 scopes**：复制 `pi.session.name`；只为被复制的 entries 复制 `pi.entry.label` values；排除 usage ledger、`pi.result`、所有 `pi.op.*`、所有 `pi.pending.*`（entries、tool checkpoints、assistant frames），以及 open-operation state 的每一处痕迹。Destination usage totals 从零开始；destination `messageCount` 等于被复制 message entries 的数量，正如当前 conformance 已经证明的。Destination metadata 记录 `parentSessionId = source.id`。Sequence preservation 不是 fork 契约的一部分：backends 可以为被复制和转换的 writes 分配 destination-local sequences，只要 destination sequence 和 list-cursor semantics 保持内部有效。

**Application values/lists（在保留的 `pi`/`pi.*` namespaces 之外）**：tree scope 复制每一个当前 scalar value 和每一个存活的 list element；branch scope 不复制任何。一个 `seq <= tipSeq` cutoff 作为 "historical reconstruction" 是被禁止的 —— 它可证明地不是：

```text
Scalar: TX[seq 10: set my-app.state = v1] · TX[seq 12: insert e1] ·
        TX[seq 50: set my-app.state = v2]     (v2 describes work after e1)
Branch fork at e1, cutoff seq <= 12: only v2 exists (v1 was replaced, no
history is retained); 50 > 12 excludes it → state absent, though the app
demonstrably had state v1 at the fork point. The cutoff cannot recover v1.

List:   append seq 5 · append seq 20 · deleteList seq 40 · append seq 60
Cutoff seq <= 30: elements 5 and 20 no longer exist (whole-list delete
destroyed them); only 60 survives and is excluded → empty list, though the
list held {5, 20} at seq-30 time.
```

任何 cutoff 都会过滤 *survivors*，静默地把倒回的 intent 与删除后的现实混合。因此 branch scope 不复制任何 application-owned 的东西，与其全新的 idle lane state 和零 ledger 相匹配；applications 拥有它们自己的 re-derivation。

### 1.2 一个封闭的 fork classifier

所有 namespace fork 知识都位于 `session/values.ts` 和 `session/fork.ts` 旁边的一个 core module 中（例如 `session/fork-policy.ts`）。它是一个封闭的 switch，不是 registry、plugin policy 或 DSL：

- `pi.op.*`、`pi.pending.*`、`pi.result` → 两个 scopes 都 exclude。
- `pi.session.name` → copy。
- `pi.entry.label` → 当且仅当 keyed entry 被复制时 copy。
- `pi.branch.tip`、`pi.lane.config`、`pi.lane.state` → 结构化 lane actions；scope-specific 规则（branch 只保留具名 lane 并重写它的 tip；lane state 总是被替换为全新的 idle state；tree 保留全部）位于一个被所有 backends 消费的共享 driver 中。
- 精确的 namespace `pi` 和任何其他 `pi.*` namespace → fork **失败**，但仅在 fork 时存在当前存活状态（一个当前 scalar row 或一个存活的 list element）时。后来被替换或删除的历史写入在每个 backend 上都不存在于当前状态中，且不得单独导致 JSONL fork 失败 —— 行为是 backend-equivalent 的。引入一个新的 built-in namespace 而不声明其 fork semantics 必须破坏 fork tests，而不是静默复制或丢弃状态。
- 既非 `pi` 也非 `pi.*` → application：tree 上 copy，branch 上 exclude。唯一的 built-in list namespace（`pi.pending.assistant_frame`）exclude；application lists 遵循 application 规则。

Driver 暴露一个 streaming shape —— 接受一个已提交的 value/list write（或 current row），发出零个或多个 destination writes，`finish()` 发出全新的 idle lane states 和重写后的 branch tip。Entry-copy membership 是一个 backend 提供的 predicate，因此每个 backend 使用它自己的 index。`createForkSnapshot`、`forkSnapshotWrites`、`ForkSourceSnapshot`、`ForkDestinationSnapshot` 和 `entriesComplete` escape hatch 被删除。

### 1.3 Streaming backend 过程

Forks 必须 stream source writes，而不是物化完整的 source snapshot arrays。Source copy 路径不得调用返回数组的完整读取：不得有 `snapshotEntriesAndValues()`、`captureForkSource()`、`readAllScalarValueRows()`、`readAllEntryRows()`、整文件 `readTextFile` 或对无界行集的 SQLite `.all()`。JSONL 可以在内存中保留它的 structural index 和 legacy-v3 compaction tail。

**Memory.** 在一个 source `commitQueue` 边界处，通过 classifier/driver 对 source maps 迭代一次，直接构建 destination `InMemoryStorageState`。Branch scope 从 branch tip 向 root 遍历 `parentId` 以计算 ancestry id set 并校验 `entryId` membership；精确复制那个 set。没有中间 snapshot arrays；`MemoryStorage.fromSnapshot` 和 `captureForkSource` 被移除。

**JSONL.** Source 通过一个 read-only path 读取，该 path 在 commit-queue boundary 捕获 source 当前的 `nextSeq`；两个 scans 都只发出低于该 sequence 的完整 writes。Fork 从不写 source：没有 torn-tail truncation/rewrite，没有 v3 normalization persistence，source 旁边没有 `.tmp`。一个撕裂或不完整的最后一行在内存中被丢弃。这依赖 format-4 sources 保持 append-only，并且在 fork 运行期间不被替换；compaction/replacement coordination 与 J1 一起被推迟。

- *两个 scopes* 都使用两个 scans 直到捕获的 sequence boundary。Pass 1 stream 每一行，并把 value/list writes 折叠进一个内存 structural index：对每个 scalar address，当前存活 `set` 的 seq（在尾部 `delete` 之后则 absent）；对每个 list address，存活 element seqs 的集合（whole-list delete 清空它）；加上 entry `id → parentId`，branch scope 需要 ancestry 时使用。该折叠应用与 replay 相同的 current-state semantics。
- Pass 2 再次 stream，仅当 index 证明它是当前的且 classifier 选中它时才发出一个 write：selected set 中的一个 entry write；一个 scalar `set`，其 seq 等于 index 中该 address 的 current-row seq；一个 list `append`，其 element seq 在 survivor set 中。Deletes、被取代的 sets 和已死的 application value/list history 从不作为 destination state 发出。
- 转换后的 built-ins 在 pass 2 到达一个被保留的 branch 或已配置 lane 的 source 当前对应 row 时发出。Destination writer 可以分配 destination-local sequences。
- *Branch scope* 通过内存 index 遍历 tip→root 以物化 ancestry set 并在 pass 2 之前校验 `entryId` membership；labels 只为 member entries 发出。
- Destination 在一个 temp file 中 staging，并原子重命名（现有的 `publishFileAtomically`）；失败时移除 temp file。Legacy v3 按 source state 拆分。Forking 一个 **open** 的 legacy-v3 `JsonlStorage` **以一个清晰的错误拒绝**，直到一次正常的非空 commit 升级并持久化了它规范化的 format-4 ids：v3 normalization 铸造非确定性的 UUIDv7 tails，因此独立的磁盘 reparse 无法复现打开的 Session 所暴露的 ids，也无法校验 caller 的 `entryId`；fork 不得修改/升级 source 本身。一个 **closed** 的 legacy-v3 source 使用 read-only parser/normalizer 且从不触碰该文件：tree forks 成功；当 import 重建出一个完整配置的 lane 时，branch forks 可以使用省略的 `entryId`（默认的 normalized tip），而任何 caller 提供的、来自更早一次 open 的 process-local id 在多次 reparse 之间不稳定，会正常拒绝；一个仅数据重建的 lane 像各处一样拒绝。Parser 可以在内存中保留 structural metadata 和 compaction `retainedTail` context。普通可写的 `JsonlStorage.open` 可以保留内存内 normalization，但 resident state 永远不是 fork source。
- **没有 resident-state path**：一个打开的 same-repository JSONL source 在 source `commitQueue` 上入队一个短的 boundary callback，其唯一职责是捕获 `nextSeq`，然后释放 queue；fork 在该 boundary 之下运行同样的两 scan 过程，同时后续的 source appends 继续进行。已提交的 writes 在被应用到 resident state 之前就已持久化到文件中，因此在该 boundary 处文件是权威的。

**SQLite.** 通过一个有界内存的临时磁盘 SQLite **staging database** 进行基于 iterator 的 row transfer，对 per-file 和 shared-container 两种布局统一使用。Source reader 从不直接 stream 到 destination transaction —— 一个 WAL reader 和一个 writer 可以共存，但在 shared-container mode 中 destination writer 会持有 container 的唯一 write lock，并在 capture 仍在 streaming 时阻塞 boundary 之后的 source writer；staging 到一个独立文件消除了这种耦合。使用 prepared-statement iteration（`iterate`/stepwise），绝不用 source-sized 的 `.all()` snapshot arrays：

- *External/closed/live-worker source:* WP07 路径 —— 在精确的 canonical path 上 `openReadOnly`，一个 deferred read transaction，session row 和 storage version 在其内校验。
- *Same-repository open source:* **先**打开独立 read-only connection，然后在 source Storage `commitQueue` 上入队一个短的 boundary callback，其唯一职责是在释放 queue 之前 `BEGIN` 并建立独立 reader 的 snapshot（发出一次平凡读取）。不要在 source writer connection 上开始一个 read transaction 然后释放它的 queue，也不要在 copy 期间持有 queue。
- *Stage:* 当 source reader 保持打开时，stream 选中的 entries `ORDER BY seq` 和 classifier 选中的 current scalar/list rows（SQL-level namespace prefilters 匹配 classifier —— 枚举的 built-in namespaces 加上排除精确 `pi` 和 `pi.%` 的 application predicate —— 每一行仍然通过 classifier）到临时 staging database，以有界批次进行。Branch scope 通过 `branch_entries` segment chain 枚举 ancestry 直到选中的 entry，并通过该 index 而不是 in-RAM id set 来回答 `entryId` 和 label membership。后续 source commits 使用原始 writer connection，并可以在 staging stream 期间完成，在**两种**布局中都是如此，因为 stage writes 指向另一个文件。
- *Publish:* 关闭/提交 source read transaction，然后把 stage stream 到一个 destination `BEGIN IMMEDIATE` transaction —— entries 按 source order 维护 destination branch index 并增量维护 `message_count`，然后是 values/list elements —— 并在成功和失败时都在 `finally` 中删除 staging database。Destination 分配它自己的有效 sequence range。Shared-container destinations 只写新 session 的行。

### 1.4 保留的 WP07 行为

Destination id reservation across create/open/fork/delete、no-create opens、foreign-metadata rejection、per-file 和 shared-container layouts、WAL commit-boundary wholeness（一次 source commit 完全在一次 fork 之内或完全在其之外），以及 all-settled repository close 保持不变。

### 1.5 Coding-agent 状态（仅记录）

`/fork`、`/clone` 和 `--fork` 完全运行在 legacy `SessionManager`（`createBranchedSession`、`forkFrom`）上，不在这里迁移。当 coding-agent 采用 `SessionRepo` 时的未来映射：`/fork` → `{ scope: "branch", branch: "main", entryId, position: "before" }`；`/clone` → `{ scope: "branch", branch: "main" }`；`--fork` → `{ scope: "tree" }`。

## 2. 当前源码中的问题

- `ForkOptions` 把 `scope` 默认为 `"branch"` 并硬编码 source/destination `main`（`fork.ts`、两个 backend branch readers）。
- 没有 ancestry membership 检查：`selectForkContents` 从 tree 中任意位置提供的 `entryId` 遍历 parents，并把结果标记为 `main`。
- 每一个 backend 都物化完整的 source：`snapshotEntriesAndValues()`（Memory/JSONL）、`readAllScalarValueRows` + `readAllEntryRows`/`scanBranchEntries` arrays（SQLite），全部通过内存中的 `createForkSnapshot` 汇聚。
- `createForkSnapshot` 及其 array snapshots 强制所有 backends 走一次物化的内存 source copy。
- 对一个 closed source 的 JSONL fork 使用 `JsonlStorage.open()`，它会在 torn tail 上重写 source file —— 今天一个 fork 可以修改它的 source。
- Lists 从不被复制；application values 被排除且没有声明 tree policy（`values.md` 明确推迟它）。
- Namespace fork 知识在 `fork.ts`、`values.md` 正文和 conformance assertions 中重复；没有任何东西强制一个新的 `pi.*` namespace 声明 fork semantics。
- `entriesComplete?: false` 的存在只是为了让 SQLite branch snapshots 跳过其他 branches 的 tip validation。

## 3. 必需结果

1. `ForkOptions` 和校验完全如 §1.1；所有 rejection paths 不创建 destination file、database rows 或 reserved-but-leaked ids。
2. §1.2 的封闭 classifier/driver，从 core 导出并被所有三个 backends 消费；未知的 reserved namespaces（精确 `pi` 或未声明的 `pi.*`）仅当存在当前存活状态时使 fork 失败，在每个 backend 上一致。
3. §1.3 的 streaming procedures 在所有三个 backends 上；`createForkSnapshot`/`captureForkSource`/`snapshot()` fork plumbing 及其 exports 从 `session/index.ts` 和 sqlite-node import surface 中移除。
4. 每个 backend 上有效的 destination-local sequence allocation；对相同 sources，跨 backends 的 logical destination state 相同（conformance）。
5. JSONL source 不被修改，包括 torn-tail sources 和 legacy v3 sources。
6. 文档：`harness.md` §2.7（以及 §1.7 与 fork 相关的句子）、`values.md` "Forks and rewrites" 和 backend snapshot 提及、`post-wp05-roadmap.md`（撤下 SQLite fork-cost 项，添加/指向本包）、`packages/session-backends/sqlite-node/README.md` fork 段落、`packages/agent/benchmark/session/README.md`（如果 dataset 措辞改变）。历史 WP 文档和已发布 changelogs 不动。Format/storage versions 不变；无 migration。

## 4. 实现切片

### Slice A — contract 与 classifier（core，Memory reference）

文件：`session/types.ts`、新的 `session/fork-policy.ts`、`session/fork.ts`（重写或删除）、`session/values.ts`（仅在需要新 helpers 时）、`session/index.ts`、`session/memory.ts`、`session/in-memory-storage-state.ts`、conformance `testing/conformance/session-repo.ts`、`test/harness/memory-conformance.test.ts`、`test/harness/memory-session-repo.test.ts`。

1. 替换 `ForkOptions`；实现 validation 和 classifier/driver。
2. 把 Memory fork 重写为在 commit-queue boundary 处的直接 destination construction。
3. 为新契约（§5）重写共享的 fork conformance，并在 Memory 上通过它。

### Slice B — JSONL streaming

文件：`session/jsonl/storage.ts`、`session/jsonl/repo.ts`、`session/jsonl/types.ts`、`FileSystem` capability 中的 streaming reader support（`harness/types.ts`、`harness/env/*`）（如果需要）、`test/harness/jsonl-session-repo.test.ts`、`jsonl-session-repo-conformance.test.ts`、`jsonl-storage.test.ts`、`jsonl-v3-migration.test.ts`。

1. Read-only sequence-boundary capture 带内存内 torn-tail discard；对 open sources 在 source `commitQueue` boundary 做同样的 capture；任何 fork path 都不写 source。
2. 对两个 scopes 做两 scan 的内存 current-state fold 与 emission；branch ancestry membership 通过 structural index；原子 destination publish。
3. Open-v3 fork rejection 和 closed-v3 read-only parser/normalizer path；按 §5 更新 v3 fork tests。


### Slice C — SQLite streaming

文件：`sqlite/repo.ts`、`sqlite/storage.ts`、`sqlite/session/values.ts`、`sqlite/session/entries.ts`、`sqlite/session/branch-entries.ts`、`sqlite/types.ts`、`test/repo.test.ts`、`test/repo-conformance.test.ts`。

1. 用 independent-reader-plus-boundary-callback 设计替换 `SqliteStorage.snapshot()`/array snapshot helpers，并把 iterator transfer 到临时 staging database，然后 stage-to-destination publication 带 `finally` cleanup。
2. Branch ancestry/membership/labels 通过 branch index；classifier-matching SQL prefilters。
3. 保留 WP07 identity、reservation、no-create 和 close coverage；两种 layouts。

### Slice D — benchmarks 与文档

文件：`testing/benchmark/session-repo.ts`、两个 `session-repo.bench.ts` 文件、`benchmark/session/README.md`、`harness.md`、`values.md`、`post-wp05-roadmap.md`、sqlite-node `README.md`、changelogs 仅在正常分支规则下。

更新 fork option literals，添加 large-source fork benchmarks（tree 和 branch），并落地 §3.6 的文档集。

## 5. 必需测试

### Contract 与 validation

- branch scope 拒绝：未知 branch name；仅数据 Branch（仅 tip）；`entryId` 不在具名 Branch 的 tip ancestry 上（存在于 tree 中其他地方）；`entryId` 未知；`entryId` 带 `null` tip。每次拒绝不留下 destination artifact 并释放它预留的 id。Fork tests 不构造或审计所选 Branch 之外的格式错误 lane records。
- branch scope 接受：省略 `entryId`（tip）、显式 tip、mid-ancestry entry、`position: "before"` 在 mid entry 和 root entry 处（`null` destination tip）、没有 `entryId` 的 `null` source tip。
- destination shape：恰好一个 Branch、相同 name、复制的 config、全新的 idle lane state、没有其他 lane values、设置了 `parentSessionId`。
- tree scope：不可达 entries 被复制；每一个 tip 被复制；已配置 lanes 获得 config 加全新 idle state；仅数据的 Branches 保持仅数据。Forking 不审计格式错误的 lane records。
- 两个 scopes：session name 被复制；labels 只为被复制的 entries（branch fork 排除非 ancestry entries 的 labels）；`pi.result`、`pi.op.*`、`pi.pending.*`（pending entries、tool checkpoints、assistant frame lists）和 usage rows 缺失；精确的 stats 预期 —— 一个复制 N 个 message entries 的 fork 报告 `getStats()` = `{ messageCount: N, usage: all-zero }`，与当前 conformance 匹配；ledger-completeness invariant（"a fork's ledger starts at zero"）保留。

### Application values 与 lists

- tree fork 复制每一个非 `pi.*` scalar 和每一个存活的 list element；一个在 source 中先删除后重新 append 的 list 只复现存活的元素。
- branch fork 不复制任何 application values/lists（把 §1.1 的 scalar 和 list traces 固定为 regression cases：fork point 之后的覆盖和 delete-destroyed elements 在任何实现下都不得重新出现）。
- 未知 reserved namespace（精确 `pi` 或未声明的 `pi.*` scalar 或存活 list element）中的当前存活状态在每个 backend 上使 fork 失败；同一个 namespace 在 fork 之前 **set then deleted** 不在任何 backend 上失败 —— 包括 JSONL，其中已死历史作为物理行保留，而磁盘 fold 必须把它归类为 absent。通过原始 committed writes 构造这两种情况。

### Sequence allocation

- sequence preservation、source high-water marks 和 source list cursors 不是 fork 契约的一部分。每个 destination 分配有效的 local sequences 和 list cursors；它的第一次 post-fork commit 必须无冲突地分配。
- JSONL 捕获 source `nextSeq` 只是为了建立 append-only source boundary；一次 torn incomplete final write 不属于该 fork。

### Streaming source reads 与 source non-mutation

- instrumented source readers（test decorators/spies）断言 fork paths 从不调用 `snapshotEntriesAndValues`、`captureForkSource`、`readAllScalarValueRows`、`readAllEntryRows`、整文件 `readTextFile` 或对 entries/values/lists 的 source-sized `.all()` arrays；确定性的大型 fixtures（扩展现有的 benchmark dataset generators）在数千 entry 的 sources 上运行 tree 和 branch forks。
- SQLite staging databases 在成功和失败时都被移除；一次失败的 fork 既不留下 stage file 也不留下 destination rows。
- JSONL：fork 一个 closed torn-tail source 成功，destination 完全排除 torn transaction，且 source file 字节不变（前后字节比较）；fork 一个 legacy v3 source 使 source file 不变；source 旁边不出现 `.tmp`。
- JSONL sequence-boundary capture：capture 之后完成的一次 source append 完全不在该 fork 中。
- JSONL destination content：destination file 只包含当前选中的 scalar rows 和存活的 list elements —— 没有 delete records、被取代的 sets 或已死的 application history。
- legacy v3：forking 一个 **open** v3 source 以清晰的 pre-upgrade error 拒绝；在一次正常的非空 commit 把它升级到 format 4 之后，fork 成功并保留持久化的 ids；一个 **closed** v3 tree fork 通过 read-only parser 成功，并使 source 字节完全相同；一个带省略 `entryId` 的 closed v3 branch fork 在重建出完整配置的 lane 时成功，来自更早一次 open 的 caller-supplied id 拒绝，仅数据重建的 main 拒绝。

### Coordination 与 ordering

- Memory open-source forks 保留 queue-boundary conformance case：在 fork 之前 admitted 的一次 commit 完整出现；之后 admitted 的不出现。
- JSONL open-source forks 在 `commitQueue` boundary 捕获 sequence boundary：在 boundary 之前 admitted 的一次 commit 完整出现；boundary capture 之后完成的一次 source append 在 fork 仍在 streaming 时继续，并完全不在该 fork 中。
- SQLite same-repo：独立 reader 先打开，source `commitQueue` 上的 boundary callback 建立它的 snapshot 并释放 queue，随后在 writer connection 上的一次 source commit **在 reader 仍在 stream 到 stage 时完成**，并完全不在该 fork 中；之后的一次 fork 完整包含它。在 per-file 和 shared-container **两种**布局中断言这一点（在 shared containers 中可满足，因为 stage writes 指向另一个文件），外加 WP07 的 live external-worker case 不变。
- destination-reservation races（create vs fork on one id，两种顺序）不变。

### Backend equivalence

- 一个共享的 conformance source（entries、unreachable entries、多个 lanes、仅数据 Branch、labels、带 deletes 的 app scalars/lists、带 pending/frame/checkpoint state 的 open operation、usage rows）在两个 scopes 上 fork 出在 Memory、JSONL 和 SQLite 上相同的 logical destination state。

## 6. 验证与审查

在每个 slice 之后：`npm run check`，然后通过来自所属 package 的 repository Vitest binary 运行修改过的聚焦测试；最终审查之前 `./test.sh`。Grep guards：历史文档和本 handoff 之外不再有 `createForkSnapshot|captureForkSource|ForkSourceSnapshot|entriesComplete`；没有任何 **production fork source path** 把 `"main"` 作为 literal 引用（本文档和 §1.5 记录的 coding-agent mapping 有意提及 main）。

审查检查点（委派的审查使用 provider `anthropic`、model `claude-fable-5`）：

1. Slice A 之后：contract、classifier closure、conformance shape。
2. Slice C 之后：same-repo ordering、reader independence 和 streaming-source evidence。
3. 对源码、测试、文档和排除项的最终审查。

## 7. 排除项

不要包含：

- compatibility aliases、默认 scope 或隐式 `main`；
- 任何 `seq <= tip` cutoff 或其他 historical-state reconstruction；
- fork-policy registry、plugin hook 或 DSL；per-address application opt-ins；
- 在任何 option 下复制 usage rows、`pi.result` 或任何 open-operation state；
- coding-agent `/fork`、`/clone`、`--fork` 或 RPC migration；
- storage-version bumps、migrations 或 format changes（formats 保持 WIP-in-place）；
- J1 snapshot compaction（streaming reader 可以构建为可共享，仅此而已）；
- SQLite branch-segment 重新设计或 uncompacted-divergence fix；
- 超出 `ForkOptions` 的 `SessionRepo` interface 变更（repository `close()` 属于 lifecycle package）；
- precise-rewrite tooling；search；对 WP00–WP07 文档或已发布 changelog 章节的编辑。

如果实现需要一个被排除的项，停下来并修订 handoff。

## 8. 退出条件

当以下条件满足时 WP08 完成：

- `ForkOptions` 恰好是 §1.1 的 union 及所述 validation，在所有三个 backends 上；
- branch forks 要求一个完整配置的 source AgentLane 并强制 ancestry membership；tree forks 复制完整的不可变 tree、每一个 tip、已配置和仅数据的 Branches；
- tree forks 携带所有当前 application values 和存活 list elements；branch forks 不携带任何；
- 一个封闭的 core classifier 拥有每个 namespace disposition；未知 reserved namespaces（精确 `pi` 或未声明的 `pi.*`）恰好当存在当前存活状态时使 forks 失败，在所有 backends 上等价；
- 所有受支持的 fork paths —— 包括 closed legacy v3 sources —— stream source writes 而不物化完整 source snapshot arrays，由大型 fixtures 上的 instrumented-reader tests 证明；JSONL 可以在内存中保留 structural indexes 和 legacy compaction context；forking 一个 open legacy-v3 source 被明确不支持（清晰拒绝）直到一次普通 commit 升级它，而不是由内存内异常处理；
- JSONL forks 从不修改它们的 source，包括 torn-tail 和 legacy v3 sources，且 JSONL destinations 只包含当前选中的 rows；
- SQLite forks 通过一个临时磁盘 database staging（source reader → 打开期间 stage，reader 关闭后 stage → 一个 destination `BEGIN IMMEDIATE`，stage 在 `finally` 中删除），其 independent-reader boundary design 和并发后续 writer commits 在两种布局中都被证明，保留所有 WP07 行为；
- destinations 分配有效的 local sequences，且 backends 产生相同的 logical destinations；
- shared conformance、focused backend tests、benchmarks、`npm run check` 和 `./test.sh` 通过；
- 规范性文档和 roadmap 反映新契约，历史文档不动；
- 最终 Fable 审查报告无 blocker。

## 9. TODO

### Invocation cancellation 之后的 cleanup

Cancellation-safe filesystem cleanup 被推迟。Cleanup 当前接收 caller 的 Context，因此一次 aborted invocation 可能留下一个 staged file，即使 readers 已关闭且 destination id reservation 已释放。在实现这个之前定义 cleanup Context policy；不要把 Chord 的 `withoutAbortSignal` 直接导入 JSONL 代码作为临时 workaround。
