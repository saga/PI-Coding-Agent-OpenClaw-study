# pi.dev（pi2）代码架构与 Agent Harness 研究报告

> 研究对象：`pi2-source-code/pi`（pi.dev 官方 monorepo，`@earendil-works/*`）
> 版本：`0.85.1` ｜ HEAD：`71dca871b`（2026-09-11，"fix(ci): Fix a broken test"）
> 代码规模：11 个 package、约 1.2 万文件（含 node_modules 外的 src/test/docs）
> 对比基线：`pi-coding-agent-source-code/pi-mono`（pi1，`0.67.68`，2026-04-18）

---

## 阅读指引：本报告的核心问题

这篇报告不是"逐个包介绍"。它围绕一个问题展开：

> **Agent Harness 的核心任务，是把"当前 Agent 状态"编译成下一次模型调用所需要的完整上下文。**
>
> **Execution 负责保证这个状态不会因为崩溃、重试和副作用而失真；Composition 负责决定有哪些能力和上下文可以进入这次编译。**

> （**"失真"在这里的意思**：模型看到的内容和真实发生过的事对不上——少了一条结果、多了一条并不存在的成功、或者顺序错了。后面每次说"失真"，都是这个意思。**"副作用"**指的是"除了返回值之外，还对外部世界造成了改变"——写了一个文件、发了一次请求、改了一条数据库记录。后面每次说"副作用"，都是这个意思。）

更准确地说（这个说法比"Harness 就是 Prompt 拼装器"准确得多）：

> **Agent Harness 本质上是一台编译器：输入是"Agent 此刻的状态"，输出是"下一次交给模型的那份内容"。这个编译过程里最核心的一步是 Prompt Assembly——把散落各处的信息整理成模型能直接读的那一份。**

两条主线由此确定：

| 主线 | 问题 | pi2 的答案 | 本文位置 |
|---|---|---|---|
| **Execution** | 怎么保证"下一次喂给模型的东西"**不会因为崩溃、重试、副作用而失真**？ | `AgentHarness` | §4 |
| **Composition** | 怎么决定**哪些能力和上下文可以进入这次编译**？ | `Chord` | §6–§8 |

这两条线不是并列，而是**因果**：先把 execution 做可靠，才暴露出"谁有权参与编译"这个更大的问题。所以本报告先铺平 execution（§4），再铺平 composition 的问题空间（§6），然后才展开 Chord（§7–§8）——**为了理解 Chord，先把它所在的问题空间铺平**。

最后（§9）拿这套模型去看 DeepSeek Harness（dsh / Cordis），回答一个更实际的问题：**这两个系统到底是不是在解决同一个问题？**

> **不熟悉这套代码术语的读者**：先扫一眼下面的「术语速查」，再往下读。表里包含 **prompt / system prompt / messages / Prompt Assembly** 这几个最常出现、也最容易含混的词，以及一批中文术语（失真、落盘、幂等、原子……）的确切含义。文中第一次出现专有名词时，也会尽量用大白话再解释一遍。
>
> 如果你最关心的是"**到底什么东西会写进 prompt 文字里**"，可以直接跳 **§4.4**——那里有一张完整的对照表。

### 全文主线

```
Agent 为什么需要 Harness？
        ↓
因为 Agent 不是一次 LLM call
        ↓
每一轮都要重新构造 Model Input
        ↓
Model Input 从哪里来？
        ↓
历史 + 状态 + tools + prompt + plugin contributions
        ↓
所以需要 Context Assembly
        ↓
但是 Context Assembly 必须可靠
        ↓
Pi → AgentHarness
        ↓
可靠以后，又遇到"谁可以参与 assembly"
        ↓
Pi → Chord
        ↓
另一种答案
        ↓
DeepSeek → Cordis / Everything is Plugin
        ↓
比较两种答案：
"固定 execution kernel + 外部 composition"
        vs
"pluginized execution + context composition"
```

### 术语速查（读前扫一眼即可）

本报告尽量说人话，但有些词是这套代码里的正式名字，绕不开。第一次遇到时按这张表理解：

| 词 | 一句话解释 |
|---|---|
| **prompt** | 笼统地指"交给模型的那段内容"。**它不是一个字符串**，而是由好几条消息拼出来的（系统说明 + 历史 + 工具结果……）。本报告在没有特别说明时，"prompt" 就泛指这份输入里"文字性"的那部分 |
| **system prompt** | 消息列表最前面那段"系统角色说明"：你是谁、规则是什么、怎么干活 |
| **messages** | 真正发给 provider 的消息数组，每条带一个角色（system / user / assistant / tool） |
| **Prompt Assembly** | 把这些东西组装成一次模型输入的过程；在 pi 里就是 §4.3 那套整理算法 |
| **prompt template** | 可复用的提示词模板，展开后当成一条用户消息发出去（比如斜杠命令） |
| **Harness** | 包在模型外面、负责"把活干完"的那层程序：管历史、管状态、管工具、管崩溃恢复 |
| **Model Input** | 这一次真正发给模型的东西（system prompt + 历史 + 工具定义 + 上下文……） |
| **Context Assembly / 整理上下文** | 把上面那些零散信息拼成 Model Input 的过程 |
| **execution** | "保证状态不被崩溃/重试/副作用弄坏"这一半问题 |
| **composition** | "决定谁的能力、谁的上下文可以进来"这一半问题 |
| **entry** | 会话树里的一个节点（一条消息、一次压缩摘要……），写进去就不再改 |
| **lane** | 一条可执行的会话支线：有自己的模型配置、队列和当前操作 |
| **operation** | 被接受的一次工作单元（跑一轮 / 压缩 / 跳转） |
| **13 个平铺状态** | pi 文档原话是 `flat 13-leaf union`，指 `state.at` 只能取 13 个值之一，彼此不嵌套。**"leaf（叶子）"是 pi 作者借树结构造的词，不是业界标准术语**；TypeScript 里的正式说法是"联合类型的成员"。详见 §4.7 |
| **facet** | 一个插件在某个运行环境里的那一部分（同一个插件可以有多个 facet） |
| **service** | facet 对外提供的能力，用"带类型的名字"（token）而不是对象引用来引用 |
| **replicated state** | 会实时同步到别的进程/界面的状态（比如进度条） |
| **pass** | 一次"从开始推进到结束"的进程内过程 |
| **effect** | 会对外部世界产生实际影响的操作（调模型、真正执行工具、写文件） |
| **KV cache** | 模型对已经读过的前缀的缓存；在中间插内容会让它全部作废、成本翻倍 |

另外几个中文词，本报告用它们时是这个意思（不是日常口语里的意思）：

| 词 | 在本报告里的意思 |
|---|---|
| **失真** | 模型看到的内容和真实发生过的事**对不上**：少了一条结果、多了一条并不存在的成功、或者顺序错了 |
| **副作用** | 除了返回值之外，还对外部世界造成了改变（写了文件、发了请求、改了数据库记录） |
| **落盘** | 写进持久存储（文件 / 数据库），也就是"重启之后还在" |
| **幂等** | 同一件事重复做多次，效果和只做一次一样（所以可以安全重试） |
| **原子** | 要么整个做完，要么完全没做，不存在"做了一半"的中间状态 |
| **重入** | 进程不在运行时（比如服务端收到一次 HTTP 请求），借这次机会把之前挂起的活继续跑下去 |
| **门面（facade）** | 一个包装过的对象，只暴露"允许你用的那几个方法"，不让你碰到里面的真身 |
| **裸（的某个对象）** | 没被包装的真身。拿到裸对象就意味着可以随便调它的任何方法 |
| **退化** | 从"更精细的做法"退回到"更笨但结果一样"的做法 |
| **收敛** | 不同的说法/机制最后指向同一个问题或同一个结论 |
| **契约** | 双方约定的"长什么样、能做什么"。在本报告里通常指**类型层面的约定**，由编译器而不是由人来检查 |
| **状态机** | 一个对象只能处在有限几个状态之一，并且只能按规定的路径从一个状态走到另一个 |
| **投影 / 整理** | 从一份完整的原始数据里，挑出这次需要的那部分并重新组织。本报告尽量用"整理上下文"这个说法 |

后面出现这些词时，会尽量在第一次用到的地方再用大白话解释一遍。

---

## 再换一个视角：Harness 最终到底在干什么？

不管内部叫 Harness、Agent Loop、Context、System Prompt 还是 Plugin Runtime，最后都绕不过一个问题：

> **下一次调用模型时，究竟应该把什么交给模型？**

这个输入不是一句 prompt。它通常由几部分组成：

```
持久历史
  + 当前运行状态
  + system prompt
  + tools
  + plugin contributions
  + 动态上下文
  + 本轮运行结果
  ↓
Model Input
  ↓
LLM
  ↓
新的 assistant / tool output
  ↓
再次进入下一轮
```

把它摊开，"Model Input" 至少包含这些成分：

| 成分 | 说明 |
|---|---|
| system prompt | 角色、规则、工作方式 |
| conversation / history | 之前的对话与工具结果 |
| tool definitions | 本轮模型能调用的工具 schema |
| tool results | 上一轮工具执行的结果 |
| current runtime state | 当前 lane / 队列 / 权限 / 模式 |
| plugin contributions | 扩展贡献的 prompt 片段、工具、上下文 |
| dynamic context | 随时间变化的运行时上下文 |
| model / provider constraints | 上下文窗口、能力开关、provider 差异 |

因此，理解 Agent Harness，最有效的问题不是"它有多少状态机、多少插件 API"，而是这六个：

1. 这些信息**从哪里来**？
2. **谁决定**哪些信息进入模型上下文？
3. 它们以什么**顺序**进入？
4. 它们什么时候**持久化**？
5. **插件如何修改**它？
6. **崩溃后**如何保证下一次构造出来的上下文仍然正确？

**Pi 和 DeepSeek 给出了两种不同答案。** 本报告后面所有内容，都是围绕这六个问题展开的。

---

## 0. 结论速览

0. **本报告的核心判断**：Agent Harness 本质上是一台"把 Agent 状态编译成模型输入"的运行时编译器，Prompt Assembly 是其中最核心的一步。围绕它有两个问题——**execution**（保证这份状态不会因为崩溃、重试、副作用而变得不准确）与 **composition**（决定哪些能力和上下文可以进入这次编译）。pi2 的答案分别是 `AgentHarness`（§4）与 `Chord`（§7）；DeepSeek Harness 的答案是 Cordis + `system-prompt` 子系统（§9）。
1. **pi2 把"可持久化的 Agent 运行时"从应用层下沉到了核心层**。pi1 的 `pi-agent-core` 只有 `Agent` + `agent-loop` 两个文件；pi2 新增 `AgentHarness`，用「不可变 entry 树 + 可变更的值/列表 + 只追加的用量账本」三种存储，把崩溃后恢复所需要的全部信息都记录了下来。
2. **整个 harness 的设计被一条铁律管着**：*任何一份数据，只能出现在 entry、bound value/list、ledger 这三个地方中的一个，没有第四处*。这条铁律的真正作用不是"数据结构漂亮"，而是**让下一次整理上下文时，能一眼分清哪些是已经发生的事实、哪些只是当前这一次运行的临时状态**——所以 `operationState`（本轮运行状态）永远不会混进 conversation history（对话历史）。
3. **接受（accept）与执行（drive）分离**。`accept` 只把一次操作落盘，不启动任何进程内的工作；`drive` 才真正在进程里跑起来。这让 harness 天然适配"没有常驻调度器的服务端"（定时器、后台任务、HTTP 请求重入都可以）。
4. **所有对外部世界的动作（请求模型、真正调用工具）都被包成"先说要做 → 做完记录结果"两步**，中间任何一步崩溃都能查出来、都能恢复，而且**已经记录过结果的动作绝不会被重放一次**。
5. **Session ≠ Prompt**：Session 是"已经发生的事实"，而 Model Input 里的 **`messages` 是从这些事实里挑出来、重新整理出来的**（`systemPrompt` 与 `tools` 则是每次现算的请求字段，不进入历史，§4.2）。理解这一条，三种存储、上下文挑选、压缩、重放就串成了一条线（§4.2、§4.3）。
6. **execution 问题解决之后，composition 问题浮现**。真实产品不是单进程单界面：TUI / Web / mobile 要同时渲染一个 session，session 要活在长生命周期进程里，插件要能运行时装卸，部分能力必须在另一个进程甚至另一台机器。pi2 的回答是 `chord`——一个**不依赖 Pi 内部任何东西、可以被完全无关的应用拿去复用**的组装运行时（facet / service / replicated state / remote boundary）。
7. **Chord 回答两个核心问题，第二个才是它最有特色的地方**：① 怎么把组件装起来（composition）；② 装起来以后，每个组件允许拿到什么（**capability boundary，能力边界**）。大多数插件系统只认真做第 1 问；Chord 把第 2 问直接做进了 API 的写法里——`setup(env)` 的参数表在**类型层面**就卡死了插件能拿到什么，负责展示的 facet 永远拿不到裸的 Harness / Session / 工具注册表 / 凭据存储。隔离不靠文档约定，而是靠 API 本身卡死。
8. **稳定 CLI 与实验性分布式架构并行存在**：稳定版 `pi` CLI 仍跑 `Agent` + JSONL `SessionManager`；`AgentHarness` + Chord facet/RPC + session worker 只在 `src/experimental/` 与 `packages/{protocol,client,server,chord}` 中启用。这是本仓库当前最重要的"双轨"事实。
9. 代码质量取向极端保守：直连依赖全部 pin 到精确版本、`min-release-age=2`、shrinkwrap 白名单、erasable TypeScript only、`npm run check` 全绿才允许提交。

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

### 1.2 构建顺序是依赖顺序，不是架构分层

`package.json` 的 `build` 脚本显式给出了依赖顺序（谁都不依赖的包先编译）：

```
chord → tui → telemetry → ai → agent → session-backends/sqlite-node
      → protocol → client → server → coding-agent
```

注意三点（⚠️ 先编译 ≠ 架构上更底层）：

- `chord` 被排在**最前**，且 `chord/README.md` 明确声明"它不是 Pi 包，不依赖任何其他 Pi workspace 包"。它是可以被完全无关的应用拿去复用的通用组装运行时。
- `telemetry` 早于 `ai`，说明遥测契约是基础设施，而不是某个功能模块的附带产物。
- `tui` 排第二**仅仅因为它不依赖任何其他包**，不是因为它是底层——它唯一的用户是最顶层的 `coding-agent`，`agent` / `ai` / `server` 都不引用它（详见 §2）。

---

## 2. 分层架构

整体分成两类：一条从上到下、上层依赖下层的**主干**；以及几个不依赖 Pi 内部任何东西、也不属于任何一层的**独立工具库**：

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
独立工具库（不属于任何一层）：
  chord ─ 被 agent / protocol / client / server / coding-agent 引用的
          通用组装运行时（facet / service / replicated state）
  tui   ─ 仅被 coding-agent（interactive 模式）使用的终端 UI 工具库；
          agent / ai / server 都不引用它，它不是任何意义上的"底层"
```

### 2.1 各层职责边界

| 层 | 包 | 核心职责 | 明确不做 |
|---|---|---|---|
| 工具库 | `chord` | facet 生命周期、依赖图校验、service 绑定、replicated state、RPC 边界 | 不认识 Harness / TUI / 业务 |
| 工具库 | `tui` | 差分渲染、CSI 2026 同步输出、原生扩展（仅供产品层调用） | 不被 agent / ai / server 引用，不含任何会话相关逻辑 |
| 遥测 | `telemetry` | 用显式回调传 `TelemetryContext`/`Span`、定义 schema | 不内置任何上报通道（exporter），不依赖"全局当前 span"这种隐式状态 |
| 模型 | `ai` | 统一流式 API、auth 解析、token/cost 统计、延迟句柄（deferred handle）、帧编解码 | 不含 agent 循环 |
| 会话 | `agent` | 持久化 operation 状态机、崩溃恢复、工具执行编排、hooks/events | 不做调度、不做复制 |
| 存储 | `session-backends` | SQLite 原子事务、WAL（预写日志）快照、分支索引 | 不保证 Session 独占所有权 |
| 传输 | `protocol` | 信封校验、CBOR、分帧、版本握手 | 不解析包体内容（由 Chord 负责） |
| 服务端 | `server` | 路由、附件生命周期、worker 托管 | 不实现跨 server 路由 |
| 产品 | `coding-agent` | CLI 交互、扩展加载、工具实现、session 管理、UI | 不做权限系统（README 明示） |

### 2.2 一张图看懂：Application / Chord / Harness / Session 的位置

上表是"包视角"。但理解 pi2 更有效的视角是**运行时视角**——谁负责组装，谁负责执行：

```
┌───────────────────────────────────────────────────────────────────────┐
│  Application                                                          │
│  一个 Agent 产品 = 多个进程 / 多个界面 / 可插拔扩展                     │
├───────────────────────────────────────────────────────────────────────┤
│  Chord   ── composition + boundary ───────────────────────────────────│
│  facet 组装 · service 绑定 · replicated state · remote 边界            │
│  它同时定下两件事：「谁提供什么能力」和「谁被允许拿到什么能力」          │
├──────────────┬────────────────────────────┬───────────────────────────┤
│ Presentation │  Services                  │  Worker                   │
│ TUI / Web /  │  catalogue / binding /     │  session worker           │
│ Mobile / RPC │  subscription / delta      │  （真正持 Harness 的进程） │
├──────────────┴────────────────────────────┴───────────────────────────┤
│  AgentHarness  ── execution + recovery ──────────────────────────────│
│  accept/drive · 13 个平铺状态 · Drive 同时只有一个                     │
├───────────────────────────────────────────────────────────────────────┤
│  Session                                                              │
│  不可变 entry 树 · bound value/list · usage ledger（三存储铁律）        │
└───────────────────────────────────────────────────────────────────────┘
```

读这张图要抓住三点：

1. **Chord 在 Harness 之上，不在其内**。Chord 不认识 Session、Operation、工具；Harness 不认识进程、传输、插件分发。
2. **Presentation 与 Worker 之间没有直连**。所有跨进程调用都经过 Chord 的 service 边界与 server 的路由——这正是"能力边界"落地的地方（§8.4）。
3. **上下两半的时间尺度不同**。Harness/Session 关心"跨崩溃仍然正确"（秒到天）；Chord 关心"运行中怎么组合与替换"（毫秒到秒）。这个差异是两者必须分开的根本原因（§7.10）。

---

## 3. `pi-ai`：Agent Runtime 依赖的模型层（主线外，可跳过）

> 本章**不在 execution → composition 主线上**，只是为了完整性保留。**赶时间可直接跳到 §4。** 这里只留 AgentHarness 真正依赖的几件事。

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

### 3.2 AgentHarness 真正依赖的四件事

| 依赖 | 说明 |
|---|---|
| **`Models` / `ModelRuntime` 双层** | `Models` 是模型注册表 + 流式入口（`createModels()` → `setProvider()` → `getModel()`，无隐式全局注册表）；`ModelRuntime` 负责 auth/凭据组合，供 CLI/SDK 使用 |
| **`AssistantMessageFrame`** | pi2 独有机制：把 provider 流式事件编码成紧凑的**恢复帧**。harness 只负责把它追加到一个有上限的列表里，不重复实现编解码器（`harness.md` §0.7 明确"harness 不定义第二个 frame codec"） |
| **deferred handle（延迟句柄）** | provider 返回"稍后完成"的响应（如长思考任务）时，harness 用 `deferred.suspended ↔ deferred.effect_pending` 这一对状态来跟踪它 |
| **只收录支持 function calling 的模型** | README 明确——agentic 工作流依赖工具调用 |

其余细节（47 个 provider 工厂、codex 订阅通道的独立实现、overflow 检测、旧 API 兼容面）与主线无关，需要时再查源码。

---

## 4. `AgentHarness`：从持久状态到下一次 Model Input

> **这一节回答第一个问题：怎么保证"下一次喂给模型的东西"不会因为崩溃、重试、副作用而失真？**
>
> 读这一节时请记住一个反直觉的事实：**这套机制的目标不是"更快"，而是"不管在哪一步崩溃，都能说清楚崩在哪一步，并且能恢复到正确结果"**。它刻意放弃了写放大（一次逻辑上的改动会被拆成多次实际写盘）、放弃了靠重放日志来恢复、放弃了常驻调度器，换取"任意时刻杀掉进程，重启后结果和没被杀过一样"。这套保证是后面 Chord 能存在**前提**——只有 execution 可靠，"谁有权参与这次编译"才是一个值得讨论的问题。

### 4.1 从 Session 到 Model Input

先看这条链的**全程**。Pi 的每一次 provider 请求，都是从同一份持久事实里挑出来、重新整理出来的：

```
Session（不可变 entry 树 + bound values/lists + ledger）
        │
        ▼
   scanBranch（从 tip 反向扫到 compaction 边界）
        │
        ▼
   compaction boundary（截断点：更早的内容永不读取）
        │
        ▼
   filter（丢弃 error / aborted / deferred 的 assistant 响应）
        │
        ▼
   project（custom entry 过 entryProjectors）
        │
        ▼
   transform_context（hook）
        │
        ▼
   toProviderMessages
        │
        ▼
   messages（从历史整理出来的那部分）
        │
        ▼
   Model Input  ← 还要再加上现算的 systemPrompt / tools（§4.2）
```

本节每一小节都在回答这条链上的一个问题：

| 小节 | 回答的问题 |
|---|---|
| 4.2 Session 是事实来源，不是 Prompt | 事实存在哪？为什么不能直接当 prompt？ |
| 4.3 Context Projection | 从历史里**选出**这一次需要的内容 |
| 4.4 哪些机制只在程序内部 | 上面这些机制，**哪些会变成 prompt 文字，哪些模型根本看不到？** |
| 4.5 Compaction | 历史太长时，如何**重新定义**上下文 |
| 4.6 Tool / Assistant Durability | 模型刚做过的事，下一轮**怎么看到正确结果** |
| 4.7 accept / drive | 为什么"接受任务"和"生成下一轮输入"必须**分开** |
| 4.8 Effect / Replay | 外部世界变了以后，**如何恢复** |
| 4.9 结论 | 为什么它最终是一个**可恢复的 Context Assembly Runtime** |

### 4.2 Session 是事实来源，不是 Prompt

> **Pi 并没有把 Session 当成 Prompt。**
>
> **Session 是"已经发生的事实"；Model Input 则是根据当前 lane 和 provider 的需要，从这些事实里挑出来、重新整理出来的结果。**

这个区分是整个设计的支点：

- **Session 是已经发生的事实（durable truth）** —— 只追加、永不删除、跨崩溃仍然正确；
- **Context 是每次现算的（projection，投影）** —— 每次请求重新算一遍，有大小上限，可以随时丢掉；
- **Prompt 只是其中一部分** —— 真正发给 provider 的 messages，只是这次整理出来的产物之一。

**注意一个容易搞错的细节**：一次 provider 请求实际上是三块东西，来源并不相同（源码见 `agent-loop.ts:296`、`harness/runtime/drive/generation.ts:103`）：

```
Model Input
  ├── messages      ← 从 Session 整理出来的（§4.3 那 5 步）
  ├── systemPrompt  ← 请求字段。来自 lane 配置 / harness options，可以是一个字符串，
  │                    也可以是每次请求现算的函数；transform_context 还能改写它
  └── tools         ← 请求字段。来自工具注册表与当前 lane 的配置
```

**也就是说：只有 `messages` 是从事实历史里整理出来的；`systemPrompt` 和 `tools` 是"每次现算的请求参数"，不进入 Session、也不进入消息历史。** 记住这一点，§9.6 与 DeepSeek 的对照才读得准——两边在这一点上其实是**不同**的做法。

**系统模型**

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

**三存储铁律**

> 原文：**Every payload is in an entry, a bound value/list, or the ledger; there is no third place.**
>
> 意思就是：**任何一份数据，只能待在这三个地方之一，没有第四处。**

| 存储 | 含义 | 什么时候被删 |
|---|---|---|
| `entries` | 会话树，写一次、只追加，放在哪和内容写在同一行 | 永不删除（唯一例外：§2.9 的精确改写） |
| `values` / `lists` | 当前可变的状态；value 可以整个替换，list 只能往后追加或整表删掉 | 由它的 owner 显式清理 |
| `usage ledger` | 成本记录，只追加 | 永不删除 |

**为什么恰好是这三层？** 因为它们在被整理成模型输入时，地位完全不同：

```
entries        = 可以进入长期上下文的「事实」
values / lists = 当前运行的「状态」（大多不会进模型上下文）
usage ledger   = 成本和运行证据（永远不进模型上下文）
```

这三者**不在同一个层次上**。Harness 最终把它们整理成下一次模型调用需要的输入——而正是这条铁律，保证了整理过程能一眼分清"哪些是事实、哪些只是当前运行状态"。

它顺带解释了那些看起来"过度设计"的规则：

- **为什么 `operationState` 不能直接混进 conversation history** —— 它是运行状态，不是事实；混进去会污染上下文（而且它每轮都被覆盖，30 轮下来大约 30 次）。
- **崩溃点是可以列出来的** —— 它只可能发生在两次事务之间，不可能发生在一次事务内部。
- **清理就是删除，不是垃圾回收** —— 30 轮运行会替换 `operationState` 约 30 次，最后删掉它，只留下对话、账本和少量 lane/session 值。
- **恢复不靠"修修补补再重写"** —— 只追加 entry、只替换自己拥有的 value，走的路径和正常执行完全一样，所以"中断后重跑"和"从没中断过"结果一致。

**Bound Typed Address（绑定了类型的地址）**

```ts
const state  = value<ApplicationState>("my-app.state");   // 可替换标量
const events = list<ApplicationEvent>("my-app.events");   // 只追加列表
await session.setValue(state, next, context);
await session.appendList(events, event, context);
```

- `namespace` / `key` 在构造时**绑定一次**，之后每次读写只传地址，不用再传第二把 key。
- 用一个只存在于类型层面的字段 `[storedValueType]?: (value: T) => T` 把 `T` 锁死（invariant），地址不会悄悄变成别的类型。
- `pi` 以及所有 `pi.*` 开头的命名空间留给内建使用；应用自己另建命名空间。
- **没有全局的类型表、没有注册表、也不需要 TypeScript 的声明合并**——应用定义自己的地址就行。
- 只有 5 个前缀构造器（`branchTipInventoryPrefix` 等）可以用于 `scanValues()` 批量扫描，其余一律要用精确地址。

内建地址清单（部分）：

| 地址 | kind | 持久化 namespace/key | 含义 |
|---|---|---|---|
| `branchTip(lane)` | value | `pi.branch.tip` / lane | 该 lane 下次追加的位置 |
| `laneConfig(lane)` | value | `pi.lane.config` / lane | 完整 lane 配置 |
| `laneState(lane)` | value | `pi.lane.state` / lane | current/last op id + inbox |
| `operationMeta(opId)` | value | `pi.op.meta` / opId | 接受时的元数据，只写一次 |
| `operationState(opId)` | value | `pi.op.state` / opId | **本轮运行状态的重启点** |
| `pendingEntry(entryId)` | value | `pi.pending.entry` / entryId | 已落盘但还没放进树里的内容 |
| `pendingToolOutput(op, inv)` | value | `pi.pending.tool_output` / … | 最新的工具进度快照（有大小上限） |
| `pendingAssistantFrames(op, resp)` | list | `pi.pending.assistant_frame` / … | 已经提交的流式帧前缀 |
| `operationResult(opId)` | value | `pi.result` / opId | 不可变的最终结果记录 |

### 4.3 Context Projection：从历史里选出这一次需要的内容

Provider 请求的构造是 5 步**固定算法**（注意"固定"二字——这是与 DeepSeek 的关键差异，§9）：

1. `scanBranch({ start: tip, order: "newestFirst", stopAtType: "compaction" })`
2. 反转；若被 compaction 截断，则上下文 = `summary` + `retainedTail` + 其后所有 entry。**更早的内容永不读取。**
3. 丢弃 stopReason 为 `error` / `aborted` / `deferred` 的 assistant 响应（保留真正的 `length`）。
4. custom entry 会经过 `entryProjectors`，没被整理出来的就不进上下文。
5. `transform_context` → `toProviderMessages`。

**扩展点只有两个半**：`entryProjectors`（决定 custom entry 怎么进上下文）、`transform_context`（决定最终的消息长什么样）、以及 §4.6 的 hooks。**算法本身不可替换**——这是 Pi 的选择：整理路径固定下来，可靠性才有可能被证明。

**只追加的上下文铁律（append-only context invariant）**：同一个 lane 的多次请求，发给 provider 的上下文只允许在末尾往后加——如果在上一请求的末尾之前插入内容，会让 provider 已经算好的 KV cache 全部作废（KV cache：模型对已经读过的前缀的缓存），成本成倍上升。所以运行过程中产生的内容一律推迟到 checkpoint，追加到末尾。**compaction 是唯一一处故意让 cache 失效的地方。**

这条铁律直接限制了上下文的整理：**你不能"想加什么就加什么"**，只能往末尾追加。它让"插件能怎么改上下文"这个问题的答案，收窄成了一个非常保守的集合。

### 4.4 哪些机制只在程序内部，不会出现在 prompt 文字里

读完 §4.1–§4.3 很容易产生一个误解：以为上面讲的每样东西，最后都会变成模型看到的一段文字。

**不是。** 恰恰相反——Pi 里绝大部分机制，模型**完全看不到**。它们只负责"让程序把活干对"，而不负责"往 prompt 里写什么"。真正会出现在 prompt 文字里的，只有很少几类东西。

**判断标准只有一条：**

> **看它最终有没有变成某条 provider message 的"内容"。**
> 只影响"这条消息什么时候产生、按什么顺序排、崩了怎么恢复"的机制，都不会出现在 prompt 里。

#### 表 A：只在程序内部，模型完全看不到

| 机制 | 它管什么 | 为什么模型看不到 |
|---|---|---|
| `operationState` / 13 个平铺状态 | 本轮跑到哪一步了 | 它是"运行状态"，不是"发生过的事实"；每次转移被整份覆盖，且从不写进 entry |
| `usage ledger`（用量账本） | 花了多少 token、多少钱 | 只用于计费和统计，永不进上下文 |
| `branchTip` / `laneConfig` / `laneState` | 下一条追加到哪、lane 怎么配、inbox 里有什么 | 这些是调度信息，不是对话内容 |
| `pendingEntry` / `pendingToolOutput` / `pendingAssistantFrames` | 已落盘但还没归位的中间态 | 只是临时存放，归位之后就删掉 |
| Drive / pass / `gate.admit` | 谁在推进、什么时候才允许真正去调外部 | 纯执行机制 |
| 单写者规则 / 写入串行线 / 数据库事务（`BEGIN IMMEDIATE`） | 并发写入怎么不打架 | 存储层机制 |
| `replay: safe / never` | 崩了以后哪些能重跑 | 只决定"要不要重跑"，模型只看到最终结果 |
| `accept` / `drive` 分离 | "接受任务"和"真正执行"分开 | 调度机制 |
| events / `LaneSnapshot` / `reduceLaneSnapshot` | 客户端怎么收到状态变化 | 这是给界面用的通知，不进模型 |
| telemetry span | 遥测埋点 | 只上报，不参与上下文 |
| Chord：facet 组装 / 依赖图校验 / reload 原子切换 | 组件怎么装起来、怎么换掉 | 都是组装期机制 |
| Chord：service token / 服务绑定 | 谁能拿到什么能力 | 权限与寻址机制 |
| Chord：replicated state / delta tracking | 进度怎么实时同步到界面 | 它明确被定义为"实时视图"，不是对话历史 |
| `pi-protocol`：分帧 / CBOR / 信封 | 字节怎么在两个进程间传 | 传输层 |
| **hook 的"持久性分类"本身** | 决定一个 hook 的输出算不算数 | 分类是机制；只有被分到 transition-consumed 时，它的**输出**才会进上下文 |

#### 表 B：会真的出现在 prompt 文字里

| 东西 | 以什么形式出现 | 由谁决定 |
|---|---|---|
| 对话历史（message entry） | provider messages 里的 user / assistant 条目 | Session + §4.3 那 5 步整理算法 |
| 工具调用与结果 | assistant 的 tool call 条目 + tool 结果条目 | §4.6 的持久化过程 |
| 压缩摘要 | 一条 summary + 保留的尾部 | §4.5 Compaction |
| **system prompt** | 请求的 `systemPrompt` 字段（**不是**消息历史里的一条） | lane 配置 / harness options；可以是每次请求现算的函数，`transform_context` 可改写 |
| **工具定义（tools schema）** | 请求的 `tools` 字段（**不是**消息历史里的一条） | 工具注册表 + 当前 lane 配置 |
| custom entry 被 `entryProjectors` 整理后的内容 | 变成普通消息 | 扩展注册的 projector |
| `transform_context` 改写后的结果 | 最终的 messages **和** systemPrompt | hook |
| 图片 / 附件（如果作为 entry 内容） | 消息里的图片块 | 写入该 entry 的工具或扩展 |
| 运行时状态里**被显式写进 entry 的部分** | 消息文字 | 只有"真的写进 entry"才会出现 |

> 表 B 里只有前三行和最后三行来自 Session；**system prompt 与工具定义是"请求字段"，每次请求现算**，不进入会话历史。这一点在 §9.6 会再次用到。

#### 三组最容易混淆的，单独澄清

**① hook ≠ prompt 内容。**
hook 本身是程序内部的钩子，模型看不到。只有被分到 `transition-consumed` 的那几个（`before_run` / `after_response` / `before_tool` / `after_tool` …），它们的**输出**会跟着持久化一起落盘，从而进入后续所有轮的上下文。而 `before_drive` 是 pass-local 的——它做的事崩了就没了，模型永远看不到。

**② 工具"怎么执行" ≠ 工具"结果是什么"。**
工具跑了几次、并行还是串行、崩了重不重跑、中途的进度快照——模型全都看不到。模型只看到最终写进会话树里的那一条结果；如果这条调用被标成 `replay: "never"` 又在执行中崩了，模型看到的是一条"这条调用被中断了"的错误结果，而不是伪造的成功。

**③ replicated state ≠ 上下文。**
"当前 token 数""正在跑哪个工具""进度 60%"这类实时视图，走的是 Chord 的 replicated state，**明确不进 Session**（§7.5）。所以模型永远看不到进度条。

#### 一句话总结

> **Pi 的绝大部分代码，是在保证"程序内部的状态是对的"，而不是在"写 prompt"。**
>
> 模型最终看到的，只是这条链沉淀下来的少数几类内容（表 B）；表 A 里的东西全是脚手架——它们不产生内容，只保证表 B 里的内容正确、完整、顺序确定。

这也正好回答了阅读指引里那个说法：**把 Harness 叫成"Prompt 拼装器"太窄了**——拼装只是它最后一步的可见产物，前面那一整套（状态机、崩溃恢复、效果准入、并发写入、插件边界）都发生在模型视野之外。

### 4.5 Compaction：当历史太长，如何重新定义上下文

- **compaction 是一份自包含的检查点，不是指向历史的指针**。它不是"从这里往前看"的游标，而是一份完整摘要 + 保留的尾部；整理上下文时读它，而不是读它之前的所有东西。

它在状态机里有一整组状态（`summary.deciding` / `summary.ready` / `summary.effect_pending` / `summary.retry_wait`），因为生成摘要本身就是一次**对外部世界的动作**（要调 provider），必须走"先说要做 → 做完记录结果"这两步。

压缩的产物是 `summary` + `retainedTail`，它**替换**了上下文从哪里开始算——所以压缩既是管理上下文的机制，也是唯一允许让 provider KV cache 失效的地方。

### 4.6 Tool / Assistant Durability：模型刚做过的事，下一轮怎么看到正确结果

模型看到的世界里，工具结果必须**恰好出现一次**。这一节讲 Pi 怎么保证。

**工具执行：先说要做 → 真正执行 → 记录结果**

```
call i: planned
   │  通过准入检查（before_tool / 查表 / 参数校验）
   ▼  TX[ 写 pi.op.tool_args, state = effect_pending{replay} ]
effect_pending
   │  工具 onUpdate(partial, {checkpoint:true})  → TX[ 覆盖 pi.pending.tool_output ]
   ▼  结果落定 + after_tool
   TX[ pi.pending.entry = 最终结果, 删 tool_output, 删 memo, state = outcome_ready ]
outcome_ready
   ▼  从第一个还没完成的源位置开始，按**源码里的先后顺序**写进树里
   TX[ 插入结果 entry（可多个）, 删 pending, 移动 tip, state = completed / 下一 checkpoint ]
```

设计要点：

- **工具完成的先后 ≠ 它们写进树里的先后**。并行跑的工具按完成顺序暂存，但写进树时按 assistant 给出的先后顺序——这既保证了"下一轮模型看到的消息顺序是确定的"，也保证了"崩溃后已完成的结果不会被重放"。
- **checkpoint 由工具自己控制**节奏、去重与大小上界；API 不设通用的字节上限。bash 的实践值：实时更新 100ms、checkpoint 最多每 2s 一次且仅在内容变化时、单次 50KiB。
- **`terminate: true`** 让工具直接结束这一轮 run，不用再来一次 provider 调用——这是"用结构化输出替代一轮对话"的实现方式。
- **invocation memo**（`getMemo`/`setMemo`）是"单次工具调用"范围内的持久键值存储，用于 Flue 风格的命名结果记忆；把结果写进树时会连同这次调用一起删掉。

**Assistant 输出的持久性**：`assistant.ready` / `assistant.effect_pending` / `assistant.retry_wait` 三个状态 + `pendingAssistantFrames` 这个有上限的列表。流式帧被编码成紧凑的恢复帧后追加到该列表；harness 只负责追加，**不重复实现编解码器**（`harness.md` §0.7 明确"harness 不定义第二个 frame codec"）。

**Hooks：三类持久性**

> 先解释一个词：**pass**。它指的是"从 drive 开始，到这一轮推进结束"的这段进程内过程。

| 类别 | 含义 | 例子 |
|---|---|---|
| **pass-local** | 只影响当前这次 pass，不记录 hook 到底跑没跑过 | `before_drive` |
| **request-local** | 只在构造/执行这一次请求期间存在，重试会重跑 | `transform_context`、`before_request`、`before_payload` |
| **transition-consumed** | 输出会跟着后面那次持久化一起写进盘 | `before_run`、`after_response`、`before_tool`、`after_tool`、`before_compaction`、`before_navigation`、`before_run_end` |

11 个 hook 全表见 `harness.md` §5.6。统一规则：

- 按注册顺序执行，后面的 handler 能看到前面已经聚合出来的输出。
- 抛错 → 发 `handler_error`，跳过这个 handler，其余继续。**例外：`before_drive` 出错就直接拒绝整个 pass；`before_tool` 出错就直接挡住这个工具（即 fail-closed，出错时一律走"不许"）。**
- **没有任何 hook 保证全局只跑一次**。会对外部世界产生副作用的操作，必须由扩展自己用稳定的 operation/invocation id 保证重复执行也安全（幂等）。

**这三类持久性，就是"插件能在哪一步影响 Model Input"的精确答案**：

| 类别 | 对 Model Input 的影响 |
|---|---|
| pass-local（`before_drive`） | 只影响这一次进程内 pass，**不持久**——崩了就没了 |
| request-local（`transform_context` / `before_request` / `before_payload`） | 影响这一次请求的输入，**重试会重跑** |
| transition-consumed（`before_run` / `after_response` / `before_tool` / `after_tool` / …） | 输出**随持久转移一起落盘**，因此会进入后续所有轮的上下文 |

**事件、快照与折叠函数**

- **事件只是被动地通知"某个状态已经提交了"**，它永远不会去驱动执行，也不会从持久历史里被重放。
- 事件组：operation（`run_start`…）、terminal/segment（`run_end` / `compaction_end` / `navigation_end`）、suspended/retry、transcript（`message_*` / `entry_added`）、tools/turns、replicated state（`queue_update` / `config_update` / `usage`）、metadata/faults。
- **`queue_update` 是唯一权威的队列事件**（没有 `write_pending`）。
- **`LaneSnapshot` + `reduceLaneSnapshot`**：客户端这个折叠函数是规范的一部分——把快照和自己收到的事件序列折叠在一起，得到下一个快照；遇到 `navigation_end` 时返回 `{ rebase: true }`，客户端调用 `resnapshot()` 重新取一份，而不是重建订阅。
- `watch()` 在写入串行线上抓取一个**一致快照**，然后把之后的事件按顺序暴露出来。

### 4.7 accept / drive：为什么"接受任务"和"生成下一轮输入"必须分开

**四个原语**

| 原语 | 作用 | 关键性质 |
|---|---|---|
| `accept(request)` | 把一次 operation 落盘（meta + 初始状态 + lane.currentId） | 不安装 Drive、不跑 hook、不启动任何对外动作 |
| `drive({operationId})` | 安装/加入一个由 lane 拥有的推进过程 | 第一个调用者并不是 owner，所有调用者都是对等的观察者 |
| `requestAbort(opId)` | **唯一能持久化的取消方式** | 幂等；没有 Drive 时只落盘一个标记 |
| `inspectExecution()` | 一次性报告当前状态和最近的最终状态 | 纯观察，不改任何东西 |

便捷方法（`prompt` / `skill` / `promptFromTemplate` / `compact` / `navigateTree` / `resume` / `abort`）只是在原语之上加了一层**进程内等待策略**，它们产生的历史和直接用原语完全等价、可以在外部复现。**没有 scheduler、没有 reopen 后自动启动、没有隐藏的续跑逻辑。**

**为什么必须分开**：`accept` 只落盘一个 operation——**它记录的是"将要生成下一轮输入"这个事实**，不启动任何进程内工作；`drive` 才安装 pass——**它真正去生成**。这个分离让 harness 不依赖任何调度器：服务端可以用 alarm / job / HTTP 重入来"稍后 drive"，而"下一轮输入该不该生成"这个决定已经持久化了。

**操作状态机：13 个平铺的状态**

> **先把"平铺"这个词说清楚。**
>
> pi 官方文档的原话是 `a flat 13-leaf union`。这里两个词都不算业界标准说法，直接照译会很别扭：
>
> - **flat（平铺）**：这 13 个取值都摆在**同一层**，互相不嵌套；
> - **leaf（叶子）**：作者借用了树结构的说法（叶子节点 = 下面没有子节点），意思是"这个取值下面不再挂别的状态"。
>
> **"叶子状态"不是业界标准术语。** 在 TypeScript 里，它的正式名字是"**联合类型（union）的成员**"，或者叫"**判别式取值**"——说白了就是：`state.at` 这个字段**只能等于下面这 13 个字符串之一**，程序读它来决定"下一步该干什么"。
>
> 本报告统一说"**13 个平铺的状态**"。
>
> 唯一例外：并行工具的批次（`ToolBatch` / `ToolCall`）内部**确实是嵌套的**——每个工具调用自己还有 `planned | effect_pending | outcome_ready | completed` 四个小状态，因为并行的子调用会各自结束、各自落定。

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

**核心规则**：每次状态转移，都用**完整的当前状态**整个覆盖 `operationState(opId)`，绝不依赖上一个状态、绝不重放日志、也绝不靠"少了什么"去猜自己走到哪一步。恢复时直接读 `state.at` 这个字段，按它的值分派到对应的处理过程。

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

**执行、效果准入与单写者**

- **Drive**：由 lane 拥有的、跑在进程内的续跑过程（continuation）。它的全部状态就是 `completion`、`gate`、`context`、`waitForRetry`、`deferredPermits`。
- **单写者规则**：同一时刻只有一个 Drive 能推进顶层状态。inbox 方法只改 inbox 字段，`requestAbort` 只改 control，`close` 只是禁止新的写入进来——因此一个正在运行的 operation，它的身份和 `at` 状态值不可能被并发改掉。唯一的例外是并行工具的子调用（兄弟状态之间确实会竞争）。
- **Session 写入串行线（mutation line）**：一条不带 key 的串行队列。`Session.mutate()` 是回调式的便利封装（保证在 `finally` 里执行 `end()`）。**禁止在这个回调内部再调用公开的写方法**（会把自己排到队尾，死锁）。

### 4.8 Effect / Replay：外部世界变了以后，如何恢复

- **效果准入闸门（effect gate）**：`gate.admit(() => invoke())` 把"检查"和"调用"放在同一个同步表达式里，中间不让出执行权。准备工作必须在 `admit` **之前**做完，否则取消可能在准备期间抢先生效。

```ts
await prepareRequest();                        // 全部准备先做
const admittedContext = withAbortSignal(drive.gate.signal, drive.context);
const stream = drive.gate.admit(() =>         // 检查与调用是同一个同步表达式
  models.streamSimple(model, aiContext, { ...options, signal: admittedContext.abortSignal }),
);
```

- 允许调用 `admit` 的地方是一份**写死的清单**：hook 聚合（每个 hook 用一个 admit 包住整条流水线）、provider 操作、真正的 `tool.execute`、重试定时器的创建。其他代码一律不许调用 `admit`。

**`replay` 策略**：标为 `"safe"` 的调用（读、查询）崩溃后带着持久化的参数重跑；标为 `"never"` 的（删除、写入）则造出一条"被中断"的错误结果（带上最新的 checkpoint 内容 + 明确的警告），**绝不重跑**。

这是**对"下一次模型看到什么"的直接承诺**：读操作可以重跑（结果一样），写操作不能重跑（世界已经变了）——所以写操作崩溃后，模型看到的是"这条调用被中断了"这个**事实**，而不是一条伪造的成功结果。**replay 策略不是性能选项，是上下文正确性的一部分。**

### 4.9 结论：为什么 Pi 的 Harness 最终是一个"可恢复的 Context Assembly Runtime"

**后端：Memory / JSONL / SQLite 同一套一致性测试**

| 后端 | 编码 | 要点 |
|---|---|---|
| Memory | 四张 Map | 一次提交处理一个队列；在所有校验完成之前，不改动任何一张 map |
| JSONL | **文件的角色是"重放 Memory map 的配方"，不是状态本身** | 一次 `commit()` 写一行；数组行表示一次写多条；**末尾那行如果被截断（撕裂），整行丢弃**（数组行则整行元素都丢）；`nextSeq` 记住最高的序号，防止序号被复用 |
| SQLite | `session-backends/sqlite-node` | 每个 Session 一个库（默认）或共享容器；每个写事务必须 `BEGIN IMMEDIATE`；`branch_entries` 是分段的（segment 化）分支索引 |

SQLite 的两个不那么显然的点：

- **必须用 `BEGIN IMMEDIATE`**：用 deferred `BEGIN` 先读后写时，拿到的是读快照；之后要升级成写锁，如果被别的写者抢先，就**一定失败，而且 `busy_timeout` 也救不了**（光等待没法刷新已经过期的快照）。
- **`scanBranch` 必须用 `CROSS JOIN`** 强制 `branch_entries` 当外层循环，否则查询规划器可能从 `entries` 出发，产生 `USE TEMP B-TREE FOR ORDER BY`——测试会直接断言查询计划。

**明确非目标（Non-goals）**

这套设计的克制之处同样重要：

- ❌ 外部效果 exactly-once（hook 副作用必须幂等）
- ❌ provider 流恢复（永不重连 provider 流；committed frames 只用于恢复与重连显示）
- ❌ 多写者（一个 Session 同一时刻只有一个 host 指定的 owner）
- ❌ 工作调度（harness 不创建 alarm、不扫描被遗弃的 session、不承诺 HTTP 回执）
- ❌ 复制（一个 session 只存在于一个地方）
- ❌ 持久化写历史（value 只保留当前值，list 删了就没了）
- ❌ 删除作为运行时特性（entry/usage 永不删除；合规级擦除只能走管理侧的 precise rewrite）

最后一条与"整理上下文"的关系值得点明：**entry 永不删除，意味着"历史事实"永远还能被拿去整理**；而 value 只保留当前值，意味着"运行状态"不会越积越多。两者共同保证：用来整理上下文的输入集合始终是**明确的、不会缺东西的**——不会出现"某条历史没了，所以这一轮上下文和上一轮对不上"。

**实现状态（官方自陈的缺口）**

`harness.md` §0.9 诚实列出了未完成项，值得记录：

| 编号 | 内容 | 状态 |
|---|---|---|
| J1 | JSONL 快照压缩 | 已写进规范，**未实现**（被弃用的字节永不回收） |
| C1 | raw RemoteSession | 规范与已发布产品矛盾，**需决策** |
| R12 | `watchSession` | 抛 `SliceNotImplemented`，唯一的 stub |
| T1 | telemetry | 只启动 tool-hook span；RPC 无 trace 传播 |
| S3 | search | 只有设计，`src/search/index.ts` 骨架与设计冲突 |
| R11 | schema migration | 机制已定，activation-gated，无实际迁移 |
| WP08 | 命名分支 + 流式 fork | 进行中（Slice A） |
| — | SQLite 分支发散 | 未压缩分支上首个发散会 copy O(history)，违背"有界复制"目标 |

**小结**

把 §4 的所有机制放回同一个问题，它们回答的其实是同一件事：

> **下一次 Context Assembly 的输入，怎么保证是正确的？**

| 机制 | 它保证的事 |
|---|---|
| 三存储铁律 | 分清"事实"与"运行状态" |
| Context Projection | 从事实里**选出**这一次要什么 |
| Compaction | 太长时如何**重新定义** |
| Tool / Assistant Durability | 刚发生的事**恰好出现一次**，且顺序确定 |
| accept / drive | "生成输入"这件事本身**也可恢复** |
| Effect / Replay | 世界变了以后，模型看到的是**真相**而不是幻觉 |
| 后端一致性 | 以上全部在三套存储上**等价成立** |

所以更准确的称呼是：

> **`AgentHarness` 是一个"可恢复的 Context Assembly Runtime"——它的首要产物不是"执行了任务"，而是"每一次都给模型一个正确、可复现、可恢复的 Model Input"。**

---

## 5. `coding-agent`：终端 harness 产品层

> 这一节是 execution 与 composition 之间的**过渡**。`coding-agent` 是今天的稳定产品形态——单进程、单界面、进程内扩展。它同时给出了两个信号：**（a）** 稳定产品线暂时不需要 Chord；**（b）** 扩展系统已经出现了"多来源、可装卸、需隔离"的苗头，这正是 composition 问题的第一道裂缝。

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

### 5.5 system prompt 是怎么拼出来的

§4.2 说过：`systemPrompt` 是**请求字段**，每次请求现算。那它到底是谁算的？答案是**产品层的一个纯函数**。

`packages/coding-agent/src/core/system-prompt.ts`（168 行）只有一件事：`buildSystemPrompt(options)` —— **参数进，一个字符串出**。没有模板引擎、没有注册表、没有插件 section。

**默认模板的拼装顺序**（`buildSystemPrompt` 默认分支）：

```
① 固定开头模板
     "You are an expert coding assistant operating inside pi …"
     + Available tools（只列"提供了一行说明"的工具）
     + Guidelines（按当前可用工具动态生成，去重）
     + pi 自己的文档路径指引
② appendSystemPrompt（追加一段）
③ <project_context> 块
     每个 context file（AGENTS.md / CLAUDE.md 之类）包成
     <project_instructions path="…"> … </project_instructions>
④ skills（用 formatSkillsForPrompt；仅当 read / bash 可用时才加）
⑤ 末尾一行 Current working directory: <cwd>
```

几个具体的设计点：

- **Guidelines 是按工具动态生成的**。比如有 `bash` 但没有 `grep` / `find` / `ls` 时，会自动加一条"用 bash 做文件查找"；`promptGuidelines` 可以再追加，最后固定两条：`Be concise in your responses`、`Show file paths clearly when working with files`。
- **工具列表只显示"给了一行说明"的工具**（`toolSnippets`）。工具真的能被调用是一回事，**在 prompt 里被介绍**是另一回事——这两件事在 pi 里是分开的。
- **`customPrompt` 会整段替换默认模板**（只保留 append + project_context + skills + cwd）。
- 算好的字符串由 `agent-session.ts` 赋给 `agent.state.systemPrompt`；扩展可以在 hook 里返回一个新的 `systemPrompt` 覆盖它（`agent-session.ts:1307-1313`）。

**和 DeepSeek 的对照可以先记一句**：pi 这边是"**一个纯函数 + 一组 options**"，dsh 那边是"**一个可注册、可排序、可拦截的 section 注册表 + waterfall 事件**"（§9.6）。同样是"现算"，一个走函数，一个走运行时对象。

### 5.6 扩展系统

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

### 5.7 Skills / Prompt Templates / Themes / Pi Packages

- **Skills**：实现 [Agent Skills 标准](https://agentskills.io/specification)，但有意放宽"name 必须等于目录名"这一条（理由是共享 skill 目录场景）。渐进式披露——只有 name/description 常驻上下文，完整 `SKILL.md` 按需 `read` 加载。可从 `~/.claude/skills`、`~/.codex/skills` 直接复用其他 harness 的 skill。
- **Prompt templates**：斜杠命令展开的复用提示词。
- **Pi Packages**：把扩展/skill/提示词/主题打包，经 npm 或 git 分发（`pi install npm:@foo/bar@1.0.0`）。
- **Themes**：内置 + 自定义终端主题。

### 5.8 Evals

`packages/evals` 把真实 `AgentSession` 适配到 `vitest-evals`，在隔离的临时项目/agent 目录中运行，附带原生 session 产物。用途是**度量端到端行为并对比 prompt / 工具 / skill / 模型 / harness 配置**——而不是跑单元测试。

```bash
npm run eval -- src/extensions.eval.ts src/models.eval.ts --provider openai --model gpt-5.6-sol --repetitions 5
```

---

## 6. 问题二 · Composition：为什么单进程 harness 不够

> **这一节铺平 Chord 所在的问题空间。** 上一节结束时，我们有了一个能在崩溃、重试、并发下可靠执行的单 lane 内核——但它默认"整个应用就是一个进程、一个界面、扩展都在进程内"。真实产品不是这样。

### 6.1 场景：一个 Agent 产品的真实形状

假设这个 Agent 产品要同时满足五件事：

1. **多个界面**：终端 TUI、浏览器 Web UI、移动端、脚本/CI 的 headless 调用——它们都要**看着同一个 session**。
2. **session 必须活得比界面久**：关掉 TUI 再打开，任务应该还在跑。
3. **能力必须能跨进程**：工具执行、凭据、模型调用可能需要放在专门的进程里（隔离、权限、资源）。
4. **插件由第三方编写**：要能运行时装卸、能热替换、能不残留副作用。
5. **部分能力在远端**：另一台机器、另一个运行时环境。

把它画出来：

```
        Presentation                     Composition                  Execution
        ────────────                     ───────────                  ─────────
   ┌── TUI 终端界面 ──┐
   ├── Web 浏览器  ───┤              谁提供服务？
   ├── Mobile App  ───┤              谁需要服务？                ┌──────────────────┐
   ├── RPC / 脚本  ───┼──────────►   服务现在在哪？      ◄──────  │  AgentHarness    │
   └── CI / headless ┘              服务断了怎么办？              │  单 lane 持久化   │
                                    服务能否被远程调用？          │  执行 + 崩溃恢复  │
                                    状态怎么同步？                └──────────────────┘
                                    模块升级怎么切换？                     │
                                    模块卸载时怎么清理？                   ▼
                                          │                        ┌───────────┐
                                          ▼                        │  Session  │
                                    ┌───────────┐                  │  三存储    │
                                    │   Chord   │                  └───────────┘
                                    └───────────┘
                                          │
                    ┌─────────────────────┼─────────────────────┐
                    ▼                     ▼                     ▼
             session worker           server 进程         presentation 进程
             （真正持 Harness）        （路由 / 附件）      （只渲染，无 agent 状态）
```

### 6.2 组合问题的清单

上图的左半边，逐条拆开就是 Chord 要回答的问题。注意它们**没有一个是"谁创建谁"**：

| # | 问题 | 传统 DI 能回答吗 |
|---|---|---|
| 1 | 谁提供服务、谁需要服务？ | ✅ 能 |
| 2 | 服务现在**在哪个进程 / 哪台机器**？ | ❌ 不能 |
| 3 | 服务**断开**了怎么办？消费者要不要自己写重连？ | ❌ 不能 |
| 4 | 服务**能不能被远程调用**？契约怎么保证？ | ❌ 不能 |
| 5 | 服务**状态怎么同步**给远端消费者？ | ❌ 不能 |
| 6 | 模块**升级**时怎么切换，切换期间消费者会不会看到"服务消失"？ | ❌ 不能 |
| 7 | 模块**卸载**时它注册的东西怎么清理干净？ | ⚠️ 部分 |
| 8 | 一个功能需要**同时跑在多个环境**（worker / TUI / browser），怎么组织？ | ❌ 不能 |

没有这层基础设施会怎样？**每个团队自己搞 RPC、自己搞插件加载、自己搞状态同步、自己搞生命周期**——然后这四套东西互相不知道对方存在。这就是 pi2 在实验性架构里要回答的问题，也是 `chord` 这个包存在的全部理由。

### 6.3 pi2 给出的答案：三层职责

```
┌─ facet kernel ─────────────────────────────────────────────┐
│ 同步 setup、依赖图校验、本地/远端 service 绑定、激活、        │
│ 按作用域归属的资源所有权、setup 失败时清理、reload、          │
│ 按相反顺序销毁                                               │
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

### 6.4 协议层：Chord 之外的那一半

`pi-protocol` v8：

- 版本握手识别逻辑 `serverId`
- 显式 server / Session 请求目标：`{ serverId }` 或 `{ serverId, sessionId, attachmentId }`
- 带关联的请求/响应，包体是不透明的 strict-JSON
- 请求取消、不透明订阅更新、带外 attachment 变更
- **分帧**：4 字节大端长度 + 一个定长 CBOR 数据项；解码器接受任意的流式分片与合并
- 明确不做：peer 鉴权、trace 传播

`pi-protocol` 只校验"是 strict JSON"，**不校验也不导出 Chord 语法**——语义校验在 Chord service adapter 边界完成。这个切分很干净：**协议管字节，Chord 管语义**（§7.6 展开）。

### 6.5 `experimental/mini`：最小可用分布式 harness

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

### 6.6 `experimental/services`：实验性服务切片

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

关键约束（**本报告最重要的一条约束**）：

> **presentation facet 永远拿不到裸的 Harness / Session / tool registry / hook registry / 凭据存储 / storage handle**——只能拿到定义了明确含义的 service 与 replicated state。

这条约束不是靠文档约定维持的，是靠 Chord 的 API 形状在类型层面卡死的。它是 §8.4 的主题。

### 6.7 `experimental/pico`（v3 设计）

`packages/agent/docs/pico-v3.md`（2113 行）+ `pico-usage-guide.md` 描述的是 harness 的**下一步重构方向**：把内建 agent 行为从"固定调度状态机"改为"由 task 组合"。

```
                    ┌─ tool A ─┐
generation ──────────┼─ tool B ─┼─ post_tools ─ generation
                    └─ tool C ─┘

替换一个 task 定义 → 改变该行为 → 保留 scheduler 与 storage
```

Scheduler 只懂 task 生命周期、依赖、时序、取消；不懂 prompt、工具参数、摘要。Storage 只懂存储对象与原子变更，不懂 task 行为。这与当前 `harness.md` 的"直接 async 过程 + 13 个平铺状态"形成对照——**pico 是"从状态机走向可替换任务图"的演进路线**。文档明确标注为"Design under discussion"。

### 6.8 收束：Agent Harness 的本质，是构造下一次 Model Input

把 §6 的所有问题再往上抽一层。Agent 的工作永远是同一个循环：

```
State
  ↓
Context Assembly        ← 把当前状态编译成模型能读的输入
  ↓
Model Input
  ↓
LLM
  ↓
Tool / Assistant Output
  ↓
State
  ↺
```

所以：

> **Agent Harness 的本质，不是"跑一个循环"，而是"每一轮都把 Agent State 编译成下一次 Model Input"。**

于是 Pi 和 DeepSeek 的真正区别就浮出来了：

> **不是有没有 Agent Loop，也不是有没有 Plugin，而是 Context Assembly 的控制权在哪里。**

| | 谁控制 Model Input 的构造 |
|---|---|
| **Pi** | Harness 控制**核心 assembly**（§4.3 那条 5 步固定算法）；Chord 控制**外部 composition**（谁有资格贡献 service / state / hook） |
| **DeepSeek** | Cordis 控制 **plugin composition**；agent loop / prompt / tools 本身也参与 composition（§9 详述） |

这正是 §7 要展开的东西：

> **Chord 决定"谁有资格参与 Context Assembly，以及以什么能力参与"。**

---

## 7. Chord：谁可以参与 Agent Runtime 的组合

> §6 已经把问题空间铺平。现在展开答案。
>
> 一句话预告全章：**Chord 交付的不是"依赖注入"，而是"能力边界"**——它同时定下"谁提供什么能力"和"谁被允许拿到什么能力"（§7.2 的两个核心问题）。理解这一点的关键，是看清 `setup(env)` 这个参数表到底给了插件什么、又刻意不给什么（§7.3、§8.4）。
>
> 用 §6.8 的话说：**Chord 决定谁有资格参与 Context Assembly，以及以什么能力参与。** 它不是"让插件能改 prompt"，而是"让插件通过受控的 service / state / hook 参与，而不是绕过 assembly 直接改模型看到的世界"。
>
> **阅读约定**：本章每个概念分两层——先用现实问题把它讲清楚，再用 `#### 实现细节` 展开 API / 源码。**第一次读可以跳过所有"实现细节"，只跟主线走**（7.1 → 7.2 → 7.3 → 7.4 → 7.5 → 7.6 → 7.7 → 7.8 → 7.9 → 7.10）；第二次再回来看细节。§7.9 是本章的总结图。

### 7.1 为什么需要 Chord

先用一个具体场景把它逼出来。

```
假设 Agent 已经在 worker 进程里跑起来了。

现在又来了三个需求：

- TUI 要显示当前执行进度；
- RPC client 要远程发起一次 run；
- 插件要注册一个新的 service。

最简单的办法，是把 Session / Harness / tool registry
直接暴露给它们。

但这样很快会出问题：

  TUI 拿到了 Harness，就能碰内部状态；
  插件拿到了 tool registry，就绕过 service 边界；
  RPC 要跨进程，又不能直接传对象。

所以问题已经不是"Agent 怎么执行"，
而是：

  一个已经可靠运行的 Agent，如何被拆开、连接、扩展，
  同时不把内部能力全部暴露出去？
```

**Chord 解决的就是这个问题。** 把 §6.2 的清单倒过来读，就是它的存在理由。三个层面：

**第一层：execution 问题解决了，但它只解决了一个进程内的一条 lane。**
`AgentHarness` 的语义边界非常清楚——一个 Session、一条 lane、一个 owner、不做复制、不做调度（§4.9 的非目标清单）。这不是缺陷，是刻意的克制。但真实产品要把这条 lane 暴露给多个界面、放进一个长生命周期进程、允许第三方扩展它。这些**全都在 Harness 的语义边界之外**。

**第二层：跨进程的"能力组合"缺少一层通用设施。**
如果没有它，每个团队会各自发明：一套 RPC 约定、一套插件加载器、一套状态同步、一套生命周期管理。这四套东西彼此不知道对方存在，且都无法被复用。Chord 的定位就是把这四件事收进一个**通用、可被无关应用复用**的运行时。

**第三层（也是最关键的）：组合的同时必须划定边界。**
这是 pi2 与"通用插件框架"最不一样的地方。pi2 的目标不是"让插件能做更多事"，而是**让插件只能做被允许的事**：presentation 插件要能渲染 session、能发命令，但**不能**直接读凭据、不能直接跑工具、不能直接碰 Harness 内部状态。这个边界必须在**类型层面**成立，而不是靠代码评审。

> 所以 Chord 不是为了"更灵活"，而是为了"灵活的同时仍然可治理"。

### 7.2 一句话理解 Chord

**Chord 是"把一个应用拆成多个进程/环境中的插件，并用类型化服务把它们再组装起来"的通用运行时。**

它不认识 Harness、TUI、Session、工具——只认识 facet、service、replicated state 和字节边界。

但它其实回答了**两个**核心问题，而不只是一个：

```
Chord 有两个核心问题：

1. 怎么把组件装起来？              → composition
2. 装起来以后，每个组件能拿到什么？  → capability boundary
```

所以更完整的定义是：

> **Chord 不只是一个 application composition runtime，它同时是一个 capability boundary runtime。**

这两句话里，**第二句才是本报告认为最有价值的观察**。大多数"插件系统"只认真解决第 1 问——让插件能挂上去；至于挂上去之后插件能伸手拿到什么，通常靠文档约定和代码评审。Chord 把第 2 问做进了 API 形状（§7.3 的 `setup(env)`、§8.4）。第 1 问是它和 Cordis 相似的地方，第 2 问是它和 Cordis 分道的地方。

身份特征（均有源码实证）：

- **零 Pi 内依赖**：`packages/chord/package.json` 的 dependencies 无任何 `@earendil-works/*`；README 原话"it is not a Pi package … can be used by unrelated applications"。这也是它排在构建第一位的原因。
- **保留命名空间**：Chord 自有标识用 `chord.*`，保留 service 前缀 `$chord.*`；`defineService()` 对 `$chord.` 开头的 id 直接抛错（`src/api.ts:80`：`Service IDs beginning with $chord. are reserved`）。
- **分路径导出**：包根（tokens/hosts/state）、`/context`（`Context` 等通用名特意不污染根 API）、`/delta`（独立 delta 原语）、`/node`（仅 Node 的 bundle loader）、`/bundler`（esbuild 打包）。调用方按需 import，不是一锅端。
- **体量**：`src/services/` + `delta` + `context` + `node/bundle` 约 3700 行，`facets/host.ts`（FacetKernel）906 行，10 个测试文件。不是小工具，是完整子系统。

### 7.3 Facet：一个组件怎么加入系统

**Facet 是"一个插件的不同侧面"。** 这是 Chord 里最容易把人搞晕的词，但它其实非常简单。

一个插件可能需要在不同地方运行。例如：

```
GitHub Plugin
├── Worker 部分      → GitHub API 调用
├── Web UI 部分      → GitHub 页面组件
└── Backend 部分     → Token / 数据服务
```

这三部分就是三个 facet。

> **Plugin = 一个完整功能；Facet = 这个功能在不同运行环境里的那一部分。**

把三者放在一起看，关系就清楚了：

```
Plugin   = 我想提供的完整功能
Facet    = 这个功能在某个运行环境里的具体部分
Service  = Facet 对外暴露的能力
```

一句话串起来：

> **Facet 是"东西住在哪里"，Service 是"它对外能做什么"。**

回到 §2.2 那张主图：图里的 **Presentation** 与 **Worker** 就是不同 facet 所在的环境——同一个插件可以在这两处各有一个 facet，各自只做本地能做的事，彼此通过 Service 说话。

为什么不直接叫 Plugin？因为普通 Plugin 默认"加载进当前程序"，而 Chord 想做的是"**同一个功能可以拆到多个环境**"。这时候单纯叫 Plugin 已经表达不了了。

#### 实现细节

数据结构极简：

```ts
interface Facet {
  readonly id: string;
  setup(env: FacetEnvironment): void;   // 必须是同步的
}
```

`setup(env)` 的完整动词表（`src/types.ts:206-224`）：

| 方法 | 作用 | 只能在哪个阶段调用 |
|---|---|---|
| `use<T>(service)` | 硬依赖一个单例，拿到一个稳定的门面对象（facade） | setup 期声明 |
| `observe<T>(service, handler)` | 订阅"按 key 区分的实例"的出现/变化 | **仅 setup 期** |
| `provide<T>(service, impl)` | 安装单例实现 | setup 期 |
| `provideMany<T>(service)` | 拿到 `ServiceSpawner`，按 key 动态产生实例 | setup 期 |
| `replicatedState<T>(initial)` | 创建一份可发布的状态（**按 facet 各创建一份**） | setup 期 |
| `own(disposal)` | 托管一个清理函数 | setup 期 / active 期 |
| `onActivate(cb)` / `onDeactivate(cb)` | 异步初始化 / 退役回调 | **仅 setup 期** |

两个设计决定值得单独说：

1. **`setup` 必须同步。** 因为 FacetHost 要先收齐**所有** facet 的声明，才能一次性校验完整依赖图（§7.7）。如果 setup 可以 `await`，一个 facet 就无法确定性地声明自己完整的形状——"先验证后绑定"就做不到了。**异步初始化一律推迟到 `onActivate()`。**
2. **`env.replicatedState` 是按 facet 各创建一份的。** 这意味着这份状态的**生产者身份天然绑定到 facet 的生命周期**——facet 退役，它发布的状态自然就没有生产者了。这是一个很干净的归属关系。

阶段守卫是硬性的，违规直接抛错，而不是变成未定义行为：

```
setup → assembling → connecting → activating → active
   ↳ reloading（热替换）/ disposing → dead
```

- `observe` / `onActivate` 只能在 setup 期；
- `own` 可在 setup / active 期；
- service 句柄只能在 active 期使用，销毁时收回。

### 7.4 Service：组件如何向 Context Assembly 提供能力

先回答一个更基本的问题：**为什么不直接传对象？**

```
普通设计：

TUI ──► models 对象

问题：
- TUI 拿到了真实实现
- 很难跨进程
- 生命周期由调用方自己猜
- 没法明确限制它能看到什么

Chord：

TUI ──► Models Service ──► 当前实现 / 远端实现
```

> 如果你熟悉 NestJS，可以先把 Chord 理解成"**DI 的远亲**"：它也有依赖和 service，但它进一步解决了生命周期、跨进程 binding、状态复制和动态替换。所以它关心的不是"对象怎么注进去"，而是"**能力在哪、由谁提供、什么时候存在、谁可以拿到**"。

这就是为什么 Chord 用的是 token 而不是对象引用：**Service 就是一个带类型的稳定标识（token）。** 定义方式只有一行：

```ts
export interface Models {
  readonly state: ReplicatedState<ModelsState>;
  cycleThinking(context: Context): Promise<void>;
  refresh(context: Context): Promise<void>;
  select(model: ModelRef, context: Context): Promise<void>;
}
export const Models = defineService<Models>("pi.models");
```

`defineService` 把"接口类型"和"稳定 id"绑在一行里。TUI 拿到的是这个 **token**，不是那个对象；背后是本地实现还是远端实现，由 Chord 在绑定期决定。回到 §2.2 主图：Presentation 与 Worker 之间**没有直连线**——Service 就是中间那道能力契约。
**把 Service 放回 §6.8 的编译链看**，它扮演的角色就清楚了：

```
TUI
  ↓
AgentController Service          ← 一道能力契约
  ↓
Worker
  ↓
Harness
  ↓
Context Assembly                 ← 真正构造 Model Input 的地方
```

关键点：**插件不是直接改 prompt 字符串**。它只能：

```
Plugin
  ↓  提供 Service / State / Hook
Harness / composition layer
  ↓
构造 Model Input
```

这条路径是**间接的、受控的、可审计的**。插件想让模型看到新东西，不能往 prompt 里塞字符串，而必须让某个 service 或 hook 在 assembly 时把它带进去——而这正是"能力边界"要保护的东西（§8.4）。

#### 实现细节

四个维度：

| 维度 | 取值 | 含义 |
|---|---|---|
| **模式** | `singleton` | 一对一：一个 provider，所有 consumer 共享同一份 |
| | `keyed` | 一对多：按 key 动态产生实例，consumer 用 `observe` 订阅 |
| **可见性** | 进程内 | 可以用**任意 JS 契约**（函数、类实例、闭包都行） |
| | 远端可暴露 | **必须满足 strict-JSON 契约**（`RemoteServiceContract`） |
| **契约** | 类型化 | token 的泛型参数就是契约本身，在编译期检查 |
| **生命周期** | 稳定的门面 | provider 断开或被替换时，**consumer 手里的句柄仍然有效** |

⚠️ 一处**规格与实现的落差**：`src/types.ts:60` 定义 `ServiceMode = "singleton" | "keyed"`；而更晚的规格文档 `facets.md` 里已经出现 `"singleton" | "keyed" | "peer"` 三态。**`peer` 目前只是设计，未落地。**

命名惯例（实验性代码中的实际用法）：

| 前缀 | 含义 | 例子 |
|---|---|---|
| `pi.*` | 可远端暴露（strict JSON） | `pi.models`、`pi.session-directory`、`pi.agent-controller` |
| `pi.local.*` | `{ local: true }`，纯进程内，任意 JS 契约 | `pi.local.presentation-ui` |
| `$chord.*` | **保留**，应用禁用（`defineService` 直接抛错） | `$chord.service`（wire 层控制通道） |

最后一行值得展开：`$chord.service` 是 Chord 自己在 wire 层用的**控制通道 id**（`src/services/wire.ts:39`），承载 catalogue / subscribe / unsubscribe 三类控制调用（§7.6）。把它标为保留前缀，是为了让应用的 service 命名空间与控制通道永远不冲突。

### 7.5 Replicated State：状态如何进入其他运行环境

问题：session worker 里正在跑一个任务，TUI 想实时显示"当前 token 数 / 正在执行哪个工具 / 进度 60%"。这个状态**不该进 Session**（它不是对话历史，是易变的实时视图），也**不该由 TUI 自己轮询**（那要重新发明一套同步协议）。

回到 §2.2 主图：图里 **Worker → Presentation** 那条实时状态传播，就是 replicated state。

Chord 的答案：

```ts
const status = env.replicatedState({ output: "", count: 0 });
status.state.output += "done\n";     // 改 tracked proxy
status.state.count += 1;
status.publish(context);             // 发布一次
```

- **生产者**修改被追踪的 `state` 代理对象，然后调 `publish(context)`；
- **消费者**收到的是一份**完整的不可变值**，不需要理解增量；
- Chord 每次 publish 会把一批编码后的操作（delta）发出去，每个"远端 client ↔ state"配对都有**自己独立的路径编码状态**；
- 副本在断开或被替换后进入 **unready**（未就绪）状态，直到重新灌完数据（rehydrate）为止。

#### 实现细节：Delta tracking

**Delta tracking** 是它的底座（`/delta` 可以独立使用）：

| 特性 | 说明 |
|---|---|
| 首次 flush | 永远是**完整的基础批次**（消费者不需要事先知道任何状态） |
| 后续 flush | 基于路径的增量变更（path-based changes） |
| 字符串优化 | 纯追加、以及"滚动窗口式地从头部截断"这两种情况能保持增量语义；其余情况退化成整值替换（set） |
| durable base batch | 支持把基线持久化 |
| 不信任输入 | 应用不可信的操作时**会做校验** |
| 不保留变更历史 | 不存变更日志，而是在 flush 时从被追踪的普通 JSON 现推 |

独立用法示例：

```ts
import { apply, track } from "@earendil-works/chord/delta";

const changes = track({ output: "", count: 0 });
changes.flush();                    // 打开发布用的基础批次
changes.state.output += "done\n";
changes.state.count += 1;

const ops = changes.flush();
const replica = apply({ output: "", count: 0 }, ops);
```

一个必须点明的设计后果：**pi2 因此出现了"两套 state"**。

| | Durable State（持久状态） | Live Distributed State（实时分发状态） |
|---|---|---|
| 存在哪 | Session（entry 树 / bound value / ledger） | Chord replicated state |
| 性质 | 跨崩溃仍然正确，永不删除 | 进程活着期间有效，断开即 unready |
| 时间尺度 | 秒 → 天 | 毫秒 → 秒 |
| 消费者 | 恢复逻辑、整理上下文 | 界面、其他进程 |
| 谁负责 | `AgentHarness` | `Chord` |

**这个区分是理解 pi2 的关键之一**：把实时视图塞进 Session 会污染持久化语义（并且每次进度更新都要落盘）；把对话历史塞进 replicated state 会在崩溃后丢失。两者必须分开。

### 7.6 Remote Boundary：这些能力怎么跨进程

回到 §2.2 主图：**Presentation 与 Worker 之间那条横线**，就是这道边界。它必须存在，否则 TUI 就又能直接碰 Harness 了。

跨进程调用需要一套 wire 语法。Chord 的选择是**只定语法，不定传输**。

Chord 拥有的（与具体传输方式无关）：

| 组成 | 内容 |
|---|---|
| 控制调用 | `$chord.service` 上的 catalogue / subscribe / unsubscribe（`createServiceCatalogueCall()` / `createServiceSubscribeCall()` / `createServiceUnsubscribeCall()`） |
| 端点处理 | `createRemoteServiceEndpoint()` 处理这些调用，含订阅的激活与清理 |
| 语义解析 | `parseServiceCall()` / `parseServiceCatalogue()` + 解码后的 snapshot / update 解析器 |
| 错误 | `RemoteServiceErrorCode` / `REMOTE_SERVICE_ERROR_CODES`（跨边界的稳定错误码） |
| 编解码 | provider 侧 `createServiceStateEncoder()`，consumer 侧 `createServiceStateDecoder()`，每个订阅一对 |
| 类型工具 | `JsonRepresentation<T>`（为来源未知的包体推导出"能安全序列化"的类型）、`isJsonValue()`（在 adapter 边界校验收到的值） |

Chord **不**拥有（应用方自理）：

- framing、routing、transport
- 外层 wire envelope
- 版本握手、鉴权

应用可以把这些值放进**任意** routing / request / response / event 信封——Chord 不规定那个外层协议。在 pi2 里，这个"应用方"就是 `pi-protocol`（§6.4）。

这个切分很干净：**`pi-protocol` 校验"是 strict JSON"，Chord 在校验完的字节上做语义校验。** 两层各管一件事，互不越界。

> 规格里还提到 **symmetric RPC peers**（对称 RPC 对等方）作为这个边界的一种可选实现——目前是 planned，不是已实现。

### 7.7 FacetHost：系统怎么把这些组件装起来

回到 §2.2 主图：FacetHost 就是"**把组件装起来**"那一步的实现——图里 Presentation 与 Worker 各自都有一个 FacetHost，各自只装为本进程构建的 facet。

```ts
const host = await createFacetHost({
  facets,                    // 要装的 facet 列表
  serviceSources,            // 可选的远端 service 来源
  onError,                   // 可选错误回调
});

host.services                // RemoteServiceProvider —— 对外唯一句柄
await host.reload(newFacets) // 热替换
await host.dispose()         // 退役
```

**先验证后绑定**是核心流程：

```
① 全部 facet setup() 完成        （只声明，不绑定）
        ▼
② 统一校验完整依赖图             （缺 provider / 循环依赖 → 此时报错）
        ▼
③ provider 先于 consumer 激活    （保证 consumer 激活时依赖已就绪）
        ▼
④ 按依赖的相反顺序销毁           （consumer 先走，provider 后走）
```

补充细节：

- **setup 失败要清理已经分配的资源**——不能留下一个半初始化的世界。
- `host.services` 是**唯一对外的句柄**，类型是 `RemoteServiceProvider`。应用拿不到 facet 列表、拿不到 kernel 内部结构。
- **FacetLoader** 是加载抽象：`load(): Promise<LoadedFacets>`。提供 `createStaticFacetLoader()`（内置 facet）与 `combineFacetLoaders()`（组合多个来源）。

这套流程的直接效果：**依赖缺失或成环是启动期错误，不是运行期惊喜。**

### 7.8 Plugin Reload：运行中的组件怎么替换

替换一个正在服务的插件，难点是"替换期间 consumer 会不会看到服务消失"。Chord 的答案是**三段式**（`worker.ts:84-103` 的 `reloadPlugins`，用串行 `reloadTail` 保证不并发）：

```
candidate = await pluginLoader.load()
await facetHost.reload(candidate.facets)   // 失败 → dispose candidate，抛错
retired   = loadedPlugins; loadedPlugins = candidate
await retired.dispose()                    // 成功之后才退役老的
```

关键性质：

| 性质 | 说明 |
|---|---|
| **候选先激活** | 新 facet 在**老 provider 仍在提供服务**的状态下完成激活与校验 |
| **原子切换** | 校验通过后单例直接替换——普通 reload 下，**稳定的 service 句柄不会经历一段"用不了"的空窗** |
| **keyed 例外** | 按 key 的实例是"每一代各一份"的，替换后拿到的是**全新一代（fresh generation）**（旧实例的订阅者要重新灌数据） |
| **失败即回滚** | reload 抛错 → 销毁候选，老 provider 完全不动 |
| **形状保持** | 允许按 `Facet.id` 做"形状不变"的替换，前提是新 facet 声明了**完全相同的 manifest（清单）** |

最后一条有个重要细节（`facets.md`）：因为 manifest 是**静态**的，这个检查发生在**构造候选之前**——比"跑一遍 setup 看形状对不对"好得多。结构性变更则需要重装依赖图或重启进程。

**插件分发链**（bundler → manifest → loader，`README:124-204`）：

```
TS/ESM 入口
   │  @earendil-works/chord/bundler（esbuild）
   ▼
按内容寻址的独立 .cjs + chord-facets.json
   │   peerDeps 外部化；从不安装依赖、不跑 lifecycle 脚本
   ▼
createFacetBundleLoader（Node-only）
   │   每次 load() 验 SHA-256
   │   用 node:vm 直接编译（不进模块缓存）
   │   dispose 退役这一代之后，编译产物就可以被 GC 回收
   ▼
输出目录：先写临时目录 → 原子替换（loader 永远看不到半成品）
```

`package.json` 里用 `chord.facets` 声明 facet 入口映射，值为 `worker` / `presentation` / `false`（`false` 表示在该环境禁用）。

**为什么是"拆掉消费者"而不是"代理换实现"？**

`facets.md` §13.1（"Teardown, not swapping"）专门论证了这一点，值得引用：Chord 拒绝"给每个依赖方套一个代理、在背后换实现"的模型。理由有三层——

- **OSGi 两种都提供**，但它自己的指引把 `STATIC` 设为默认，因为 dynamic 要求**每个** consumer 都对"服务调用中途消失"做防御。
- **Cordis 就是代理模型**：`ctx.get(name)` 在服务不存在时返回 `undefined`，而官方指引是"handle their absence"——**防御性检查是被推荐的路径**。
- **缓存的引用让代理更糟，不是更好**：Cordis 的守卫在**访问路径**上，不在**值**上——`ctx.foo` 在服务没了会抛，但你存下来的引用照常工作，直接调进已死插件的闭包里。

pi 的选择：`ctx.use(Token)` **在设计上就在构造期返回值**——代价是同样的隐患，但"**依赖方随 provider 一起销毁**"让它是安全的。**代理不修复缓存引用，它只是把"不可能"变成"静默错误"。**

### 7.9 一个完整例子：TUI → Service → Worker → Harness

把前面所有零件串起来。场景：用户在一个 TUI 里输入 prompt，任务实际在另一个进程里跑，进度实时回显。

> **这一节是 §7 的总结图**：它把 §2.2 的主图从"静态分层"展开成"一次调用的动态过程"——Facet（§7.3）落在哪两个环境、Service（§7.4）怎么当中间契约、Replicated State（§7.5）怎么传播进度、FacetHost（§7.7）怎么组装、Reload（§7.8）怎么替换，全部在这条时序里各就各位。

**① 组装（worker 进程，标准模板）**

```ts
const builtins = await createStaticFacetLoader([
  agentControllerRuntimeFacet,
  pluginRuntimeFacet,
  createModelsServiceFacet(options),
  createTranscriptServiceFacet(options.lane),
]).load();

const pluginLoader = options.facetLoader ?? createStaticFacetLoader([]);
const loadedPlugins = await pluginLoader.load();

facetHost = await createFacetHost({
  facets: [...builtins.facets, ...loadedPlugins.facets],
});
```

**② 定义 service 与 facet（以 session worker 的 Models 服务为例）**

```ts
// ① 定义 token：接口 + id 一行绑定（experimental/services/models.ts）
export interface Models { /* … */ }
export const Models = defineService<Models>("pi.models");

// ② 写 facet：setup 里声明提供（models-provider.ts）
export function createModelsServiceFacet(options): Facet {
  return defineFacet({
    id: "@pi/models",
    setup(env) {
      const runtime = createModelsService(options.lane, options.modelRuntime, options.settingsManager, env.replicatedState);
      env.provide(Models, runtime.service);                        // 安装 singleton 实现
      env.onActivate(() => runtime.activate(BACKGROUND_CONTEXT));  // 异步初始化后置
    },
  });
}
```

**③ 端到端时序**

```
TUI                    server                 session worker S0              Harness
 │                       │                          │                          │
 │ 用户输入 prompt        │                          │                          │
 ├─ AgentController ────►│                          │                          │
 │  (remote service 调用) │  路由到持有该 session 的   │                          │
 │                       ├─ worker ────────────────►│                          │
 │                       │                          ├─ accept(run) ───────────►│ 落盘 operation
 │                       │                          │                          │ （不启动任何工作）
 │                       │                          ├─ drive({operationId}) ──►│ 安装推进过程
 │                       │                          │                          ├─ 13 个平铺状态推进
 │                       │                          │                          ├─ 工具：先说要做→执行→记录结果
 │                       │                          │◄─ transcript 状态变化 ────┤
 │                       │                          ├─ publish(context)        │
 │◄─ delta（按路径的增量）─┼──────────────────────────┤  （replicated state）    │
 │  渲染进度 / 输出        │                          │                          │
 │                       │                          │                          │
 │ 插件热加载：pluginLoader.load() → facetHost.reload() → 老 provider 退役（§7.8）
```

**④ 关键点回扣**

| 观察 | 对应机制 |
|---|---|
| TUI 不知道 Harness 在哪、怎么 RPC | Chord service 边界（§7.4、§7.6） |
| 关掉 TUI 再打开，任务还在跑 | worker 持有 Harness，operation 已落盘（§4.7 accept/drive 分离） |
| 进度是实时的，但**没进 Session** | replicated state 是 Live Distributed State（§7.5） |
| 插件替换时 TUI 没看到服务消失 | 候选先激活 + 原子切换（§7.8） |
| TUI 拿不到凭据 / 工具注册表 | `setup(env)` 参数表在类型层面卡死（§8.4） |

### 7.10 为什么 Harness 与 Chord 必须分开

回到 §2.2 主图：图的**上半部分是 composition，下半部分是 execution**。这条横线不是画出来的——它是两者各自的核心铁律不同所决定的。

这不是"顺手分了个包"，而是**三个维度上都不该合并**：

| 维度 | `AgentHarness` | `Chord` |
|---|---|---|
| **核心铁律** | "数据只存在于 entry / bound value-list / ledger 三者之一" | "依赖图先验证后绑定，按相反顺序销毁" |
| **时间尺度** | 跨崩溃仍然正确（秒 → 天） | 运行中组合与替换（毫秒 → 秒） |
| **依赖方向** | 只 `import type` chord（`Context` / `JsonValue`） | 零 Pi 内依赖 |

第三行是最硬的证据。看 `agent` 包对 chord 的实际引用：

```ts
// packages/agent/src/harness/context.ts / session/types.ts
import type { Context, ContextKey } from "@earendil-works/chord";
import type { JsonValue } from "@earendil-works/chord";
```

**全是 `import type`。** 稳定版 Harness 根本没用 facet / service 运行时，只复用了 `Context` 与 JSON 类型。连核心层都只取其类型、不取其运行时——这是"独立工具库"最有力的证据，也是"两者职责不同"最直接的证明。

如果强行合并会怎样：

- Chord 就得懂 Session / Operation / 工具参数 / hook 语义 → 它就不再是"可以被无关应用复用"的通用运行时；
- Harness 就得懂进程、传输、插件分发、generation 管理 → 它的三存储铁律会被外部生命周期污染。

正确的组合方式是**装配，不是合并**：

> **实验性架构 = 用 Chord 装配 Harness。** presentation 与 session worker 只是被装到了不同进程的 facet 里；Harness 本身完全不知道自己被装进了什么容器。

一句话总结本节：

> **`AgentHarness` 是"单 lane 持久化执行"的专用答案；`Chord` 是"多进程插件组装"的通用答案。前者是后者的被装配对象，不是它的一个模块。**

### 7.11 Chord 与 DeepSeek Harness 的对应关系（速览）

既然两边都在做"插件 + 服务 + 上下文 + 动态组合"，自然会想对齐。先把**能对上的**列出来：

| 概念 | Chord | dsh / Cordis |
|---|---|---|
| 插件单元 | `Facet { id, setup(env) }` | `Plugin`（挂到 `ctx` 上） |
| 能力暴露 | `Service<T>`（singleton / keyed） | `ctx.provide()` / `ctx.get()` |
| 依赖声明 | `env.use(Service)` / `observe` | `inject = [...]`（未就绪则 PENDING） |
| 状态共享 | `replicatedState` + delta | 共享 `ctx` 上的 service 状态 |
| 副作用回收 | `env.own(disposal)` + onDeactivate | `ctx.effect(() => disposer)` |
| 热替换 | `FacetHost.reload()`（候选→切换→退役） | 改配置 → 卸载旧插件 → 加载新插件 |
| 上下文 | `Context`（Go 式：取消 + invocation 值） | `ctx`（上下文 + 服务容器） |

但**对齐到这一步就必须停住**。三个层次必须分开说，否则会得出错误结论：

| 判断层次 | 结论 |
|---|---|
| **概念相似** | ✅ 大量重叠。"插件 + 服务 + 上下文 + 可逆副作用"是共同词汇。 |
| **实现相同** | ❌ 不同。最典型的：Chord 是 `use(Token)` 构造期返回值 + **拆掉依赖方**；Cordis 是 `ctx.get(name)` 访问期守卫 + **代理换实现**（`facets.md` §13.1 明确论证了为什么 pi 拒绝后者）。 |
| **架构位置相同** | ❌ **完全不同**。这是最关键的一点，详见 §9。 |

**架构位置**的差异，一句话概括：

> **更准确地说，Cordis 更偏向进程内的应用组装与插件树，而 Chord 在此基础上进一步处理运行环境、跨进程边界和 replicated state。**

⚠️ 这句话容易被读成"两者不在一个抽象层"，那就过度切割了。**它们是相邻而不是分离的**：都做插件组合与依赖解析，区别在于**重心**——Cordis 的重心在进程内的组合语义（插件树、事件、可逆副作用），Chord 的重心在跨运行环境的能力边界与状态传播。**重心不同 ≠ 层级不同。**

由此推出两者最根本的不同，也是本报告认为最值得记住的一条：

| | pi2 | dsh |
|---|---|---|
| Agent Loop 的地位 | **不可替换的执行内核**（`AgentHarness` 有自己的铁律与规范） | **本身就是一个 plugin**（"不存在需要打补丁的特权内核"） |
| 组合发生在哪 | **内核之外**：把 Harness 当作一个被装配的模块 | **内核之内**：Agent 本身被拆成插件树 |
| 隔离的边界 | 跨进程 / 跨运行环境（facet 在不同环境） | 同进程内的插件边界（`ctx.isolate` 可做作用域隔离） |

完整对照见 §9。

---

## 8. Chord 与依赖注入（DI）容器：像什么、不像什么

### 8.1 传统 DI 回答的问题

以 NestJS 为例：

```
UserService
   │
   ├── UserRepository
   └── Logger
```

你声明 `UserService needs UserRepository`，容器负责：创建 → 注入。

它回答的是一个很具体的问题：

> **"这个对象需要哪些其他对象？"**

即 `Object A → depends on → Object B`。这是经典 DI 的全部。

### 8.2 Chord 多回答了什么

Chord 面对的图不是 `A → B`，而是：

```
Browser  ──┐
Worker   ──┤
Backend  ──┼──►  ？
Worker 2 ──┘
```

它要回答 §6.2 那张清单上的八个问题。所以更准确的说法是：

> **Chord 不是"不用 DI"，而是不满足于 DI。**

```
传统 DI
   └─ 解决：依赖注入

Chord
   └─ DI
      + Service discovery / binding
      + Lifecycle（setup → activate → dispose，含失败清理）
      + Remote binding（跨进程 / 跨运行环境）
      + State replication（replicated state + delta）
      + Dynamic composition（候选→切换→退役）
```

一句话：**传统 DI 解决"谁创建谁"；Chord 解决"谁在什么时候活着、在哪儿活着、谁被允许拿到什么"。**

### 8.3 为什么 Chord 不用 `ctx.get(name)` 那套代理模型

这是 Chord 与 Cordis 最具体、最可验证的实现差异，值得单独说清（依据 `facets.md` §13.1）。

| | `ctx.get(name)` 代理模型（Cordis） | `env.use(Service)` token 模型（Chord） |
|---|---|---|
| 服务缺失时 | 返回 `undefined`，官方指引是"handle their absence"（自己处理它不存在的情况） | 不存在这种状态——依赖图在启动期就已经校验过 |
| 检查位置 | **访问路径**上（`ctx.foo` 会抛） | **构造期**：`use()` 直接返回一个值 |
| 缓存引用 | 存下来的引用**照常工作**，直接调进已死插件的闭包里 | 同样有隐患，但**依赖方会随 provider 一起销毁** |
| 替换方式 | 代理换实现，consumer 不被拆掉 | **拆掉依赖方**，重建 |
| 代价 | 每个 consumer 都要写防御代码 | 替换粒度更粗（结构性变更要重装依赖图） |

关键判断（原文意思）：**代理不修复缓存引用问题，它只是把"不可能"变成"静默错误"。** 而"拆掉依赖方"之所以安全，正是因为**持有者会随提供者一起死**。

pi 也没有把这条路堵死。`facets.md` 记录了一个**推迟的（deferred, not adopted）**方案：如果将来发现"拆掉依赖方"太粗，加的不是 OSGi 式的动态策略，而是 HMR（热模块替换）式的 `accept()`——一个**按依赖粒度**的选择加入：

```
uses: [Harness, accepts(Models)]
  = 我的获取可以被重新指向 / 我不从该 provider 派生状态 / 我不持有指向它的在途注册
```

kernel 只在两边的 schema 可以双向赋值时才允许替换，否则**静默回退到"拆掉依赖方"**。文档的原话很值得记：**"拆掉依赖方必须始终是那条永远可用的路"**——一旦 `accepts` 成为正确性的必要条件，所有 consumer 就又开始写防御代码了。

### 8.4 能力边界：为什么 Chord 故意不让插件拿到 Harness

这是 Chord 最容易被误解、也最重要的一点——也就是 §7.2 说的**第二个核心问题**（"装起来以后，每个组件能拿到什么"）。

§6.6 那条约束——"presentation facet 永远拿不到裸的 Harness / Session / tool registry / hook registry / 凭据存储 / storage handle"——**不是靠代码评审守住的，是靠 API 形状守住的**。

看 `setup(env)` 的参数表。插件能拿到的全部东西：

```
env.use(Service)            → 一个稳定的门面对象
env.observe(Service, h)     → 一个订阅回调
env.provide(Service, impl)  → 安装自己实现的能力
env.provideMany(Service)    → 按 key 产生实例
env.replicatedState(init)   → 创建可发布状态
env.own(disposal)           → 托管清理
env.onActivate(cb)          → 异步初始化
env.onDeactivate(cb)        → 退役回调
```

**没有 `env.host`、没有 `env.getHarness()`、没有 `env.registry`、没有全局单例。** 想要什么能力，就必须先有人把它声明成一个 `Service` 并 `provide` 出来——而且**提供方自己决定契约长什么样**（比如 `AgentController` 只暴露"面向 presentation 的 `AgentLane` 安全门面"，而不是裸 `AgentLane`）。

这就是为什么本报告反复强调：

> **Chord 的真正交付物不是"依赖注入"，而是"能力边界"。**

它同时定下两件事：

1. **谁提供什么能力**（service binding / dependency graph）；
2. **谁被允许拿到什么能力**（`setup(env)` 的参数表 + service 契约 + 跨进程 strict-JSON 边界）。

而且这个边界是**三道**的，不是一道：

| 边界 | 机制 | 拦住什么 |
|---|---|---|
| 类型边界 | `FacetEnvironment` 参数表 | 插件拿到 host 内部对象 |
| 契约边界 | `Service<T>` 的泛型 + `RemoteServiceContract` | 拿到不该拿的方法 / 传不该传的数据 |
| 进程边界 | facet 在不同进程加载，跨进程只能走 strict JSON | 进程内绕开边界（直接 `import` 别的模块） |

一个"可组合的插件系统"如果没有第三道，隔离就只是礼节。Chord 把三道都做进去了——**这才是它值得单独研究的理由**。

**真正的风险不是"它拿到一个内部对象"**

用 §6.8 的视角重说一遍这件事。为什么 presentation facet 不能拿裸 Harness？

不是因为"它会读到一个不该读的字段"，而是因为：

> **它拿到内部对象以后，就可以绕过受控的 Context Assembly 路径，直接改变模型看到的世界。**

具体来说，如果 TUI 手里有裸 Harness，它就能：

- 往 Session 里追加 entry → 下一轮整理上下文时，这些 entry 会**自动进入**模型上下文；
- 直接改 `laneState` / 配置 → 改变模型收到的运行时状态；
- 拿到 hook registry → 在 `transform_context` 里任意改写 provider messages。

这三件事都不需要"恶意"，只需要"方便"。而一旦发生，**§4 建立起来的那条"整理上下文"的链路就不再是唯一入口**——"下一次模型看到什么"就变成了一个无法审计的问题。

所以能力边界的最终目的，不是保护对象，而是保护**这条链的唯一性**：

```
Plugin ──(只能走)──► Service / State / Hook ──► 受控的 Context Assembly ──► Model Input
             ╳ 不能绕过这条链
```

这条链的终点——也就是"**到底什么东西最后会变成 prompt 文字**"——§4.4 有逐项清单。对照那份清单可以看得更清楚：插件真正能"写进模型视野"的入口只有两个（写 entry、注册 hook），其余全是程序内部机制。

**这就是 Chord 与 Context Assembly 的最终连接点**：Chord 管的不只是"组件怎么装起来"，而是"**谁有资格参与这次编译，以及以什么能力参与**"。

---

## 9. 两种 Harness：谁控制 Model Input 的构造

> **方法声明与证据等级。** 本节分两类证据，务必区分：
>
> - **一手证据（pi 侧）**：pi 仓库内对 Cordis / DSH 的直接评价（`packages/agent/docs/mobile-handoff/02-plugins/01-facets/facets.md` §13.1–13.2），以及 Chord / harness 源码。
> - **一手证据（dsh 侧）**：DeepSeek Harness 官方文档（2026-09 直接读取）——`docs/subsystems/system-prompt.md`、`docs/cordis-tutorial/index.md`、`.agents/notes/implemented/architecture/2026-06-11-microkernel-event-taxonomy.md`。引用处均标注文件名。
> - **二手证据**：dsh / Cordis 的第三方报道与拆解（官方仓库 `deepseek-ai/deepseek-harness`，MIT，2026-08-13 发布 Developer Preview，CLI 名 `dsh`，官方明示"THERE WILL BE COMPATIBILITY-BREAKING CHANGES"；底层元框架 `cordiverse/cordis`，源自 Koishi，作者 Shigma）。
>
> ⚠️ dsh 未在本工作区留存源码；dsh 侧结论以官方文档（preview 期）为准，可能随版本漂移。

### 9.1 两个系统各是什么（先分清 dsh 与 Cordis）

这两个名字不能混用：

| 名称 | 是什么 | 关系 |
|---|---|---|
| **Cordis** | 一个**元框架**（meta-framework）：规定"副作用如何组合、依赖如何解析"，不预设业务领域。源自 QQ 机器人框架 Koishi，2022 年独立成 npm 包 | dsh 的**底层** |
| **DeepSeek Harness（dsh）** | DeepSeek 开源的 **Agent Harness 产品**：把模型适配器、工具注册表、会话日志、Agent Loop、沙箱、审批、UI 组合成能执行任务的 Agent | **建在 Cordis 之上** |

Cordis 的五个核心概念：**插件、上下文、注入、事件、可逆副作用**。

```
export function apply(ctx: Context) {
  ctx.on('some/event', (payload) => { /* ... */ })   // 监听（卸载时自动移除）
  ctx.effect(() => { /* ... */ })                    // 注册副作用（卸载时自动回滚）
  ctx.plugin(SomePlugin)                             // 挂载子插件（随父卸载）
  ctx.get('someService')                             // 读服务（不存在则 undefined）
  ctx.provide('someValue', 42)                       // 提供服务
}
```

**dsh 官方对 Cordis 的定义**（`docs/cordis-tutorial/index.md`，原文）：

> "Cordis is the plugin framework underneath DeepSeek Harness: a small runtime where **every capability — tools, LLM adapters, file access, the agent loop itself — is a plugin mounted into a shared context.**"

**dsh 官方的产品原则**（microkernel 架构笔记，原文）：

> "The product principle is 'everything is a plugin': **hooks, /goal, /loop, dynamic workflows, compaction, sandboxing, permissions, UI, persistence, MCP, skills must all be writable as plugins without modifying the core.**"

### 9.2 主对照：谁控制 Model Input 的构造

这是本报告认为**价值最大**的一张表。它不比较 API 名字，而是逐条回答"下一轮模型看到什么，由谁决定"：

| 问题 | Pi | DeepSeek Harness |
|---|---|---|
| **谁构造模型输入** | Harness 整理 `messages`（固定 5 步，§4.3）+ 现算 `systemPrompt` / `tools` | plugin/context + prompt assembly（waterfall，瀑布式事件） |
| **Prompt 是什么** | 三块：`messages`（从 Session 整理）+ `systemPrompt`（请求字段，现算）+ `tools`（请求字段）。**system prompt 不进入历史** | SystemPrompt + PromptContext + history 等，**全部作为消息进入派生历史** |
| **谁能贡献 prompt / context** | `entryProjectors` / hooks / runtime mechanisms | Cordis plugins / `PromptSection` / `PromptContext` |
| **Tool 如何进入模型** | 定义走请求的 `tools` 字段；调用与结果走持久化的 entry | `tools` service / tool plugins |
| **Agent loop 在哪** | Harness 是相对独立的执行内核 | **agent loop 本身就是 plugin** |
| **状态真相在哪里** | Session + bound values/lists + ledger | 共享的 Cordis service 图 + session/持久化 |
| **崩溃恢复** | 显式建模（operation 状态 / 效果状态） | 重点不完全相同，更多靠 plugin/context/session 的组合 |
| **Composition 发生在哪里** | Harness **外部**，由 Chord 组装 | Harness **内部**，Cordis 本身就是组合机制 |
| **插件能改变什么** | 受 Chord service 边界限制 | 原则上很多核心行为本身就是 plugin |
| **核心哲学** | **durable execution first（先把持久执行做可靠）** | **everything is a plugin（一切都是插件）** |

注意最后一行的对称性：两边的哲学**不是同一个命题的正反面，而是两个不同的首要关切**。Pi 先要"不会错"，再谈"能不能换"；dsh 先要"什么都能换"，再把可靠性当作插件组合的一个性质。

### 9.3 两张 Prompt Assembly 图

**Pi：固定的整理管线**

```
        Session（已发生的事实）        lane 配置 / harness options
                 │                              │
                 ▼                              ▼
        Context Projection              systemPrompt 现算（可为函数）
        （5 步固定算法 §4.3）            tools 现算（工具注册表 + lane 配置）
                 │                              │
                 ▼                              ▼
             messages  ───────────┬───────  systemPrompt / tools
                                  ▼
                        Model Input（一次 provider 请求）
                                  ▼
                                 LLM
```

左边是从历史**整理**出来的，右边是每次**现算**的请求字段——两者都不落盘成历史。

> **"谁允许改变这条 pipeline？"**
>
> 答案是一个**封闭集合**：Harness 自己（算法固定）+ hooks（三类持久性，§4.6）+ `entryProjectors` + `transform_context` + service 提供的数据 + Chord 控制的贡献。
>
> 而且 §4.3 的**只追加上下文铁律（append-only context invariant）**给这条 pipeline 加了一道硬约束：**只能在尾部追加**。所以"改 prompt"在 Pi 这里从来不是"随便改字符串"。
>
> **到底哪些东西会真的变成 prompt 文字、哪些只是程序内部的脚手架**，§4.4 给了一张完整清单。

**DeepSeek：assembly 本身是一个 waterfall 事件**

```
                 Cordis Context
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
   system-prompt    tools          llm
        │              │
   PromptSection   Tool plugins
   PromptContext
        │              │
        └───────┬──────┘
                ▼
           agent/request
                ▼
           Model Input
                ▼
                LLM
```

> **DeepSeek 更像是在让整个 Agent Input 的构造过程，本身变成一个"插件怎么组合"的问题（plugin composition problem）。**

**最精确的一处差异**，两边都有源码/文档支撑：

| | Pi | DeepSeek |
|---|---|---|
| context / prompt 的组装 | **固定 5 步算法**，扩展点窄且显式 | **`system-prompt/assemble` 本身就是一个 waterfall 事件**，插件可以包住整个组装过程（microkernel 笔记把它与 `agent/request`、`tools/execute` 并列为 waterfall 类） |
| 含义 | 整理路径不可替换，可靠性才可证明 | 组装过程本身可以被插件改写、短路、恢复 |

这**不是**谁更先进的问题，而是**两种可靠性策略**：Pi 把可靠性放在"路径固定"上，dsh 把可靠性放在"事件语义明确 + 卸载即回滚"上。

### 9.4 真正的分歧：谁是内核

这是回答"两者是不是在解决同一个问题"的关键，比笼统的"架构位置不同"更有解释力。

**Pi**

```
                    Application
                        ↓
                     Chord
                        ↓
               AgentHarness
                        ↓
                 Context Assembly
                        ↓
                      LLM
```

**Harness 是一个相对固定的执行内核。** 它有明确的铁律：

- Session 怎么存（三存储铁律）
- Operation 怎么恢复（13 个平铺状态）
- Tool 怎么 replay（`safe` / `never`）
- 上下文怎么整理（5 步固定算法）

然后 **Chord 在外面**负责把它装起来。

**DeepSeek**

```
              Cordis Context
                    ↓
        ┌───────────┼───────────┐
        │           │           │
     tools        llm       system-prompt
        │           │           │
        ├──────── agent-loop ───┤
                    ↓
                   LLM
```

**Agent loop 本身也是 plugin。** 官方 microkernel 笔记的原话很硬：

> "`@deepseek-ai/dsh-agent-loop` is **the only concrete loop plugin and is itself swappable — nothing outside it may depend on it.**"

于是两者的哲学对比就出来了：

```
Pi:
  固定 execution kernel
  +
  外部 composition

DeepSeek:
  可组合 plugin runtime
  +
  Agent 本身也是 composition 的一部分
```

**推论**（同时修正"两者不在一个抽象层"的误读）：

> **它们不是同一个问题的两种解法。** dsh 在回答"一个 Agent 应用内部怎么被插件化组装"——**连 Agent 自己都是被组装的对象**；Pi 在回答"一个已经可靠的 Agent 内核，怎么被拆到多个进程、多个界面、可插拔的环境里，同时不暴露内部能力"。
>
> **两者甚至可以组合**：Cordis 负责**进程内**的插件组合，Chord 负责**进程之间**的服务组合。这不是二选一。

⚠️ 这里要防止一种过度切割：**"谁是内核"描述的是重心，不是"一个做这个、另一个不做那个"**。两者都做插件组合与依赖解析，都关心生命周期与卸载清理；差别在于各自把工程投入压在哪一侧、以及 Agent Loop 是否被当作可替换件。

一处**直接的一手证据**，说明 pi 的作者确实认真读过并比较过 Cordis 与 DSH——`facets.md` §13.2 对两者在"退役时在途工作"上的处理：

> "Neither reference system solves this. Cordis's `_unload` is `await Promise.all(disposers)` with a try/catch and no deadline — a disposer that hangs hangs the reload. **DSH goes further and places the obligation on the tool author**: async work must *'observe or forward `exec.signal` and settle only after'* reaching *'quiescence'*, with the registry rechecking cancellation afterwards. That is the settlement concept Cordis lacks, but **it is stated in prose and enforced by nothing**, so a tool that ignores its signal still wedges the unload."

pi 因此提出四阶段退役（Deregister → Signal → Race a deadline → Settle by outcome），并指出**后两阶段是两个参考系统都没有的**。注意这里的措辞：pi 承认 DSH 有"结算（settlement）"这个概念而 Cordis 没有——**这是"实现不同"层面的准确判断，不是"我们一样"的拉平**。

### 9.5 "Everything is a Plugin" 的真正含义

不要把 dsh 的这句话理解成"它的架构更模块化"——太泛，等于没说。

它的真正含义是：

> **"谁能影响 Agent 行为"不再由一个巨大的 Agent 类写死，而是由插件图（plugin graph）决定。**

```
Plugin
   ↓
提供 capability
   ↓
参与事件 / prompt / tool / state
   ↓
改变下一轮 Agent Input
   ↓
改变 Agent 行为
```

这一层才是 dsh 的核心思想。而官方 microkernel 笔记给的**证据清单**非常具体——这些**全部**要求"作为插件可写、不改 core"：

| 类别 | 内容 |
|---|---|
| 行为扩展 | hooks、`/goal`、`/loop`、dynamic workflows |
| 上下文管理 | compaction、system-prompt |
| 安全与治理 | sandboxing、permissions |
| 外围 | UI、persistence、MCP、skills |

用 §6.8 的语言翻译一遍：**dsh 让"谁参与 Context Assembly"这个问题的答案，完全由 plugin graph 给出**——包括 loop 本身、prompt 本身、tool surface 本身。而 Pi 把这个问题拆成了两半：内核内固定（Harness），内核外可组合（Chord）。

### 9.6 DeepSeek 的 system-prompt：Prompt 是一个可组合运行时对象

这一节是 §9.2 表格第一行的展开，也是 dsh 侧最值得 pi 研究的具体机制（依据 `docs/subsystems/system-prompt.md`）。

**人话版**：DeepSeek 没有把 system prompt 当成一大段固定字符串，而是拆成很多可组合的贡献：

```
core instructions
  + plugin A 的 section
  + plugin B 的 section
  + dynamic context（随运行状态变化）
  + tools（本轮可见的 schema 集）
  ↓
按规则 assembly
  ↓
模型输入
```

所以在 DeepSeek 这里，**Prompt 本身已经成了一个"可组合运行时对象"**。

**机制细节**（官方类型定义）：

| 类型 / API | 作用 | 关键约束 |
|---|---|---|
| `PromptSection` | 一段有序 prompt 贡献 | `{ name, order, text, interpolate?, complete? }`；`text` 可以是静态字符串**或每次 assembly 求值的 provider 函数**；`order` 升序拼接，相同 order 按 code-unit 名称序；**同名重复注册直接抛错** |
| `PromptSection.complete` | 声明"我这一段就是完整 system prompt" | 装配仍会跑完 waterfall（让 tools / contexts / variables 解析），然后**把这一段恢复为唯一的 prompt section**；**出现多于一个 effective complete → assembly 失败** |
| `PromptContext` | **`PromptSection` 的"缓存安全"另一面（cache-safe counterpart）** | "Dynamic model context materialized as a durable user-role snapshot"（动态上下文被写成一份持久的 user 角色快照）；assembly 负责解析与排序，agent-loop 只在**它变化了、或被 compaction 移除时**，才在**保留的历史之后**记录它的完整快照 |
| `ctx.systemPrompt` | 注册与装配的 registry service | `section()` / `context()` / `tools(provider)` / `variable(name, provider)` / `getSectionOrder()` / `getContextOrder()` / `suppressRuntimeContext()` / `assemble()`；**每个注册都返回一个 Cordis effect disposer** |
| `system-prompt/assemble` | **waterfall** 事件 | 作用域过滤派发；返回值即权威；"a registered complete section is restored after this waterfall" |
| `system-prompt/change` | `emit` 事件 | registry 变更通知，不过滤 |

**两个值得 pi 注意的点：**

1. **`PromptContext` 的 "cache-safe" 与 pi 的"只追加上下文铁律"是同一个焦虑**（§4.3）。两边都发现：**在历史中间插入内容会摧毁 provider 的 KV cache**。pi 的解法是"运行中写入一律延后到 checkpoint，只在尾部追加"；dsh 的解法是"把动态上下文做成持久快照，只在变化时、且只在保留历史之后记录"。**这是同一个约束的两种工程表达。**

2. **prompt 不作为请求字段，而是作为"派生历史里的一条消息"**（官方决策记录）。agent-loop 用 `renderPrompt` 渲染装配结果，然后把它**提交成一个 `system/message` surface node**：首步作为 surface node 0 追加，之后渲染文本变化时**原地替换**；若本次调用声明 `systemPromptUpdate: 'in-history'`，则在**缓存历史之后**追加。官方原话是：

> "so the prompt reaches the model as a **message of derived history rather than as a request field**"

对照 pi，**这里恰恰是两边做法不同的地方**（§4.2 的请求三块图）：

| | pi | DeepSeek |
|---|---|---|
| system prompt 放在哪 | **请求字段** `systemPrompt`：每次请求现算（可以是函数），不写进会话历史，也不落盘 | **派生历史里的一条 `system/message`**：由 `renderPrompt` 渲染后提交，成为消息历史的一部分 |
| 这样做的直接后果 | 改 system prompt 不影响历史、不破坏缓存；但"模型实际看到的 system prompt"不会留在 Session 里，需要另行记录才可审计 | system prompt 与其他历史一视同仁，天然可回放、可审计；代价是它一旦变化就要小心 cache 与顺序 |

**共同点只在更上一层**：两边都认为"模型输入是**算出来的**，不是存下来的"——pi 的 messages 从 Session 整理、systemPrompt 从 lane 配置现算；dsh 的 prompt 从 section 装配。**但"prompt 到底算不算历史的一部分"，两边给出了相反的答案。** 这是本报告认为值得记住的一处真实分歧，而不是"独立得出同一结论"。

### 9.7 附：概念相似与实现不同（保留为 API 层对照）

前几节是"控制权"层面的比较。作为补充，这里保留 API 层的对照——**它有用，但不足以支撑结论**。

**概念层面确实大量重叠**（"插件 + 服务 + 上下文 + 可逆副作用"是共同词汇）：

| 概念 | Chord | dsh / Cordis |
|---|---|---|
| 插件单元 | `Facet { id, setup(env) }` | `Plugin`（挂到 `ctx` 上） |
| 能力暴露 | `Service<T>`（singleton / keyed） | `ctx.provide()` / `ctx.get()` |
| 依赖声明 | `env.use(Service)` / `observe` | `inject = [...]`（未就绪则 PENDING） |
| 状态共享 | `replicatedState` + delta | 共享 `ctx` 上的 service 状态 |
| 副作用回收 | `env.own(disposal)` + onDeactivate | `ctx.effect(() => disposer)` |
| 热替换 | `FacetHost.reload()`（候选→切换→退役） | 改配置 → 卸载旧插件 → 加载新插件 |
| 上下文 | `Context`（Go 式：取消 + invocation 值） | `ctx`（上下文 + 服务容器） |

**实现层面则明显不同**：

| 关切 | Chord 的做法 | Cordis / dsh 的做法 | 差异实质 |
|---|---|---|---|
| **服务获取** | `env.use(Token)`：**构造期**返回稳定值；依赖图启动期校验 | `ctx.get(name)`：**访问期**才去查，缺失返回 `undefined`，指引"handle their absence" | 检查位置：构造期 vs 访问期 |
| **替换方式** | **拆掉依赖方**（teardown of dependents）；持有者随提供者一起死 | **代理换实现**；consumer 保持存活，`inject` 让插件进入 PENDING 并在服务回归时自动重激活 | Chord 拒绝代理模型，理由见 §8.3 |
| **副作用回收** | `env.own(disposal)` + `onDeactivate`；资源所有权绑定在 facet 的作用域上 | `ctx.effect(() => disposer)`；**所有对上下文的变更最终都归结为这一个原语** | Cordis 更统一；Chord 更显式（分阶段守卫） |
| **命名/键** | 强类型 token + `chord.*` 命名空间 + `$chord.*` 保留前缀 | 字符串键 `ctx.get('name')` + 论文提出的 **coeffect 类型表 Σ** | 前者靠 token 与保留前缀，后者靠类型系统建模字符串键 |
| **事件地位** | harness 事件是**被动观察**（§4.6"永不驱动执行"）；**Chord 甚至没有 event bus** | 有类型的事件是**一等公民式的协调机制**（`emit`/`parallel`/`serial`/`bail`/`waterfall`） | 相反的设计取向 |
| **隔离原语** | 跨进程 facet（进程/环境即边界）+ service 契约 | `ctx.isolate(key, realm)` 作用域隔离 + `ctx.intercept(key, meta)` 拦截依赖访问 | Chord 的边界是**进程级**；Cordis 的是**作用域级** |

**三层判断必须分开说**，否则会得出错误结论：

| 判断层次 | 结论 |
|---|---|
| **概念相似** | ✅ 大量重叠。 |
| **实现相同** | ❌ 不同。最典型的就是上表第一、二行。 |
| **控制权相同** | ❌ **完全不同**（§9.2、§9.4）。这才是本质差异。 |

### 9.8 pi 可从 dsh / Cordis 借的三件事（具体）

1. **`dsh config` 式的"最终合成树"可视化**：facet/bundle 叠加之后"实际生效的到底是什么"今天只能靠读代码；dsh 把它做成了一等命令。§6 的 facet 排查成本会大降。
2. **把"可逆副作用"当作扩展 API 的契约**：pi 的扩展卸载/热替换今天靠人工写对清理逻辑（`worker.ts` 的 `retired.dispose()`）；Cordis 把"注册即附带撤销"做进了框架（所有上下文变更都归结为 `ctx.effect`，而且**每个注册都返回一个 disposer**——dsh 的 `ctx.systemPrompt.section()` 等 API 正是这个形态）。可以直接对标 Chord 的 `own()` 机制补齐——**但要注意 §8.3 的取舍**：Cordis 的统一原语是有代价的（代理模型），照搬会丢掉 Chord 现在的能力边界。
3. **`PromptContext` 式的"贡献 + 排序 + 快照"三件套**：dsh 把动态上下文做成了**可注册、可排序、可抑制（`suppressRuntimeContext()`）、带缓存安全快照语义**的一等对象。pi 目前的对应物是 `entryProjectors` + `transform_context`，扩展点更窄、也更不显式。若 pi 未来要让插件更规范地贡献运行时上下文，dsh 这个形态是现成参考——**而且它不违反 pi 的只追加铁律**（快照只追加在保留历史之后）。

反过来，dsh 若借鉴 pi，最值得拿的是**§4 的崩溃恢复完备性**（13 个平铺状态 + accept/drive 分离 + replay 契约）与**§4.6 的"事件不驱动"纪律**——这两样在 dsh 的公开文档里找不到等价物。

---

## 10. 与 pi1（pi-mono）的架构演进

| 维度 | pi1 `pi-mono` 0.67.68 | pi2 `pi` 0.85.1 |
|---|---|---|
| packages | agent / ai / coding-agent / mom / pods / tui / web-ui | + chord / protocol / client / server / session-backends / telemetry / evals（去 mom/pods/web-ui） |
| `agent` 包内容 | `agent-loop.ts`、`agent.ts`、`proxy.ts`、`types.ts` | 上述 + 完整 `harness/`（session / runtime / drive / tools / compaction / execution） |
| 持久化位置 | `coding-agent/src/core/session-manager.ts`（JSONL v3） | 下沉到 `agent` 包：Session + 三存储 + 三种后端 |
| 并发模型 | 单 Session 单写者（隐式） | 显式的写入串行线 + Drive 单写者 + 效果准入闸门 |
| 崩溃恢复 | 无正式语义 | 13 个平铺状态的重启点 + 孤儿（orphan）恢复表 + "先说要做/记录结果"两步提交 |
| 扩展边界 | 进程内 extension API | extension API（稳定）+ facet/service/RPC（实验） |
| 遥测 | 无独立包 | `telemetry` 独立契约包 + 有类型的 schema |
| 组合能力 | 无 | `chord`（通用组装运行时，可脱离 Pi 复用） |
| 供应链 | 无特别说明 | pin + min-release-age + shrinkwrap 白名单 + CI audit |
| 发布形态 | npm 包 | npm 包 + 单文件二进制（`bun build --compile`）+ 版本化 source archive + SHA256SUMS |

**一句话概括**：pi1 是"能用的极简 coding agent"；pi2 是"把 agent 运行时的持久化与并发语义做成可证明的工程系统"（execution），**并在此基础上长出了一层通用的应用组装运行时**（composition），为多进程/多 presentation 形态预留了完整骨架。

---

## 11. 可借鉴的设计模式

1. **三存储铁律**：把"什么能存在哪里"约束成一条规则，并发、恢复、清理、分叉就全部可以推导出来。比"每个功能自己决定存哪"健壮得多。
2. **接受与执行分离**：`accept` 只落盘、`drive` 才执行。这让 harness 不依赖任何调度器，服务端可以用定时器/后台任务/HTTP 重入来"稍后跑"。
3. **整份状态覆盖，而不是增量日志**：每次转移都写完整的 `operationState`，恢复时只读它。放弃写放大，换来"崩溃点能列出来"。
4. **Bound typed address**：地址在构造时就绑定 namespace/key，之后读写只传地址；用一个只存在于类型层面的字段保证类型不变；没有全局注册表。应用扩展不需要改核心。
5. **先说要做 → 执行 → 记录结果**：把"不确定的那段窗口"显式建模，并给每个效果声明 `replay: safe | never`。这是 agent 系统里最容易被忽略、后果最严重的一环。
6. **同步准入边界**：`gate.admit` 的"检查"和"调用"必须是同一个同步表达式，准备工作必须前置。这个约束很小，但很关键。
7. **事件是被动观察，不是驱动源**：`reduceLaneSnapshot` 是唯一规范的折叠函数，避免每个客户端各自实现第二套状态机。
8. **先验证后绑定**：所有 facet 同步声明自己的形状 → 一次性校验完整依赖图 → provider 先激活 → 按相反顺序销毁。让依赖错误在启动期就暴露，而不是等到运行期。
9. **能力边界靠 API 形状，不靠约定**：`setup(env)` 的参数表就是权限清单。**这是本报告认为 Chord 最值得学的一点**——它把"插件不该拿到什么"从文档要求变成了类型约束。
10. **拆掉依赖方，而不是代理换实现**：`use(Token)` 在构造期返回值 + 依赖方随 provider 一起销毁，比"访问期检查 + 缓存引用"更容易推理。
11. **稳定的窄接口 + 显式非目标**：文档里专门有一节 Non-goals。写清楚"不做什么"比写清楚"做什么"更能约束实现不腐化。
12. **诚实的实现状态清单**：`harness.md` §0.9 逐条列出未实现项与契约上的欠账。这在真实工程里极其少见，也极其有用。
13. **双轨演进**：新内核（AgentHarness）先在 experimental 与独立包中成型，用 `mini` 这类最小真实客户端压测，再谈替换稳定路径。
14. **通用设施零内部依赖**：`chord` 不依赖任何 Pi 包——这既是它可复用的前提，也是它不变质的保险（它无法偷偷去懂 Harness）。
15. **把"输入"当成一等产物**（本报告的核心视角）：Harness 的产出不只是"执行了任务"，而是"**每一次都给模型一个正确、可复现、可恢复的 Model Input**"。一旦这样定义，三存储、整理上下文、压缩、replay、能力边界就全部收敛到同一个问题——**"下一次给模型什么"由谁决定、怎么保证正确**。这个框架比"Harness = 状态机 + 插件 API"更有解释力。
16. **保护"整理上下文"这条链的唯一性**：能力边界的深层目的不是保护对象，而是保证"模型看到的输入"只有一条受控路径（§8.4）。任何"绕过 assembly 直接改上下文"的口子，都会让"下一次模型看到什么"变成不可审计的问题。
17. **把"模型输入"当成算出来的，而不是存下来的**：pi 的 `messages` 从 Session 整理、`systemPrompt` 与 `tools` 每次请求现算（§4.2）；dsh 的 prompt 由 `PromptSection` 装配。两边的共同点是"输入是算出来的"。
    ⚠️ 但**具体做法不同**：dsh 把 prompt 提交成派生历史里的一条 `system/message`，pi 则把它保留为请求字段。这是本报告修正过的一处判断——不要把两者说成"独立得出了同一结论"（详见 §9.6）。

---

## 12. 风险与未完成项

| 风险 | 说明 | 影响 |
|---|---|---|
| JSONL 无物理回收（J1） | 逻辑删除立即生效，物理字节永不回收 | 长会话文件持续膨胀；敏感内容无法物理清除 |
| SQLite 分支发散 | 未压缩分支首个发散 copy O(history) | 长历史 + 频繁分支时性能退化 |
| C1 契约矛盾 | 规范里的 RemoteSession 与已发布产品冲突 | 需要一次明确决策，否则文档持续误导 |
| S3 search | 骨架与设计冲突，无实现 | 搜索能力缺失 |
| 双轨并存 | 稳定 CLI 与 harness 内核不同源 | 概念混淆、文档分裂、迁移成本 |
| frame 持久化成本 | 每帧一次持久化追加 + 复制写 | 长输出场景下 IO 被放大；`mobile-handoff` 文档已在设计替代方案 |
| 无内建权限系统 | 默认以启动用户权限运行 | 需依赖容器化/扩展；README 已明示 |
| Chord 规格超前实现 | `ServiceMode` 的 `peer`、symmetric RPC peers 等只在 `facets.md` 出现，`types.ts` 尚未落地 | 读文档时需区分"设计"与"已实现" |
| Chord 组合可视化缺失 | facet/bundle 叠加后实际生效的组合不可见 | 排查成本高（§9.8 建议借 `dsh config`） |

---

## 13. 附录：关键文件索引

### 13.1 规格与设计文档

| 路径 | 内容 |
|---|---|
| `packages/agent/docs/harness.md` | **AgentHarness 规范（1468 行，Part 0–9 + 附录，具规范效力）** |
| `packages/agent/docs/values.md` | bound typed address 规格（735 行） |
| `packages/agent/docs/tool-durability.md` | 工具持久性（704 行） |
| `packages/agent/docs/assistant-durability.md` | assistant 输出持久性（355 行） |
| `packages/agent/docs/runtime-simplification.md` | 运行时简化（391 行） |
| `packages/agent/docs/plugins.md` | coding-agent facet/service 架构（1158 行，已被 facets.md 取代） |
| `packages/agent/docs/mobile-handoff/02-plugins/01-facets/facets.md` | **更新的 facet/service 规格（1855 行）；§13.1–13.2 是对 Cordis / DSH 的一手对照与批评** |
| `packages/agent/docs/rpc.md` | facet service RPC 语义 |
| `packages/agent/docs/pico-v3.md` | 下一代 harness 设计（2113 行，讨论中） |
| `packages/agent/docs/pico/pico-usage-guide.md` | pico 使用指南（1497 行） |
| `packages/agent/docs/work-packages/00–09` | WP 工作包（runtime1 移除 → lane snapshot settled tools） |
| `packages/coding-agent/docs/` | 34 篇用户/开发者文档（extensions 3033 行、rpc 1618 行、sdk 1226 行…） |
| `packages/chord/README.md` | **Chord 设计总览（205 行）：六件套、remote adapter、delta、bundling** |
| `packages/chord/PLANNING.md` | Chord RPC / generation-loading 规划 |
| `packages/chord/src/delta/README.md` | delta 变更、数组、生命周期与消费者所有权规则 |
| `AGENTS.md` / `CONTRIBUTING.md` / `SECURITY.md` | 项目规则 |

**外部对照资料（DeepSeek Harness，§9 用；非本工作区文件）**

| 路径 | 内容 |
|---|---|
| `docs/subsystems/system-prompt.md` | **`PromptSection` / `PromptContext` / `ctx.systemPrompt` / `system-prompt/assemble` waterfall；"cache-safe" 语义；prompt 作为 `system/message` surface node** |
| `docs/cordis-tutorial/index.md` | Cordis 教程；官方定义："every capability — tools, LLM adapters, file access, the agent loop itself — is a plugin mounted into a shared context" |
| `.agents/notes/implemented/architecture/2026-06-11-microkernel-event-taxonomy.md` | **microkernel 决策：waterfall / serial / parallel / emit 四类派发；"everything is a plugin" 的完整清单；`dsh-agent-loop` 是唯一且可替换的 loop plugin** |
| `docs/subsystems/core.md` / `docs/cordis-primer.md` | 各子系统与 Cordis 概念参考 |
| `docs/cookbook/extension-cookbook.md` | "feature → mechanism map"（每个功能映射到一个 listener） |

### 13.2 核心源码

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
| `packages/coding-agent/src/experimental/services/worker.ts` | — | **标准组装模板**：builtins + 插件 facets → `createFacetHost` → 候选 reload（§7.9） |
| `packages/chord/src/types.ts` | — | `Facet` / `FacetEnvironment` / `Service` / `ServiceMode` / wire 类型全集 |
| `packages/chord/src/api.ts` | 90 | `createFacetHost` / `defineFacet` / `defineService` / `replicatedState` / `createRemoteServiceBinding`；`$chord.` 保留前缀检查 |
| `packages/chord/src/facets/host.ts` | 906 | FacetKernel：setup/激活/依赖图校验/reload/dispose |
| `packages/chord/src/services/` | ~1900 | service consumer/provider/handle/state-codec/wire（`$chord.service` 控制通道） |
| `packages/chord/src/delta/index.ts` | 1267 | 独立 delta 原语（`track`/`apply`，base batch + 路径操作） |
| `packages/chord/src/node/` + `bundler.ts` | — | facet 打包（esbuild/CJS/manifest）与 Node 加载（SHA-256 + `node:vm`） |
| `packages/protocol/src/` | — | codec / framing / protocol + cbor |
| `packages/server/src/session-router.ts` | — | Session 路由与附件 |
| `packages/session-backends/sqlite-node/src/` | — | node:sqlite 后端 |

---

*本报告基于本地源码静态阅读完成，未运行构建或测试。规范类结论以 `packages/agent/docs/harness.md` 与 `packages/chord/README.md` 为准；行为类结论以源码为准；两者冲突处已在正文标注（如 §4.8 列出的契约债、§7.4 的 `peer` 规格落差）。§9 的 dsh / Cordis 结论按证据等级标注：pi 侧一手证据来自仓库内 `facets.md` §13.1–13.2 与 Chord / harness 源码；dsh 侧一手证据来自 DeepSeek Harness 官方文档（`docs/subsystems/system-prompt.md`、`docs/cordis-tutorial/index.md`、microkernel 架构笔记），第三方报道仅作背景。*
