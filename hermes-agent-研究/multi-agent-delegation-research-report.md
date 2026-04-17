# Multi-Agent 委托与协调系统研究报告

## 一、概述

Hermes Agent 的 `delegate_task` 工具实现了一个完整的 Multi-Agent 委托架构，允许父 Agent 生成子 Agent 来并行处理独立任务。子 Agent 在隔离的上下文中运行，最终只有摘要结果返回给父 Agent。

**核心特性**：
- 单任务和批量（并行）模式
- 隔离的对话和终端会话
- 受限的工具集配置
- 深度限制防止递归委托
- Credential 池共享与智能路由
- 与 Memory 系统的集成

---

## 二、架构设计

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                        父 Agent (Parent)                          │
│  - 完整的对话历史                                                 │
│  - 全部工具集                                                     │
│  - Memory 访问                                                    │
└──────────────────────────┬──────────────────────────────────────┘
                           │ delegate_task(goal, context, tasks)
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
┌───────────────┐  ┌───────────────┐  ┌───────────────┐
│  子 Agent 1   │  │  子 Agent 2   │  │  子 Agent 3   │
│  - 新会话     │  │  - 新会话     │  │  - 新会话     │
│  - 隔离终端   │  │  - 隔离终端   │  │  - 隔离终端   │
│  - 受限工具   │  │  - 受限工具   │  │  - 受限工具   │
└───────┬───────┘  └───────┬───────┘  └───────┬───────┘
        │                  │                  │
        └──────────────────┼──────────────────┘
                           │ summary + tool_trace
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                      结果聚合                                      │
│  - 状态 (completed/failed/interrupted)                           │
│  - 摘要文本                                                        │
│  - 工具调用追踪                                                    │
│  - Token 统计                                                      │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 关键设计决策

| 决策 | 选择 | 原因 |
|------|------|------|
| 上下文隔离 | 完全隔离 | 防止父 Agent 历史污染子 Agent |
| 工具限制 | 阻塞危险工具 | 安全考量（递归委托、用户交互） |
| 深度限制 | MAX_DEPTH = 2 | 防止无限递归 |
| 并行数 | 默认 3 | 平衡并发与资源消耗 |
| Credential | 池共享 | 避免单个 Key 限流 |

---

## 三、核心实现

### 3.1 委托工具入口

```python
# tools/delegate_tool.py
def delegate_task(
    goal: Optional[str] = None,           # 单任务目标
    context: Optional[str] = None,         # 上下文信息
    toolsets: Optional[List[str]] = None, # 工具集
    tasks: Optional[List[Dict]] = None,   # 批量任务
    max_iterations: Optional[int] = None,
    acp_command: Optional[str] = None,
    acp_args: Optional[List[str]] = None,
    parent_agent=None,
) -> str:
```

**两种模式**：

```python
# 模式 1: 单任务
delegate_task(
    goal="修复登录模块的 bug",
    context="错误日志位于 /var/log/app.log",
    toolsets=["terminal", "file"]
)

# 模式 2: 批量并行
delegate_task(tasks=[
    {"goal": "任务 A", "context": "...", "toolsets": [...]},
    {"goal": "任务 B", "context": "...", "toolsets": [...]},
    {"goal": "任务 C", "context": "...", "toolsets": [...]},
])
```

### 3.2 子 Agent 构建

```python
def _build_child_agent(
    task_index: int,
    goal: str,
    context: Optional[str],
    toolsets: Optional[List[str]],
    model: Optional[str],
    max_iterations: int,
    parent_agent,
    override_provider: Optional[str] = None,
    override_base_url: Optional[str] = None,
    override_api_key: Optional[str] = None,
    override_api_mode: Optional[str] = None,
    override_acp_command: Optional[str] = None,
    override_acp_args: Optional[List[str]] = None,
) -> AIAgent:
```

**子 Agent 的关键配置**：

```python
child = AIAgent(
    # Credential 继承
    base_url=effective_base_url,
    api_key=effective_api_key,
    model=effective_model,
    provider=effective_provider,
    api_mode=effective_api_mode,
    acp_command=effective_acp_command,
    acp_args=effective_acp_args,

    # 工具集：与父 Agent 取交集
    enabled_toolsets=child_toolsets,

    # 隔离：跳过上下文文件和记忆
    skip_context_files=True,
    skip_memory=True,

    # 专注的系统提示
    ephemeral_system_prompt=child_prompt,

    # 进度回调
    thinking_callback=child_thinking_cb,
    tool_progress_callback=child_progress_cb,

    # Credential 池共享
    _credential_pool=child_pool,

    # 深度限制
    _delegate_depth=parent_depth + 1,
)
```

### 3.3 阻塞工具列表

```python
# 子 Agent 永远不能访问的工具
DELEGATE_BLOCKED_TOOLS = frozenset([
    "delegate_task",   # 禁止递归委托
    "clarify",         # 禁止用户交互
    "memory",          # 禁止写入共享 MEMORY.md
    "send_message",    # 禁止跨平台副作用
    "execute_code",    # 子 Agent 应该逐步推理
])
```

### 3.4 子 Agent 系统提示构建

```python
def _build_child_system_prompt(
    goal: str,
    context: Optional[str] = None,
    workspace_path: Optional[str] = None,
) -> str:
    """构建专注的子 Agent 系统提示"""
    parts = [
        "You are a focused subagent working on a specific delegated task.",
        "",
        f"YOUR TASK:\n{goal}",
    ]
    if context:
        parts.append(f"\nCONTEXT:\n{context}")
    if workspace_path:
        parts.append(
            "\nWORKSPACE PATH:\n"
            f"{workspace_path}\n"
            "Use this exact path for local repository/workdir operations."
        )
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

---

## 四、并行执行机制

### 4.1 单任务 vs 批量

```python
if n_tasks == 1:
    # 单任务：直接运行，无线程池开销
    result = _run_single_child(0, goal, child, parent_agent)
    results.append(result)
else:
    # 批量：使用线程池并行执行
    with ThreadPoolExecutor(max_workers=max_children) as executor:
        futures = {}
        for i, t, child in children:
            future = executor.submit(
                _run_single_child,
                task_index=i,
                goal=t["goal"],
                child=child,
                parent_agent=parent_agent,
            )
            futures[future] = i

        for future in as_completed(futures):
            entry = future.result()
            results.append(entry)
```

### 4.2 进度回调机制

```python
def _build_child_progress_callback(task_index, parent_agent, task_count):
    """
    构建进度回调，将子 Agent 的工具调用中继到父 Agent 显示
    """
    spinner = getattr(parent_agent, '_delegate_spinner', None)
    parent_cb = getattr(parent_agent, 'tool_progress_callback', None)

    def _callback(event_type, tool_name=None, preview=None, args=None, **kwargs):
        if event_type in ("_thinking", "reasoning.available"):
            # 推理事件
            if spinner:
                spinner.print_above(f" [{task_index}] ├─ 💭 \"{preview}\"")

        elif event_type == "tool.started":
            # 工具启动
            if spinner:
                emoji = get_tool_emoji(tool_name)
                spinner.print_above(f" [{task_index}] ├─ {emoji} {tool_name}")
            if parent_cb:
                _batch.append(tool_name)

    _callback._flush = lambda: parent_cb("subagent_progress", f"🔀 {_batch}")
    return _callback
```

### 4.3 心跳机制

```python
def _heartbeat_loop():
    """防止父 Agent 因子 Agent 运行期间无活动而被 Gateway 超时杀死"""
    while not _heartbeat_stop.wait(_HEARTBEAT_INTERVAL):
        if parent_agent is None:
            continue
        touch = getattr(parent_agent, '_touch_activity', None)
        if touch:
            child_summary = child.get_activity_summary()
            desc = f"delegate_task: subagent running {child_summary.get('current_tool')}"
            touch(desc)
```

---

## 五、结果聚合

### 5.1 子 Agent 执行结果结构

```python
{
    "task_index": 0,
    "status": "completed",        # completed / failed / interrupted / error
    "summary": "修复了 login.py 的认证逻辑...",
    "api_calls": 15,
    "duration_seconds": 23.45,
    "model": "anthropic/claude-sonnet-4-5",
    "exit_reason": "completed",   # completed / max_iterations / interrupted
    "tokens": {
        "input": 12345,
        "output": 2345,
    },
    "tool_trace": [
        {"tool": "read_file", "args_bytes": 50, "result_bytes": 1024, "status": "ok"},
        {"tool": "terminal", "args_bytes": 100, "result_bytes": 512, "status": "error"},
    ],
}
```

### 5.2 工具调用追踪

```python
def _build_tool_trace(messages):
    """从对话历史构建工具调用追踪"""
    tool_trace = []
    trace_by_id = {}

    for msg in messages:
        if msg.get("role") == "assistant":
            for tc in msg.get("tool_calls", []):
                fn = tc.get("function", {})
                entry = {
                    "tool": fn.get("name", "unknown"),
                    "args_bytes": len(fn.get("arguments", "")),
                }
                tool_trace.append(entry)
                tc_id = tc.get("id")
                if tc_id:
                    trace_by_id[tc_id] = entry

        elif msg.get("role") == "tool":
            content = msg.get("content", "")
            is_error = "error" in content[:80].lower()
            result_meta = {
                "result_bytes": len(content),
                "status": "error" if is_error else "ok",
            }
            tc_id = msg.get("tool_call_id")
            target = trace_by_id.get(tc_id)
            if target:
                target.update(result_meta)

    return tool_trace
```

### 5.3 返回格式

```python
{
    "results": [
        {"task_index": 0, "status": "completed", "summary": "...", ...},
        {"task_index": 1, "status": "failed", "summary": "...", ...},
        {"task_index": 2, "status": "completed", "summary": "...", ...},
    ],
    "total_duration_seconds": 45.67,
}
```

---

## 六、Credential 管理

### 6.1 Credential 池共享

```python
def _resolve_child_credential_pool(effective_provider, parent_agent):
    """子 Agent 的 Credential 池解析规则"""
    if not effective_provider:
        return getattr(parent_agent, "_credential_pool", None)

    parent_provider = getattr(parent_agent, "provider", None)
    parent_pool = getattr(parent_agent, "_credential_pool", None)

    # 规则 1: 同 Provider → 共享父 Agent 的池
    if parent_pool and effective_provider == parent_provider:
        return parent_pool

    # 规则 2: 不同 Provider → 尝试加载该 Provider 的池
    pool = load_pool(effective_provider)
    if pool and pool.has_credentials():
        return pool

    return None
```

### 6.2 Credential 继承与覆盖

```python
# 优先级：config > env > parent inheritance
effective_model = model or parent_agent.model
effective_provider = override_provider or getattr(parent_agent, "provider", None)
effective_base_url = override_base_url or parent_agent.base_url
effective_api_key = override_api_key or parent_api_key
effective_api_mode = override_api_mode or getattr(parent_agent, "api_mode", None)
```

### 6.3 Credential 租赁机制

```python
leased_cred_id = child_pool.acquire_lease()
if leased_cred_id is not None:
    leased_entry = child_pool.current()
    child._swap_credential(leased_entry)

# ... 执行任务 ...

child_pool.release_lease(leased_cred_id)
```

---

## 七、与 Memory 系统集成

### 7.1 委托完成通知

```python
# delegate_task 函数末尾
if parent_agent and hasattr(parent_agent, '_memory_manager'):
    for entry in results:
        parent_agent._memory_manager.on_delegation(
            task=task_goal,
            result=entry.get("summary", "") or "",
            child_session_id=child.session_id,
        )
```

### 7.2 Memory Provider 钩子

```python
# agent/memory_provider.py
def on_delegation(self, task: str, result: str, *,
                  child_session_id: str = "", **kwargs):
    """
    父 Agent 完成子 Agent 时调用
    task: 委托目标
    result: 子 Agent 的最终响应
    child_session_id: 子 Agent 的会话 ID
    """
```

### 7.3 内部 Provider 实现

```python
# BuiltinMemoryProvider.on_delegation() 示例
def on_delegation(self, task, result, **kwargs):
    # 存储委托结果到 SQLite
    self.store(
        category="delegation",
        content=f"Delegated: {task}\nResult: {result}",
    )
```

---

## 八、深度限制与安全

### 8.1 深度限制机制

```python
MAX_DEPTH = 2  # parent (0) -> child (1) -> grandchild rejected (2)

def delegate_task(..., parent_agent):
    depth = getattr(parent_agent, '_delegate_depth', 0)
    if depth >= MAX_DEPTH:
        return json.dumps({
            "error": f"Delegation depth limit reached ({MAX_DEPTH}). "
                     "Subagents cannot spawn further subagents."
        })
```

### 8.2 子 Agent 深度设置

```python
child._delegate_depth = getattr(parent_agent, '_delegate_depth', 0) + 1
```

---

## 九、配置选项

### 9.1 config.yaml 配置

```yaml
delegation:
  # 子 Agent 使用的模型
  model: "anthropic/claude-sonnet-4-5"

  # 子 Agent 使用的 Provider（可选）
  provider: "openrouter"

  # 直接端点（优先于 provider）
  # base_url: "https://api.openai.com/v1"

  # 子 Agent 最大迭代次数
  max_iterations: 50

  # 最大并发子 Agent 数
  max_concurrent_children: 3

  # 子 Agent 推理配置
  reasoning_effort: "medium"
```

### 9.2 环境变量

```bash
DELEGATION_MAX_CONCURRENT_CHILDREN=5
```

---

## 十、使用场景

### 10.1 适合委托的场景

```
✅ 推理密集型子任务（调试、代码审查、研究综合）
✅ 会污染上下文的大量中间数据任务
✅ 独立的并行工作流（同时研究 A 和 B）
✅ 复杂任务分解
```

### 10.2 不适合委托的场景

```
❌ 机械性的多步骤工作 → 使用 execute_code
❌ 单工具调用 → 直接调用工具
❌ 需要用户交互的任务 → 子 Agent 无法使用 clarify
```

---

## 十一、与 PI-Coding-Agent 的集成建议

### 11.1 简化实现

```python
# pi-coding-agent/agent/delegate.py
class DelegateTool:
    """简化的委托工具"""

    MAX_DEPTH = 2
    BLOCKED_TOOLS = {"delegate_task", "clarify", "memory", "send_message"}

    def __init__(self, parent_agent):
        self.parent = parent_agent
        self.max_concurrent = 3

    def execute(self, goal=None, context=None, tasks=None, toolsets=None):
        # 深度检查
        if self.parent.delegate_depth >= self.MAX_DEPTH:
            return self._error("Depth limit reached")

        # 单任务或批量
        if tasks:
            return self._run_batch(tasks)
        elif goal:
            return self._run_single(goal, context, toolsets)
        else:
            return self._error("Provide goal or tasks")

    def _build_child_system_prompt(self, goal, context):
        return f"""You are a focused subagent.

YOUR TASK: {goal}

CONTEXT: {context or 'None'}

Provide a clear summary when done."""

    async def _run_child(self, goal, context, toolsets):
        # 构建子 Agent
        child = Agent(
            system_prompt=self._build_child_system_prompt(goal, context),
            enabled_toolsets=self._filter_toolsets(toolsets),
            skip_memory=True,
        )

        # 运行
        result = await child.run(goal)

        # 返回摘要
        return {
            "status": "completed" if result.response else "failed",
            "summary": result.response,
            "tool_trace": result.tool_executions,
        }

    def _filter_toolsets(self, toolsets):
        # 移除阻塞的工具
        allowed = toolsets or self.parent.enabled_toolsets
        return [t for t in allowed if t not in self.BLOCKED_TOOLS]
```

### 11.2 进度回调

```python
async def _run_batch(self, tasks):
    results = []

    with ThreadPoolExecutor(max_workers=self.max_concurrent) as executor:
        futures = [
            executor.submit(self._run_child, t["goal"], t.get("context"), t.get("toolsets"))
            for t in tasks
        ]

        for future in as_completed(futures):
            results.append(future.result())

    return {"results": sorted(results, key=lambda r: r["task_index"])}
```

---

## 十二、总结

### 核心价值

| 能力 | 说明 |
|------|------|
| 上下文隔离 | 子 Agent 无法访问父 Agent 历史 |
| 工具限制 | 阻塞危险工具，确保安全 |
| 并行执行 | 批量任务充分利用并发 |
| Credential 池 | 共享池避免限流 |
| 结果追踪 | 完整工具调用追踪 |
| Memory 集成 | 委托结果可被记忆系统记录 |

### 与其他系统的集成

| 系统 | 集成点 |
|------|--------|
| Memory | `on_delegation()` 钩子 |
| Context Compression | 隔离上下文减少压缩需求 |
| Credentials | 池共享机制 |
| Display | 进度回调机制 |
| RL Training | ToolContext 验证 |

---

## 参考文件

| 文件 | 作用 |
|------|------|
| `tools/delegate_tool.py` | 委托工具核心实现 |
| `agent/memory_manager.py` | Memory 管理器 |
| `agent/memory_provider.py` | Memory Provider 基类 |
| `run_agent.py` | Agent 主循环 |
