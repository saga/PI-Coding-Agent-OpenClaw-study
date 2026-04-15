# Hermes Agent 架构分析报告

## 1. 整体架构概述

Hermes Agent 是一个模块化的 AI Agent 系统，采用分层架构设计：

```
┌─────────────────────────────────────────────────────────────┐
│                        CLI / Gateway                         │
│              (hermes_cli/, gateway/)                        │
├─────────────────────────────────────────────────────────────┤
│                      AIAgent                                  │
│              (run_agent.py - 核心 Agent 类)                 │
├─────────────────────────────────────────────────────────────┤
│                    Agent 组件                                │
│  prompt_builder | context_engine | memory_manager |          │
│  auxiliary_client | model_metadata | display | ...           │
├─────────────────────────────────────────────────────────────┤
│                   Tool System                                │
│  model_tools.py | tools/registry.py | toolsets.py           │
├─────────────────────────────────────────────────────────────┤
│                   Environments                               │
│  hermes_base_env.py | agent_loop.py | tool_context.py      │
├─────────────────────────────────────────────────────────────┤
│                    LLM Provider                              │
│    OpenAI | Anthropic | OpenRouter | Codex | Custom        │
└─────────────────────────────────────────────────────────────┘
```

## 2. 核心设计模式

### 2.1 工具注册系统 (Tool Registry Pattern)

采用**自注册模式**，每个工具模块在导入时自动向中央注册表注册：

```python
# tools/registry.py - 单例注册表
registry = ToolRegistry()

# tools/terminal_tool.py - 工具实现
def check_requirements() -> bool:
    return True

def terminal_tool(...) -> str:
    return json.dumps({"result": "..."})

registry.register(
    name="terminal",
    toolset="terminal",
    schema={"name": "terminal", "parameters": {...}},
    handler=terminal_tool,
    check_fn=check_requirements,
)
```

关键特性：
- **自动发现**：通过 AST 分析 `tools/*.py` 中的 `registry.register()` 调用
- **可用性检查**：每个工具可配置 `check_fn`，运行时判断是否可用
- **工具集组合**：`toolsets.py` 支持工具集组合和继承
- **插件扩展**：支持 MCP 工具和外部插件注册

### 2.2 工具集系统 (Toolset Distribution)

```python
TOOLSETS = {
    "web": {"tools": ["web_search", "web_extract"]},
    "terminal": {"tools": ["terminal", "process"]},
    "file": {"tools": ["read_file", "write_file", "patch", "search_files"]},
    # 组合工具集
    "debugging": {
        "tools": ["terminal", "process"],
        "includes": ["web", "file"]  # 继承其他工具集
    },
}
```

支持两种配置方式：
1. **显式启用**：`enabled_toolsets=["terminal", "web"]`
2. **概率采样**：`distribution="development"` 从配置分布中采样

### 2.3 消息格式标准化

统一使用 OpenAI 格式，内部无缝适配多种 API：
- **Chat Completions**：标准 OpenAI 格式
- **Anthropic Messages**：通过 `anthropic_adapter.py` 适配
- **Codex Responses API**：通过 `auxiliary_client.py` 中的适配器转换

## 3. Agent Harness Engineering

### 3.1 Agent Loop 核心循环

```python
# run_agent.py - AIAgent.run_conversation()
while api_call_count < max_iterations:
    response = client.chat.completions.create(
        model=model,
        messages=messages,
        tools=tool_schemas
    )

    if response.tool_calls:
        for tool_call in response.tool_calls:
            result = handle_function_call(tool_call.name, tool_call.args)
            messages.append(tool_result_message(result))
    else:
        return response.content
```

### 3.2 上下文管理引擎 (Context Engine)

采用**策略模式**支持可插拔的上下文管理：

```python
# agent/context_engine.py - 抽象基类
class ContextEngine(ABC):
    @abstractmethod
    def update_from_response(self, usage: Dict) -> None: ...

    @abstractmethod
    def should_compress(self, prompt_tokens: int) -> bool: ...

    @abstractmethod
    def compress(self, messages: List[Dict]) -> List[Dict]: ...
```

默认实现 **ContextCompressor**：
- **Token Budget Tail Protection**：保护最近 ~20K tokens
- **智能裁剪**：保留头部（系统提示）和尾部（最新对话）
- **LLM 摘要**：中间轮次通过 LLM 生成结构化摘要
- **迭代更新**：后续压缩复用前一次摘要

### 3.3 提示构建系统 (Prompt Builder)

多层提示组装：

```
系统提示 = 身份定义
        + 平台提示 (CLI/Telegram/Discord等)
        + 环境提示 (WSL/Docker等)
        + Skills 索引
        + Memory 上下文
        + 项目上下文 (SOUL.md/AGENTS.md/CLAUDE.md)
        + 工具使用指导
        + Nous 订阅能力
```

### 3.4 内存系统 (Memory Manager)

```python
class MemoryManager:
    def add_provider(self, provider: MemoryProvider) -> None: ...

    def build_system_prompt(self) -> str: ...
    def prefetch_all(self, query: str) -> str: ...
    def sync_all(self, user_content: str, assistant_content: str) -> None: ...
```

支持：
- **内置记忆**：基于 SQLite 的会话历史
- **外部插件**：仅允许一个外部内存提供者
- **预取机制**：提前检索相关记忆

## 4. LLM 交互设计

### 4.1 多 Provider 自动路由

```python
# agent/auxiliary_client.py - 辅助任务路由
AUTO_PROVIDER_CHAIN = [
    ("openrouter", _try_openrouter),
    ("nous", _try_nous),
    ("local/custom", _try_custom_endpoint),
    ("openai-codex", _try_codex),
    ("api-key", _resolve_api_key_provider),
]
```

支持自动降级：
- 支付错误 → 尝试下一个 Provider
- 连接错误 → 尝试下一个 Provider

### 4.2 Anthropic 提示缓存

```python
# agent/prompt_caching.py
def apply_anthropic_cache_control(messages, cache_ttl="5m"):
    # 4 个缓存断点策略：
    # 1. System prompt (静态)
    # 2-4. 最近 3 条非系统消息 (滚动窗口)
    # 节省 ~75% 输入 token 成本
```

### 4.3 并行工具执行

```python
# run_agent.py
def _should_parallelize_tool_batch(tool_calls) -> bool:
    # 只读工具可并行：read_file, search_files, web_search 等
    # 文件工具有路径隔离检测
    # 危险工具顺序执行：clarify
```

### 4.4 错误处理与重试

```python
class FailoverReason(Enum):
    RATE_LIMIT
    CONTEXT_OVERFLOW
    MODEL_NOT_FOUND
    ...

def classify_api_error(exception) -> Tuple[FailoverReason, str]: ...
```

## 5. RL/Atropos 集成

### 5.1 HermesAgentBaseEnv

```python
# environments/hermes_base_env.py
class HermesAgentBaseEnv(BaseEnv):
    async def collect_trajectory(self, item) -> AgentResult:
        # 运行 Agent Loop
        result = await HermesAgentLoop(...).run(messages)
        # 计算奖励
        reward = await self.compute_reward(item, result, ctx)
        return ScoredDataItem(tokens, masks, scores=reward)
```

### 5.2 两阶段操作

| 阶段 | 模式 | 用途 | Token 追踪 |
|------|------|------|-----------|
| Phase 1 | OpenAI Server | 评估/SFT 数据生成 | Placeholder |
| Phase 2 | VLLM ManagedServer | 完整 RL 训练 | 精确 Token IDs + Logprobs |

### 5.3 ToolContext 验证

```python
# environments/tool_context.py
class ToolContext:
    async def compute_reward(self, item, result, ctx):
        # 在 Agent 的沙箱中运行验证
        test_result = ctx.terminal("pytest -v")
        file_content = ctx.read_file("/workspace/solution.py")
        return 1.0 if test_result["exit_code"] == 0 else 0.0
```

## 6. 关键安全机制

### 6.1 提示注入检测

```python
# agent/prompt_builder.py
_CONTEXT_THREAT_PATTERNS = [
    r'ignore\s+(previous|all|above|prior)\s+instructions',
    r'do\s+not\s+tell\s+the\s+user',
    # ... 更多模式
]
```

### 6.2 危险命令检测

```python
_DESTRUCTIVE_PATTERNS = re.compile(
    r'rm\s|rmdir\s|mv\s|sed\s+-i|git\s+(?:reset|clean|checkout)\s'
)
```

### 6.3 工具结果大小限制

```python
# tools/budget_config.py
class BudgetConfig:
    default_result_size: int = 15000  # 单个工具结果上限
    turn_budget: int = 50000          # 单轮总计上限
    preview_size: int = 2000          # 预览大小
```

## 7. 关键文件索引

| 文件 | 职责 |
|------|------|
| `run_agent.py` | AIAgent 核心类，Agent Loop 实现 |
| `model_tools.py` | 工具编排，handle_function_call() |
| `tools/registry.py` | 中央工具注册表 |
| `toolsets.py` | 工具集定义和解析 |
| `agent/prompt_builder.py` | 系统提示组装 |
| `agent/context_engine.py` | 上下文管理抽象基类 |
| `agent/context_compressor.py` | 默认压缩实现 |
| `agent/memory_manager.py` | 多记忆提供者编排 |
| `agent/auxiliary_client.py` | 辅助 LLM 客户端路由 |
| `environments/hermes_base_env.py` | RL 训练环境基类 |
| `environments/agent_loop.py` | 可复用的 Agent Loop |
| `gateway/` | 消息平台网关 |

## 8. 设计亮点

1. **模块化工具注册**：自注册 + AST 扫描，无需维护显式导入列表
2. **可插拔上下文引擎**：策略模式支持多种压缩算法
3. **Provider 抽象层**：统一接口支持多种 LLM 提供商，自动降级
4. **沙箱隔离**：RL 环境与主 Agent 共享相同工具系统
5. **多平台统一**：CLI、Gateway、MCP、ACP 多入口共享核心逻辑
6. **Prompt Cache 优化**：Anthropic 提示缓存减少 75% 输入成本
7. **内存系统抽象**：支持插件扩展的记忆系统
