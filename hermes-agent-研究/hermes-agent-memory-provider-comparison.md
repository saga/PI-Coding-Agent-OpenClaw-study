# Hermes Agent Memory Provider 架构对比研究

## 1. 概述

Hermes Agent 实现了一个高度插件化的 Memory Provider 架构，支持 8+ 外部记忆提供商，同时保持内置的 MEMORY.md 和 USER.md 基础记忆系统。该架构的核心设计理念是：**单一外部 Provider 并发 + 内置记忆常开**。

## 2. 核心架构设计

### 2.1 三层架构

```
┌─────────────────────────────────────────────────────┐
│              Application Layer (run_agent.py)        │
│  - MemoryManager 统一管理                            │
│  - 生命周期调用（initialize/prefetch/sync/shutdown） │
└─────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────┐
│           Orchestration Layer (MemoryManager)        │
│  - 管理 Builtin Provider + 1 个 External Provider     │
│  - 工具路由（tool_name → provider）                  │
│  - 系统 prompt 组装                                   │
│  - 错误隔离（一个 provider 失败不影响其他）            │
└─────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────┐
│          Provider Layer (MemoryProvider ABC)         │
│  - BuiltinMemoryProvider（始终激活）                 │
│  - External Providers（8+ 插件，只能激活 1 个）         │
└─────────────────────────────────────────────────────┘
```

### 2.2 MemoryProvider 抽象基类

[MemoryProvider](file:///Users/saga/code-repos/PI-Coding-Agent-OpenClaw-study/hermes-agent-source-code/agent/memory_provider.py#L36-L208) 定义了所有 Memory Provider 必须实现的核心接口：

```python
class MemoryProvider(ABC):
    # 核心属性
    @property
    @abstractmethod
    def name(self) -> str: ...
    
    # 核心生命周期方法
    @abstractmethod
    def is_available(self) -> bool: ...
    @abstractmethod
    def initialize(self, session_id: str, **kwargs) -> None: ...
    def system_prompt_block(self) -> str: ...
    def prefetch(self, query: str, *, session_id: str = "") -> str: ...
    def sync_turn(self, user_content: str, assistant_content: str, ...) -> None: ...
    @abstractmethod
    def get_tool_schemas(self) -> List[Dict[str, Any]]: ...
    def handle_tool_call(self, tool_name: str, args: Dict, **kwargs) -> str: ...
    def shutdown(self) -> None: ...
    
    # 可选钩子（按需实现）
    def on_turn_start(self, turn_number: int, message: str, **kwargs) -> None: ...
    def on_session_end(self, messages: List[Dict]) -> None: ...
    def on_pre_compress(self, messages: List[Dict]) -> str: ...
    def on_memory_write(self, action: str, target: str, content: str) -> None: ...
    def on_delegation(self, task: str, result: str, **kwargs) -> None: ...
```

**关键设计点：**

1. **is_available() 不做网络调用**：仅检查配置和依赖，确保快速判断
2. **initialize() 支持多场景**：通过 kwargs 传递 hermes_home、platform、agent_context 等
3. **prefetch() 支持后台线程**：provider 可在 queue_prefetch() 中异步预取
4. **工具路由集中管理**：MemoryManager 维护 tool_name → provider 映射

### 2.3 MemoryManager 编排器

[MemoryManager](file:///Users/saga/code-repos/PI-Coding-Agent-OpenClaw-study/hermes-agent-source-code/agent/memory_manager.py#L62-L328) 负责管理所有 Provider 的生命周期和工具路由：

```python
class MemoryManager:
    def __init__(self) -> None:
        self._providers: List[MemoryProvider] = []
        self._tool_to_provider: Dict[str, MemoryProvider] = {}
        self._has_external: bool = False  # 标记是否已有外部 Provider
    
    def add_provider(self, provider: MemoryProvider) -> None:
        """注册 Provider，只允许 1 个外部 Provider"""
        is_builtin = provider.name == "builtin"
        
        if not is_builtin:
            if self._has_external:
                # 拒绝第二个外部 Provider
                logger.warning("Rejected memory provider '%s'...", provider.name)
                return
            self._has_external = True
        
        # 索引工具名称用于路由
        for schema in provider.get_tool_schemas():
            tool_name = schema.get("name", "")
            self._tool_to_provider[tool_name] = provider
```

**关键约束：**

- **Builtin Provider 始终第一**：不可移除
- **仅允许 1 个 External Provider**：防止工具模式膨胀和后端冲突
- **错误隔离**：单个 Provider 失败不影响其他 Provider

## 3. 插件发现与加载机制

### 3.1 双层插件目录

```
plugins/memory/                # 内置插件（随包分发）
├── honcho/
├── mem0/
├── hindsight/
├── holographic/
├── openviking/
├── retaindb/
├── byterover/
└── supermemory/

$HERMES_HOME/plugins/          # 用户安装插件（profile 隔离）
└── my-custom-provider/
```

### 3.2 发现流程

[plugins.memory.__init__](file:///Users/saga/code-repos/PI-Coding-Agent-OpenClaw-study/hermes-agent-source-code/plugins/memory/__init__.py) 实现了插件发现：

```python
def discover_memory_providers() -> List[Tuple[str, str, bool]]:
    """扫描内置和用户目录，返回 (name, description, is_available)"""
    results = []
    for name, child in _iter_provider_dirs():
        # 读取 plugin.yaml 获取描述
        # 调用 is_available() 检查可用性
        results.append((name, desc, available))
    return results

def load_memory_provider(name: str) -> Optional[MemoryProvider]:
    """加载 Provider 实例"""
    provider_dir = find_provider_dir(name)
    return _load_provider_from_dir(provider_dir)
```

**注册模式：**

- **插件风格**：`register(ctx)` 函数，模拟 ctx 调用
- **类风格**：直接实例化继承 MemoryProvider 的类

### 3.3 配置与激活

**配置位置：** `~/.hermes/config.yaml`

```yaml
memory:
  provider: honcho  # 或 mem0, hindsight, holographic 等
```

**激活命令：**

```bash
hermes memory setup      # 交互式选择 + 配置
hermes memory status     # 查看当前激活的 Provider
hermes memory off        # 禁用外部 Provider
```

**自动迁移逻辑：**

如果检测到 Honcho 已配置（有 API key 或 base_url）但未设置 `memory.provider`，会自动激活 Honcho 插件并持久化配置。

## 4. 8 大 Memory Provider 详细对比

### 4.1 Honcho

**定位：** AI-native 跨会话用户建模

**架构特点：**

```python
class HonchoMemoryProvider(MemoryProvider):
    def initialize(self, session_id: str, **kwargs) -> None:
        # 1. cron guard：跳过 cron/flush 场景
        # 2. recall_mode 配置：context/tools/hybrid
        # 3. peer_name 覆盖：gateway 场景用 user_id
        # 4. lazy session init：tools-only 模式延迟初始化
        # 5. 会话预创建：get_or_create(session_key)
```

**核心能力：**

- **Dialectic Q&A**：LLM 驱动的辩证推理
- **Peer Cards**：用户/代理身份建模
- **语义搜索**：跨会话上下文检索
- **持久结论**：conclusion 工具存储事实

**配置链：** `$HERMES_HOME/honcho.json` → `~/.honcho/config.json`

**多 Agent 支持：**

每个 Hermes profile 对应一个 Honcho AI peer，共享 workspace：

```json
{
  "workspace": "hermes",
  "hosts": {
    "hermes": {"aiPeer": "hermes"},
    "hermes.coder": {"aiPeer": "coder"},
    "hermes.writer": {"aiPeer": "writer"}
  }
}
```

### 4.2 Holographic

**定位：** 本地 SQLite 事实存储 + HRR 代数检索

**架构特点：**

```python
class HolographicMemoryProvider(MemoryProvider):
    def initialize(self, session_id: str, **kwargs) -> None:
        self._store = MemoryStore(
            db_path="$HERMES_HOME/memory_store.db",
            default_trust=0.5,
            hrr_dim=1024
        )
        self._retriever = FactRetriever(...)
```

**核心能力：**

- **9 种工具动作**：add/search/probe/related/reason/contradict/update/remove/list
- **实体解析**：probe 查询特定实体的所有事实
- **组合推理**：reason 支持多实体 AND 查询
- **信任评分**：fact_feedback 训练信任度（+0.05/-0.10）
- **HRR 代数**：向量空间中的组合查询

**独特优势：**

- **零外部依赖**：SQLite 始终可用，NumPy 可选
- **本地优先**：数据完全存储在 `$HERMES_HOME/`
- **自动提取**：session end 时可自动抽取事实

### 4.3 Hindsight

**定位：** 知识图谱 + 多策略检索

**架构特点：**

```python
class HindsightMemoryProvider(MemoryProvider):
    def initialize(self, session_id: str, **kwargs) -> None:
        # 支持 Cloud 或 Local 模式
        # Local 模式：嵌入式 PostgreSQL + LLM API
        # Cloud 模式：Hindsight 服务
```

**核心能力：**

- **知识图谱**：实体关系图
- **多策略检索**：semantic/entity/temporal 等
- **Reflect 合成**：跨记忆合成（其他 Provider 无此能力）
- **自动保留**：对话回合自动存储（含工具调用）

**配置模式：**

```json
{
  "mode": "cloud",  // 或 "local"
  "bank_id": "hermes",
  "recall_budget": "mid",  // low/mid/high
  "memory_mode": "hybrid"  // context/tools/hybrid
}
```

### 4.4 OpenViking

**定位：** 自托管知识库 + 文件系统层级

**架构特点：**

- **文件系统 URI**：`viking://folder/subfolder/note`
- **分层加载**：L0(~100 tokens) → L1(~2k) → L2(full)
- **自动分类**：6 类记忆（profile/preferences/entities/events/cases/patterns）

**工具集：**

- `viking_search`：语义搜索
- `viking_read`：分层读取
- `viking_browse`：文件系统导航
- `viking_remember`：存储事实
- `viking_add_resource`：导入 URL/文档

### 4.5 Mem0

**定位：** 服务端 LLM 自动事实提取

**架构特点：**

```python
class Mem0MemoryProvider(MemoryProvider):
    # 服务端处理：
    # 1. LLM 自动提取事实
    # 2. 语义去重
    # 3. Reranking 排序
```

**核心能力：**

- **免维护**：Mem0 处理所有提取逻辑
- **语义搜索 + Reranking**：高精度检索
- **自动去重**：避免重复事实

### 4.6 RetainDB

**定位：** 混合搜索 + 增量压缩

**架构特点：**

- **混合搜索**：Vector + BM25 + Reranking
- **7 种记忆类型**：结构化分类
- **增量压缩**：delta compression 节省存储

### 4.7 ByteRover

**定位：** CLI 驱动的本地优先记忆

**架构特点：**

```python
class ByteRoverMemoryProvider(MemoryProvider):
    # 通过 brv CLI 交互
    # 知识树层级结构
    # 预压缩提取：on_pre_compress 钩子
```

**核心能力：**

- **分层检索**：模糊文本 → LLM 驱动搜索
- **预压缩提取**：在上下文压缩前保存洞察
- **CLI 便携性**：`npm install -g byterover-cli`

### 4.8 Supermemory

**定位：** 语义记忆 + 会话图导入

**架构特点：**

```python
class SupermemoryMemoryProvider(MemoryProvider):
    # 1. Context Fencing：防止递归污染
    # 2. Session Graph：会话级图导入
    # 3. Multi-container：跨容器读写
```

**核心能力：**

- **上下文围栏**：剥离召回的记忆，防止递归污染
- **会话端导入**：session end 时导入图 API
- **多容器模式**：agent 可跨命名容器读写

**配置示例：**

```json
{
  "container_tag": "hermes-{identity}",  // profile 隔离
  "enable_custom_container_tags": true,
  "custom_containers": ["project-alpha", "shared-knowledge"]
}
```

## 5. Provider 对比矩阵

| Provider | 存储方式 | 成本 | 工具数 | 依赖 | 独特能力 |
|----------|----------|------|--------|------|----------|
| **Honcho** | Cloud | 付费 | 4 | `honcho-ai` | Dialectic 用户建模 |
| **OpenViking** | Self-hosted | 免费 | 5 | `openviking` + server | 文件系统层级 + 分层加载 |
| **Mem0** | Cloud | 付费 | 3 | `mem0ai` | 服务端 LLM 提取 |
| **Hindsight** | Cloud/Local | 免费/付费 | 3 | `hindsight-client` | 知识图谱 + reflect 合成 |
| **Holographic** | Local | 免费 | 2 | 无 | HRR 代数 + 信任评分 |
| **RetainDB** | Cloud | $20/月 | 5 | `requests` | 增量压缩 |
| **ByteRover** | Local/Cloud | 免费/付费 | 3 | `brv` CLI | 预压缩提取 |
| **Supermemory** | Cloud | 付费 | 4 | `supermemory` | Context fencing + 会话图 + 多容器 |

## 6. Profile 隔离机制

每个 Provider 的数据按 Profile 隔离：

| Provider 类型 | 隔离方式 |
|---------------|----------|
| **本地存储** (Holographic, ByteRover) | `$HERMES_HOME/` 路径不同 |
| **配置文件** (Honcho, Mem0, Hindsight, Supermemory) | `$HERMES_HOME/` 下配置文件独立 |
| **云服务** (RetainDB) | 自动派生 profile 专属项目名 |
| **环境变量** (OpenViking) | 各 profile 的 `.env` 文件独立 |

## 7. 生命周期调用流程

```
Agent Init
    ↓
MemoryManager.add_provider(Builtin)
MemoryManager.add_provider(External)  # 仅 1 个
    ↓
initialize(session_id, hermes_home, platform, agent_context, user_id)
    ↓
每轮对话开始：
    on_turn_start(turn_number, message, **kwargs)
    prefetch(query) → 注入 <memory-context> 块
    ↓
每轮对话结束：
    sync_turn(user_content, assistant_content)
    queue_prefetch(query)  # 为下一轮预取
    ↓
会话结束：
    on_session_end(messages)
    shutdown()
```

**Context Fencing 机制：**

```python
def build_memory_context_block(raw_context: str) -> str:
    """用 XML 标签包裹召回的记忆，防止模型误认为用户输入"""
    return (
        "<memory-context>\n"
        "[System note: The following is recalled memory context, "
        "NOT new user input.]\n\n"
        f"{sanitize_context(raw_context)}\n"
        "</memory-context>"
    )
```

## 8. 工具路由机制

MemoryManager 维护工具名称到 Provider 的映射：

```python
def handle_tool_call(self, tool_name: str, args: Dict, **kwargs) -> str:
    provider = self._tool_to_provider.get(tool_name)
    if provider is None:
        return tool_error(f"No memory provider handles tool '{tool_name}'")
    return provider.handle_tool_call(tool_name, args, **kwargs)
```

**工具名冲突处理：**

- 先注册者优先
- 后注册的 Provider 工具会被忽略并记录警告

## 9. 配置管理

### 9.1 配置声明

Provider 通过 `get_config_schema()` 声明配置字段：

```python
def get_config_schema(self):
    return [
        {
            "key": "api_key",
            "description": "API key",
            "secret": True,        # 写入 .env
            "required": True,
            "env_var": "MY_API_KEY",
            "url": "https://provider.com/keys",
        },
        {
            "key": "region",
            "description": "Server region",
            "default": "us-east",
            "choices": ["us-east", "eu-west"],
        },
    ]
```

### 9.2 配置保存

```python
def save_config(self, values: dict, hermes_home: str) -> None:
    """保存非秘密配置到 Provider 原生位置"""
    config_path = Path(hermes_home) / "my-provider.json"
    config_path.write_text(json.dumps(values, indent=2))
```

**秘密字段**（`secret: True`）写入 `$HERMES_HOME/.env`，其他字段写入 Provider 原生配置文件。

## 10. 设计亮点总结

### 10.1 单一外部 Provider 约束

**优点：**

- 避免工具模式膨胀（每个 Provider 2-5 个工具）
- 防止多个后端冲突写入
- 简化用户选择（无需配置多个 Provider 的协调）

**代价：**

- 无法同时使用多个 Provider 的优势

### 10.2 Builtin + External 双层架构

**优点：**

- 内置记忆（MEMORY.md/USER.md）始终可用
- 外部 Provider 是增量增强，非替代
- 用户可随时切换 External Provider，内置记忆不受影响

### 10.3 错误隔离

MemoryManager 确保单个 Provider 失败不影响整体：

```python
for provider in self._providers:
    try:
        provider.prefetch(query, session_id=session_id)
    except Exception as e:
        logger.debug("Memory provider '%s' prefetch failed (non-fatal): %s", ...)
```

### 10.4 Profile 隔离

通过 `$HERMES_HOME` 路径实现天然隔离：

- 本地数据库路径：`$HERMES_HOME/memory_store.db`
- 配置文件：`$HERMES_HOME/honcho.json`
- 环境变量：`$HERMES_HOME/.env`

### 10.5 Context Fencing

用 XML 标签包裹召回的记忆，防止模型混淆：

```xml
<memory-context>
[System note: The following is recalled memory context, NOT new user input.]

- 用户偏好：喜欢简洁代码
- 项目信息：正在开发 X 项目
</memory-context>
```

## 11. 对 pi-coding-agent 的借鉴建议

### 11.1 架构层面

1. **采用 MemoryProvider ABC**：定义清晰的插件接口
2. **引入 MemoryManager 编排器**：统一管理生命周期和工具路由
3. **支持 Builtin + External 双层**：基础记忆 + 插件增强

### 11.2 插件机制

1. **双层插件目录**：内置插件 + 用户安装插件
2. **自动发现机制**：扫描插件目录，调用 `is_available()` 检查
3. **配置向导**：`hermes memory setup` 交互式配置

### 11.3 工具集成

1. **工具路由表**：tool_name → provider 映射
2. **工具名冲突检测**：先注册优先，警告后注册者
3. **工具 Schema 注入**：动态添加到模型工具列表

### 11.4 生命周期钩子

实现以下钩子支持高级功能：

- `on_turn_start`：每轮计数、范围管理
- `on_session_end`：会话级事实提取
- `on_pre_compress`：压缩前提取洞察
- `on_memory_write`：镜像内置记忆写入
- `on_delegation`：子代理任务观察

### 11.5 Profile 隔离

1. **HERMES_HOME 环境变量**：profile 专属目录
2. **配置文件 profile 化**：每个 profile 独立配置
3. **数据路径隔离**：本地数据库按 profile 分路径

## 12. 实现路线图

### 阶段 1：基础架构

1. 定义 MemoryProvider ABC
2. 实现 MemoryManager 编排器
3. 实现 BuiltinMemoryProvider（兼容现有 memory_tool）

### 阶段 2：插件系统

1. 实现插件发现机制
2. 实现插件加载器
3. 实现配置管理（get_config_schema/save_config）

### 阶段 3：工具集成

1. 实现工具路由表
2. 实现工具 Schema 动态注入
3. 实现工具名冲突检测

### 阶段 4：生命周期钩子

1. 实现 on_turn_start/on_session_end
2. 实现 on_pre_compress（配合上下文压缩）
3. 实现 on_memory_write（镜像写入）

### 阶段 5：Profile 隔离

1. 引入 HERMES_HOME 环境变量
2. 配置文件 profile 化
3. 数据路径隔离

### 阶段 6：示例 Provider

1. 实现 Holographic（本地 SQLite，零依赖）
2. 实现 Honcho（云服务，多 Agent 支持）
3. 实现 OpenViking（自托管，文件系统层级）

## 13. 总结

Hermes Agent 的 Memory Provider 架构是一个高度模块化、可扩展的插件系统，核心设计原则包括：

- **单一外部 Provider 约束**：避免复杂性和冲突
- **Builtin + External 双层**：基础功能 + 插件增强
- **Profile 隔离**：多用户/多项目场景支持
- **错误隔离**：单个 Provider 失败不影响整体
- **Context Fencing**：防止模型混淆召回记忆

该架构已成功支持 8+ 外部 Provider，每个 Provider 都有独特的定位和优势，用户可根据需求选择最适合的方案。
