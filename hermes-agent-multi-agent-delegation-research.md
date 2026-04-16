# Hermes Agent Multi-Agent 委托与协调系统研究

**研究日期**: 2026-04-16  
**研究对象**: Hermes Agent 的 `delegate_task` 工具和 Subagent 架构

---

## 执行摘要

Hermes Agent 的 Multi-Agent 委托系统是其最强大的功能之一，允许主 Agent 自动或手动创建隔离的子 Agent 来并行处理任务。这个系统的核心创新在于：

1. **隔离的上下文**：子 Agent 从零开始，没有父 Agent 的对话历史
2. **并行执行**：最多 3 个子 Agent 同时运行
3. **受限的工具集**：子 Agent 无法调用危险工具（memory、clarify、delegation）
4. **凭证池共享**：子 Agent 继承父 Agent 的 API 凭证池，实现速率限制恢复
5. **中断传播**：父 Agent 中断会自动中断所有子 Agent
6. **深度限制**：防止无限递归（最大深度 2）

这个系统让 Hermes 能够处理复杂的多步骤任务，同时保持每个子任务的上下文清晰和高效。

---

## 一、核心概念

### 1.1 Subagent 的本质

Subagent（子 Agent）是**完全隔离的 AIAgent 实例**，具有：

| 特性 | 说明 |
|------|------|
| **独立的上下文** | 从零开始，没有父 Agent 的对话历史 |
| **独立的会话** | 每个子 Agent 有自己的 session_id 和终端会话 |
| **受限的工具集** | 自动过滤危险工具（memory、clarify、delegation 等） |
| **独立的迭代预算** | 每个子 Agent 有自己的 max_iterations（默认 50） |
| **独立的进度回调** | 子 Agent 的工具调用实时显示在父 Agent 的终端 |

**关键设计原则**：
- Subagent 不知道父 Agent 的任何信息（除了明确传递的 goal 和 context）
- Subagent 的工作是**专注于单一任务**，完成后返回结构化摘要
- 父 Agent 的上下文**只包含委托调用和摘要结果**，不包含中间工具调用

### 1.2 委托的两种模式

#### 单任务模式（Single Task）

```python
delegate_task(
    goal="Debug why tests fail",
    context="Error: assertion in test_foo.py line 42",
    toolsets=["terminal", "file"]
)
```

**特点**：
- 直接运行，无需线程池
- 适合需要完整上下文的复杂任务
- 阻塞直到完成

#### 批量模式（Batch / Parallel）

```python
delegate_task(tasks=[
    {"goal": "Research topic A", "toolsets": ["web"]},
    {"goal": "Research topic B", "toolsets": ["web"]},
    {"goal": "Fix the build", "toolsets": ["terminal", "file"]}
])
```

**特点**：
- 使用 `ThreadPoolExecutor` 并行执行
- 最多 3 个并发子 Agent（可配置）
- 结果按任务索引排序，不按完成顺序

---

## 二、实现细节

### 2.1 核心数据结构

#### 深度限制

```python
MAX_DEPTH = 2  # parent (0) -> child (1) -> grandchild rejected (2)
```

```python
# run_agent.py (line 780)
self._delegate_depth = 0  # 0 = top-level agent, incremented for children
```

**作用**：防止无限递归委托

#### 活跃子 Agent 管理

```python
# run_agent.py (line 781-782)
self._active_children = []      # Running child AIAgents
self._active_children_lock = threading.Lock()
```

**作用**：
- 跟踪所有活跃的子 Agent
- 支持中断传播
- 会话结束时清理子 Agent

### 2.2 子 Agent 构建流程

```python
def _build_child_agent(
    task_index: int,
    goal: str,
    context: Optional[str],
    toolsets: Optional[List[str]],
    model: Optional[str],
    max_iterations: int,
    parent_agent,
    # Credential overrides
    override_provider: Optional[str] = None,
    override_base_url: Optional[str] = None,
    override_api_key: Optional[str] = None,
    ...
) -> AIAgent:
```

**构建步骤**：

1. **工具集继承与过滤**
   ```python
   # 从父 Agent 继承工具集
   parent_enabled = getattr(parent_agent, "enabled_toolsets", None)
   
   # 过滤掉被阻止的工具集
   child_toolsets = _strip_blocked_tools(toolsets)
   ```

2. **系统提示构建**
   ```python
   child_prompt = _build_child_system_prompt(goal, context, workspace_path=workspace_hint)
   ```

3. **凭证继承**
   ```python
   # 继承父 Agent 的 API key
   parent_api_key = getattr(parent_agent, "api_key", None)
   
   # 或使用委托配置的覆盖
   effective_provider = override_provider or getattr(parent_agent, "provider", None)
   ```

4. **凭证池共享**
   ```python
   child_pool = _resolve_child_credential_pool(effective_provider, parent_agent)
   if child_pool is not None:
       child._credential_pool = child_pool
   ```

5. **进度回调设置**
   ```python
   child_progress_cb = _build_child_progress_callback(task_index, parent_agent)
   ```

6. **子 Agent 实例化**
   ```python
   child = AIAgent(
       base_url=effective_base_url,
       api_key=effective_api_key,
       model=effective_model,
       provider=effective_provider,
       max_iterations=max_iterations,
       enabled_toolsets=child_toolsets,
       quiet_mode=True,  # 不输出到用户界面
       ephemeral_system_prompt=child_prompt,  # 临时系统提示
       log_prefix=f"[subagent-{task_index}]",
       tool_progress_callback=child_progress_cb,
       ...
   )
   child._delegate_depth = parent_agent._delegate_depth + 1
   ```

### 2.3 被阻止的工具

```python
DELEGATE_BLOCKED_TOOLS = frozenset([
    "delegate_task",   # no recursive delegation
    "clarify",         # no user interaction
    "memory",          # no writes to shared MEMORY.md
    "send_message",    # no cross-platform side effects
    "execute_code",    # children should reason step-by-step, not write scripts
])
```

**原因**：
- `delegate_task`：防止无限递归
- `clarify`：子 Agent 不能与用户交互
- `memory`：子 Agent 不能写入共享记忆
- `send_message`：子 Agent 不能发送跨平台消息
- `execute_code`：子 Agent 应该逐步推理，而不是写脚本

### 2.4 并行执行机制

```python
# tools/delegate_tool.py (line 350-360)
_DEFAULT_MAX_CONCURRENT_CHILDREN = 3

def _get_max_concurrent_children() -> int:
    """Read delegation.max_concurrent_children from config, falling back to
    DELEGATION_MAX_CONCURRENT_CHILDREN env var, then the default (3)."""
    cfg = _load_config()
    val = cfg.get("max_concurrent_children")
    if val is not None:
        try:
            return max(1, int(val))
        except (TypeError, ValueError):
            logger.warning("Invalid max_concurrent_children, using default 3")
    env_val = os.getenv("DELEGATION_MAX_CONCURRENT_CHILDREN")
    if env_val:
        try:
            return max(1, int(env_val))
        except (TypeError, ValueError):
            pass
    return _DEFAULT_MAX_CONCURRENT_CHILDREN
```

**执行流程**：
```python
# 批量模式使用 ThreadPoolExecutor
with ThreadPoolExecutor(max_workers=max_concurrent) as executor:
    futures = []
    for task_index, task in enumerate(tasks):
        child = _build_child_agent(...)
        future = executor.submit(_run_single_child, task_index, goal, child, parent_agent)
        futures.append(future)
    
    # 收集结果（按任务索引排序）
    results = []
    for future in as_completed(futures):
        result = future.result()
        results.append(result)
    
    # 按任务索引排序
    results.sort(key=lambda x: x['task_index'])
```

### 2.5 进度回调与显示

#### CLI 模式

```python
def _build_child_progress_callback(task_index: int, parent_agent, task_count: int = 1):
    spinner = getattr(parent_agent, '_delegate_spinner', None)
    
    def _callback(event_type: str, tool_name: str = None, preview: str = None, ...):
        prefix = f"[{task_index + 1}] " if task_count > 1 else ""
        
        if event_type == "tool.started" and spinner:
            emoji = get_tool_emoji(tool_name)
            line = f" {prefix}├─ {emoji} {tool_name}"
            if preview:
                line += f"  \"{preview[:35]}...\""
            spinner.print_above(line)
```

**显示效果**：
```
[1] 🔀 Researching WebAssembly...
    ├─ 🔍 web_search "WebAssembly 2025 outside browser"
    ├─ 🔍 web_search "Wasmtime Wasmer runtimes"
[2] 🔀 Researching RISC-V...
    ├─ 🔍 web_search "RISC-V server chips 2025"
    ├─ 🔍 web_search "cloud providers adopting RISC-V"
```

#### Gateway 模式

```python
def _callback(event_type: str, tool_name: str = None, ...):
    if parent_cb:
        _batch.append(tool_name)
        if len(_batch) >= _BATCH_SIZE:
            summary = ", ".join(_batch)
            parent_cb("subagent_progress", f"🔀 {prefix}{summary}")
            _batch.clear()
```

### 2.6 心跳机制

```python
_HEARTBEAT_INTERVAL = 30  # seconds

def _heartbeat_loop():
    """Periodically propagate child activity to parent to prevent gateway timeout."""
    while not _heartbeat_stop.wait(_HEARTBEAT_INTERVAL):
        touch = getattr(parent_agent, '_touch_activity', None)
        if touch:
            child_summary = child.get_activity_summary()
            child_tool = child_summary.get("current_tool")
            child_iter = child_summary.get("api_call_count", 0)
            child_max = child_summary.get("max_iterations", 0)
            desc = f"delegate_task: subagent {task_index} working"
            if child_tool:
                desc = f"delegate_task: subagent running {child_tool} (iteration {child_iter}/{child_max})"
            touch(desc)
```

**作用**：防止 Gateway 的 inactivity timeout 在子 Agent 工作时触发

### 2.7 凭证池共享

```python
def _resolve_child_credential_pool(provider: Optional[str], parent_agent):
    """Share parent's credential pool with child when possible."""
    parent_pool = getattr(parent_agent, '_credential_pool', None)
    if parent_pool is None:
        return None
    
    # Child inherits parent's pool for the same provider
    return parent_pool
```

**作用**：
- 子 Agent 可以在父 Agent 的 API key 之间轮换
- 避免单个 key 的速率限制影响所有子 Agent
- 提高整体的容错性

---

## 三、核心特性

### 3.1 上下文隔离

**问题**：如果子 Agent 知道父 Agent 的对话历史，会出现什么问题？

1. **上下文污染**：子 Agent 可能被父 Agent 的讨论分散注意力
2. **信息过载**：子 Agent 需要处理不必要的历史信息
3. **假设偏差**：子 Agent 可能假设父 Agent 已经讨论过的内容

**解决方案**：
```python
# 子 Agent 的系统提示完全由 goal 和 context 构建
def _build_child_system_prompt(goal: str, context: Optional[str], ...) -> str:
    parts = [
        "You are a focused subagent working on a specific delegated task.",
        "",
        f"YOUR TASK:\n{goal}",
    ]
    if context and context.strip():
        parts.append(f"\nCONTEXT:\n{context}")
    # ... 没有父 Agent 的对话历史！
    return "\n".join(parts)
```

**最佳实践**：
```python
# BAD - 子 Agent 无法理解
delegate_task(goal="Fix the bug we were discussing")

# GOOD - 子 Agent 有完整的上下文
delegate_task(
    goal="Fix the TypeError in api/handlers.py line 47",
    context="""The error is: 'NoneType' object has no attribute 'get'.
    The function process_request() receives a dict from parse_body(),
    but parse_body() returns None when Content-Type is missing."""
)
```

### 3.2 工具集限制

**被阻止的工具集**：
```python
_EXCLUDED_TOOLSET_NAMES = frozenset({
    "debugging", "safe", "delegation", "moa", "rl"
})
```

**被阻止的工具**：
```python
DELEGATE_BLOCKED_TOOLS = frozenset([
    "delegate_task",   # 防止递归
    "clarify",         # 不能与用户交互
    "memory",          # 不能写入共享记忆
    "send_message",    # 不能发送跨平台消息
    "execute_code",    # 应该逐步推理
])
```

**工作流程**：
```python
def _strip_blocked_tools(toolsets: List[str]) -> List[str]:
    blocked_toolset_names = {"delegation", "clarify", "memory", "code_execution"}
    return [t for t in toolsets if t not in blocked_toolset_names]
```

### 3.3 中断传播

```python
# run_agent.py (line 3058-3065)
def interrupt(self, message: Optional[str] = None) -> None:
    # ... 父 Agent 的中断逻辑 ...
    
    # Propagate interrupt to any running child agents
    with self._active_children_lock:
        children_copy = list(self._active_children)
    for child in children_copy:
        try:
            child.interrupt(message)
        except Exception as e:
            logger.debug("Failed to propagate interrupt to child agent: %s", e)
```

**效果**：
- 用户发送新消息 → 父 Agent 中断 → 所有子 Agent 中断
- 防止子 Agent 在用户不再需要时继续工作
- 节省 API 调用成本

### 3.4 深度限制

```python
# run_agent.py (line 780)
self._delegate_depth = 0  # parent (0)

# _build_child_agent 中
child._delegate_depth = getattr(parent_agent, '_delegate_depth', 0) + 1

# run_conversation 中检查
if child._delegate_depth >= MAX_DEPTH:
    raise ValueError("Delegation depth limit exceeded")
```

**作用**：防止无限递归委托

---

## 四、使用模式

### 4.1 并行研究

```python
delegate_task(tasks=[
    {
        "goal": "Research WebAssembly outside the browser in 2025",
        "context": "Focus on: runtimes (Wasmtime, Wasmer), cloud/edge use cases, WASI progress",
        "toolsets": ["web"]
    },
    {
        "goal": "Research RISC-V server chip adoption",
        "context": "Focus on: server chips shipping, cloud providers adopting, software ecosystem",
        "toolsets": ["web"]
    },
    {
        "goal": "Research practical quantum computing applications",
        "context": "Focus on: error correction breakthroughs, real-world use cases, key companies",
        "toolsets": ["web"]
    }
])
```

**优势**：
- 3 个子 Agent 同时搜索，比串行快 3 倍
- 每个子 Agent 专注于一个主题，不会混淆
- 结果按任务索引排序，便于父 Agent 整合

### 4.2 代码审查 + 修复

```python
delegate_task(
    goal="Review the authentication module for security issues and fix any found",
    context="""Project at /home/user/webapp.
    Auth module files: src/auth/login.py, src/auth/jwt.py, src/auth/middleware.py.
    The project uses Flask, PyJWT, and bcrypt.
    Focus on: SQL injection, JWT validation, password handling, session management.
    Fix any issues found and run the test suite (pytest tests/auth/).""",
    toolsets=["terminal", "file"]
)
```

**优势**：
- 子 Agent 有全新的上下文，不会被之前的讨论影响
- 可以深入分析代码，发现潜在问题
- 自动运行测试验证修复

### 4.3 多文件重构

```python
delegate_task(tasks=[
    {
        "goal": "Refactor all API endpoint handlers to use the new response format",
        "context": """Project at /home/user/api-server.
        Files: src/handlers/users.py, src/handlers/auth.py, src/handlers/billing.py
        Old format: return {"data": result, "status": "ok"}
        New format: return APIResponse(data=result, status=200).to_dict()
        Run tests after: pytest tests/handlers/ -v""",
        "toolsets": ["terminal", "file"]
    },
    {
        "goal": "Update all client SDK methods to handle the new response format",
        "context": """Project at /home/user/api-server.
        Files: sdk/python/client.py, sdk/python/models.py
        Old parsing: result = response.json()["data"]
        New parsing: result = response.json()["data"] (same key, but add status code checking)""",
        "toolsets": ["terminal", "file"]
    },
    {
        "goal": "Update API documentation to reflect the new response format",
        "context": """Project at /home/user/api-server.
        Docs at: docs/api/. Update all response examples from old format to new format.""",
        "toolsets": ["terminal", "file"]
    }
])
```

**优势**：
- 3 个子 Agent 同时处理不同的文件，互不干扰
- 每个子 Agent 有自己的终端会话，不会冲突
- 父 Agent 只接收摘要，上下文保持干净

### 4.4 Subagent-Driven Development（子 Agent 驱动开发）

这是 Hermes Agent 的高级模式，每个任务使用 3 个子 Agent：

1. **Implementer**：实现任务
2. **Spec Reviewer**：验证是否符合规范
3. **Quality Reviewer**：审查代码质量

```python
# Step 1: Implementer
delegate_task(
    goal="Implement Task 1: Create User model with email and password_hash fields",
    context="""
    TASK FROM PLAN:
    - Create: src/models/user.py
    - Add User class with email (str) and password_hash (str) fields
    - Use bcrypt for password hashing
    - Include __repr__ for debugging
    
    FOLLOW TDD:
    1. Write failing test in tests/models/test_user.py
    2. Run: pytest tests/models/test_user.py -v (verify FAIL)
    3. Write minimal implementation
    4. Run: pytest tests/models/test_user.py -v (verify PASS)
    5. Run: pytest tests/ -q (verify no regressions)
    6. Commit: git add -A && git commit -m "feat: add User model"
    """,
    toolsets=['terminal', 'file']
)

# Step 2: Spec Reviewer
delegate_task(
    goal="Review if implementation matches the spec from the plan",
    context="""
    ORIGINAL TASK SPEC:
    - Create src/models/user.py with User class
    - Fields: email (str), password_hash (str)
    - Use bcrypt for password hashing
    - Include __repr__
    
    CHECK:
    - [ ] All requirements from spec implemented?
    - [ ] File paths match spec?
    - [ ] Function signatures match spec?
    
    OUTPUT: PASS or list of specific spec gaps to fix.
    """,
    toolsets=['file']
)

# Step 3: Quality Reviewer
delegate_task(
    goal="Review code quality for Task 1 implementation",
    context="""
    FILES TO REVIEW:
    - src/models/user.py
    - tests/models/test_user.py
    
    CHECK:
    - [ ] Follows project conventions and style?
    - [ ] Proper error handling?
    - [ ] Clear variable/function names?
    - [ ] Adequate test coverage?
    
    OUTPUT FORMAT:
    - Critical Issues: [must fix before proceeding]
    - Important Issues: [should fix]
    - Minor Issues: [optional]
    - Verdict: APPROVED or REQUEST_CHANGES
    """,
    toolsets=['file']
)
```

**优势**：
- 每个子 Agent 专注于单一职责
- 自动化审查流程，减少人为疏漏
- 发现问题 early，避免 compounded problems

---

## 五、配置选项

### 5.1 全局配置

```yaml
# ~/.hermes/config.yaml

delegation:
  max_iterations: 50                        # Max turns per child (default: 50)
  max_concurrent_children: 3                # Max concurrent subagents (default: 3)
  default_toolsets: ["terminal", "file", "web"]  # Default toolsets
  model: "google/gemini-flash-2.0"          # Optional: cheaper model for subagents
  provider: "openrouter"                    # Optional: route subagents to different provider
  reasoning_effort: "low"                   # Optional: reduce reasoning for simple tasks
```

### 5.2 环境变量

```bash
# ~/.hermes/.env
DELEGATION_MAX_CONCURRENT_CHILDREN=5
```

### 5.3 代码配置

```python
# Single task
delegate_task(
    goal="Quick file check",
    context="Check if /etc/nginx/nginx.conf exists",
    max_iterations=10,  # Override default
    toolsets=["terminal", "file"]
)

# Batch mode
delegate_task(tasks=[
    {"goal": "Task A", "toolsets": ["web"], "max_iterations": 20},
    {"goal": "Task B", "toolsets": ["file"], "max_iterations": 30},
])
```

---

## 六、与 execute_code 的对比

| 特性 | delegate_task | execute_code |
|------|--------------|-------------|
| **推理** | 完整的 LLM 推理循环 | 仅 Python 代码执行 |
| **上下文** | 完全隔离的对话 | 无对话，仅脚本 |
| **工具访问** | 所有非阻止工具 + 推理 | 7 个工具 via RPC，无推理 |
| **并行** | 最多 3 个并发子 Agent | 单个脚本 |
| **适用场景** | 需要判断的复杂任务 | 机械的多步骤工作流 |
| **Token 成本** | 更高（完整的 LLM 循环） | 更低（仅 stdout 返回） |
| **用户交互** | 无（子 Agent 不能 clarify） | 无 |

**使用建议**：

- **使用 delegate_task**：当子任务需要推理、判断或多步骤问题解决
- **使用 execute_code**：当需要机械的数据处理或脚本化工作流

**混合模式**（最高效）：
```python
# Step 1: Mechanical gathering (execute_code is better)
execute_code("""
from hermes_tools import web_search, web_extract

results = []
for query in ["AI funding Q1 2026", "AI startup acquisitions 2026"]:
    r = web_search(query, limit=5)
    for item in r["data"]["web"]:
        results.append({"title": item["title"], "url": item["url"]})

urls = [r["url"] for r in results[:5]]
content = web_extract(urls)

import json
with open("/tmp/ai-funding-data.json", "w") as f:
    json.dump({"search_results": results, "extracted": content["results"]}, f)
""")

# Step 2: Reasoning-heavy analysis (delegation is better)
delegate_task(
    goal="Analyze AI funding data and write a market report",
    context="Raw data at /tmp/ai-funding-data.json...",
    toolsets=["terminal", "file"]
)
```

---

## 七、最佳实践

### 7.1 提供完整的上下文

```python
# BAD - 子 Agent 无法工作
delegate_task(goal="Fix the bug")

# GOOD - 子 Agent 有完整的上下文
delegate_task(
    goal="Fix the TypeError in api/handlers.py line 47",
    context="""The error is: 'NoneType' object has no attribute 'get'.
    The function process_request() receives a dict from parse_body(),
    but parse_body() returns None when Content-Type is missing.
    Project is at /home/user/myproject. Run tests with: pytest tests/ -v"""
)
```

### 7.2 使用具体的目标

```python
# BAD - 太模糊
delegate_task(goal="Improve the code")

# GOOD - 具体明确
delegate_task(
    goal="Refactor all print() calls in src/ to use logging module",
    context="Use logger = logging.getLogger(__name__). Replace print() with:"
            "- logger.error() for errors"
            "- logger.warning() for warnings"
            "- logger.info() for info"
            "- logger.debug() for debug"
)
```

### 7.3 限制工具集

```python
# BAD - 子 Agent 可能执行意外的命令
delegate_task(
    goal="Research WebAssembly",
    context="...",
    toolsets=["terminal", "file", "web", "browser"]  # browser is dangerous
)

# GOOD - 只给必要的工具
delegate_task(
    goal="Research WebAssembly",
    context="...",
    toolsets=["web"]  # Only web_search and web_extract
)
```

### 7.4 合理设置 max_iterations

```python
# Simple task
delegate_task(
    goal="Check if file exists",
    context="Check if /etc/nginx/nginx.conf exists",
    max_iterations=5  # Simple task, don't need many turns
)

# Complex task
delegate_task(
    goal="Implement user authentication system",
    context="...",
    max_iterations=50  # Complex task, may need many iterations
)
```

---

## 八、性能优化

### 8.1 减少子 Agent 的迭代次数

```python
# Simple task
delegate_task(
    goal="Quick file check",
    context="...",
    max_iterations=10  # Instead of default 50
)
```

**节省**：10 iterations × $0.001/iteration = $0.01 saved per subagent

### 8.2 使用更便宜的模型

```yaml
delegation:
  model: "google/gemini-flash-2.0"  # Cheaper than gpt-4o
  provider: "openrouter"
```

**节省**：gemini-flash 价格是 gpt-4o 的 1/10

### 8.3 限制并发数

```yaml
delegation:
  max_concurrent_children: 2  # Instead of default 3
```

**适用场景**：
- API key 速率限制较低
- 预算有限
- 任务不紧急

---

## 九、安全机制

### 9.1 工具阻止

```python
DELEGATE_BLOCKED_TOOLS = frozenset([
    "delegate_task",   # 防止递归
    "clarify",         # 不能与用户交互
    "memory",          # 不能写入共享记忆
    "send_message",    # 不能发送跨平台消息
    "execute_code",    # 应该逐步推理
])
```

### 9.2 深度限制

```python
MAX_DEPTH = 2  # parent (0) -> child (1) -> grandchild rejected (2)
```

### 9.3 凭证池隔离

```python
# 每个子 Agent 从父 Agent 的凭证池中租用一个 key
leased_cred_id = child_pool.acquire_lease()
if leased_cred_id is not None:
    child._swap_credential(leased_entry)
```

**作用**：防止多个子 Agent 同时使用同一个 API key，导致速率限制

---

## 十、与 pi-coding-agent 的集成方案

### 10.1 核心组件实现

#### 1. 子 Agent 构建器

```python
# pi-coding-agent/agent/subagent_builder.py

from typing import List, Dict, Optional
from pi_agent_sdk.agent import Agent as PI-Agent

class SubagentBuilder:
    """构建隔离的子 Agent"""
    
    def __init__(self, parent_agent: PI-Agent):
        self.parent_agent = parent_agent
        self.max_depth = 2
        self.blocked_tools = {
            "delegate_task", "clarify", "memory", "send_message", "execute_code"
        }
    
    def build_child_agent(
        self,
        task_index: int,
        goal: str,
        context: Optional[str],
        toolsets: Optional[List[str]],
        max_iterations: int = 50,
    ) -> PI-Agent:
        """构建子 Agent"""
        
        # 1. 工具集过滤
        child_toolsets = self._filter_toolsets(toolsets)
        
        # 2. 构建系统提示
        child_prompt = self._build_system_prompt(goal, context)
        
        # 3. 构建子 Agent
        child = PI-Agent(
            model=self.parent_agent.model,
            system_prompt=child_prompt,
            max_iterations=max_iterations,
            enabled_tools=child_toolsets,
            quiet_mode=True,  # 不输出到用户界面
            session_id=self._generate_unique_session_id(),
        )
        
        # 4. 设置深度
        child._delegate_depth = getattr(self.parent_agent, '_delegate_depth', 0) + 1
        
        return child
    
    def _filter_toolsets(self, toolsets: Optional[List[str]]) -> List[str]:
        """过滤被阻止的工具"""
        if toolsets is None:
            return self.parent_agent.enabled_tools
        
        return [
            tool for tool in toolsets
            if tool not in self.blocked_tools
        ]
    
    def _build_system_prompt(self, goal: str, context: Optional[str]) -> str:
        """构建子 Agent 的系统提示"""
        parts = [
            "You are a focused subagent working on a specific delegated task.",
            "",
            f"YOUR TASK:\n{goal}",
        ]
        if context and context.strip():
            parts.append(f"\nCONTEXT:\n{context}")
        
        parts.append(
            "\nComplete this task using the tools available to you. "
            "When finished, provide a clear, concise summary of:\n"
            "- What you did\n"
            "- What you found or accomplished\n"
            "- Any files you created or modified\n"
            "- Any issues encountered"
        )
        
        return "\n".join(parts)
```

#### 2. 并行执行器

```python
# pi-coding-agent/agent/subagent_executor.py

from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Dict, Any
import threading

class SubagentExecutor:
    """执行子 Agent（并行或串行）"""
    
    def __init__(self, max_concurrent: int = 3):
        self.max_concurrent = max_concurrent
        self._active_children: List[PI-Agent] = []
        self._active_children_lock = threading.Lock()
    
    def execute_single(self, child: PI-Agent, goal: str) -> Dict[str, Any]:
        """执行单个子 Agent"""
        result = child.run(goal)
        
        return {
            "success": True,
            "result": result,
            "api_calls": child.api_call_count,
            "completed": child.is_completed,
        }
    
    def execute_batch(self, tasks: List[Dict], parent_agent: PI-Agent) -> List[Dict]:
        """批量执行子 Agent（并行）"""
        results = []
        
        with ThreadPoolExecutor(max_workers=self.max_concurrent) as executor:
            futures = []
            
            for task_index, task in enumerate(tasks):
                # 构建子 Agent
                builder = SubagentBuilder(parent_agent)
                child = builder.build_child_agent(
                    task_index=task_index,
                    goal=task["goal"],
                    context=task.get("context"),
                    toolsets=task.get("toolsets"),
                    max_iterations=task.get("max_iterations", 50),
                )
                
                # 提交任务
                future = executor.submit(
                    self.execute_single,
                    child,
                    task["goal"]
                )
                futures.append((task_index, future))
            
            # 收集结果
            for task_index, future in futures:
                try:
                    result = future.result()
                    result["task_index"] = task_index
                    results.append(result)
                except Exception as e:
                    results.append({
                        "task_index": task_index,
                        "success": False,
                        "error": str(e),
                    })
        
        # 按任务索引排序
        results.sort(key=lambda x: x["task_index"])
        
        return results
```

#### 3. 中断传播

```python
# pi-coding-agent/agent/interrupt_propagation.py

import threading
from typing import List

class InterruptPropagation:
    """中断传播机制"""
    
    def __init__(self, parent_agent: PI-Agent):
        self.parent_agent = parent_agent
        self._active_children: List[PI-Agent] = []
        self._active_children_lock = threading.Lock()
    
    def add_child(self, child: PI-Agent) -> None:
        """添加子 Agent"""
        with self._active_children_lock:
            self._active_children.append(child)
    
    def propagate_interrupt(self, message: Optional[str] = None) -> None:
        """向所有子 Agent 传播中断"""
        with self._active_children_lock:
            children_copy = list(self._active_children)
        
        for child in children_copy:
            try:
                child.interrupt(message)
            except Exception as e:
                logger.debug(f"Failed to propagate interrupt to child: {e}")
    
    def cleanup(self) -> None:
        """清理子 Agent"""
        with self._active_children_lock:
            children = list(self._active_children)
            self._active_children.clear()
        
        for child in children:
            try:
                child.close()
            except Exception as e:
                logger.debug(f"Failed to close child: {e}")
```

### 10.2 集成到 pi-coding-agent

```python
# pi-coding-agent/tools/delegate_tool.py

from typing import List, Dict, Optional
from pi_agent_sdk.tool import Tool, ToolRegistry
from .subagent_builder import SubagentBuilder
from .subagent_executor import SubagentExecutor
from .interrupt_propagation import InterruptPropagation

registry = ToolRegistry()

def delegate_task(
    goal: Optional[str] = None,
    context: Optional[str] = None,
    toolsets: Optional[List[str]] = None,
    max_iterations: int = 50,
    tasks: Optional[List[Dict]] = None,
) -> Dict[str, Any]:
    """
    Delegate task to subagent(s)
    
    Args:
        goal: Single task goal
        context: Task context
        toolsets: Toolsets to enable for subagent
        max_iterations: Max iterations for subagent
        tasks: Batch tasks (parallel execution)
    
    Returns:
        Summary of the delegation
    """
    agent = get_current_agent()  # 获取当前 pi-coding-agent 实例
    
    # 检查深度限制
    current_depth = getattr(agent, '_delegate_depth', 0)
    if current_depth >= 2:
        return {
            "success": False,
            "error": "Delegation depth limit exceeded (max 2)"
        }
    
    # 创建中断传播器
    interruptor = InterruptPropagation(agent)
    
    # 选择执行模式
    if tasks is not None:
        # Batch mode (parallel)
        executor = SubagentExecutor(max_concurrent=3)
        results = executor.execute_batch(tasks, agent)
        
        # 汇总结果
        summaries = []
        for result in results:
            if result["success"]:
                summaries.append(result["result"])
            else:
                summaries.append(f"Failed: {result.get('error', 'Unknown error')}")
        
        return {
            "success": True,
            "results": summaries,
            "task_count": len(tasks),
        }
    else:
        # Single task mode
        if goal is None:
            return {
                "success": False,
                "error": "goal is required for single task delegation"
            }
        
        builder = SubagentBuilder(agent)
        child = builder.build_child_agent(
            task_index=0,
            goal=goal,
            context=context,
            toolsets=toolsets,
            max_iterations=max_iterations,
        )
        
        interruptor.add_child(child)
        
        try:
            result = executor.execute_single(child, goal)
            
            return {
                "success": result["success"],
                "result": result["result"],
                "api_calls": result["api_calls"],
            }
        finally:
            interruptor.cleanup()


# 注册工具
registry.register(
    Tool(
        name="delegate_task",
        description="Spawn isolated child agents for parallel workstreams",
        parameters={
            "type": "object",
            "properties": {
                "goal": {"type": "string", "description": "Single task goal"},
                "context": {"type": "string", "description": "Task context"},
                "toolsets": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Toolsets to enable"
                },
                "max_iterations": {
                    "type": "integer",
                    "default": 50,
                    "description": "Max iterations for subagent"
                },
                "tasks": {
                    "type": "array",
                    "items": {"type": "object"},
                    "description": "Batch tasks for parallel execution"
                },
            },
            "required": ["goal", "tasks"],  # 至少提供一个
        },
        func=delegate_task
    )
)
```

### 10.3 配置文件

```yaml
# pi-coding-agent-config.yaml

delegation:
  max_iterations: 50
  max_concurrent_children: 3
  default_toolsets:
    - terminal
    - file
    - web
  model: null  # 使用父 Agent 的模型
  provider: null  # 使用父 Agent 的 provider
```

---

## 十一、总结

### 11.1 核心创新

1. **隔离的上下文**：子 Agent 从零开始，没有父 Agent 的对话历史
2. **并行执行**：最多 3 个子 Agent 同时运行
3. **受限的工具集**：自动过滤危险工具
4. **凭证池共享**：子 Agent 继承父 Agent 的 API 凭证池
5. **中断传播**：父 Agent 中断会自动中断所有子 Agent
6. **深度限制**：防止无限递归委托

### 11.2 设计哲学

- **专注**：每个子 Agent 只负责一个任务
- **隔离**：子 Agent 与父 Agent 完全隔离
- **并行**：多个子 Agent 可以同时工作
- **安全**：阻止危险工具，限制深度
- **容错**：凭证池共享，速率限制恢复

### 11.3 与 pi-coding-agent 的集成要点

1. **子 Agent 构建器**：实现工具集过滤和系统提示构建
2. **并行执行器**：使用 ThreadPoolExecutor 实现并行执行
3. **中断传播器**：实现父 Agent 中断传播到子 Agent
4. **配置管理**：支持 YAML 配置和环境变量
5. **进度回调**：实现子 Agent 的进度显示

---

## 十二、参考资料

### 官方文档
- [Subagent Delegation](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation.md)
- [Delegation & Parallel Work](https://hermes-agent.nousresearch.com/docs/guides/delegation-patterns.md)
- [Credential Pools](https://hermes-agent.nousresearch.com/docs/user-guide/features/credential-pools.md)

### 源码
- [delegate_tool.py](file:///Users/saga/code-repos/PI-Coding-Agent-OpenClaw-study/hermes-agent-source-code/tools/delegate_tool.py)
- [run_agent.py](file:///Users/saga/code-repos/PI-Coding-Agent-OpenClaw-study/hermes-agent-source-code/run_agent.py)
- [credential_pool.py](file:///Users/saga/code-repos/PI-Coding-Agent-OpenClaw-study/hermes-agent-source-code/agent/credential_pool.py)

### 技能
- [Subagent-Driven Development](file:///Users/saga/code-repos/PI-Coding-Agent-OpenClaw-study/hermes-agent-source-code/skills/software-development/subagent-driven-development/SKILL.md)

---

**文档完成日期**: 2026-04-16  
**作者**: AI Assistant
