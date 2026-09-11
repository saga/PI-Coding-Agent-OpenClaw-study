# Post-WP05 roadmap 审计

**审计基线：** `5507d76ee`（`dev`，2026-08-27）。

**Status:** 规划盘点，而非行为契约。在与当前产品边界一致之处，[`harness.md`](harness.md) 仍是规范。下文列出的矛盾必须被显式解决；本文档不会静默地选择其中一方。

## 范围与方法

本审计覆盖持久化 AgentHarness 及其直接耦合的 Session backend 与 presentation 路径：

- `packages/agent/src/harness`、`packages/agent/src/search` 及其测试/文档；
- `packages/session-backends/sqlite-node`；
- 当前 `packages/protocol`、`packages/client` 与 `packages/server` presentation 路径；
- `packages/coding-agent/src/experimental` 及其承载该路径时的聚焦测试；
- `packages/telemetry`、`packages/ai` 与 `packages/agent` 中的遥测管线。

该盘点已对照当前源码、测试、包 README、完整的 `harness.md`、已完成的 WP00–WP07 状态、可执行的 WP08 handoff、显式的 stub/TODO/skip 以及已发布的包边界进行核对。当当前源码与已完成的 WP05 契约取代了历史 handoff 时，历史 handoff 不被视为待办。

## 总体结果

WP05 已完成至 M10。其剩余的 assistant-output 工作由 [mobile assistant-output handoff](mobile-handoff/01-harness/05-assistant-output/message-update.md) 及其编号前置项负责。当前 Harness 执行图没有未完成的 runtime 路径：`watchSession()` 是唯一的 `SliceNotImplemented` Harness 方法。

这**并不**意味着周边的持久化系统已经完成。剩余的审计发现为：

1. 规范性的 JSONL snapshot-compaction 行为没有实现；
2. 一个必需的 Harness 方法 stub（`watchSession`）；
3. 一次对原始 `RemoteSession` 的有意删除，与后续规范性的 WP06/`harness.md` 文本冲突；
4. 一个公开的 search 类型骨架，与更新的 search 设计冲突且没有实现；
5. 一整套遥测词汇表，其唯一的生产 span 是 tool-hook span；
6. 更小的 repository、client-watch、query-bound、文档与端到端测试缺口。

WP07 在审计基线之后完成了 SQLite host-ownership 对齐与 live-source fork 支持；其历史 handoff 为 [`work-packages/07-sqlite-host-ownership-live-forks.md`](work-packages/07-sqlite-host-ownership-live-forks.md)。WP08 现在负责单独的 named-branch、tree-state 与 bounded-memory fork 重新设计；其可执行 handoff 为 [`work-packages/08-named-branch-streaming-forks.md`](work-packages/08-named-branch-streaming-forks.md)。

## 缺失的必需功能与契约矛盾

### R12 — Session 级 Harness watch

**证据**

- `AgentHarness.watchSession(context)` 在 `src/harness/agent-harness.ts` 中是公开的。
- `Harness.watchSession()` 在 `src/harness/runtime/harness.ts` 中抛出 `SliceNotImplemented("watchSession")`。
- `SessionSnapshot` 当前仅包含 `{ lanes: LaneInfo[]; faulted: boolean }`。
- Lane watch、event buffering、delivery-tail barrier 与 `resnapshot()` 已存在于 `src/harness/events.ts` 与 `src/harness/runtime/lane.ts` 中。

**剩余边界**

为动态 lane 盘点与 fault 状态定义一套连贯的 capture 与 fold。决定有意保持精简的 `SessionSnapshot` 是维持精简，还是获得 session 元数据/统计/全局配置。然后实现 snapshot-before-events、lane 创建、resnapshot、listener 重入、close/fault 行为，以及——若承诺仅靠 event 的复制——一个 session reducer。

**依赖**

独立于 mobile assistant-output handoff 与 SQLite 内部。它应当先于任何基于它的、带版本号的 Transcript service 或远程 session 级观察。

### JSONL snapshot compaction

**证据**

`harness.md` §1.7 规范性地规定了 temp-file-and-rename 的 snapshot compaction、保留的 sequence high-water mark/list cursor、打开时的阈值检查，以及 terminal/outcome 删除后的回收。`JsonlStorage` 实现了原子创建、torn-tail 修复、legacy-v3 重写、append 与 fork snapshot，但不存在当前状态的 snapshot 重写或 dead-byte 记账。

**后果**

被取代的 `pi.op.state`、已删除的 pending payload、已删除的 tool checkpoint 与已删除的 assistant-frame list 会无限期地保留为物理字节。通用 compaction 与 [mobile assistant-output handoff](mobile-handoff/01-harness/05-assistant-output/message-update.md) 是互补的。Compaction 在事后回收已死的 session 作用域写入历史；该 handoff 把 pending assistant/tool output 移入 ephemeral scope，使其永不成为主日志历史，并用 Chord op batch 取代 full/per-frame 复制。

**依赖**

assistant-output handoff 不依赖 J1：scoped storage 是 pending output 的预期生命周期机制，而 J1 仍是针对被取代的 session 作用域状态的回收机制。分别度量两者，以免它们的效果被混为一谈。

### Remote Session 契约矛盾——需要决策

**当前产品边界**

提交 `f8a6e670d` 有意删除了 `RemoteSession`、其原始 Session RPC 协议与 server 的 mutation-scope manager，用 attachment-fenced 的路由语义服务取代了它们。当前 protocol/server README 明确说明真实的 `Session` 与 `AgentHarness` 对象保持进程本地。已发布的路径支持 Session 发现/创建/attachment、main-lane prompt/watch 与白名单化的 plugin-service 调用；它不通过 RPC 暴露 `Session`、`SessionMutation`、values/lists、branches 或 storage。

**冲突的契约**

在删除之后编写的 WP06 要求“当前无 key 的 RemoteSession mutation transport”，在必需测试与停止条件中包含了远程 begin/read/commit/publication/end，并禁止删除它。`harness.md` §2.8 与 9.1 同样声明本地与远程实现都保留该生命周期。在审计基线处，不存在任何此类实现、protocol schema、client facade、server 持有的 scope、worker adapter 或 conformance 测试。

**所需决策**

在安排实现之前选择其一：

1. **进程本地 Session 仍是有意为之：** 从规范性的当前状态文档中移除错误的 RemoteSession 要求，同时保留语义 service RPC；或
2. **需要 RemoteSession：** 委托一个专用包，负责 mutation begin/read/commit/end、disconnect/timeout 清理、publication-before-end、values/lists/branches/entries/stats、protocol 校验、client/server/worker adapter 与远程 conformance。

不要将当前的 lane-watch 兼容 RPC 或 plugin-service RPC 计为 RemoteSession。不要原样恢复被删除的 507 行 facade：它早于无 key 的 Session/Branch 契约，并且严重依赖无类型解码。

### 遥测契约超出实现

**证据**

`src/harness/telemetry.ts` 与生成的 `docs/telemetry-schema.md` 声明了 `pi.ai.request`、operation、checkpoint、turn、step、tool、hook、sleep、event-handler 与 session-write span。生产源码只启动 `pi.harness.hook`，且仅针对已注册的 `before_tool`/`after_tool` handler。AI options 会传播 `telemetryContext`，但没有 provider 路径启动 `pi.ai.request`。Server 请求入口有取消，但没有 trace carrier 或 client/server RPC span。`TODO_CONTEXT` 仍留在 transport/worker 生命周期与 event-delivery 边界处。

**剩余边界**

将其视为相互独立的包：

1. 本地 Harness/Session/AI 插桩与 runtime 测试；
2. RPC trace-carrier/client/server 传播；
3. 可选的、由应用选择的 exporter/adapter。

首先厘清每个已声明的 span 是否仍被需要。若保留，则实现它；若不保留，则移除不受支持的公开 schema 表面并修正 `harness.md`。不要把遥测与 Context/RPC cancellation 混在一起，后者已有独立的 request-ID 信令。

### S3 — Search

**证据**

`src/search/index.ts` 导出了一个公开的 `SessionSearchService` 骨架，带有 `sync()`、`notify()` 与返回数组的 `searchEntries()`。`harness.md` §2.8 则规定了一个独立服务、分离的 catch-up/notify 工具、generation-aware cursor 与可选的 `AsyncIterable` entry search。不存在 factory、sync 工具、cursor store、projection 或源 SQLite FTS 实现。在审计基线处，SQLite README 宣传了并不存在的 `createSqliteSessionSearch()` 行为；本审计修正了该 README，而不是把缺失的 API 当作已实现。

**剩余边界**

在实现之前，替换或厘清草案公开接口，并决定元数据过滤（`cwd`）、候选限制或索引元数据。在排序后的 `limit` 之后做后置过滤是不可靠的。然后实现独立的 catch-up 与单独的 SQLite FTS5 projection；不要添加 repository search 方法。

### R11 — Schema migrations，由 activation 触发

当前不需要 format-4 migration。Memory 是仅当前版本；JSONL 与 SQLite 拒绝不受支持的 storage 版本；SQLite 仅运行幂等的 `001_initial.sql`。R11 会在 format 4 稳定之后的第一个不兼容持久化 storage 版本/地址/状态变更之前立即变为必需。它不是 mobile assistant-output handoff 或当前 WIP format 替换的前置工作。

在被激活时，它必须提供在独占所有权下有序的、打开时事务性迁移，版本特定的 JSONL 解码加上迁移后 compaction，以及为每一个可达的 open operation leaf 与存活的 value/list 提供完整映射。

## 正确性与数据安全债务

### SQLite host ownership 与 live-source fork——由 WP07 完成

权威的产品规则在 `plugins.md` 中：恰好一个由 host 分配的进程拥有可写 Session 权威；通常它是 Session worker，而 server 可能在关闭并交接之前临时拥有一个新建或 fork 的目标。Storage backend 不实现 writer ownership。server 在破坏性 repository 管理之前关闭 worker。

SQLite 现在遵循该规则：writer-lease schema/module、claim、renewal timer、lease-loss 路径与 pre-commit callback 均已移除，且没有替代性的锁或所有权原语。Create/open/fork/delete 保留 repository 本地的 ID 预留。元数据打开与删除使用真正的 no-create 读写模式；list 与外部 fork source 使用 no-create 只读连接。

同 repository 的 fork 保留源 `commitQueue` 排序接缝。在别处拥有（包括由活动 worker 拥有）的源，会通过一个独立的只读 deferred WAL 事务从其确切规范容器中读取。聚焦的 per-file 与 shared-container 测试在 reader 建立其 snapshot 之后、关闭之前提交一个完整的后续源事务：第一次 fork 完全排除该事务，稍后的 fork 完全包含它。

WP07 还完成了规范的 `(containerPath, sessionId)` 活动身份、安全的显式 ID 文件名、自定义 `databasePath` 父目录创建、Session 作用域的共享删除、WAL/SHM 清理与 all-settled 的 SQLite repository 关闭。可写 open/delete 拒绝外来元数据；外来 fork source 仅从其确切路径读取。`createdAt` 相等的 list 排序仍没有确定性的 tie-break，留待日后作为保持行为的清理项。

### Repository close 的所有权未明确

`JsonlSessionRepo.close()` 包含唯一一处活动的 Agent 源 TODO，并且不关闭任何打开的 Session handle。Memory 仍使用 fail-fast 的 `Promise.all`；SQLite 现在对当前打开的 handle 执行 backend 本地的 all-settled 清理，但一个已被接纳的 create/open/fork 仍可能在 repository close 捕获该集合之后注册 handle。`SessionRepo` 本身未声明 `close()` 方法，共享 conformance 也未定义 repository 到 handle 的所有权或对已接纳 repository operation 的排空。在一个 repository-lifecycle 包中解决所有权与通用清理；在未确定通用契约之前，不要进一步修补单个 backend。

### 断开后 client watch 的陈旧问题

`Client` 在断开时会清空其活动 watch-listener map，但现存的 `LaneWatch` 对象保留本地的 `ready`/`started` 状态与旧的 watch ID。在 reconnect/reattach 之后，它们可能调用 `start()` 或 `resnapshot()` 并在远程失败，而不是确定性地作为陈旧对象被拒绝，这与 `packages/client/README.md` 相悖。Service-subscription 对象有同类问题：其 listener 被清空，幸存的对象的静默地失效。用 connection/attachment incarnation fencing 与聚焦的 reconnect 测试修复两者。这与 R12 相互独立：当前 client 方法是一个兼容性的 main-lane watch。

### Query bound 与 SQLite bind 限制

- SQLite `getEntries(ids)` 为每个请求的 ID 生成一个占位符，可能超出引擎的变量上限。
- Entry、usage 与 branch 限制使用临时的 `Math.max(0, limit)` 行为。Memory 与 SQLite 对 `NaN`、无穷大、分数与极端值的处理出现分歧；与 list 读取不同，这里没有共享的归一化契约。

在 agent conformance 中定义跨 backend 的 query-limit 语义，然后分块处理 SQLite 的 ID 查找。这是一个 storage-contract 加固包，不属于 WP07。

### Harness 契约与 conformance 收口

- 公开的 `OperationStatus` 包含 `"running"`，但 lane inspection、snapshot 与 `reduceLaneSnapshot` 当前只产生 `"open"` 或 `"aborting"`。定义并实现其生产者，或移除这个死变体。
- 重写前的 abort 契约在 resolve 取消 promise 并发出 live gate 信号之前，就绑定/发布了 `operation_abort`。当前 `Lane.command()` 在构造并绑定 event batch 之前就物化结果——resolve/signal，尽管它仍在释放 Session mutation line 之前绑定 recipient。决定是修改实现，还是保留/记录当前的无交错顺序；添加一个显式的顺序测试。
- 生产环境的 gate-close 契约只允许 `HarnessClosed | HarnessFault`，但私有的源原语接受任意 `Error`，且隔离测试使用了这个更宽的类型。收窄源声明与 fixture，或显式保留私有的放宽。
- `harness.md` 的第 9 部分是必需的 conformance matrix。现有的聚焦测试广泛覆盖了该图，包括对全部 13 个 leaf 的 cancellation reconciliation，但没有经过审计的一一证明，表明每个 close/reopen leaf 情形与每个 race 行都具有两种确定性顺序。审计该矩阵，只添加缺失的情形，而不是笼统地宣称完成。

把这个包与 telemetry、RemoteSession 及 mobile assistant-output handoff 分开；它是本地契约/测试收口。

### 被禁用的真实 worker 持久化回归

`packages/coding-agent/test/experimental-remote-runtime.test.ts` 仍跳过“completes and persists a prompt through the worker-owned Harness”，且带有过时的说明“Re-enable with runtime no-tool execution.”。No-tool execution 现已存在。重新启用它，或用一个确定性的 faux-provider 真实 worker 持久化测试替换它；不要使用真实的付费 provider。

## 性能债务

### Mobile assistant-output handoff——持久化与复制放大

仓库之外、由用户提供的激励性 mini Session 为 303,920 字节、跨 569 个物理行。这些外部测量是证据，而非可复现的签入 fixture：

- 477 次 assistant-frame append，总计约 118,418 序列化写入字节；
- 12 次 frame-list 删除；提及 frame 命名空间的物理行总计 148,214 字节；
- 约 51,568 字节的被取代 `pi.op.state` 写入与 26,192 字节的一次结构性准备，说明为何通用 JSONL compaction 与 frame 特定的边界限定是不同的。

权威设计是 [mobile assistant-output handoff](mobile-handoff/01-harness/05-assistant-output/message-update.md)，遵循 [`mobile-handoff/README.md`](mobile-handoff/README.md) 中编号的 `01-harness` 前置项。Chord delta tracking 已落地；scoped storage、tool-output 集成与 assistant-output 集成尚未落地。

实现必须添加一个确定性的 repository fixture 与测量脚本，复现或替换这些数字，然后测量 Memory 逻辑元素、SQLite 行/页/WAL、JSONL 峰值 sidecar/main-log 字节与 reopen/replay 时间。该 handoff 必须保留 unknown-outcome recovery、invocation fencing、non-blocking provider streaming 与 settlement retirement，同时消除 per-frame 持久化写入与二次方的 `message_update` 复制。数值预算属于其实现 handoff/测试，而不属于一份竞争的独立设计。

### SQLite branch 分歧

`createDivergentBranchForEntry()` 复制最新 compaction 之后的每一行；没有 compaction 时它复制从 root 到 parent。因此从一段很长的未 compaction transcript 产生第一次分歧是 O(history) 写入。这暴露了 `harness.md` §2.6 中的一个内部矛盾：其开篇的 bounded-prefix 承诺与其自身基于 compaction 的复制算法相冲突，而实现遵循的是后者。同时修改规范与 segment 表示，使分歧能够在 parent 边界引用一个覆盖性 segment。保留 shared-container 支持，并添加大体积未 compaction 分歧以及 chain-soundness 测试/基准。

### Fork 契约与物化——WP08 可执行项

所有当前 backend 都会物化与源等大的 fork snapshot。Branch scope 默认是 `main`，没有 named-Branch 祖先校验；tree scope 省略应用 values/lists；JSONL 对已关闭源的 fork replay 可能修复其源。WP08 用必需的 named-branch 或 tree scope、单一封闭的 built-in-state 策略、tree fork 的完整当前应用状态以及 backend 特定的 bounded-memory 复制过程来取代该契约。它保留 WP07 的 host ownership、物理身份、同 repository 排序与独立的 live-source WAL 边界。

### SQLite catalog、statement、stats 与回收

- 默认的 per-session `list()` 会串行地同步打开/配置每个 SQLite 文件，并静默跳过失败。共享容器或外部 catalog 是可扩展的部署选择；有界的异步调度不会使 `DatabaseSync` 变为非阻塞。
- 大多数热查询每次调用都会准备一条新的 statement。在测量之后缓存窄范围拥有的 statement。
- 每一行 usage 都会解析并重写完整的聚合 JSON usage payload。
- 共享容器行删除不会回收页。单独定义维护/VACUUM 策略；切勿随意把 `VACUUM` 加入普通删除。

这些是可度量的优化/运维包，而非正确性修复。

### Pending-payload 放大与 mutation-line 并行度

排队的 payload 会有意写入 `pendingEntry → immutable entry`；在改变它之前先测量病态 payload。Keyed Session mutation line 仍是可选的，需要 profiling 加上一次新的 mutable-ownership 审计。两者都不是当前的正确性工作。

## 保持行为的清理与文档修复

由本审计完成：

- 重写了 SQLite README 中并不存在的 `SqliteSessionRepository`/search API、错误的 `await using` 与 `appendMessage` 示例、FTS trigger/rebuild 声明与“一个共享连接”的声明；
- 调和了 `harness.md` 中默认单文件 SQLite 的措辞与受支持的可选共享容器；
- 调和了 `harness.md` 第 8 部分与本审计，并修正了 `telemetry.md` 中过时的 drive-ownership/RPC-cancellation 状态；
- 修正了 coding-agent settings 文档：install telemetry 配置也控制所选 provider 的 attribution header。

剩余清理：

- **Harness 拥有的 DTO 边界：** 持久化 Harness 仍从 `src/types.ts` 导入遗留的 agent-loop DTO：`AgentMessage`、`AgentToolResult`、`AgentToolCall`、`AgentTool`、`QueueMode` 与 `ThinkingLevel`。日后做一次性的切换到独立的 `HarnessMessage`、`CustomHarnessMessages`、`HarnessToolResult`、`HarnessToolCall`、`HarnessQueueMode` 与 `HarnessThinkingLevel` 定义；保留 `AgentHarnessTool` 作为可执行的 Harness 配置类型。一并更新 Harness 内部、root 导出、declaration-merging 测试、文档与 experimental coding-agent 消费者。不要把新的 message/tool DTO 别名回遗留类型，因为那会保留本项工作旨在移除的耦合。
- 保留 shared-container 支持；不要顺带移除它。
- 移除或使用未使用的 `insertEntryRow()` 与 `insertUsageLedgerRow()`。
- 只有在正确性测试同时钉住两条路径之后，才合并重复的 SQLite branch payload/structure 扫描管线。
- 在移除 schema 之前，决定未使用的 `sessions.metadata` 与未测量的索引是否有未来的归属；不要随意更改 schema。
- 只有在遥测表面被保留时才合并 `startAiSpan()`/`startHarnessSpan()` 实现。
- 将历史持久化文档标记为已交付（它们现在仍读起来像实现队列之处）。WP00–WP07、`runtime-simplification.md`、`values.md` 中旧的 consumer deferral 与 external-finalization 设计都不是活动的 runtime 待办。

## 可选或推迟的产品能力

这些不是持久化 Harness 的阻塞项：

- 在完成其 API 决策后的独立 S3 search；
- Accounts 移除与带版本号的 Transcript 生产；
- 针对 experimental 本地服务器的已认证 workspace/client 授权；
- private returned reference、service flow control、multi-pane presentation、plugin kernel/reload 收口与 version-skew 协商；
- 管理性的精确重写工具；
- 分区的 Postgres backend/保留策略；
- 通用远程 Harness/对象能力；
- 在具体的 snapshot 压力证明其合理性之前的 DeltaState 或 delta 复制；
- 生产遥测 exporter；
- 在不兼容的稳定格式变更激活 R11 之前的 schema migration。

## 推荐的依赖顺序

该顺序以数据安全为先，其次才是依赖关系。相互独立的轨道只有在不修改相同契约时才可以并行推进。

1. **Harness 契约/conformance 收口。** 解决 `OperationStatus.running`、abort signal/event 绑定顺序、gate-close 类型与第 9 部分覆盖矩阵。
2. **Remote Session 决策（仅决策）。** 尽早解决错误的规范边界。若进程本地胜出，修复文档。若原始 RemoteSession 胜出，日后创建专门的 protocol/client/server/worker 包；不要把它并入 telemetry 或 R12。
3. **Client watch/subscription 陈旧问题**与 **repository 生命周期契约。** 小而独立的正确性包；在扩展 server/worker 生命周期语义之前完成它们。生命周期包还必须处理 Memory 的 fail-fast repository close。
4. **[Mobile Harness handoff](mobile-handoff/README.md)。** 遵循其编号前置项，依次经过 scoped storage、tool output 与 assistant output；保留所有恢复边界并落地确定性的放大测量。
5. **JSONL snapshot compaction。** 为剩余的 session 作用域历史实现已经规范化的物理回收路径与指标。
6. **R12 session 级 watch。** 在构建带版本号的 Transcript/session 级远程观察之前，完成唯一的 Harness 方法 stub。
7. **Telemetry（若保留）：** 先厘清 schema，再本地插桩，然后 RPC 传播，最后是可选的 exporter。RPC 传播遵循 Remote Session/产品边界决策。
8. **WP08 — named-branch 与 streaming fork。** 实现可执行的 handoff，且不重新打开 WP07 的所有权或生命周期决策。
9. **SQLite branch/query 性能加固。** 与已完成的 WP07 所有权对齐及 WP08 fork 语义保持分离；要求提供基准。
10. **S3 search。** 解决其 API/filter/cursor 决策，然后实现 catch-up 与独立 FTS projection。
11. **R11 migrations。** 在第一个不兼容的稳定持久化 schema 变更之前立即激活，而不是更早。

## roadmap 准确性的停止条件

当以下任一事实发生变化时，必须更新本盘点：

- `watchSession` 不再是唯一的 Harness `SliceNotImplemented` 方法；
- 原始 RemoteSession 被重新启用或从规范契约中移除；
- JSONL snapshot compaction 落地；
- 遥测 schema 被实现或被移除；
- S3 的公开 API 被厘清；
- 一次持久化格式变更激活 R11；
- WP08 落地或其 fork 契约发生变化；
- host-authority 契约发生变化。
