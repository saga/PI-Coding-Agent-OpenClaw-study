# Hermes Agent vs OpenClaw Memory 实现对比研究

**研究日期**: 2026-04-16  
**研究对象**: 
- Hermes Agent (https://github.com/NousResearch/hermes-agent)
- OpenClaw (https://github.com/openclaw/openclaw)

---

## 执行摘要

Hermes Agent 和 OpenClaw 都实现了持久化记忆系统，但在架构设计、实现细节和用户体验上存在显著差异。**Hermes Agent 被认为"更好用"的核心原因在于**：

1. **清晰的记忆分层**：MEMORY.md + USER.md 双存储，职责明确
2. **严格的容量管理**：字符级别限制（2200/1375 chars），强制保持记忆质量
3. **冻结快照模式**：系统 prompt 在 session 启动时捕获，保持 prefix cache 稳定
4. **插件化 Memory Provider 架构**：支持 8+ 外部记忆提供商（Honcho、OpenViking、Mem0 等）
5. **完整的 Session Search**：SQLite FTS5 全文搜索 + LLM 摘要，支持跨会话召回
6. **主动保存机制**：Agent 被训练为主动保存，无需用户提醒

---

## 一、Hermes Agent Memory 架构

### 1.1 核心设计

Hermes Agent 采用**双层记忆 + 外部 Provider**的架构：

```
┌─────────────────────────────────────────────────────────┐
│                   System Prompt                          │
│  ┌───────────────────────────────────────────────────┐  │
│  │ MEMORY.md (2200 chars)                            │  │
│  │ - 环境事实、项目约定、工具技巧、已完成任务        │  │
│  │ - 使用率：67% — 1,474/2,200 chars                 │  │
│  └───────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────┐  │
│  │ USER.md (1375 chars)                              │  │
│  │ - 用户偏好、沟通风格、期望                        │  │
│  │ - 使用率：45% — 620/1,375 chars                   │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────┐
│              MemoryManager (Orchestrator)               │
│  - BuiltinMemoryProvider (always active)                │
│  - ONE External Provider (Honcho/OpenViking/Mem0...)    │
└─────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────┐
│              Session Search (SQLite FTS5)               │
│  - 所有会话历史存储在 ~/.hermes/state.db                │
│  - FTS5 全文索引                                        │
│  - LLM 摘要生成                                         │
└─────────────────────────────────────────────────────────┘
```

### 1.2 记忆存储细节

**文件位置**: `~/.hermes/memories/`

| 文件 | 用途 | 字符限制 | 典型条目数 |
|------|------|----------|-----------|
| MEMORY.md | Agent 的个人笔记 | 2,200 chars (~800 tokens) | 8-15 条 |
| USER.md | 用户画像 | 1,375 chars (~500 tokens) | 5-10 条 |

**条目分隔符**: `§` (section sign)

**示例格式**:
```
══════════════════════════════════════════════
MEMORY (your personal notes) [67% — 1,474/2,200 chars]
══════════════════════════════════════════════
User's project is a Rust web service at ~/code/myapi using Axum + SQLx
§
This machine runs Ubuntu 22.04, has Docker and Podman installed
§
User prefers concise responses, dislikes verbose explanations
```

### 1.3 冻结快照模式 (Frozen Snapshot Pattern)

这是 Hermes Agent 的核心创新之一：

```python
class MemoryStore:
    def __init__(self):
        self.memory_entries: List[str] = []
        self.user_entries: List[str] = []
        # Frozen snapshot for system prompt -- set once at load_from_disk()
        self._system_prompt_snapshot: Dict[str, str] = {"memory": "", "user": ""}

    def load_from_disk(self):
        """Load entries from disk, capture system prompt snapshot."""
        self.memory_entries = self._read_file(mem_dir / "MEMORY.md")
        self.user_entries = self._read_file(mem_dir / "USER.md")
        
        # Capture frozen snapshot for system prompt injection
        self._system_prompt_snapshot = {
            "memory": self._render_block("memory", self.memory_entries),
            "user": self._render_block("user", self.user_entries),
        }

    def format_for_system_prompt(self, target: str) -> Optional[str]:
        """
        Return the frozen snapshot for system prompt injection.
        
        This returns the state captured at load_from_disk() time, 
        NOT the live state. Mid-session writes do not affect this.
        This keeps the system prompt stable across all turns, 
        preserving the prefix cache.
        """
        return self._system_prompt_snapshot.get(target, "")
```

**关键优势**:
- 系统 prompt 在整个 session 中保持稳定
- 保持 LLM 的 prefix cache，减少重复计算
- 中间写入会立即持久化到磁盘，但不会改变系统 prompt
- 工具响应始终显示实时状态

### 1.4 Memory 工具操作

Hermes 提供单一的 `memory` 工具，支持三种操作：

```python
MEMORY_SCHEMA = {
    "name": "memory",
    "description": "Save durable information to persistent memory...",
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["add", "replace", "remove"]},
            "target": {"type": "string", "enum": ["memory", "user"]},
            "content": {"type": "string"},  # 用于 add 和 replace
            "old_text": {"type": "string"},  # 用于 replace 和 remove
        },
        "required": ["action", "target"],
    },
}
```

** substring matching**: replace 和 remove 操作使用短唯一子串匹配，无需完整文本：

```python
# 如果 memory 包含 "User prefers dark mode in all editors"
memory(action="replace", target="memory",
       old_text="dark mode",
       content="User prefers light mode in VS Code, dark mode in terminal")
```

### 1.5 容量管理

**严格的字符限制**（非 token 数，因为字符数与模型无关）：

| Store | 限制 | 使用率警告 |
|-------|------|-----------|
| memory | 2,200 chars | >80% 时应合并条目 |
| user | 1,375 chars | >80% 时应合并条目 |

**满额时的错误响应**:
```json
{
  "success": false,
  "error": "Memory at 2,100/2,200 chars. Adding this entry (250 chars) would exceed the limit. Replace or remove existing entries first.",
  "current_entries": ["..."],
  "usage": "2,100/2,200"
}
```

**最佳实践**:
- 80% 容量时开始合并相关条目
- 将 3 条分散的 "project uses X" 合并为一条综合描述
- 使用密度高、信息量大的条目

### 1.6 安全扫描

由于记忆会被注入到系统 prompt，Hermes 在写入前会扫描：

```python
def _scan_memory_content(content: str) -> Optional[str]:
    """Scan for injection/exfiltration patterns."""
    # 扫描 prompt injection 模式
    # 扫描凭证外泄模式
    # 扫描 SSH 后门模式
    # 扫描不可见 Unicode 字符
    return None  # 或返回错误消息
```

### 1.7 Session Search

除了 MEMORY.md 和 USER.md，Hermes 还提供 `session_search` 工具：

**存储**: SQLite 数据库 `~/.hermes/state.db`
**索引**: FTS5 全文搜索
**功能**: 
- 搜索过去的对话
- Gemini Flash 摘要生成
- 跨会话召回

**对比**:

| 特性 | Persistent Memory | Session Search |
|------|------------------|----------------|
| 容量 | ~1,300 tokens | 无限制（所有会话） |
| 速度 | 即时（在系统 prompt 中） | 需要搜索 + LLM 摘要 |
| 用例 | 关键事实始终可用 | 查找特定过去对话 |
| 管理 | Agent 手动策划 | 自动存储所有会话 |
| Token 成本 | 每 session 固定 (~1,300) | 按需（搜索时产生） |

---

## 二、OpenClaw Memory 架构

### 2.1 记忆分层

根据研究文档，OpenClaw 采用三层记忆结构：

| 层级 | 存储位置 | 作用 |
|------|----------|------|
| 短期记忆 | `memory/YYYY-MM-DD.md` | 每日追加日志，启动时加载今天 + 昨天 |
| 长期记忆 | `MEMORY.md` | 用户偏好、长期目标、关键事实 |
| 会话记忆 | `sessions/YYYY-MM-DD-{slug}.md` | 每次会话归档，支持跨会话检索 |

### 2.2 技术特点

根据现有研究文档：

- **本地优先**: Markdown + SQLite（FTS5 + sqlite-vec）
- **混合检索**: 70% 向量相似度 + 30% BM25 关键词匹配
- **自动 Flush**: 上下文接近阈值时自动沉淀关键信息

### 2.3 记忆搜索工具

根据研究文档，OpenClaw 提供：

```typescript
// memory_search - 语义搜索
export function createMemorySearchTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  return {
    name: "memory_search",
    description: "Mandatory recall step: semantically search MEMORY.md...",
    parameters: MemorySearchSchema,
    execute: async (_toolCallId, params) => {
      const { manager } = await getMemorySearchManager({ cfg, agentId });
      const results = await manager.search(query, {
        maxResults,
        minScore,
        sessionKey: options.agentSessionKey,
      });
      return jsonResult({ results, provider: status.provider, ... });
    },
  };
}

// memory_get - 精确读取
export function createMemoryGetTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  return {
    name: "memory_get",
    description: "Safe snippet read from MEMORY.md...",
    parameters: MemoryGetSchema,
    execute: async (_toolCallId, params) => {
      const result = await manager.readFile({ relPath, from, lines });
      return jsonResult(result);
    },
  };
}
```

### 2.4 向量索引支持

根据文档，OpenClaw 可以构建向量索引：

```
"OpenClaw can build a small vector index over MEMORY.md and memory/*.md 
so semantic queries can find related notes even when wording differs."
```

---

## 三、架构对比分析

### 3.1 核心差异

| 维度 | Hermes Agent | OpenClaw |
|------|-------------|----------|
| **记忆存储** | 双文件（MEMORY.md + USER.md） | 多文件（MEMORY.md + memory/*.md + sessions/*.md） |
| **容量限制** | 严格字符限制（2200/1375） | 未明确限制，依赖 truncate 机制 |
| **系统 prompt 注入** | 冻结快照（session 启动时捕获） | 动态加载（每次 session 重新读取） |
| **外部 Provider** | 支持 8+ 插件（Honcho, OpenViking, Mem0 等） | 未明确支持 |
| **Session 搜索** | SQLite FTS5 + LLM 摘要 | SQLite + 向量索引（可选） |
| **记忆操作** | 单一工具（add/replace/remove） | 多工具（memory_search, memory_get） |
| ** substring matching** | ✅ 支持 | ❌ 需要完整路径或行号 |

### 3.2 Memory Provider 架构对比

**Hermes Agent**:
```python
class MemoryManager:
    """Orchestrates the built-in provider plus at most one external provider."""
    
    def add_provider(self, provider: MemoryProvider) -> None:
        # Built-in provider always first
        # Only ONE external provider allowed
```

**优势**:
- 插件化架构，易于扩展
- 支持 Honcho、OpenViking、Mem0、Hindsight、Holographic、RetainDB、ByteRover、Supermemory
- 外部 Provider 与内置记忆并行运行（不替换）
- 提供知识图谱、语义搜索、自动事实提取、跨会话用户建模

**OpenClaw**:
- 根据现有文档，未发现类似的插件化 Provider 架构
- 记忆功能似乎更紧密集成到核心代码中

### 3.3 Session 持久化对比

**Hermes Agent**:
- SQLite 数据库存储所有会话
- FTS5 全文索引
- 支持 lineage tracking（跨压缩/恢复的父子关系）
- 每平台隔离（CLI、Telegram、Discord 等）
- 原子写入，处理竞争

**OpenClaw**:
- Markdown 文件存储会话（sessions/YYYY-MM-DD-{slug}.md）
- 可选 SQLite + sqlite-vec 向量索引
- 支持会话归档和检索

### 3.4 容量管理对比

**Hermes Agent**:
- 硬性字符限制
- 满额时拒绝写入，要求先合并/删除
- 使用率百分比显示在系统 prompt 中
- 强制保持记忆质量

**OpenClaw**:
- 根据文档，MEMORY.md 默认会被注入到系统 prompt
- 大文件会被 truncate（默认 20000 字符）
- 总注入量有上限（默认 150000 字符）
- 更宽松，但可能导致 token 浪费

---

## 四、为什么 Hermes Agent 感觉更好用？

### 4.1 设计哲学差异

**Hermes Agent**: "少即是多"
- 严格的容量限制强制保持记忆质量
- 清晰的职责分离（MEMORY.md vs USER.md）
- 冻结快照模式保持性能稳定
- 插件化架构允许按需扩展

**OpenClaw**: "更多可能性"
- 多层记忆结构（短期/长期/会话）
- 更宽松的容量管理
- 向量索引支持语义搜索
- 更复杂，但也更灵活

### 4.2 用户体验优势

#### 4.2.1 主动保存机制

Hermes Agent 的 `memory` 工具描述中明确指导 Agent 何时保存：

```
WHEN TO SAVE (do this proactively, don't wait to be asked):
- User corrects you or says 'remember this' / 'don't do that again'
- User shares a preference, habit, or personal detail
- You discover something about the environment
- You learn a convention, API quirk, or workflow specific to this user's setup
- You identify a stable fact that will be useful again in future sessions

PRIORITY: User preferences and corrections > environment facts > procedural knowledge.
The most valuable memory prevents the user from having to repeat themselves.
```

**效果**: Agent 被训练为主动保存，无需用户提醒。

#### 4.2.2 清晰的容量反馈

Hermes 在系统 prompt 中显示：
```
MEMORY (your personal notes) [67% — 1,474/2,200 chars]
```

**效果**: 
- Agent 清楚知道当前容量
- 用户也能看到记忆使用状态
- 80% 时触发合并建议

#### 4.2.3  substring matching

Hermes 的 replace/remove 操作：
```python
memory(action="replace", target="memory",
       old_text="dark mode",  # 短子串即可
       content="...")
```

**效果**: 
- 无需记住完整条目文本
- 降低使用门槛
- 提高操作效率

#### 4.2.4 冻结快照模式

**优势**:
- 系统 prompt 在整个 session 中稳定
- 保持 LLM prefix cache，减少重复计算
- 中间写入不影响当前 session 的上下文
- 工具响应显示实时状态

#### 4.2.5 插件化 Provider

**优势**:
- 支持 8+ 外部记忆提供商
- 按需选择（Honcho 用于知识图谱，RetainDB 用于混合搜索等）
- 不替换内置记忆，而是增强
- 统一的 MemoryManager 接口

### 4.3 技术优势

#### 4.3.1 SQLite FTS5 vs 向量索引

**Hermes (FTS5)**:
- 成熟稳定，SQLite 内置
- 关键词匹配精确
- 无需额外依赖
- 搜索速度快

**OpenClaw (向量索引)**:
- 需要 sqlite-vec 或其他向量数据库
- 语义相似度搜索
- 可能找到措辞不同但语义相关的内容
- 需要 embedding 模型

**实际体验**: FTS5 对于精确查找更可靠，向量搜索可能返回不相关结果。

#### 4.3.2 Session Search 集成

**Hermes**:
- `session_search` 工具直接可用
- LLM 摘要生成
- 跨会话召回
- 当前 session 自动排除

**OpenClaw**:
- 根据文档，需要配置向量索引
- 依赖外部 embedding 模型
- 更复杂的设置

### 4.4 安全性对比

**Hermes Agent**:
- 写入前扫描 injection/exfiltration 模式
- 扫描不可见 Unicode 字符
- 文件锁防止并发写入冲突

**OpenClaw**:
- 根据现有文档，未发现类似的安全扫描机制

---

## 五、代码质量对比

### 5.1 Hermes Agent

**代码组织**:
```
hermes-agent-source-code/
├── agent/
│   ├── memory_manager.py      # 核心编排器
│   ├── memory_provider.py     # 抽象基类
│   └── ...
├── tools/
│   └── memory_tool.py         # 内置记忆工具
├── plugins/memory/
│   ├── honcho/
│   ├── openviking/
│   ├── mem0/
│   ├── hindsight/
│   ├── holographic/
│   ├── retaindb/
│   ├── byterover/
│   └── supermemory/
└── tests/
    ├── tools/test_session_search.py
    └── ...
```

**代码质量**:
- 完善的类型注解
- 详细的文档字符串
- 全面的单元测试
- 清晰的职责分离

### 5.2 OpenClaw

根据研究文档，OpenClaw 的记忆模块分布在：
- `src/memory/` - 核心记忆管理
- `extensions/memory-*/` - 记忆扩展
- `tools/memory-tool.ts` - 记忆工具

**代码质量**:
- TypeScript 实现
- 模块化设计
- 但根据现有文档，代码组织不如 Hermes 清晰

---

## 六、实际使用场景对比

### 6.1 场景 1：用户分享偏好

**Hermes Agent**:
```
用户：我更喜欢 TypeScript 而不是 JavaScript

Agent: (主动调用 memory 工具)
memory(action="add", target="user", 
       content="User prefers TypeScript over JavaScript")

系统 prompt 更新（下次 session）:
USER PROFILE [45% — 620/1,375 chars]
User prefers TypeScript over JavaScript
```

**OpenClaw**:
```
用户：我更喜欢 TypeScript 而不是 JavaScript

Agent: (可能需要用户提醒，或写入 memory/YYYY-MM-DD.md)
写入到 memory/2026-04-16.md:
"- User prefers TypeScript over JavaScript"
```

**差异**: Hermes 更主动，直接存入长期记忆；OpenClaw 可能先写入短期日志。

### 6.2 场景 2：跨会话召回

**Hermes Agent**:
```
用户：我们上周讨论的 API 设计是什么？

Agent: (调用 session_search 工具)
session_search(query="API design discussion last week")

返回：
[Session 20260409_143052_abc123]
We discussed RESTful API design with these principles:
- Resource-based URLs
- HTTP verbs for actions
- JSON request/response bodies
- Status codes for errors
```

**OpenClaw**:
```
用户：我们上周讨论的 API 设计是什么？

Agent: (可能需要 memory_search 或手动查找 sessions/*.md)
memory_search(query="API design")

返回类似结果，但需要配置向量索引。
```

**差异**: Hermes 的 FTS5 更直接，OpenClaw 的向量搜索需要额外配置。

### 6.3 场景 3：记忆满额

**Hermes Agent**:
```
Agent: memory(action="add", target="memory", 
              content="New discovery about Docker networking")

返回:
{
  "success": false,
  "error": "Memory at 2,100/2,200 chars. Adding this entry (250 chars) 
           would exceed the limit. Replace or remove existing entries first.",
  "current_entries": ["...", "...", "..."],
  "usage": "2,100/2,200"
}

Agent: (自动合并相关条目，然后重试)
memory(action="replace", target="memory",
       old_text="Docker basic",
       content="Docker networking uses bridge network by default. 
                Port mapping: -p host:container. Volume mounts: -v src:dst")
memory(action="add", target="memory", 
       content="New discovery about Docker networking")
```

**OpenClaw**:
```
Agent: (写入 MEMORY.md，可能触发 truncate)
如果超过 20000 字符，文件会被截断。
```

**差异**: Hermes 强制 Agent 主动管理记忆质量；OpenClaw 被动截断。

---

## 七、总结与建议

### 7.1 Hermes Agent 的优势

1. **清晰的架构**: 双存储 + 插件化 Provider
2. **严格的容量管理**: 强制保持记忆质量
3. **冻结快照模式**: 性能优化，prefix cache 稳定
4. **主动保存机制**: Agent 被训练为主动保存
5. ** substring matching**: 降低使用门槛
6. **完善的 Session Search**: FTS5 + LLM 摘要
7. **安全性**: 写入前扫描威胁模式
8. **插件生态**: 8+ 外部 Provider 可选

### 7.2 OpenClaw 的特点

1. **多层记忆**: 短期/长期/会话三层结构
2. **向量索引**: 支持语义搜索（需配置）
3. **更宽松**: 容量管理更灵活
4. **Markdown 优先**: 会话存储为 Markdown 文件

### 7.3 为什么 Hermes Agent 感觉更好用？

**核心原因**:
1. **主动性**: Agent 被训练为主动保存，无需用户提醒
2. **清晰反馈**: 系统 prompt 中显示容量使用率
3. **简单操作**: substring matching 降低使用难度
4. **稳定性能**: 冻结快照模式保持 prefix cache
5. **可扩展性**: 插件化 Provider 按需增强
6. **质量保证**: 严格容量限制强制保持记忆精炼

### 7.4 对 OpenClaw 的改进建议

基于 Hermes Agent 的优势，建议 OpenClaw 考虑：

1. **引入主动保存机制**: 在系统 prompt 中明确指导 Agent 何时保存
2. **添加容量反馈**: 在系统 prompt 中显示 MEMORY.md 使用率
3. **实现 substring matching**: 简化 replace/remove 操作
4. **考虑冻结快照**: 优化 prefix cache，提升性能
5. **插件化 Provider**: 支持外部记忆服务
6. **安全扫描**: 写入前扫描 injection/exfiltration 模式
7. **统一 MemoryManager**: 简化记忆管理接口

---

## 八、参考资料

### Hermes Agent
- [Persistent Memory Documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- [Memory Tool Implementation](file:///Users/saga/code-repos/PI-Coding-Agent-OpenClaw-study/hermes-agent-source-code/tools/memory_tool.py)
- [Memory Manager Implementation](file:///Users/saga/code-repos/PI-Coding-Agent-OpenClaw-study/hermes-agent-source-code/agent/memory_manager.py)
- [Memory Provider Base Class](file:///Users/saga/code-repos/PI-Coding-Agent-OpenClaw-study/hermes-agent-source-code/agent/memory_provider.py)
- [Session Search Tests](file:///Users/saga/code-repos/PI-Coding-Agent-OpenClaw-study/hermes-agent-source-code/tests/tools/test_session_search.py)

### OpenClaw
- [Memory System Analysis](file:///Users/saga/code-repos/PI-Coding-Agent-OpenClaw-study/minimax-studydoc/openclaw研究/_dev_doc_kimi25/memory_md_optimization_analysis.md)
- [Compaction vs Retrieval Analysis](file:///Users/saga/code-repos/PI-Coding-Agent-OpenClaw-study/minimax-studydoc/openclaw研究/_dev_doc_kimi25/compaction_vs_retrieval_analysis.md)
- [Coding Agent Server Memory Analysis](file:///Users/saga/code-repos/PI-Coding-Agent-OpenClaw-study/glm5-studydoc/coding-agent-server/MEMORY-ANALYSIS.md)

---

**研究结论**: Hermes Agent 通过清晰的设计、严格的容量管理、主动保存机制和插件化架构，提供了更好的用户体验。OpenClaw 虽然在技术上有其特点（如向量索引），但在用户友好性和主动性方面还有改进空间。
