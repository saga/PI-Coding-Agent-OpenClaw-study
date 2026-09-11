# pi.dev（pi2）代码架构与 Agent Harness 研究报告

> 研究对象：`pi2-source-code/pi`（pi.dev 官方 monorepo，`@earendil-works/*`）
> 版本：`0.85.1` ｜ HEAD：`71dca871b`（2026-09-11，"fix(ci): Fix a broken test"）
> 代码规模：11 个 package、约 1.2 万文件（含 node_modules 外的 src/test/docs）
> 对比基线：`pi-coding-agent-source-code/pi-mono`（pi1，`0.67.68`，2026-04-18）

---

## 0. 结论速览

1. **pi2 把"可持久化的 Agent 运行时"从应用层下沉到了核心层**。pi1 的 `pi-agent-core` 只有 `Agent` + `agent-loop` 两个文件；pi2 新增 `AgentHarness`，用「不可变 entry 树 + 可变更值/列表 + append-only 用量账本」三存储模型承载完整的崩溃恢复语义。
2. **整个 harness 的设计被一条不变式统治**：*任何 payload 只存在于 entry、bound value/list、或 ledger 三者之一*。所有并发、恢复、清理、分叉、附件（attachment）规则都从这条不变式推导。
3. **接受（accept）与执行（drive）分离**。`accept` 只落盘一个 operation，不启动任何进程内工作；`drive` 才安装进程内的 pass。这使 harness 天然适配"无调度器的服务端"（alarm / job / HTTP 重入均可）。
4. **"意图 → 不确定效果 → 结算"两段提交**包裹所有外部效果（provider 请求、真实工具调用），使崩溃点可枚举、可恢复，且**永不重放已结算的效果**。
5. **稳定 CLI 与实验性分布式架构并行存在**：稳定版 `pi` CLI 仍跑 `Agent` + JSONL `SessionManager`；`AgentHarness` + Chord facet/RPC + session worker 只在 `src/experimental/` 与 `packages/{protocol,client,server,chord}` 中启用。这是本仓库当前最重要的"双轨"事实。
6. 代码质量取向极端保守：直连依赖全部 pin 到精确版本、`min-release-age=2`、shrinkwrap 白名单、erasable TypeScript only、`npm run check` 全绿才允许提交。

---

## 1. 仓库与版本概览

### 1.1 Monorepo 结构

```
pi/
├── packages/
│   ├── chord/                    # 应用组装运行时：facets / services / replicated state / RPC 边界
│   ├── telemetry/                # 厂商中立 telemetry 契约（无 exporter、无全局 span）
│   ├── tui/                      # 终端 UI 库：差分渲染 + CSI 2026 同步输出 + 原生扩展
│   ├── ai/                       # 统一多 provider LLM API（47 个 provider 工厂）
│   ├── agent/                    # Agent 运行时：Agent / agent-loop（兼容）/ AgentHarness（持久化）
│   ├── session-backends/
│   │   └── sqlite-node/          # node:sqlite Session 后端
│   ├── protocol/                 # 路由信封 + CBOR 编解码 + 字节流分帧（protocol v8）
│   ├── client/                   # 传输无关的协议客户端
│   ├── server/                   # 实验性本地服务端（Session 路由 + 多 presentation 附件）
│   ├── coding-agent/             # CLI 产品（4 种运行模式 + 扩展系统）
│   └── evals/                    # 行为级 eval（vitest-evals，跑真实 AgentSession）
├── scripts/                      # 发布、shrinkwrap、entry-graph、browser-smoke 等校验脚本
├── AGENTS.md                     # 项目开发规则（对人和 agent 同时生效）
└── .pi/skills/                   # 仓库自用的 pi skill（如 interactive-testing.md）
```

### 1.2 构建顺序是编译拓扑序，不是架构分层

`package.json` 的 `build` 脚本显式给出拓扑序（叶子先编译）：

```
chord → tui → telemetry → ai → agent → session-backends/sqlite-node
      → protocol → client → server → coding-agent
```

注意三点（⚠️ 构建得早 ≠ 架构上低）：

- `chord` 被排在**最前**，且 `chord/README.md` 明确声明"它不是 Pi 包，不依赖任何其他 Pi workspace 包"。它是可被无关应用复用的通用组装运行时。
- `telemetry` 早于 `ai`，说明遥测契约是基础设施而非横切关注点。
- `tui` 排第二**仅因为它是零依赖叶子**，不是因为它是底层——它的唯一消费方是顶层的 `coding-agent`，`agent` / `ai` / `server` 均不引用它（详见 §2）。

---

## 2. 分层架构

纵向主干（上层依赖下层）外加横向设施（无 Pi 内依赖的叶子库，不属于任何纵向层）：

```
┌──────────────────────────────────────────────────────────────────────┐
│ L4 产品层      coding-agent（CLI / SDK / RPC / JSON 模式、扩展、skills）│
├──────────────────────────────────────────────────────────────────────┤
│ L3 会话层      agent（AgentHarness · Session · Branch · AgentLane）    │
│                session-backends（SQLite 存储后端；Memory/JSONL 在 agent │
│                包内，与 Session 同一套一致性测试）                      │
├──────────────────────────────────────────────────────────────────────┤
│ L2 模型层      ai（Models / ModelRuntime / provider 工厂 / auth）      │
├──────────────────────────────────────────────────────────────────────┤
│ L1 传输层      protocol / client / server（信封、CBOR 分帧、路由）     │
├──────────────────────────────────────────────────────────────────────┤
│ L0 契约层      telemetry（厂商中立遥测契约，被 ai / agent 引用）        │
└──────────────────────────────────────────────────────────────────────┘
横向设施：
  chord ─ 被 agent / protocol / client / server / coding-agent 引用的
          通用组装运行时（facet / service / replicated state）
  tui   ─ 仅被 coding-agent（interactive 模式）消费的终端 UI 工具库；
          agent / ai / server 均不引用它，不是任何意义上的"底层"
```

### 2.1 各层职责边界

| 层 | 包 | 核心职责 | 明确不做 |
|---|---|---|---|
| 横向 | `chord` | facet 生命周期、依赖图校验、service 绑定、replicated state、RPC 边界 | 不懂 Harness / TUI / 业务 |
| 横向 | `tui` | 差分渲染、CSI 2026 同步输出、原生扩展（仅供产品层调用） | 不被 agent / ai / server 引用，不承载任何会话语义 |
| 遥测 | `telemetry` | 显式 callback 式 `TelemetryContext`/`Span`、schema 定义 | 不带 exporter、不用全局 current-span |
| 模型 | `ai` | 统一流式 API、auth 解析、token/cost 统计、deferred handle、frame 编解码 | 不含 agent 循环 |
| 会话 | `agent` | 持久化 operation 状态机、崩溃恢复、工具执行编排、hooks/events | 不做调度、不做复制 |
| 存储 | `session-backends` | SQLite 原子事务、WAL 快照、分支索引 | 不保证 Session 独占所有权 |
| 传输 | `protocol` | 信封校验、CBOR、分帧、版本握手 | 不解析 payload 语义（Chord 负责） |
| 服务端 | `server` | 路由、附件生命周期、worker 托管 | 不实现跨 server 路由 |
| 产品 | `coding-agent` | CLI 交互、扩展加载、工具实现、session 管理、UI | 不做权限系统（README 明示） |

---

## 3. `pi-ai`：统一多模型 API

### 3.1 结构

```
packages/ai/src/
├── api/          # 各协议实现：anthropic-messages / openai-responses / google-generative-ai /
│                 #   bedrock-converse-stream / mistral-conversations / pi-messages …
│                 #   每个实现有 .lazy.ts 懒加载变体（避免启动即加载全部 SDK）
├── providers/    # 47 个 provider 工厂 + 各自的 *.models.ts 模型目录
├── auth/         # 凭据解析：环境变量 / credential store / OAuth / 订阅
├── utils/        # retry、overflow 检测、assistant-message-frame、event-stream、typebox-helpers
├── models.generated.ts / image-models.generated.ts   # 生成物，禁止手改
└── compat.ts / legacy-api-aliases.ts                 # 旧 API 兼容面
```

### 3.2 设计要点

- **只收录支持 function calling 的模型**（README 明确），因为 agentic 工作流依赖工具调用。
- **provider 工厂 + 显式注册**：`createModels()` → `models.setProvider(anthropicProvider())` → `models.getModel("anthropic", "claude-sonnet-4-6")`。没有隐式全局注册表。
- **`Models` / `ModelRuntime` 双层**：`Models` 是模型注册表 + 流式入口；`ModelRuntime` 负责 auth/凭据组合，供 CLI/SDK 使用。
- **`AssistantMessageFrame` + `reduceAssistantMessageFrames`** 是 pi2 独有的机制：把 provider 流式事件编码成紧凑恢复帧。harness 只负责把它 append 到有界 list，不重复实现编解码器（§0.7 明确"harness 不定义第二个 frame codec"）。
- **deferred handle**：provider 返回"稍后完成"的响应（如长思考任务），harness 用 `deferred.suspended ↔ deferred.effect_pending` 轮询状态对建模。
- **codex 路径**：`openai-codex-responses.ts` 独立实现，说明对 OpenAI Codex 订阅通道有专门支持。

---

## 4. `pi-agent-core`：AgentHarness 核心（重点）

### 4.1 系统模型

```
Session ──┬── 不可变 entry 树（message / compaction / branch_summary / custom）
          ├── 可变更值 & 列表（bound typed address）
          ├── Branches（命名数据路径，可移动 tip）
          │     └── AgentLane = Branch + LaneConfiguration + LaneState + ≤1 Operation
          └── append-only 用量账本（usage ledger）
```

- **Session** 拥有全局持久数据与 Branch 能力；**Branch** 只有 tip 和相对查询；**AgentLane** 才是"可执行"的（有模型配置、队列、operation）。
- `main` 只是普通分支名，不隐式创建。
- **Operation** = 一个被接受的 lane 工作单元，三类：`run` / `compaction` / `navigation`。

### 4.2 三存储不变式

> **Every payload is in an entry, a bound value/list, or the ledger; there is no third place.**

| 存储 | 语义 | 生命周期 |
|---|---|---|
| `entries` | 会话树，写一次、只追加，placement 与 payload 同一行 | 永不删除（唯一例外：§2.9 precise rewrite） |
| `values` / `lists` | 当前可变更状态；value 可替换，list 只可追加或整表删除 | 由 owner 显式清理 |
| `usage ledger` | 成本历史，append-only | 永不删除 |

关键推论：

- **崩溃状态可枚举**——只可能发生在两个事务之间，不可能在事务内部。
- **清理即删除，不是垃圾回收**——30 轮运行会替换 `operationState` 约 30 次，最后删除它，只留下对话、账本和少量 lane/session 值。
- **恢复不靠修复重写**——只追加 entry、只替换自己拥有的 value，走与正常执行完全相同的转移，因此"中断后重跑"与"没中断"结果一致。

### 4.3 Bound Typed Address（有界类型地址）

```ts
const state  = value<ApplicationState>("my-app.state");   // 可替换标量
const events = list<ApplicationEvent>("my-app.events");   // 只追加列表
await session.setValue(state, next, context);
await session.appendList(events, event, context);
```

- `namespace` / `key` 在构造时**绑定一次**，之后每次读写只传地址，不再传第二把 key。
- phantom 类型 `[storedValueType]?: (value: T) => T` 让 `T` **不变（invariant）**，地址不会静默放宽到别的类型。
- `pi` 与所有 `pi.*` 命名空间为内建保留；应用自建命名空间。
- **没有全局 value-type map、没有注册表、没有 declaration merging**——应用定义自己的地址即可。
- 仅 5 个 prefix 构造器（`branchTipInventoryPrefix` 等）可用于 `scanValues()`，其余一律用精确地址。

内建地址清单（部分）：

| 地址 | kind | 持久化 namespace/key | 含义 |
|---|---|---|---|
| `branchTip(lane)` | value | `pi.branch.tip` / lane | 该 lane 下次追加的位置 |
| `laneConfig(lane)` | value | `pi.lane.config` / lane | 完整 lane 配置 |
| `laneState(lane)` | value | `pi.lane.state` / lane | current/last op id + inbox |
| `operationMeta(opId)` | value | `pi.op.meta` / opId | 接受元数据，只写一次 |
| `operationState(opId)` | value | `pi.op.state` / opId | **总态重启点** |
| `pendingEntry(entryId)` | value | `pi.pending.entry` / entryId | 已落盘但未 placement 的内容 |
| `pendingToolOutput(op, inv)` | value | `pi.pending.tool_output` / … | 最新有界进度快照 |
| `pendingAssistantFrames(op, resp)` | list | `pi.pending.assistant_frame` / … | 已提交流帧前缀 |
| `operationResult(opId)` | value | `pi.result` / opId | 不可变终态记录 |

### 4.4 操作状态机：13 个 flat leaf

```
StartingOperation                 "starting"
CheckpointOperation               "checkpoint"
AssistantReadyOperation           "assistant.ready"
AssistantEffectPendingOperation   "assistant.effect_pending"
AssistantRetryWaitOperation       "assistant.retry_wait"
ToolsOperation                    "tools"
DeferredSuspendedOperation        "deferred.suspended"
DeferredEffectPendingOperation    "deferred.effect_pending"
SummaryDecidingOperation          "summary.deciding"
SummaryReadyOperation             "summary.ready"
SummaryEffectPendingOperation     "summary.effect_pending"
SummaryRetryWaitOperation         "summary.retry_wait"
NavigationReadyToCommitOperation  "navigation.ready_to_commit"
```

**核心规则**：每次转移都用**完整总态**覆盖 `operationState(opId)`，绝不依赖前一状态、绝不重放日志、绝不从"缺失什么"推断位置。恢复时直接按 `state.at` 这个 flat leaf 分派到对应过程。

主流程（简化）：

```
idle ──accept run──► starting ──before_run──► checkpoint
   checkpoint ──► assistant.ready ──intent──► assistant.effect_pending
        │                                        │
        │                          ┌─────────────┼──────────────┐
        │                     工具调用        可重试错误      溢出
        │                          ▼             ▼             ▼
        │                       tools    assistant.retry_wait  summary.deciding
        │                          │             │             │
        │                          └─► checkpoint ◄────────────┘
        └──may_finish──► terminal（写 pi.result，删除所有 pi.op.*）
```

### 4.5 四个原语 + 便捷方法

| 原语 | 作用 | 关键性质 |
|---|---|---|
| `accept(request)` | 落盘 operation（meta + 初始 leaf + lane.currentId） | 不装 Drive、不跑 hook、不起 effect |
| `drive({operationId})` | 安装/加入一个 lane-owned pass | 首个调用者不是 owner，所有调用者是对等观察者 |
| `requestAbort(opId)` | **唯一的持久化取消原语** | 幂等；无 Drive 时只落盘标记 |
| `inspectExecution()` | 原子报告当前与最近终态 | 纯观察 |

便捷方法（`prompt` / `skill` / `promptFromTemplate` / `compact` / `navigateTree` / `resume` / `abort`）只叠加**进程内等待策略**，其历史与直接使用原语完全等价、可外部复现。**没有 scheduler、没有 reopen 自动启动、没有隐藏 continuation。**

### 4.6 执行、效果闸门与单写者

- **Drive**：lane 拥有的进程内 continuation。`completion`、`gate`、`context`、`waitForRetry`、`deferredPermits` 是其全部状态。
- **单写者规则**：一个 Drive 是唯一的顶层状态推进写者。inbox 方法只改 inbox 字段，`requestAbort` 只改 control，`close` 只封禁 mutation 准入——因此活过程的 operation 身份与 `at` leaf 不可能并发变化。唯一例外是并行工具子调用（兄弟状态真正竞争）。
- **Session mutation line**：一条无 key 的串行线。`Session.mutate()` 是回调便利式（保证 `finally` 中 `end()`）。**禁止在回调内调用公开写方法**（会自我排队死锁）。
- **Effect gate**：`gate.admit(() => invoke())` 同步检查并调用，中间不 yield。准备（prepare）必须在 `admit` **之前**完成，否则 abort 可能在准备期间获胜。

```ts
await prepareRequest();                        // 全部准备先做
const admittedContext = withAbortSignal(drive.gate.signal, drive.context);
const stream = drive.gate.admit(() =>         // 检查与调用是同一个同步表达式
  models.streamSimple(model, aiContext, { ...options, signal: admittedContext.abortSignal }),
);
```

- 准入目录是**封闭列表**：hook 聚合（每个 hook 一个 admit 包住整条 pipeline）、provider 操作、真实 `tool.execute`、重试定时器创建。其他代码一律不调用 `admit`。

### 4.7 工具执行：意图 → 效果 → 结算

```
call i: planned
   │  clearance 通过（before_tool / 查表 / 参数校验）
   ▼  TX[ 写 pi.op.tool_args, state = effect_pending{replay} ]
effect_pending
   │  工具 onUpdate(partial, {checkpoint:true})  → TX[ 覆盖 pi.pending.tool_output ]
   ▼  效果落定 + after_tool
   TX[ pi.pending.entry = 最终结果, 删 tool_output, 删 memo, state = outcome_ready ]
outcome_ready
   ▼  从首个未完成源位置起，按**源码顺序**物化
   TX[ 插入结果 entry（可多个）, 删 pending, 移动 tip, state = completed / 下一 checkpoint ]
```

设计要点：

- **效果完成顺序 ≠ 树内顺序**。并行工具按完成顺序 stage，按 assistant 源顺序 materialize——这正是"崩溃后已完成效果不重放"的保证。
- **checkpoint 由工具自己控制**节奏、去重与大小上界；API 不设通用字节上限。bash 的实践值：实时更新 100ms、checkpoint 最多每 2s 且仅在变化时、单次 50KiB。
- **`replay` 策略**：`"safe"` 的调用（读、查询）崩溃后带持久化参数重跑；`"never"`（删除、写入）则合成一条"被中断"的 error 结果（携带最新 checkpoint 内容 + 显式警告），**绝不重跑**。
- **`terminate: true`** 让工具直接结束 run，无需再来一轮 provider——这是"结构化输出替代方案"的实现方式。
- **invocation memo**（`getMemo`/`setMemo`）是 invocation 作用域的持久化键值，用于 Flue 风格的命名效果记忆；staging 时随调用一起删除。

### 4.8 Hooks：三类持久性

| 类别 | 含义 | 例子 |
|---|---|---|
| **pass-local** | 只影响当前进程内 pass，不记录 hook 是否跑过 | `before_drive` |
| **request-local** | 只在构造/执行该次请求期间存在，重试会重跑 | `transform_context`、`before_request`、`before_payload` |
| **transition-consumed** | 输出被后续持久转移的事务一并提交 | `before_run`、`after_response`、`before_tool`、`after_tool`、`before_compaction`、`before_navigation`、`before_run_end` |

11 个 hook 全表见 `harness.md` §5.6。统一语义：

- 按注册顺序执行，后续 handler 能看到前面聚合后的输出。
- 抛错 → 发 `handler_error`，跳过该 handler，其余继续。**例外：`before_drive` fail-closed 拒绝整个 pass；`before_tool` fail-closed 阻断该工具。**
- **没有任何 hook 是全局 exactly-once**。有副作用的外部操作必须由扩展自己用稳定 operation/invocation id 做幂等。

### 4.9 事件、快照与 reducer

- **事件是被动的"已提交状态观察"**，永不驱动执行，也不从持久历史重放。
- 事件组：operation（`run_start`…）、terminal/segment（`run_end` / `compaction_end` / `navigation_end`）、suspended/retry、transcript（`message_*` / `entry_added`）、tools/turns、replicated state（`queue_update` / `config_update` / `usage`）、metadata/faults。
- **`queue_update` 是唯一的权威队列事件**（无 `write_pending`）。
- **`LaneSnapshot` + `reduceLaneSnapshot`**：客户端折叠函数是规范性的——把 snapshot 折叠上自己的事件序列，得到下一个 snapshot；遇 `navigation_end` 返回 `{ rebase: true }`，客户端调 `resnapshot()` 而不重建订阅。
- `watch()` 在 mutation line 上捕获一个**一致快照**，然后暴露其后的串行事件。

### 4.10 上下文投影与压缩

Provider 请求的构造是 5 步固定算法：

1. `scanBranch({ start: tip, order: "newestFirst", stopAtType: "compaction" })`
2. 反转；若被 compaction 截断，则上下文 = `summary` + `retainedTail` + 其后所有 entry。**更早的内容永不读取。**
3. 丢弃 stopReason 为 `error` / `aborted` / `deferred` 的 assistant 响应（保留真正的 `length`）。
4. custom entry 过 `entryProjectors`，未投影的不进上下文。
5. `transform_context` → `toProviderMessages`。

- **compaction 是自包含检查点，不是指向历史的指针**。
- **append-only context invariant**：同一 lane 的多次请求，provider 上下文只允许在尾部增长——在上一请求尾部之前插入会摧毁 provider KV cache 并成倍放大成本。因此运行中的写入一律延后到 checkpoint（在尾部追加）。**compaction 是唯一刻意制造的 cache 失效。**

### 4.11 后端：Memory / JSONL / SQLite 同一套一致性测试

| 后端 | 编码 | 要点 |
|---|---|---|
| Memory | 四张 Map | 一次 commit 一个队列；验证全部完成前不改任何 map |
| JSONL | **文件的角色是 Memory map 的"重放配方"，不是状态本身** | 一次 `commit()` 一行；数组行表示多写；**尾部撕裂行整行丢弃**（含数组行全部元素）；`nextSeq` 高水位防止序号复用 |
| SQLite | `session-backends/sqlite-node` | 每 Session 一库（默认）或共享容器；每个写事务必须 `BEGIN IMMEDIATE`；`branch_entries` 分段分支索引 |

SQLite 的两个非显然点：

- **必须 `BEGIN IMMEDIATE`**：deferred `BEGIN` 先读后写会拿读快照，之后升级写锁若被其他写者抢先则**必然失败，且 `busy_timeout` 救不了**（等待无法刷新过期快照）。
- **`scanBranch` 必须用 `CROSS JOIN`** 强制 `branch_entries` 作外循环，否则 planner 可能从 `entries` 驱动并产生 `USE TEMP B-TREE FOR ORDER BY`——测试会断言查询计划。

### 4.12 明确非目标（Non-goals）

这套设计的克制之处同样重要：

- ❌ 外部效果 exactly-once（hook 副作用必须幂等）
- ❌ provider 流恢复（永不重连 provider 流；committed frames 只用于恢复与重连显示）
- ❌ 多写者（一个 Session 同一时刻只有一个 host 指定的 owner）
- ❌ 工作调度（harness 不创建 alarm、不扫描被遗弃的 session、不承诺 HTTP 回执）
- ❌ 复制（一个 session 只存在于一个地方）
- ❌ 持久化写历史（value 只保留当前值，list 删了就没了）
- ❌ 删除作为运行时特性（entry/usage 永不删除；合规级擦除只能走管理侧的 precise rewrite）

### 4.13 实现状态（官方自陈的缺口）

`harness.md` §0.9 诚实列出了未完成项，值得记录：

| 编号 | 内容 | 状态 |
|---|---|---|
| J1 | JSONL 快照压缩 | 已规范，**未实现**（死字节永不回收） |
| C1 | raw RemoteSession | 规范与已发布产品矛盾，**需决策** |
| R12 | `watchSession` | 抛 `SliceNotImplemented`，唯一的 stub |
| T1 | telemetry | 只启动 tool-hook span；RPC 无 trace 传播 |
| S3 | search | 只有设计，`src/search/index.ts` 骨架与设计冲突 |
| R11 | schema migration | 机制已定，activation-gated，无实际迁移 |
| WP08 | 命名分支 + 流式 fork | 进行中（Slice A） |
| — | SQLite 分支发散 | 未压缩分支上首个发散会 copy O(history)，违背"有界复制"目标 |

---

## 5. `coding-agent`：终端 harness 产品层

### 5.1 四种运行模式

| 模式 | 入口 | 用途 |
|---|---|---|
| interactive | `src/modes/interactive/` | 完整 TUI（alt-screen、差分渲染、图片、快捷键） |
| print / JSON | `src/modes/print-mode.ts` + `json-event.ts` | 一次性输出 / 结构化事件流（CI、脚本） |
| RPC | `src/modes/rpc/` | stdin/stdout JSONL 进程集成 |
| SDK | `src/core/sdk.ts` | 嵌入到自己的 Node 应用 |

四种模式**共享同一个 `AgentSession`**（`src/core/agent-session.ts`），各模式只加自己的 I/O 层。这是 pi2 一个清晰的架构决定。

### 5.2 关键事实：稳定 CLI 用的是 `Agent`，不是 `AgentHarness`

对 `coding-agent/src` 做全量检索：

- 引用 `AgentHarness` / `createAgentHarness` 的只有 4 个文件，**全部在 `src/experimental/`**：`services/worker.ts`、`mini/worker/run.ts`、`session-worker.ts`、`mini/README.md`。
- `AgentSession` 从 `pi-agent-core` 导入的是经典的 `Agent` / `AgentContext` / `AgentEvent`，会话持久化走 `core/session-manager.ts` 的 JSONL v3。

即：**pi2 的稳定产品线 = pi1 的架构 + 大量工程化；`AgentHarness` 是新架构的"影子内核"，先在 experimental 与独立包里成型，尚未替换稳定路径。** 理解这一点是读懂这个仓库的关键。

### 5.3 Session 格式（稳定路径）

```
~/.pi/agent/sessions/--<cwd 编码>--/<timestamp>_<session-id>.jsonl
```

- v1 线性 → v2 树（`id`/`parentId`）→ v3 把 `hookMessage` 角色重命名为 `custom`（扩展统一）。加载时自动迁移到 v3。
- 树结构使"原地分支"无需新建文件。
- 扩展消息类型：`BashExecutionMessage`、`CustomMessage`（`customType` + `display` + `details`）。
- `"pending"` 只用于流式事件中的部分消息，**永不落盘**。

### 5.4 内建工具

| 来源 | 工具 |
|---|---|
| `agent/src/harness/tools/` | `bash`、`read`、`write`、`edit`、`image`（+ `edit-diff`、`file-mutation-queue`、`path-utils`） |
| `coding-agent/src/core/tools/` | 上述 + `ls`、`find`、`grep`、`powershell`，各带 `renderers/` 供 TUI 渲染 |

工具是 `createXxxTool`（运行时绑定）+ `createXxxToolDefinition`（描述/渲染分离）成对提供的——**定义与渲染解耦**，使同一工具能复用于 TUI / HTML 导出 / RPC。

### 5.5 扩展系统

```ts
export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => { /* 可 block / 改参数 */ });
  pi.registerTool({ name, label, description, parameters: Type.Object({...}), execute });
  pi.registerCommand("name", { description, handler });
  pi.registerShortcut("ctrl+x", { ... });
  pi.registerFlag("my-flag", { ... });
}
```

- 位置：`~/.pi/agent/extensions/*.ts`（全局）、`.pi/extensions/*.ts`（项目，**需项目被信任后才加载**）。
- 用 [jiti](https://github.com/unjs/jiti) 直接跑 TypeScript，无需编译。
- 能力面：自定义工具、事件拦截（含阻断危险命令）、`ctx.ui`（select/confirm/input/notify/custom TUI 组件）、自定义命令、`pi.appendEntry()` 会话持久化、自定义渲染。
- **pi 自身不内置权限系统**（README 明确）；边界靠扩展（如 `confirm-destructive.ts`）或容器化（Gondolin / Docker / OpenShell）实现。

### 5.6 Skills / Prompt Templates / Themes / Pi Packages

- **Skills**：实现 [Agent Skills 标准](https://agentskills.io/specification)，但有意放宽"name 必须等于目录名"这一条（理由是共享 skill 目录场景）。渐进式披露——只有 name/description 常驻上下文，完整 `SKILL.md` 按需 `read` 加载。可从 `~/.claude/skills`、`~/.codex/skills` 直接复用其他 harness 的 skill。
- **Prompt templates**：斜杠命令展开的复用提示词。
- **Pi Packages**：把扩展/skill/提示词/主题打包，经 npm 或 git 分发（`pi install npm:@foo/bar@1.0.0`）。
- **Themes**：内置 + 自定义终端主题。

### 5.7 Evals

`packages/evals` 把真实 `AgentSession` 适配到 `vitest-evals`，在隔离的临时项目/agent 目录中运行，附带原生 session 产物。用途是**度量端到端行为并对比 prompt / 工具 / skill / 模型 / harness 配置**——而不是跑单元测试。

```bash
npm run eval -- src/extensions.eval.ts src/models.eval.ts --provider openai --model gpt-5.6-sol --repetitions 5
```

---

## 6. 实验性分布式架构（Chord + RPC + Worker）

这是 pi2 相对 pi1 最大胆的部分，也是"未来形态"的所在。

### 6.1 三层职责

```
┌─ facet kernel ─────────────────────────────────────────────┐
│ 同步 setup、依赖图校验、本地/远端 service 绑定、激活、        │
│ 作用域资源所有权、setup 失败清理、reload、逆序 dispose       │
│ 只知道 service，不知道 Harness / TUI / 业务                  │
└────────────────────────────────────────────────────────────┘
┌─ application host ─────────────────────────────────────────┐
│ session host  ：跑在专用 session worker 中，持有真正的 Harness│
│ presentation host：TUI（未来 web），持有用户界面              │
│ server host   ：SessionRepo、worker 管理、鉴权、附件、路由    │
└────────────────────────────────────────────────────────────┘
┌─ extension ────────────────────────────────────────────────┐
│ 每个 host 只加载为该进程构建的 facet bundle                  │
│ 没有聚合的 CodingAgentPlugin 运行时对象                       │
└────────────────────────────────────────────────────────────┘
```

初始拓扑（单 server，无 server-to-server）：

```
server
├─ TUI A
├─ web B
├─ session worker S0
└─ session worker S1
```

**没有 presentation → session-worker 的直连**，server 负责路由。

### 6.2 Chord 的核心概念

- **Facet**：`{ id, setup(env) }`，同步声明。异步初始化放 `onActivate()`。
- **Service**：带类型的稳定 token，singleton 或 keyed。可进程内（任意 JS 契约）或远端可暴露（严格 JSON）。
- **Replicated state**：生产者改 tracked `state` proxy 并调 `publish(context)`，消费者收到完整不可变值。Chord 每次发布 flush 一批解码后的操作，每个远端 client 拥有独立的 path-codec 状态。
- **依赖图先验证后绑定**：所有 facet setup 完成后统一校验完整依赖图，provider 先于 consumer 激活，按逆依赖序 dispose。

### 6.3 协议层

`pi-protocol` v8：

- 版本握手识别逻辑 `serverId`
- 显式 server / Session 请求目标：`{ serverId }` 或 `{ serverId, sessionId, attachmentId }`
- 带关联的请求/响应，payload 为不透明 strict-JSON
- 请求取消、不透明订阅更新、带外 attachment 变更
- **分帧**：4 字节大端长度 + 一个定长 CBOR item；decoder 接受任意流式分片与合并
- 明确不做：peer 鉴权、trace 传播

`pi-protocol` 只校验"是 strict JSON"，**不校验也不导出 Chord 语法**——语义校验在 Chord service adapter 边界完成。这个切分很干净。

### 6.4 `experimental/mini`：最小可用分布式 harness

存在的目的是"从真实 client 压测 harness，找出 RPC 形态的 presentation 到底需要什么"。

```
tui        tui        tui          presentations：只渲染，无 agent 状态
  \         |         /
   \        |        /             unix socket ~/.pi/agent/experimental/mini.sock
        server                    路由调用、扇出事件、拉起 worker
       /        \
      /          \                 child process stdio pipes
  worker       worker             每 session 一个：harness、storage、model runtime
```

有意思的工程细节：

- 第一个 `mini` 启动时以 detached 方式拉起 server。
- 最后一个 presentation 断开后 server 杀掉 worker，自己 10 秒后退休——**保证下次启动总是跑当前代码**。
- 若该 worker 持有未完成的持久 operation，替代者会**自动从最后记录的恢复状态续跑**。
- 只有两个动词：**call**（问一次答一次）和 **emit**（发布给监听者），两个方向都可用。

### 6.5 `experimental/services`：实验性服务切片

| Scope | Service | 当前切片 |
|---|---|---|
| server | `SessionDirectory` | replicated state 已实现 |
| server | `SessionManagement` | create/remove/attach/detach 已实现 |
| server | `PresentationPlugins` | 准备并 reload TUI artifacts |
| session | `SessionPlugins` | reload session facet generation |
| session | `Models` | state、持久化默认选择、thinking、refresh |
| session | `AgentController` | 面向 presentation 的 `AgentLane` 安全门面 |
| session | `Transcript` | 带 source-event 元数据的 replicated lane state |
| presentation | `SlashCommands` | 进程内命令贡献注册表 |
| presentation | `PresentationUI` | 进程内选择与状态能力 |

关键约束：**presentation facet 永远拿不到裸的 Harness / Session / tool registry / hook registry / 凭据存储 / storage handle**——只能拿到语义 service 与 replicated state。

### 6.6 `experimental/pico`（v3 设计）

`packages/agent/docs/pico-v3.md`（2113 行）+ `pico-usage-guide.md` 描述的是 harness 的**下一步重构方向**：把内建 agent 行为从"固定调度状态机"改为"由 task 组合"。

```
                    ┌─ tool A ─┐
generation ──────────┼─ tool B ─┼─ post_tools ─ generation
                    └─ tool C ─┘

替换一个 task 定义 → 改变该行为 → 保留 scheduler 与 storage
```

Scheduler 只懂 task 生命周期、依赖、时序、取消；不懂 prompt、工具参数、摘要。Storage 只懂存储对象与原子变更，不懂 task 行为。这与当前 `harness.md` 的"直接 async 过程 + 13 leaf flat state"形成对照——**pico 是"从状态机走向可替换任务图"的演进路线**。文档明确标注为"Design under discussion"。

---

## 7. Chord：应用组装运行时（是什么、做什么、怎么用）

§2 已把 `chord` 定位为横向设施。这里展开：它是本仓库中**唯一被设计为可脱离 Pi 存在的包**（见 `packages/chord/README.md` 与 `PLANNING.md`），理解它是理解 §6 实验性分布式架构的前提。

### 7.1 是什么

一句话：**Chord 是"把一个应用拆成多个进程/环境中的插件，并用类型化服务把它们再组装起来"的通用运行时**。它不认识 Harness、TUI、Session、工具——只认识 facet、service、replicated state 和字节边界。

身份特征（均有源码实证）：

- **零 Pi 内依赖**：`packages/chord/package.json` 的 dependencies 无任何 `@earendil-works/*`；README 原话"it is not a Pi package … can be used by unrelated applications"。这也是它排在构建第一位的原因。
- **保留命名空间**：Chord 自有标识用 `chord.*`，保留 service 前缀 `$chord.*`；`defineService()` 对 `$chord.` 开头的 id 直接抛错（`src/api.ts:80`）。
- **分路径导出**：包根（tokens/hosts/state）、`/context`（`Context` 等通用名特意不污染根 API）、`/delta`（独立 delta 原语）、`/node`（仅 Node 的 bundle loader）、`/bundler`（esbuild 打包）。调用方按需 import，不是一锅端。
- **体量**：`src/services/` + `delta` + `context` + `node/bundle` 约 3700 行，`facets/host.ts`（FacetKernel）906 行，10 个测试文件。不是小工具，是完整子系统。

### 7.2 做什么：六件套

README 列出的六个连贯部件（`packages/chord/README.md:18-58`）：

| 部件 | 作用 | 关键语义 |
|---|---|---|
| **Facet** | 同步声明式插件单元 `{ id, setup(env) }`；一个 plugin 可拆成多个 facet，分别跑在 worker / TUI / browser 等进程 | `setup` 必须是同步的；异步初始化一律推迟到 `onActivate()` |
| **Service** | 类型化稳定 token，`singleton`（一对一）或 `keyed`（一对多动态实例） | 进程内 service 可用任意 JS 契约；**可远端暴露的 service 必须满足 strict-JSON 契约**（`RemoteServiceContract`） |
| **Replicated state** | 生产者改 tracked `state` proxy → 调 `publish(context)`，消费者收到完整不可变值 | 每次 publish flush 一批解码后操作；每个远端 client/state 配对拥有独立 path-codec 状态；断开后副本变 unready 直到 rehydrate |
| **Delta tracking** | 从 tracked plain JSON 在 flush 时推导紧凑操作（`/delta` 可独立使用：`track`/`apply`/`applyImmutable`） | 首 flush 永远是完整 base batch；字符串赋值保留纯 append / 滚动窗口 front-truncate 语义，其余回退为 set；支持 durable base batch；应用不可信操作时做校验 |
| **Remote boundary** | 传输无关的 service wire 语法：`$chord.service` 控制调用（catalogue/subscribe/unsubscribe）、编解码器、错误码 | Chord **只定语法不定传输**：framing、routing、transport、外层 envelope 全由应用方（如 `pi-protocol`）提供；每订阅一对 encoder/decoder，replacement/unavailable/close/rehydrate 时重置 Delta 路径字典 |
| **Context** | Go 式 context：取消 + invocation 级应用值（权限/telemetry 可搭车，但 Chord 不依赖它们） | 进程内调用权柄；Harness 的 trailing `Context` 参数类型正来源于此（`agent` 包只引用了这一层，见 §7.3） |

Facet 生命周期（`src/facets/host.ts`，`FacetKernel`）：

```
setup → assembling → connecting → activating → active
   ↳ reloading（热替换）/ disposing → dead
```

- **先验证后绑定**：全部 facet `setup` 完成 → 统一校验完整依赖图 → provider 先于 consumer 激活 → 按逆依赖序 dispose。setup 失败要清理已分配资源。
- **阶段守卫**：`observe`/`onActivate` 只能在 setup 期；`own` 可在 setup/active 期；service handle 只能在 active 期使用，dispose 时 revoke。违规直接抛错，不是未定义行为。
- **热替换不断连**：`FacetHost.reload(candidate)` 让候选 facet 在老 provider 仍在路由的状态下完成激活与校验，然后 singleton 直接替换——普通 reload 下稳定 service handle **不经历 unavailable 间隔**；keyed 实例是 incarnation-specific，替换者拿 fresh generation。

### 7.3 怎么用：三层用法（由浅入深）

**第 1 层：只借类型（稳定 Harness 就是这么用的）**

```ts
// packages/agent/src/harness/context.ts / session/types.ts
import type { Context, ContextKey } from "@earendil-works/chord";
import type { JsonValue } from "@earendil-works/chord";
```

`agent` 包对 chord **全是 `import type`**——稳定版 Harness 根本没用 facet/service 运行时，只复用了 `Context` 与 JSON 类型。这是"横向设施"最有力的证据：连核心层都只取其类型，不取其运行时。

**第 2 层：定义 service + facet（以 session worker 的 Models 服务为例）**

```ts
// ① 定义 token：接口 + id 一行绑定（packages/coding-agent/src/experimental/services/models.ts）
export interface Models {
  readonly state: ReplicatedState<ModelsState>;
  cycleThinking(context: Context): Promise<void>;
  refresh(context: Context): Promise<void>;
  select(model: ModelRef, context: Context): Promise<void>;
  // …
}
export const Models = defineService<Models>("pi.models");

// ② 写 facet：setup 里声明提供（models-provider.ts）
export function createModelsServiceFacet(options: { lane, modelRuntime, settingsManager }): Facet {
  return defineFacet({
    id: "@pi/models",
    setup(env) {
      const runtime = createModelsService(lane, modelRuntime, settingsManager, env.replicatedState);
      env.provide(Models, runtime.service);          // 安装 singleton 实现
      env.onActivate(() => runtime.activate(BACKGROUND_CONTEXT)); // 异步初始化后置
    },
  });
}
```

`setup(env)` 的完整动词表（`src/types.ts:206-224`）：`use`（硬依赖 singleton）、`observe`（订阅 keyed 实例）、`provide` / `provideMany`（安装实现）、`replicatedState`（创建可发布状态）、`own`（托管清理函数）、`onActivate` / `onDeactivate`。注意 `env.replicatedState` 是按 facet 创建的——state 的生产者身份天然绑定到 facet 生命周期。

Service id 命名惯例（实验性代码中的实际用法）：`pi.*`（可远端：`pi.models`、`pi.session-directory`、`pi.agent-controller`…）、`pi.local.*`（`{ local: true }`，纯进程内、可用任意 JS 契约，如 `pi.local.presentation-ui`）、`$chord.*`（保留，应用禁用）。

**第 3 层：组装 host + 插件热加载（`services/worker.ts` 是标准模板）**

```ts
const builtins = await createStaticFacetLoader([
  agentControllerRuntimeFacet,
  pluginRuntimeFacet,
  createModelsServiceFacet(options),
  createTranscriptServiceFacet(options.lane),
]).load();
const pluginLoader = options.facetLoader ?? createStaticFacetLoader([]);
facetHost = await createFacetHost({ facets: [...builtins.facets, ...loadedPlugins.facets] });
// facetHost.services 即 provider；reload 路径见下
```

插件 reload 用"候选—切换—退役"三段式（`worker.ts:84-103` 的 `reloadPlugins`，串行 `reloadTail` 保证不并发）：

```
candidate = await pluginLoader.load()
await facetHost.reload(candidate.facets)   // 失败 → dispose candidate，抛错
retired = loadedPlugins; loadedPlugins = candidate
await retired.dispose()                    // 成功后才退役老的
```

插件分发链（bundler → manifest → loader，`README:124-204`）：`@earendil-works/chord/bundler` 用 esbuild 把 TS/ESM 入口打成**内容寻址的独立 `.cjs` + `chord-facets.json`**（peerDeps 外部化、从不装依赖不跑 lifecycle）；`createFacetBundleLoader`（Node-only）每次 `load()` 验 SHA-256、用 `node:vm` 直接编译（不进模块缓存），dispose 退役 generation 后编译产物可 GC；输出目录先写临时目录再原子替换，loader 永远看不到半成品。`package.json` 里 `chord.facets` 声明 facet 入口映射（`worker` / `presentation` / `false` 禁用）。

### 7.4 为什么是这个形状：回扣 §6 的约束

Chord 的 API 形状直接解释了 §6.5 的关键约束"presentation facet 永远拿不到裸 Harness"：facet 能拿到的只有 `FacetEnvironment` 给的能力（service handle + replicated state + own/onActivate）——**没有"逃逸到 host 全局"的后门**。隔离不是靠文档约定，是靠 `setup(env)` 的参数表在类型层面卡死的。同样，§6.4 mini 的"call/emit 两动词 + server 路由"正好落在 Chord 不管的那一块（transport/envelope 应用自理），两者是互补关系而非重复。

一句话：**Chord 是"多进程插件组装"的通用答案，Harness 是"单 lane 持久化执行"的专用答案**；实验性架构 = 用前者装配后者，presentation 与 session worker 只是装到了不同进程的 facet。

---

## 8. 与 pi1（pi-mono）的架构演进

| 维度 | pi1 `pi-mono` 0.67.68 | pi2 `pi` 0.85.1 |
|---|---|---|
| packages | agent / ai / coding-agent / mom / pods / tui / web-ui | + chord / protocol / client / server / session-backends / telemetry / evals（去 mom/pods/web-ui） |
| `agent` 包内容 | `agent-loop.ts`、`agent.ts`、`proxy.ts`、`types.ts` | 上述 + 完整 `harness/`（session / runtime / drive / tools / compaction / execution） |
| 持久化位置 | `coding-agent/src/core/session-manager.ts`（JSONL v3） | 下沉到 `agent` 包：Session + 三存储 + 三种后端 |
| 并发模型 | 单 Session 单写者（隐式） | 显式 mutation line + Drive 单写者 + effect gate |
| 崩溃恢复 | 无正式语义 | 13 leaf 总态重启点 + orphan 恢复表 + 意图/结算两段提交 |
| 扩展边界 | 进程内 extension API | extension API（稳定）+ facet/service/RPC（实验） |
| 遥测 | 无独立包 | `telemetry` 独立契约包 + typed schema |
| 供应链 | 无特别说明 | pin + min-release-age + shrinkwrap 白名单 + CI audit |
| 发布形态 | npm 包 | npm 包 + 单文件二进制（`bun build --compile`）+ 版本化 source archive + SHA256SUMS |

**一句话概括**：pi1 是"能用的极简 coding agent"；pi2 是"把 agent 运行时的持久化与并发语义做成可证明的工程系统"，同时为多进程/多 presentation 形态预留了完整骨架。

---

## 9. 与 DeepSeek Harness（dsh）的设计对照

> 方法声明：本节基于 dsh 公开资料（2026-09-11 前后）的静态分析，未 clone 其源码：官方仓库 `deepseek-ai/deepseek-harness`（MIT，2026-08-13 v0.1 Developer Preview，CLI 名 `dsh`）、官方文档站 `deepseek-harness.github.io/deepseek-harness`、Cordis 论文《A Programming Paradigm for Spatiotemporal Composability》（arXiv:2608.25512）。dsh 自称"THERE WILL BE COMPATIBILITY-BREAKING CHANGES"，下述结论以 preview 文档为准，可能随版本漂移。

### 9.1 dsh 一句话速写

**dsh = Cordis 之上的"一切皆插件"agent 运行时**：模型适配、工具注册表、会话日志、agent loop 本身（乃至 skills、存储、sandbox、调度、UI）全部是挂在共享 `ctx` 上的可替换插件，没有必须先打补丁的特权核心。`model + harness = agent`——模型只管推理，harness 管工具、环境、会话、权限、sandbox 与执行循环。

### 9.2 六组对照：像的地方是真像

| # | 设计关切 | pi2（本报告 §2–§7） | dsh | 相似度 |
|---|---|---|---|---|
| 1 | 插件组装 substrate | **Chord**：facet（`setup(env)`）+ service token（singleton/keyed）+ replicated state + 热替换不断连 | **Cordis**：插件挂载到 `ctx`（`ctx.tools`/`ctx.llm`/`ctx.sessions`…），`inject` 声明依赖，typed events 协作，**reversible effects**（卸载即清理 listener/tool/prompt，不残留） | 高。连"可被无关应用复用"都一样（Chord 自称 not a Pi package；Cordis 是独立 meta-framework，有论文） |
| 2 | 会话即 append-only 日志 | 不可变 entry 树 + `scanBranch` 投影；compaction 是自包含检查点 | append-only `SessionEvent` 日志是唯一真相源；`deriveMessages()` 从日志派生模型历史；resume/fork/replay/search 全消费同一事件流 | 高。dsh 的不变量"凡展示给模型的一定能从日志重建" ≈ pi 的三存储不变式 + 上下文投影规则（§4.10） |
| 3 | 接口与驱动分离 | `Agent`（稳定）vs `AgentHarness`（持久化，新内核） | `agent`（`Agent` 接口 + live registry，`ctx.agents`）vs `agent-loop`（默认驱动）；扩展只依赖 `agent`、永不直连 `agent-loop`，loop 保持可换 | 中高。形状一致，但性质不同：pi 是**迁移期双轨**（新内核尚未替换稳定路径），dsh 是**原生 seam**（可换 loop 是设计起点） |
| 4 | 执行拦截点 | 11 个 hooks（三类持久性；`before_drive`/`before_tool` fail-closed） | waterfall 事件（`agent/pre-step`、`agent/request`、`tools/*` 必须调 `next()` 才放行；`agent/turn-stopping` 串行截停） | 中。都是"请求/工具/turn 三处设卡"，但 pi 的 hook 语义绑定**持久性**（输出是否随事务落盘），dsh 的 waterfall 绑定**放行权**（调不调 `next()`） |
| 5 | 外部效果安全 | 意图 → 不确定效果 → 结算；每调用声明 `replay: safe \| never`，`never` 永不重放 | guarded tool pipeline + 审批策略 + sandbox/execution provider seam（把 fs/subprocess 指向远端 sandbox，Bash/PTY/LSP 整体搬走，无需 fork provider） | 中。同一焦虑、两种解法：pi 把"崩溃后重不重放"写进每个调用的持久化契约；dsh 把"能不能执行"交给策略与执行环境隔离 |
| 6 | 产品组装 | Pi Packages（扩展/skill/主题打包分发）+ facet bundle（esbuild/CJS/manifest/SHA-256/`node:vm` 加载） | profiles = 有序 bundle 栈 + patches（bundle 是贡献配置补丁的 npm 包；`dsh-base` + `web/headless/sdk/acp`；`dsh config` 可看最终合成树） | 中高。都是"有序叠加 + 覆盖"，dsh 的"可见的最终合成树"值得 pi 学（facet 组合目前没有等价的可视化） |

### 9.3 本质差异：两边各自回答了对方没答的问题

1. **崩溃恢复的完备性**：pi 的 AgentHarness 把"任意两事务之间杀进程都能续跑且不重放已结算效果"做成了可枚举的工程系统（13 leaf 总态重启点、accept/drive 分离、单写者 Drive、effect gate 同步准入）。dsh 的持久化叙事停在"日志 + projections + inbox 持久化变异"层面——resume/fork 有，**逐调用的 crash-replay 契约没有**。这是 pi2 全仓库最硬核、dsh 文档里找不到对应物的部分。
2. **事件的地位相反**：dsh 的 typed events 是**一等协调机制**（waterfall 驱动放行、并行、顺序决策）；pi 的 harness events 明确是**被动观察**（§4.9"永不驱动执行"）。Chord 甚至没有 event bus。两边若互借，dsh 该借 pi 的"事件不驱动"纪律（避免观察者偷偷变成驱动者），pi 该借 dsh 的"可逆注册"纪律（对应 §4.13 H1 契约债里 listener/timer 残留类问题）。
3. **可扩展类型系统的 Zel**：dsh 用 declaration merging 让插件给 `SessionEventMap` 加变体（拥有包零修改）；pi 用 bound typed address + 无全局注册表达到同样"应用扩展无需改核心"，但靠的是地址命名空间纪律而非类型合并。前者对 TS 生态更顺手，后者对多语言/远端边界更友好（地址可编码、不依赖 TS 特性）。
4. **成熟度与姿态**：pi 是"稳定 CLI（经典 Agent）+ 实验性影子内核"双轨，保守演进；dsh 是 developer preview，一切皆可换但一切皆可变（官方明示 breaking changes）。一个求稳、一个求变，读文档时要代入各自的阶段。

### 9.4 pi 可从 dsh 借的三件事（具体）

1. **`dsh config` 式最终合成树可视化**：facet/bundle 叠加后"实际生效的是什么"今天只能靠读代码，dsh 把它做成了一等命令。§6 的 facet 排查成本会大降。
2. **reversible effects 作为扩展 API 契约**：pi 的扩展卸载/热替换（`worker.ts` 的 retired dispose）今天靠人工写对清理；Cordis 把"注册即附带撤销"做进框架，可直接对标 Chord 的 `own()` 机制补齐。
3. **projection seam 的增量折叠**：dsh 的 `dsh-session-projection`（对已提交事件增量 fold，`stateOf()`/`snapshot()` 读类型化状态）与 pi 的 `reduceLaneSnapshot` 是同构思想，但 dsh 把它做成了**注册表 + 多消费者共享**，pi 的 reducer 目前是客户端各自调用——多 presentation 场景下 dsh 的形态更省。

---

## 10. 可借鉴的设计模式

1. **三存储不变式**：把"什么能存在哪里"约束成一条规则，并发、恢复、清理、分叉全部可推导。比"每个功能自己决定存哪"健壮得多。
2. **接受与执行分离**：`accept` 落盘、`drive` 执行。这让 harness 不依赖任何调度器，服务端可用 alarm/job/HTTP 重入。
3. **总态覆盖而非增量日志**：每次转移写完整 `operationState`，恢复只读它。放弃了写放大换取"崩溃状态可枚举"。
4. **Bound typed address**：地址构造时绑定 namespace/key，读写只传地址；phantom 类型保证不变性；无全局注册表。应用扩展无需改核心。
5. **意图 → 效果 → 结算**：把"不确定窗口"显式建模，并给每个效果声明 `replay: safe | never`。这是 agent 系统里最容易被忽略、后果最严重的一环。
6. **同步准入边界**：`gate.admit` 的检查与调用必须是同一个同步表达式，准备必须前置。这个约束很小但很关键。
7. **事件是被动观察，不是驱动源**：`reduceLaneSnapshot` 作为唯一规范折叠函数，避免客户端各自实现第二套状态机。
8. **稳定的窄接口 + 显式非目标**：文档里专门有一节 Non-goals。写清楚"不做什么"比写清楚"做什么"更能约束实现不腐化。
9. **诚实的实现状态清单**：§0.9 逐条列出未实现项与契约债。这在真实工程里极其少见，也极其有用。
10. **双轨演进**：新内核（AgentHarness）先在 experimental 与独立包中成型，用 `mini` 这类最小真实客户端压测，再谈替换稳定路径。

---

## 11. 风险与未完成项

| 风险 | 说明 | 影响 |
|---|---|---|
| JSONL 无物理回收（J1） | 逻辑删除立即生效，物理字节永不回收 | 长会话文件持续膨胀；敏感内容无法物理清除 |
| SQLite 分支发散 | 未压缩分支首个发散 copy O(history) | 长历史 + 频繁分支时性能退化 |
| C1 契约矛盾 | 规范里的 RemoteSession 与已发布产品冲突 | 需要一次明确决策，否则文档持续误导 |
| S3 search | 骨架与设计冲突，无实现 | 搜索能力缺失 |
| 双轨并存 | 稳定 CLI 与 harness 内核不同源 | 概念混淆、文档分裂、迁移成本 |
| frame 持久化成本 | 每帧一次 durable append + 复制写 | 长输出场景 IO 放大；`mobile-handoff` 文档已在设计替代方案 |
| 无内建权限系统 | 默认以启动用户权限运行 | 需依赖容器化/扩展；README 已明示 |

---

## 12. 附录：关键文件索引

### 规格与设计文档

| 路径 | 内容 |
|---|---|
| `packages/agent/docs/harness.md` | **AgentHarness 规范（1468 行，Part 0–9 + 附录，规范性）** |
| `packages/agent/docs/values.md` | bound typed address 规格（735 行） |
| `packages/agent/docs/tool-durability.md` | 工具持久性（704 行） |
| `packages/agent/docs/assistant-durability.md` | assistant 输出持久性（355 行） |
| `packages/agent/docs/runtime-simplification.md` | 运行时简化（391 行） |
| `packages/agent/docs/plugins.md` | coding-agent facet/service 架构（1158 行） |
| `packages/agent/docs/rpc.md` | facet service RPC 语义 |
| `packages/agent/docs/pico-v3.md` | 下一代 harness 设计（2113 行，讨论中） |
| `packages/agent/docs/pico/pico-usage-guide.md` | pico 使用指南（1497 行） |
| `packages/agent/docs/work-packages/00–09` | WP 工作包（runtime1 移除 → lane snapshot settled tools） |
| `packages/coding-agent/docs/` | 34 篇用户/开发者文档（extensions 3033 行、rpc 1618 行、sdk 1226 行…） |
| `AGENTS.md` / `CONTRIBUTING.md` / `SECURITY.md` | 项目规则 |

### 核心源码

| 路径 | 行数 | 内容 |
|---|---|---|
| `packages/agent/src/harness/agent-harness.ts` | 21541 B | Harness/Lane 公开声明 |
| `packages/agent/src/harness/runtime/lane.ts` | 2012 | Lane 实现（核心） |
| `packages/agent/src/harness/runtime/drive/structural.ts` | 1222 | compaction/navigation 结构过程 |
| `packages/agent/src/harness/runtime/drive/tools.ts` | 692 | 工具执行过程 |
| `packages/agent/src/harness/runtime/drive/response.ts` | 485 | assistant 响应过程 |
| `packages/agent/src/harness/runtime/harness.ts` | 408 | `Harness` 类实现 |
| `packages/agent/src/harness/session/` | — | Session / commit / mutation-line / fork / jsonl / memory |
| `packages/agent/src/harness/hooks.ts` | 17258 B | Hook 注册与聚合 |
| `packages/agent/src/harness/events.ts` | 9852 B | 事件总线 |
| `packages/agent/src/harness/telemetry.ts` | 18212 B | agent 侧 telemetry schema |
| `packages/agent/src/agent.ts` / `agent-loop.ts` | 18767 / 22796 B | 经典 Agent 与兼容 loop（稳定 CLI 使用） |
| `packages/coding-agent/src/core/agent-session.ts` | — | 四模式共享的会话抽象 |
| `packages/coding-agent/src/core/session-manager.ts` | — | JSONL v3 会话管理 |
| `packages/coding-agent/src/experimental/session-worker.ts` | 884 | 实验性 session worker |
| `packages/coding-agent/src/experimental/mini/` | — | 最小分布式 harness（server/worker/tui） |
| `packages/chord/src/services/` | ~1900 | service consumer/provider/handle/state-codec/wire（原"—"细化） |
| `packages/chord/README.md` / `PLANNING.md` | 205 行 / — | Chord 设计总览与 RPC/generation-loading 规划（§7） |
| `packages/chord/src/types.ts` | — | `Facet` / `FacetEnvironment` / `Service` / wire 类型全集 |
| `packages/chord/src/api.ts` | 90 | `createFacetHost` / `defineFacet` / `defineService` / `replicatedState` |
| `packages/chord/src/facets/host.ts` | 906 | FacetKernel：setup/激活/依赖图校验/reload/dispose |
| `packages/chord/src/delta/index.ts` | 1267 | 独立 delta 原语（`track`/`apply`，base batch + 路径操作） |
| `packages/chord/src/node/` + `bundler.ts` | — | facet 打包（esbuild/CJS/manifest）与 Node 加载（SHA-256 + `node:vm`） |
| `packages/coding-agent/src/experimental/services/worker.ts` | — | 标准组装模板：builtins + 插件 facets → `createFacetHost` → 候选 reload |
| `packages/protocol/src/` | — | codec / framing / protocol + cbor |
| `packages/server/src/session-router.ts` | — | Session 路由与附件 |
| `packages/session-backends/sqlite-node/src/` | — | node:sqlite 后端 |

---

*本报告基于本地源码静态阅读完成，未运行构建或测试。规范类结论以 `packages/agent/docs/harness.md` 为准；行为类结论以源码为准；两者冲突处已在正文标注（如 §0.9 列出的契约债）。*
