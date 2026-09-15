# TencentDB-Agent-Memory vs Hermes Agent vs OpenClaw 记忆系统对比研究

**研究日期**：2026-05-06
**对比对象**：
- [TencentDB-Agent-Memory](https://github.com/Tencent/TencentDB-Agent-Memory)（Tencent）
- [Hermes Agent](https://github.com/NousResearch/hermes-agent)（NousResearch）
- [OpenClaw](https://github.com/openclaw/openclaw)

---

## 1. 执行摘要

三者都致力于解决"Agent 记忆"问题，但技术路线差异显著：

| 维度 | TencentDB-Agent-Memory | Hermes Agent | OpenClaw |
|------|------------------------|--------------|----------|
| **架构哲学** | 符号化分层 + 上下文卸载 | 插件化 Provider + 冻结快照 | 朴素 Markdown 文件 |
| **记忆分层** | L0→L1→L2→L3 四层金字塔 | MEMORY.md + USER.md 双层 | MEMORY.md + 日频笔记 + DREAMS |
| **短期记忆压缩** | Mermaid 符号图谱 + node_id 溯源 | 冻结快照（session 级） | 无内置压缩，依赖手动摘要 |
| **Token 节省效果** | 最高 61.38% | 未公布 | 未公布 |
| **接入方式** | OpenClaw 插件 + Hermes Gateway 适配 | Memory Provider 插件 | 插件架构 |
| **存储后端** | SQLite+sqlite-vec / TCVDB | 可插拔（各 Provider 自定） | Markdown 文件 |
| **召回策略** | BM25+向量+RRF 混合 | 依赖 Provider 实现 | 语义搜索 + 关键词 |
| **调试可观测性** | 白盒（Markdown/Mermaid 可读） | 半白盒（文件可读） | 白盒（纯 Markdown） |

**核心结论**：TencentDB-Agent-Memory 代表了"重武器"路线，在工程完整性和量化效果上领先；Hermes Agent 代表了"生态扩展"路线，通过 Provider 插件体系覆盖多样化需求；OpenClaw 代表了"朴素实用"路线，以最低复杂度实现记忆管理。三者在不同场景下各有优势。

---

## 2. 架构设计对比

### 2.1 分层策略

**Hermes Agent — 双层静态文件**

```
System Prompt
├── MEMORY.md  (Agent 个人笔记, 2200 chars 上限)
└── USER.md    (用户画像, 1375 chars 上限)
```

- 记忆以 `\u00a7` 分隔的纯文本条目存储
- 字符级别容量管控，强制保持记忆精简
- Session 启动时冻结快照，保证 prefix cache 稳定
- 内置 Builtin Provider 始终激活，同时只允许一个外部 Provider

**TencentDB-Agent-Memory — 四层语义金字塔**

```
L0 Conversation (原始对话)
    ↓ L1 抽取
L1 Atom (结构化原子事实)
    ↓ L2 聚合
L2 Scenario (场景块, Markdown)
    ↓ L3 提炼
L3 Persona (用户画像, persona.md)
```

- 每层有明确语义职责，渐进式抽象
- 上层保留结构，下层保留证据，形成可下钻链路
- 短期记忆（任务画布）与长期记忆（用户画像）共用分层框架

**OpenClaw — 三文件平铺**

```
~/.openclaw/workspace/
├── MEMORY.md              # 长期记忆
├── memory/YYYY-MM-DD.md  # 日频笔记
└── DREAMS.md             # 梦境日志（可选）
```

- 无显式分层，依赖文件命名约定和时间维度
- memory-wiki 插件提供知识库化能力，但与主动记忆插件分离

### 2.2 短期记忆压缩机制

**TencentDB-Agent-Memory 的符号化压缩**是三家中最激进的：

```
繁杂日志 (数十万 Token)
    ↓ 1. 卸载原文
外部文件系统 (refs/*.md)
    ↓ 2. 提取关系
Mermaid 符号图谱 (带 node_id)
    ↓ 3. 轻量注入
Agent 上下文 (几百 Token)
    ↓ 按需
node_id 溯源 → 原文
```

- Mermaid 取代 JSON/自然语言，密度极高
- 保留 100% 可追溯性，不丢失证据
- 通过 `offload.mildOffloadRatio` / `aggressiveCompressRatio` 控制压缩时机

**Hermes Agent 的冻结快照**是 session 级的优化：

- Session 启动时捕获系统 prompt 快照
- 对话过程中不更新 prompt（避免 prefix cache 失效）
- Session 结束后通过 `on_session_end` 统一写入记忆
- 强调"写入时机的确定性"而非"压缩的粒度"

**OpenClaw 无内置压缩机制**，依赖 Agent 主动摘要或 memory-wiki 的编译流程。

### 2.3 存储与后端

| 系统 | 存储介质 | 向量检索 | 全文检索 | 可替换性 |
|------|----------|----------|----------|----------|
| TencentDB-Agent-Memory | SQLite / TCVDB + JSONL 文件 | sqlite-vec / TCVDB | SQLite FTS5 | 可切换后端 |
| Hermes Agent | 各 Provider 自定（文件/DB/云服务） | Provider 自定 | Provider 自定 | 8+ Provider 可选 |
| OpenClaw | Markdown 文件 | 可配置嵌入 Provider | 关键词搜索 | 插件化 |

TencentDB-Agent-Memory 和 Hermes Agent 都支持多后端，但策略不同：
- TencentDB-Agent-Memory 在同一插件内支持 SQLite 和 TCVDB 切换
- Hermes Agent 通过不同 Provider 覆盖不同后端，不支持同实例切换

---

## 3. 召回机制对比

### 3.1 召回时机

| 系统 | 召回时机 | 实现方式 |
|------|----------|----------|
| TencentDB-Agent-Memory | `handleBeforeRecall` (turn 前) | OpenClaw `before_prompt_build` / Hermes `prefetch()` |
| Hermes Agent | `prefetch(query, session_id)` | Provider 各自实现 |
| OpenClaw | 工具调用 `memory_search` | 插件提供 `memory_search` 工具 |

TencentDB-Agent-Memory 的 `TdaiCore` 统一了 OpenClaw 和 Hermes 的召回时机映射：

```typescript
// OpenClaw path
await core.handleBeforeRecall("user query", "session-1");

// Hermes path (via prefetch hook)
const recall = await core.handleBeforeRecall(userText, sessionKey);
```

### 3.2 召回策略

**TencentDB-Agent-Memory — 三段混合召回**

```
query → BM25 关键词召回
      → 向量语义召回
      → RRF (Reciprocal Rank Fusion) 融合
      → L2 Scenario / L3 Persona 注入
```

可配置为纯关键词、纯语义或混合模式。recall 层级支持：
- `type: "persona"` — 用户画像召回
- `type: "episodic"` — 场景块召回
- `type: "instruction"` — 指令类召回

**Hermes Agent — Provider 决定**

召回策略完全取决于激活的 Memory Provider：
- Honcho：跨会话语义检索 + Dialectic Q&A
- Holographic：HRR 代数向量检索
- Hindsight：知识图谱 + 多策略（semantic/entity/temporal）
- Mem0：服务端 LLM 自动提取

**OpenClaw — 语义 + 关键词双驱**

- 嵌入 Provider 自动检测（OpenAI/Gemini/Voyage/Mistral）
- hybrid search 融合向量和关键词结果

### 3.3 溯源能力

**TencentDB-Agent-Memory 的链路完整性**

```
L3 Persona → L2 Scenario → L1 Atom → L0 Conversation
     ↓            ↓            ↓           ↓
  persona.md  *.md (scene)   JSONL     refs/*.md
```

任何一条记忆都可完整回溯到原始证据，这是其核心设计承诺。

**Hermes Agent 的文件级溯源**

```
MEMORY.md / USER.md → Session Search (SQLite FTS5) → 原始对话
```

通过 `session_search` 工具可跨会话检索，但分层链路不如 TencentDB 完整。

**OpenClaw 的直接文件访问**

```
memory/YYYY-MM-DD.md → 原始条目
```

工具 `memory_get` 可按文件/行号读取，无中间抽象层。

---

## 4. 插件生态与集成

### 4.1 Hermes Agent 的 Provider 生态

```
MemoryManager (编排器)
├── BuiltinMemoryProvider (始终激活)
└── ONE External Provider (8 选 1)
    ├── Honcho          (AI-native 用户建模)
    ├── Holographic     (本地 SQLite + HRR)
    ├── Hindsight       (知识图谱)
    ├── OpenViking      (文件系统知识库)
    ├── Mem0            (服务端自动提取)
    ├── RetainDB        (云端持久化)
    ├── ByteRover       (待研究)
    └── SuperMemory     (待研究)
```

**约束设计**：只允许一个外部 Provider，防止工具模式膨胀和后端冲突。

### 4.2 TencentDB-Agent-Memory 的双端适配

```
OpenClaw (Python)
    ↓ 插件安装
memory-tencentdb 插件
    ↓ HTTP (127.0.0.1:8420)
memory-tencentdb Gateway (Node.js)
    ↓
TdaiCore (L0→L1→L2→L3 管道)
```

对 Hermes 的集成通过 `MemoryTencentdbProvider`（Python 薄封装 + HTTP 客户端）实现：

- Gateway 启动：`GatewaySupervisor` 自动发现 + `Popen` 拉起
- 健康检查：30s 轮询 `/health`
- 断路器：5 次连续失败后暂停 60s
- 背压控制：最多 4 个 in-flight `sync_turn` 线程

### 4.3 OpenClaw 的插件体系

```
Active Memory Plugin (memory-core)
    ↓ 提供
├── memory_search (语义+关键词)
├── memory_get (文件读取)
└── memory/ 日频笔记

Memory Wiki Plugin (可选叠加)
    ↓ 提供
├── wiki_search / wiki_get / wiki_apply / wiki_lint
└── 编译流程：知识库化
```

OpenClaw 的记忆插件是内聚的，不像 Hermes 那样需要选择。

---

## 5. 核心技术创新点

### 5.1 TencentDB-Agent-Memory 的 Mermaid 符号图谱

将任务状态流转编码为 Mermaid 语法，而非 JSON 或自然语言：

```
graph LR
 Log["繁杂日志"] -->|"卸载"| FS["外部 FS"]
 Log -->|"提取"| MMD["Mermaid 图谱"]
 MMD -->|"轻注"| Agent["Agent 上下文"]
 Agent -.->|"node_id 溯源"| FS
```

优势：
- Mermaid 既是 LLM 可读的符号，也是人类可读的结构化图
- 上下文仅保留拓扑关系，原文按需加载
- Token 消耗从"数十万"降至"几百"

### 5.2 Hermes Agent 的冻结快照模式

Session 启动时捕获系统 prompt 快照，对话期间不更新：

```python
def load_from_disk(self):
    self.memory_entries = self._read_file(mem_dir / "MEMORY.md")
    self.user_entries = self._read_file(mem_dir / "USER.md")
    # 冻结快照 - session 生命周期内不变
    self._system_prompt_snapshot = {
        "memory": self._render_block("memory", self.memory_entries),
        "user": self._render_block("user", self.user_entries),
    }
```

目的：保证 prefix cache 命中率，避免对话过程中 prompt 变化导致 cache miss。

### 5.3 渐进式披露与异构存储

TencentDB-Agent-Memory 提出"低层保留证据，高层保留结构"：

| 层级 | 存储介质 | 用途 |
|------|----------|------|
| L0/L1 | SQLite 数据库 + JSONL | 全量检索 + 证据保留 |
| L2/L3 | Markdown 文件 | 信息密度 + 白盒调试 |

这解决了"压缩即丢失"的矛盾——摘要不替代原文，而是索引原文。

---

## 6. 量化效果对比

| 系统 | Benchmark | 成功率变化 | Token 变化 |
|------|-----------|------------|------------|
| TencentDB-Agent-Memory | WideSearch (短期) | +51.52% | -61.38% |
| TencentDB-Agent-Memory | SWE-bench (短期) | +9.93% | -33.09% |
| TencentDB-Agent-Memory | PersonaMem (长期) | +59% (48%→76%) | — |
| Hermes Agent | 未公布 | — | — |
| OpenClaw | 未公布 | — | — |

TencentDB-Agent-Memory 提供了最详细的量化数据，展示了 61.38% Token 节省和 51.52% 成功率提升。

---

## 7. 工程完整性对比

| 维度 | TencentDB-Agent-Memory | Hermes Agent | OpenClaw |
|------|------------------------|--------------|----------|
| **CLI 管理工具** | `memory-tencentdb-ctl` | `hermes memory` | `openclaw memory` |
| **配置层级** | Level 1/2/3 渐进 | 单一 YAML | 插件配置 JSON |
| **断路器/背压** | ✅ 内置 | Provider 自定 | 插件自定 |
| **多端适配** | OpenClaw + Hermes | 原生 | 原生 |
| **技能生成 (Roadmap)** | 规划中 | Provider 生态 | 插件 |
| **可视化调试** | 规划中 | 日志 | 文件直读 |

---

## 8. 设计哲学总结

| 系统 | 核心哲学 | 解决的问题 |
|------|----------|------------|
| **TencentDB-Agent-Memory** | "分层+符号化" | 信息过载 + 证据丢失 + 幻觉 |
| **Hermes Agent** | "插件生态+冻结快照" | prefix cache + 后端多样性 |
| **OpenClaw** | "朴素文件+白盒可读" | 复杂度 + 可调试性 |

**TencentDB-Agent-Memory** 最适合追求极致 Token 效率和量化指标的生产部署；**Hermes Agent** 最适合需要灵活切换记忆后端或深度定制记忆逻辑的场景；**OpenClaw** 最适合追求简单、无外部依赖、可完全白盒掌控的小型团队。

---

## 9. 对 pi-coding-agent 的借鉴意义

1. **Mermaid 符号图谱**：可用于任务状态压缩，大幅降低长任务的 token 消耗
2. **四层记忆分层**：长期记忆（L3 Persona）和短期任务（L0-L2）共用框架，设计更统一
3. **node_id 溯源机制**：保持"压缩不丢证据"的能力，对调试和幻觉治理很有价值
4. **异构存储**：数据库存原始证据，文件系统存抽象结构，兼顾检索效率和可读性
5. **断路器+背压**：生产级可靠性设计，防止外部记忆服务故障级联影响主流程

---

*研究文档完成*
