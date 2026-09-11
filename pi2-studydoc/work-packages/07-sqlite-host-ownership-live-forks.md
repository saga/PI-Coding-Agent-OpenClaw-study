# WP07 — SQLite host ownership 与 live-source forks

**状态：已实现。**

已交付的 backend 没有 writer lease 或 replacement ownership primitive。它提供 no-create read-write/read-only opens、排队的 same-repository snapshots、用于 live external sources 的独立 read-only WAL snapshots、canonical physical identity、path-safe IDs、repository-local deletion reservation，以及 all-settled close。测试覆盖 per-file 和 shared-container 两种布局，包括一次 writer commit 在一个 read snapshot boundary 之后、但在该 reader 关闭之前完成的情况。

本包使 `packages/session-backends/sqlite-node` 与产品 ownership model 对齐：server 拥有 Session records 和 worker lifecycle，并且在任意时刻恰好有一个 host-assigned 进程拥有可写 Session authority。正常情况下该进程是 Session worker。Server 可以临时拥有一个新创建或 fork 出来的 destination，但它在把该 Session 的 metadata 交给 worker 之前会关闭它。

Storage 不实现 writer ownership。移除 SQLite writer lease；不要修复或替换它。

一次 server-side fork 有意不同于第二个 writer：它可以在 worker 持续提交的同时，并发地打开一个 live worker-owned source 以获取一个一致的 read-only snapshot。Shared SQLite containers 仍受支持。

## 0. 必读

编辑之前请完整阅读：

1. `packages/agent/docs/plugins.md` 的 ownership、replacement 和 removal 章节。
2. `packages/server/README.md` 以及相关的 Session routing/removal 源码和测试。
3. `packages/agent/docs/harness.md` §§0.6、1.4–1.7、2.7–2.8、4.3 和 Part 9。
4. `packages/agent/docs/post-wp05-roadmap.md`。
5. 已完成的 WP06 §7 以及 repository/fork conformance。
6. `packages/session-backends/sqlite-node/src` 下的每一个源文件。
7. `packages/session-backends/sqlite-node` 下的每一个测试和 benchmark。
8. `packages/session-backends/sqlite-node/README.md` 和 `CHANGELOG.md`。

不要把 `dist/` 下的陈旧文件用作实现输入。已完成的 WP01/WP06 文档是历史性的；不要重写它们来掩盖更早的 lease 实现。

## 1. 固定架构

### 1.1 可写 authority 属于 host

恰好一个 host-assigned 进程拥有一个可写 Session。Session worker 是正常的 owner。Worker replacement 会在新 worker 打开 Session 之前关闭旧 owner。Server management 围绕该 ownership transfer 序列化 creation、forking、removal 和 attachment lifecycle。

Memory、JSONL 和 SQLite 不会检测到第二个进程为写入而打开同一个 Session。绕过 server/worker lifecycle 是 trusted-host 缺陷，不是需要修复的 storage race。一个 repository 仍然拒绝它在单进程内拥有的重复可写 handles。

不要添加 storage lease、filesystem lock、fencing token、heartbeat、timeout-based takeover、deletion tombstone、quarantine protocol 或通用 lock manager。

### 1.2 Read-only fork access 可以与 worker 重叠

Server 拥有 repository administration，并可以在其 Session worker 持续写入 source 的同时 fork 一个 source。该 fork 的 source 侧：

- 打开确切的 source container 而不创建它；
- 是 read-only 的；
- 使用一个 deferred `BEGIN` transaction；
- 在该 transaction 中读取 version-gated Session row、scalar values 以及选中的 entries/branch index；
- 从不升级为写入或声称 writable authority；
- 在 `COMMIT`/`ROLLBACK` 之后关闭。

SQLite WAL 允许在 read transaction 保持打开时发生后续的 worker commits。Fork 看到的每一个 source commit 要么完全在其 snapshot boundary 之前，要么完全在其之后，绝不混合。

### 1.3 Same-repository fork ordering 保持不同

一个已经在同一 repository 中打开的 source 使用它活跃的 `SqliteStorage.snapshot()` 路径。该 snapshot 被排队到 source `commitQueue` 上，保留 WP06 的 admitted-commit ordering seam 和现有的 conformance case。

不要用独立 connection 替换该路径。相反，把 active storage lookup 绑定到精确的 physical identity 加上 Session ID，这样另一个 container 的 metadata 就无法意外地选中它。

### 1.4 Destination ownership 不重叠

`SessionRepo.create()` 和 `fork()` 继续返回一个打开的 Session。Server 可以临时拥有那个新 destination、捕获它的 metadata，并在启动 worker 之前关闭它。这是一次有效的 ownership transfer，不是把 `SessionRepo` 重新设计为 record-only API 的理由。

## 2. 当前源码中的问题

### 2.1 SQLite 重复了 host ownership

当前源码包含：

- `writer_lease` schema state；
- claim、renew 和 release helpers；
- create/open/fork 中的 lease claims；
- `SqliteOpenSession` 中的一个 idle renewal timer 和 lease-loss path；
- `SqliteStorage` 中的一个 pre-commit renewal callback；
- 基于 lease 的 deletion checks。

这是第二套不完整的 ownership system。它的 pre-commit renewal 与随后的 data transaction 不是原子的，但正确的修复是删除 ownership 机制，而不是 transaction-local fencing。

### 2.2 Non-creation access 可以创建文件

database factory 只暴露 `open(path)`，它会创建一个缺失的 SQLite 文件。Metadata open、listing probes、deletion 和 fork-source reads 不得把一个已移除的路径变成一个空 database。

Fork-source reads 还会配置 `PRAGMA journal_mode = WAL`，这是一个面向写入的 setup 步骤，不得在 read-only connection 上运行。

### 2.3 Delete 没有预留它的本地临界区

`delete()` 检查 `pendingIds` 但没有预留该 ID。一个 same-repository create/open/fork destination 可以在异步破坏性工作进行时进入。Host lifecycle 拥有跨进程 ordering；repository 仍然必须序列化它自己的本地操作。

### 2.4 Physical identity、paths 和 close 需要修正

- `openStorages` 只以 Session ID 为 key，因此同一 ID 在另一个物理路径可能选中错误的 active source。
- `create()` 创建的是 `options.directory`，而不是显式 `databasePath` 的父目录。
- Per-session filenames 直接插值任意 caller IDs；`/`、`\`、`..`、`%` 和平台分隔符不得逃逸 `directory`。
- `repo.close()` 使用 fail-fast 的 `Promise.all`，因此它可能在每一个打开的 Session 都尝试 drain 和 close 之前就返回。

Deterministic list ordering、bind-variable limits、branch-copy cost、fork scalar filtering、prepared statements 和 VACUUM policy 保持独立。

## 3. 必需结果

### 3.1 移除 storage-layer writer ownership

删除所有 runtime lease 行为：

- 删除 `src/sqlite/session/writer-lease.ts`；
- 从 WIP `001_initial.sql` 中移除 `writer_lease`；
- 从 `deleteSessionRows()` 中移除 lease deletion；
- 从 `SqliteSessionRepo` 中移除 claim/renew/release 代码；
- 从 `SqliteStorage` 中移除 `beforeCommit`；
- 从 `SqliteOpenSession` 中移除 renewal/release options、timer 和 `leaseError`；
- 移除 lease-specific tests，并用 host-authority 和 live-fork coverage 替换它们。

保留：

- Storage `commitQueue`；
- 每次 commit 一个 `BEGIN IMMEDIATE` transaction；
- transaction 内的 `next_seq` allocation；
- entry/usage uniqueness 和 parent triggers；
- Session mutation admission 和 close draining；
- process-local duplicate-open rejection。

Format 4 保持 WIP。就地从新 schema 中移除该表；一个包含未使用 `writer_lease` 表的旧文件仍然可读，该表和陈旧行永远被忽略。Post-WP07 代码不删除它们，因为这样做不服务于任何 runtime 行为。一个 pre-WP07 binary 无法在没有该表的情况下打开一个新的 post-WP07 database；不要求该 WIP format 的向后兼容。不要添加 migration、compatibility path 或 storage-version bump。

### 3.2 添加显式的 database open modes

用窄操作扩展 `SqliteDatabaseFactory`：

- `open(path)` — 有意的创建或 create-if-missing；
- `openExisting(path)` — 若文件不存在则失败的 read-write open；
- `openReadOnly(path)` — 若文件不存在则失败的 read-only open。

Node adapter 对 read-only access 使用 `DatabaseSync(path, { readOnly: true })`。为 `openExisting` 实现并测试一个真正的 no-create read-write mode；不要依赖 `access()` 后接一个 create-capable open。

拆分 connection setup：

- writable connections 建立 WAL mode 和 `busy_timeout`；
- read-only connections 只设置 read-safe options（如 `busy_timeout`），并且从不尝试更改 journal mode。

对 metadata open、listing probes、deletion 和 fork-source reads 使用 no-create modes。

### 3.3 保留两条 fork-source 路径

**Source 在本 repository 中打开：** 保留 `SqliteStorage.snapshot()` 并在先前 admitted commits 之后将它排队。把仅 ID 的 active map key 替换为 canonical `(containerPath, sessionId)` identity，并对 publish、lookup 和 removal 使用同一个 helper。

**Source 未在本 repository 中打开：** 这包括一个已关闭的 source 和一个当前由另一个进程中的 worker 拥有的 source。通过 `openReadOnly` 打开确切的 source，然后在一个 deferred read transaction 中捕获它。在该 transaction 内校验 Session row 和 storage version。不要查询 destination reservations、声称 source ownership 或阻塞 worker 后续的 commits。

Destination 在 source capture 之后仍然是一次正常的 writable create/fork transaction。在 shared-container mode 中，source worker 和 destination transaction 可能使用同一个文件；SQLite 在保留 Session row isolation 的同时序列化 destination writes。

### 3.4 让 deletion 本地独占

Host 必须在调用 `repo.delete()` 之前关闭 Session worker。不支持直接跨进程删除一个 live Session。

在一个 `SqliteSessionRepo` 内，deletion 必须从进入到完成预留 Session ID，并在 `finally` 中释放它：

- 一个已打开或已预留的 Session 拒绝 deletion；
- 该 ID 的 create/open/fork destination 在 deletion 运行期间拒绝；
- shared-container deletion 在一个 connection 上的一个 `BEGIN IMMEDIATE` transaction 中只移除目标 Session 的行；
- per-file deletion 在一次 no-create open/existence check 之后移除 database 及其 WAL/SHM sidecars；
- 一个缺失的 Session 拒绝而不创建文件。

不要添加 lease check、tombstone、quarantine rename 或 stale-deleter protocol。跨进程 removal ordering 是 server 的责任。

### 3.5 把 metadata 绑定到 physical identity 并使 paths 安全

- Canonical identity 是 `(canonical container path, sessionId)`。
- 在 per-file mode 中，metadata 必须为其 durable ID 标识 repository-affine 的编码路径。
- 在 shared-container mode 中，metadata 必须标识已配置的 canonical container 和 Session ID。
- 一个外来或不匹配的路径绝不得别名到本地 active source。在聚焦测试和 SQLite README 中固定：外来 source metadata 是被拒绝还是仅从其确切路径读取；不要静默地按 ID 替换为本地 storage。
- 当配置了 `databasePath` 时创建 `dirname(databasePath)`。
- 把任意显式 IDs 编码为安全的 per-session filenames，而不改变 durable ID。该编码必须防止 path escape，并可通过 metadata/list/open/fork 往返。
- 一个 shared container 中的两个不同 Session IDs 保持可独立寻址。

### 3.6 Drain 所有 repository-owned closes

`SqliteSessionRepo.close(context)` 必须：

1. 一次性封闭 repository admission；
2. 对每一个当前打开的 Session 启动 close；
3. 等待每一次 close settle；
4. 当全部成功时 resolve；
5. 否则仅在所有 cleanup 尝试之后 reject，返回那一个 error 或一个包含所有失败的 `AggregateError`；
6. 在重复 close 时返回同一个 promise。

这是 backend-local 资源清理。不要在本包中更改共享的 `SessionRepo` interface 或 JSONL lifecycle。

## 4. 实现切片

### Slice A — 移除 writer leases

文件：

- 删除 `src/sqlite/session/writer-lease.ts`；
- `src/sqlite/migrations/001_initial.sql`；
- `src/sqlite/session/session-row.ts`；
- `src/sqlite/storage.ts`；
- `src/sqlite/session.ts`；
- `src/sqlite/repo.ts`；
- lease-focused repository tests。

任务：

1. 移除 schema/runtime lease state 和 timer 行为。
2. 保留 commit serialization、一个 write transaction、mutation draining 和 process-local duplicate-open 行为。
3. 证明普通 commits 现在使用一个 write transaction，而不是 renewal 加 write。

### Slice B — no-create opens 与 deletion reservation

文件：

- `src/index.ts`；
- `src/sqlite/types.ts`；
- `src/sqlite/repo.ts`；
- focused adapter/repository tests。

任务：

1. 添加 `openExisting` 和 `openReadOnly`，并带有经过测试的 no-create 行为。
2. 分离 writable 和 read-only connection configuration。
3. 在本地为 deletion 的整个临界区预留。
4. 在一个 transaction 中删除一个 shared-container Session；保留无关的 Sessions。

### Slice C — live-source read-only forks 与 identity

文件：

- `src/sqlite/repo.ts`；
- repository/conformance tests。

任务：

1. 以 canonical container 加 Session ID 作为 active storage 的 key；保持 same-repository queue ordering。
2. 对 non-open/live-worker sources 使用一个独立的 read-only deferred transaction。
3. 在 snapshot 内校验 source metadata/version。
4. 保留 shared-container destination 行为。

### Slice D — paths 与 close draining

文件：

- `src/sqlite/repo.ts`；
- focused repository/conformance tests。

任务：

1. 创建实际的 custom container parent。
2. 安全地编码任意 IDs。
3. 拒绝或精确处理外来 metadata，而不发生 active-source aliasing。
4. 让 repository close all-settled 且 error-complete。

### Slice E — 文档

文件：

- `packages/agent/docs/harness.md`；
- `packages/agent/docs/post-wp05-roadmap.md`；
- `packages/agent/docs/values.md`；
- `packages/session-backends/sqlite-node/README.md`；
- changelog 仅在正常分支规则下。

记录 host-owned writable authority、两条 fork-source 路径、no-create opens、local deletion reservation，以及 storage-layer ownership 的缺失。

## 5. 必需测试

使用真正的独立 `node:sqlite` connections。Test-only wrappers 可以暴露确定性的 transaction boundaries；production code 不获得任何 sleeps 或 race flags。

### Lease removal

- 新 schema 没有 `writer_lease` 表；
- create/open/fork/commit/close 不执行任何 lease reads 或 writes，也不启动任何 renewal timer；
- same-repository duplicate writable open 仍然通过 process-local reservation 拒绝；
- 普通 commit 仍然是一个 `BEGIN IMMEDIATE` transaction。

### Live fork source

对于 per-file 和 shared-container 两种布局：

- 一个 server repository fork 一个由代表其 worker 的独立 repository/connection 保持打开的 source；
- source capture 使用一个不同的 read-only connection，且不声称任何 writable ownership；
- 在 snapshot boundary 之前完成的一次 source commit 完整地出现在 fork 中；
- 在 read snapshot 建立之后的一次 commit 可以在 reader 关闭之前完成，并且完全不在该 fork 中；
- 没有任何 fork 包含一个 entry 而缺少同一 commit 的 Branch tip/value/stats 改动；
- 之后的一次 fork 包含那次更晚的 commit；
- same-repository admitted-commit fork conformance 保持不变。

### Deletion

- 先打开/预留 Session → same-repository delete 拒绝；
- 先 delete reservation → 该 ID 的 same-repository create/open/fork destination 拒绝；
- shared deletion 只移除目标行；
- per-file deletion 移除 database/WAL/SHM 文件；
- missing-path open/list/fork/delete 不创建空 database；
- 测试陈述 host precondition：worker close 先于 deletion；不承诺任何跨进程 bypass safety。

### Identity 与 paths

- 同一 Session ID 在两个物理路径不能交叉选中 active source storage；
- 一个 shared container 中的两个 Session IDs 保持独立；
- 当其父目录不存在时 `databasePath` 成功；
- 包含 `../`、`/`、`\`、`%`、点和 Unicode 的显式 IDs 保持在 `directory` 内，并保留 metadata ID；
- create/list/open/fork 返回的 metadata 指明实际的 container。

### Close

- 一个 Session close 失败不会阻止其他每一个 Session 的 cleanup 尝试；
- 多个失败在所有 settle 之后被报告；
- 重复的 repository close 返回同一个 promise；
- 每一个成功关闭的 Session 都释放它的 connection。

### 回归

- 现有 storage 和 repository conformance 在语义上保持不变；
- fork destination reservation 和 same-repository source ordering 保持完好；
- fork snapshots 像以前一样精确排除 operation/pending/result/usage/application state；
- shared-container create/list/open/fork/delete 仍受支持；
- 每一次 write transaction 仍然使用 `BEGIN IMMEDIATE`；
- 没有出现任何 migration、storage-version bump、compatibility layer 或 replacement ownership primitive。

## 6. 验证与审查

在每个 code slice 之后：

```bash
npm run check
```

用 repository Vitest binary 从 `packages/session-backends/sqlite-node` 运行每一个修改过的聚焦测试。最终验证：

```bash
./test.sh
```

审查检查点：

1. Slice A 之后由 Fable 审查：验证不再有任何 storage ownership 机制残留，且 close draining 完好。
2. Slice C 之后由 Fable 审查：验证 same-repository ordering 和 live-worker read-only overlap 两者都成立。
3. 对源码、测试、文档和排除项的最终 Fable 审查。

委派的审查使用 provider `anthropic` 和 model `claude-fable-5`。

## 7. 排除项

不要包含：

- 任何 storage lease、lock、fence、heartbeat、takeover、tombstone 或 quarantine；
- record-only 的 `SessionRepo` 重新设计或 compatibility facade；
- server/router/worker-manager 重新设计；单独记录任何 backend-independent lifecycle race；
- SQLite branch-segment 重新设计或 uncompacted-divergence 优化；
- fork scalar filtering/indexing；
- `getEntries` bind-limit chunking 或通用 query-limit normalization；
- statement caches 或 stats aggregation optimization；
- catalog 重新设计、async database replacement 或 VACUUM policy；
- search/FTS；
- R11 migration machinery 或 storage-version bump；
- [mobile assistant-output handoff](../mobile-handoff/01-harness/05-assistant-output/message-update.md) 变更或 JSONL compaction；
- 全 repository 范围的 `SessionRepo.close()` 契约变更；
- 移除 shared-container support；
- transaction DSLs、schedulers、generic lock managers 或 compatibility layers。

如果实现需要一个被排除的项，停下来并修订 handoff，而不是静默扩展。

## 8. 退出条件

当以下条件满足时 WP07 完成：

- SQLite 不包含任何活跃的或 schema 定义的 writer lease，也不实现任何 replacement ownership 机制；
- host ownership 是被记录在案的 single-writer authority；
- same-repository active-source forks 保留它们排队的 commit boundary；
- live worker-owned sources 通过一个独立的 read-only snapshot 进行 fork，而后续 WAL commits 继续进行；
- deletion 预留它的 same-repository 临界区，并假定 worker-first 的 host removal；
- non-creation 路径不能创建空 databases；
- active source identity 包含 physical container 加 Session ID；
- 显式 IDs 不能逃逸 directory，且 custom database parents 会被创建；
- repository close 等待每一次 cleanup 尝试；
- shared-container mode 保持完全覆盖；
- 聚焦测试、`npm run check` 和 `./test.sh` 通过；
- 最终 Fable 审查报告无 blocker。
