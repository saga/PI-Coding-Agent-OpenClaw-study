# Hermes Agent Multi-Agent 委托与协调系统研究

## 1. 概述

Hermes Agent 实现了一个完整的 Multi-Agent 委托与协调系统，通过 `delegate_task` 工具实现主-子 Agent 的任务分发、并行执行、结果聚合和中断传播。该系统支持单任务委托和批量并行模式，每个子 Agent 拥有独立的会话、工具集和终端环境。

## 2. 核心架构

### 2.1 架构层次

```
┌──────────────────────────────────────────────────────────────┐
│                    主 Agent (Parent Agent)                     │
│  - 用户交互                                                    │
│  - 任务分解                                                    │
│  - 结果聚合                                                    │
│  - 中断传播                                                    │
└──────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────┐
│              delegate_task 工具 (协调器)                       │
│  - 子 Agent 构建 (_build_child_agent)                         │
│  - 并行执行 (_run_single_child + ThreadPoolExecutor)          │
│  - 结果收集与排序                                              │
│  - 进度显示 (_build_child_progress_callback)                  │
└──────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────┐
│                    子 Agent (Child Agent)                      │
│  - 独立会话 (skip_context_files=True, skip_memory=True)       │
│  - 受限工具集 (DELEGATE_BLOCKED_TOOLS)                         │
│  - 专注系统提示 (_build_child_system_prompt)                  │
│  - 深度限制 (MAX_DEPTH=2)                                     │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 核心文件

- [delegate_tool.py](file:///Users/saga/code-repos/PI-Coding-Agent-OpenClaw-study/hermes-agent-source-code/tools/delegate_tool.py) - 委托工具实现
- [run_agent.py](file:///Users/saga/code-repos/PI-Coding-Agent-OpenClaw-study/hermes-agent-source-code/run_agent.py#L781-L782) - 主 Agent 中断传播支持
- [subagent-driven-development/SKILL.md](file:///Users/saga/code-repos/PI-Coding-Agent-OpenClaw-study/hermes-agent-source-code/skills/software-development/subagent-driven-development/SKILL.md) - 子 Agent 驱动开发技能

## 3. delegate_task 工具实现机制

### 3.1 工具签名

```python
DELEGATE_TASK_SCHEMA = {
    "name": "delegate_task",
    "description": "Spawn one or more subagents to work on tasks in isolated contexts...",
    "parameters": {
        "type": "object",
        "properties": {
            "goal": {"type": "string", "description": "What the subagent should accomplish..."},
            "context": {"type": "string", "description": "Additional context for the subagent..."},
            "toolsets": {"type": "array", "items": {"type": "string"}, "description": "Toolsets available to the subagent..."},
            "tasks": {"type": "array", "items": {"object"}, "description": "Batch mode: array of task objects..."},
            "max_iterations": {"type": "integer", "description": "Maximum iterations for each subagent..."},
            "acp_command": {"type": "string", "description": "ACP command override..."},
            "acp_args": {"type": "array", "items": {"string"}, "description": "ACP arguments override..."},
        },
    },
}
```

### 3.2 两种执行模式

**单任务模式：**

```python
delegate_task(
    goal="Debug why tests fail",
    context="Error: assertion in test_foo.py line 42",
    toolsets=["terminal", "file"]
)
```

**批量并行模式：**

```python
delegate_task(tasks=[
    {"goal": "Research topic A", "toolsets": ["web"]},
    {"goal": "Research topic B", "toolsets": ["web"]},
    {"goal": "Fix the build", "toolsets": ["terminal", "file"]}
])
```

### 3.3 执行流程

```
delegate_task() 入口
    ↓
1. 深度检查 (depth >= MAX_DEPTH=2 → 拒绝)
    ↓
2. 加载配置 (_load_config)
    ↓
3. 解析凭证 (_resolve_delegation_credentials)
    ↓
4. 规范化任务列表 (单任务 → 列表，批量 → 截断到 max_children)
    ↓
5. 保存父工具名称 (_parent_tool_names = _last_resolved_tool_names)
    ↓
6. 构建所有子 Agent (_build_child_agent)
    ↓
7. 恢复父工具名称 (_last_resolved_tool_names = _parent_tool_names)
    ↓
8. 执行：
   - 单任务：直接运行 _run_single_child
   - 批量：ThreadPoolExecutor 并行执行
    ↓
9. 结果排序 (按 task_index)
    ↓
10. 通知 Memory Provider (_memory_manager.on_delegation)
    ↓
11. 返回 JSON 结果
```

### 3.4 被禁止的工具

```python
DELEGATE_BLOCKED_TOOLS = frozenset([
    "delegate_task",   # 防止递归委托
    "clarify",         # 子 Agent 不能与用户交互
    "memory",          # 不能写入共享 MEMORY.md
    "send_message",    # 不能跨平台发送消息
    "execute_code",    # 子 Agent 应逐步推理，而非写脚本
])
```

**被禁止的工具集：**

```python
blocked_toolset_names = {
    "delegation", "clarify", "memory", "code_execution",
}
```

## 4. 子 Agent 会话隔离与状态传递

### 4.1 会话隔离机制

子 Agent 通过以下参数实现完全隔离：

```python
child = AIAgent(
    # ... 其他参数 ...
    skip_context_files=True,      # 不加载上下文文件
    skip_memory=True,             # 不加载 Memory 系统
    quiet_mode=True,              # 静默模式
    ephemeral_system_prompt=child_prompt,  # 临时系统提示
    log_prefix=f"[subagent-{task_index}]",  # 日志前缀
    iteration_budget=None,        # 每个子 Agent 独立预算
    thinking_callback=child_thinking_cb,    # 思考回调
    tool_progress_callback=child_progress_cb,  # 进度回调
)
```

### 4.2 状态传递机制

**父 → 子传递的信息：**

1. **API 凭证**：
   ```python
   effective_base_url = override_base_url or parent_agent.base_url
   effective_api_key = override_api_key or parent_api_key
   effective_provider = override_provider or getattr(parent_agent, "provider", None)
   ```

2. **工具集**：
   ```python
   # 子 Agent 工具集 = 父工具集 ∩ 请求工具集 - 被禁止工具
   child_toolsets = _strip_blocked_tools([t for t in toolsets if t in parent_toolsets])
   ```

3. **推理配置**：
   ```python
   parent_reasoning = getattr(parent_agent, "reasoning_config", None)
   child_reasoning = parent_reasoning  # 可被 delegation.reasoning_effort 覆盖
   ```

4. **工作目录提示**：
   ```python
   workspace_hint = _resolve_workspace_hint(parent_agent)
   # 注入到子 Agent 系统提示中
   ```

5. **凭证池共享**：
   ```python
   child_pool = _resolve_child_credential_pool(effective_provider, parent_agent)
   if child_pool is not None:
       child._credential_pool = child_pool
   ```

6. **ACP 配置**：
   ```python
   effective_acp_command = override_acp_command or getattr(parent_agent, "acp_command", None)
   effective_acp_args = list(override_acp_args or (getattr(parent_agent, "acp_args", []) or []))
   ```

**子 → 父返回的信息：**

```python
{
    "task_index": 0,
    "status": "completed",  # completed/failed/error/interrupted
    "summary": "...",       # 子 Agent 最终响应
    "api_calls": 15,
    "duration_seconds": 42.5,
    "model": "gpt-4o",
    "exit_reason": "completed",  # completed/max_iterations/interrupted
    "tokens": {
        "input": 12345,
        "output": 6789,
    },
    "tool_trace": [  # 工具调用追踪
        {"tool": "read_file", "args_bytes": 45, "result_bytes": 1234, "status": "ok"},
        {"tool": "run_command", "args_bytes": 67, "result_bytes": 890, "status": "ok"},
    ],
}
```

### 4.3 系统提示构建

```python
def _build_child_system_prompt(goal, context, workspace_path=None):
    parts = [
        "You are a focused subagent working on a specific delegated task.",
        "",
        f"YOUR TASK:\n{goal}",
    ]
    if context and context.strip():
        parts.append(f"\nCONTEXT:\n{context}")
    if workspace_path and str(workspace_path).strip():
        parts.append(f"\nWORKSPACE PATH:\n{workspace_path}\n...")
    parts.append(
        "\nComplete this task using the tools available to you. "
        "When finished, provide a clear, concise summary of:\n"
        "- What you did\n"
        "- What you found or accomplished\n"
        "- Any files you created or modified\n"
        "- Any issues encountered\n\n"
        "Important workspace rule: Never assume a repository lives at /workspace/..."
    )
    return "\n".join(parts)
```

## 5. 主-子 Agent 间的任务分解策略

### 5.1 任务分解原则

根据 [subagent-driven-development/SKILL.md](file:///Users/saga/code-repos/PI-Coding-Agent-OpenClaw-study/hermes-agent-source-code/skills/software-development/subagent-driven-development/SKILL.md)，任务分解遵循以下原则：

1. **每个任务 = 2-5 分钟专注工作**
2. **任务粒度适中**：
   - ❌ 太大："实现用户认证系统"
   - ✅ 合适："创建 User 模型，包含 email 和 password 字段"
3. **上下文完整**：子 Agent 对父对话零知识，必须传递所有必要信息

### 5.2 两阶段审查流程

```
计划读取 → 任务提取 → Todo 列表
    ↓
对于每个任务：
    1. 派遣实现者子 Agent (delegate_task)
    2. 派遣规范合规审查者 (delegate_task)
       - 如果发现问题 → 修复 → 重新审查
    3. 派遣代码质量审查者 (delegate_task)
       - 如果发现问题 → 修复 → 重新审查
    4. 标记任务完成
    ↓
最终集成审查 (delegate_task)
    ↓
验证并提交
```

### 5.3 并行任务分解

```python
# 模式 1：并行研究
delegate_task(tasks=[
    {"goal": "研究 WebAssembly 现状", "toolsets": ["web"]},
    {"goal": "研究 RISC-V 采用情况", "toolsets": ["web"]},
    {"goal": "研究量子计算进展", "toolsets": ["web"]}
])

# 模式 2：多文件重构
delegate_task(tasks=[
    {"goal": "重构 API 端点处理器", "toolsets": ["terminal", "file"]},
    {"goal": "更新客户端 SDK 方法", "toolsets": ["terminal", "file"]},
    {"goal": "更新 API 文档", "toolsets": ["terminal", "file"]}
])

# 模式 3：收集 + 分析
execute_code("...")  # 机械数据收集
delegate_task(       # 推理密集型分析
    goal="分析 AI 融资数据并撰写市场报告",
    context="原始数据在 /tmp/ai-funding-data.json...",
    toolsets=["terminal", "file"]
)
```

## 6. 并行执行机制

### 6.1 线程池执行

```python
max_children = _get_max_concurrent_children()  # 默认 3

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
        # 显示进度...
```

### 6.2 并发控制

**配置优先级：**

1. `config.yaml` 中的 `delegation.max_concurrent_children`
2. 环境变量 `DELEGATION_MAX_CONCURRENT_CHILDREN`
3. 默认值 `3`

```python
def _get_max_concurrent_children() -> int:
    cfg = _load_config()
    val = cfg.get("max_concurrent_children")
    if val is not None:
        return max(1, int(val))
    env_val = os.getenv("DELEGATION_MAX_CONCURRENT_CHILDREN")
    if env_val:
        return max(1, int(env_val))
    return _DEFAULT_MAX_CONCURRENT_CHILDREN  # 3
```

### 6.3 进度显示

**CLI 模式：**

```python
spinner.print_above(f" {prefix}├─ {emoji} {tool_name}  \"{preview}\"")
```

**Gateway 模式：**

```python
# 批量工具名称，定期刷新
_batch.append(tool_name or "")
if len(_batch) >= _BATCH_SIZE:  # 5
    summary = ", ".join(_batch)
    parent_cb("subagent_progress", f"🔀 {prefix}{summary}")
    _batch.clear()
```

### 6.4 心跳机制

防止网关因"无活动"而杀死 Agent：

```python
def _heartbeat_loop():
    while not _heartbeat_stop.wait(_HEARTBEAT_INTERVAL):  # 30 秒
        touch = getattr(parent_agent, '_touch_activity', None)
        if not touch:
            continue
        desc = f"delegate_task: subagent {task_index} working"
        # 获取子 Agent 活动详情...
        touch(desc)

_heartbeat_thread = threading.Thread(target=_heartbeat_loop, daemon=True)
_heartbeat_thread.start()
```

## 7. 结果聚合与冲突处理

### 7.1 结果收集

```python
results = []

# 单任务模式
result = _run_single_child(0, goal, child, parent_agent)
results.append(result)

# 批量模式
for future in as_completed(futures):
    entry = future.result()
    results.append(entry)

# 按 task_index 排序，确保与输入顺序一致
results.sort(key=lambda r: r["task_index"])
```

### 7.2 返回格式

```json
{
    "results": [
        {
            "task_index": 0,
            "status": "completed",
            "summary": "子 Agent 1 的总结...",
            "api_calls": 15,
            "duration_seconds": 42.5,
            "model": "gpt-4o",
            "exit_reason": "completed",
            "tokens": {"input": 12345, "output": 6789},
            "tool_trace": [...]
        },
        {
            "task_index": 1,
            "status": "completed",
            "summary": "子 Agent 2 的总结...",
            ...
        }
    ],
    "total_duration_seconds": 45.2
}
```

### 7.3 冲突处理策略

**设计原则：**

1. **无嵌套委托**：子 Agent 不能调用 `delegate_task`，防止递归
2. **深度限制**：`MAX_DEPTH = 2`（父→子，不能孙）
3. **工具集隔离**：子 Agent 不能访问父 Agent 的所有工具
4. **会话隔离**：子 Agent 对父对话零知识
5. **文件编辑冲突**：文档建议"如果两个子 Agent 可能编辑同一文件，由用户手动处理"

**冲突场景处理：**

| 冲突类型 | 处理方式 |
|----------|----------|
| 工具名冲突 | 子 Agent 工具集被过滤，不会冲突 |
| 文件编辑冲突 | 文档建议避免，用户手动处理 |
| 终端状态冲突 | 每个子 Agent 独立终端会话 |
| 凭证冲突 | 共享凭证池，租赁机制 |

## 8. 中断传播机制

### 8.1 子 Agent 注册

```python
# 在 _build_child_agent 中
if hasattr(parent_agent, '_active_children'):
    lock = getattr(parent_agent, '_active_children_lock', None)
    if lock:
        with lock:
            parent_agent._active_children.append(child)
    else:
        parent_agent._active_children.append(child)
```

### 8.2 中断传播

```python
# 在 run_agent.py 中
def interrupt(self, message: str = None):
    # ... 中断当前 Agent ...
    
    # 传播中断到所有运行中的子 Agent
    with self._active_children_lock:
        children_copy = list(self._active_children)
    
    for child in children_copy:
        try:
            child.interrupt(message)
        except Exception as e:
            logger.debug("Failed to propagate interrupt to child agent: %s", e)
```

### 8.3 子 Agent 注销

```python
# 在 _run_single_child 的 finally 块中
if hasattr(parent_agent, '_active_children'):
    try:
        lock = getattr(parent_agent, '_active_children_lock', None)
        if lock:
            with lock:
                parent_agent._active_children.remove(child)
        else:
            parent_agent._active_children.remove(child)
    except (ValueError, UnboundLocalError) as e:
        logger.debug("Could not remove child from active_children: %s", e)
```

### 8.4 资源清理

```python
# 关闭子 Agent 资源
try:
    if hasattr(child, 'close'):
        child.close()
except Exception:
    logger.debug("Failed to close child agent after delegation")
```

## 9. 与 Memory 系统的集成

### 9.1 子 Agent 跳过 Memory

```python
child = AIAgent(
    # ...
    skip_memory=True,  # 子 Agent 不加载 Memory 系统
    # ...
)
```

### 9.2 委托结果通知 Memory Provider

```python
# 在 delegate_task 返回前
if parent_agent and hasattr(parent_agent, '_memory_manager') and parent_agent._memory_manager:
    for entry in results:
        try:
            _task_goal = task_list[entry["task_index"]]["goal"]
            parent_agent._memory_manager.on_delegation(
                task=_task_goal,
                result=entry.get("summary", "") or "",
                child_session_id=getattr(children[entry["task_index"]][2], "session_id", ""),
            )
        except Exception:
            pass
```

### 9.3 Memory Provider 的 on_delegation 钩子

```python
# 在 memory_provider.py 中
def on_delegation(self, task: str, result: str, *,
                  child_session_id: str = "", **kwargs) -> None:
    """Called on the PARENT agent when a subagent completes.

    The parent's memory provider gets the task+result pair as an
    observation of what was delegated and what came back. The subagent
    itself has no provider session (skip_memory=True).

    task: the delegation prompt
    result: the subagent's final response
    child_session_id: the subagent's session_id
    """
```

## 10. 凭证管理

### 10.1 凭证解析

```python
def _resolve_delegation_credentials(cfg: dict, parent_agent) -> dict:
    # 1. 如果配置了 base_url → 使用直接端点
    if configured_base_url:
        return {
            "model": configured_model,
            "provider": provider,
            "base_url": configured_base_url,
            "api_key": api_key,
            "api_mode": api_mode,
        }
    
    # 2. 如果配置了 provider → 通过运行时解析
    if configured_provider:
        runtime = resolve_runtime_provider(requested=configured_provider)
        return {
            "model": configured_model,
            "provider": runtime.get("provider"),
            "base_url": runtime.get("base_url"),
            "api_key": api_key,
            "api_mode": runtime.get("api_mode"),
        }
    
    # 3. 未配置 → 子 Agent 继承父 Agent 凭证
    return {
        "model": None,
        "provider": None,
        "base_url": None,
        "api_key": None,
        "api_mode": None,
    }
```

### 10.2 凭证池租赁

```python
def _resolve_child_credential_pool(effective_provider, parent_agent):
    # 1. 相同 provider → 共享父 Agent 的凭证池
    if effective_provider == parent_provider:
        return parent_pool
    
    # 2. 不同 provider → 加载该 provider 的凭证池
    pool = load_pool(effective_provider)
    if pool is not None and pool.has_credentials():
        return pool
    
    # 3. 无可用池 → 返回 None，子 Agent 使用继承凭证
    return None
```

### 10.3 租赁生命周期

```python
# 子 Agent 运行时
leased_cred_id = None
if child_pool is not None:
    leased_cred_id = child_pool.acquire_lease()
    if leased_cred_id is not None:
        leased_entry = child_pool.current()
        child._swap_credential(leased_entry)

# finally 块中
if child_pool is not None and leased_cred_id is not None:
    child_pool.release_lease(leased_cred_id)
```

## 11. 配置系统

### 11.1 配置加载

```python
def _load_config() -> dict:
    # 1. 运行时配置 (cli.py CLI_CONFIG)
    try:
        from cli import CLI_CONFIG
        cfg = CLI_CONFIG.get("delegation", {})
        if cfg:
            return cfg
    except Exception:
        pass
    
    # 2. 持久化配置 (hermes_cli/config.py)
    try:
        from hermes_cli.config import load_config
        full = load_config()
        return full.get("delegation", {})
    except Exception:
        return {}
```

### 11.2 配置选项

```yaml
# In ~/.hermes/config.yaml
delegation:
  max_iterations: 50                        # 每个子 Agent 最大迭代次数
  max_concurrent_children: 3                # 最大并发子 Agent 数
  default_toolsets: ["terminal", "file", "web"]  # 默认工具集
  model: "google/gemini-3-flash-preview"    # 子 Agent 使用的模型
  provider: "openrouter"                    # 子 Agent 的 provider
  reasoning_effort: "low"                   # 推理努力程度
  base_url: "http://localhost:1234/v1"      # 直接端点（替代 provider）
  api_key: "local-key"                      # 端点 API key
```

## 12. 工具集选择策略

| 任务类型 | 工具集 | 说明 |
|----------|--------|------|
| Web 研究 | `["web"]` | 仅 web_search + web_extract |
| 代码工作 | `["terminal", "file"]` | Shell 访问 + 文件操作 |
| 全栈任务 | `["terminal", "file", "web"]` | 除消息外的所有工具 |
| 只读分析 | `["file"]` | 只能读取文件，无 Shell |

## 13. 设计亮点总结

### 13.1 会话隔离

- **零知识启动**：子 Agent 对父对话完全无知
- **独立终端会话**：每个子 Agent 有自己的工作目录和状态
- **受限工具集**：防止子 Agent 产生副作用

### 13.2 并行执行

- **线程池模式**：支持最多 3 个并发子 Agent
- **进度显示**：CLI 树视图 + Gateway 批量进度
- **心跳机制**：防止网关超时

### 13.3 中断传播

- **注册/注销机制**：子 Agent 生命周期管理
- **锁保护**：线程安全的子 Agent 列表操作
- **资源清理**：finally 块确保资源释放

### 13.4 凭证管理

- **继承机制**：子 Agent 默认继承父凭证
- **凭证池共享**：支持凭证轮换
- **租赁机制**：防止凭证冲突

### 13.5 Memory 集成

- **子 Agent 跳过**：避免污染共享记忆
- **委托结果通知**：父 Agent 的 Memory Provider 记录委托结果
- **on_delegation 钩子**：支持跨会话记忆

## 14. 对 pi-coding-agent 的借鉴建议

### 14.1 架构层面

1. **实现 delegate_task 工具**：支持单任务和批量并行模式
2. **子 Agent 会话隔离**：独立上下文、工具集、终端
3. **深度限制**：防止递归委托（MAX_DEPTH=2）
4. **中断传播**：父 Agent 中断时传播到所有子 Agent

### 14.2 工具集管理

1. **被禁止工具列表**：防止子 Agent 产生副作用
2. **工具集继承**：子 Agent 工具集 ⊆ 父 Agent 工具集
3. **工具集选择策略**：根据任务类型推荐工具集

### 14.3 并行执行

1. **线程池执行**：支持并发子 Agent
2. **进度显示**：CLI 和 Gateway 模式适配
3. **心跳机制**：防止超时

### 14.4 凭证管理

1. **凭证继承**：子 Agent 默认继承父凭证
2. **凭证池共享**：支持凭证轮换
3. **租赁机制**：防止凭证冲突

### 14.5 Memory 集成

1. **子 Agent 跳过 Memory**：避免污染共享记忆
2. **委托结果通知**：父 Agent 记录委托结果
3. **on_delegation 钩子**：支持跨会话记忆

## 15. 实现路线图

### 阶段 1：基础委托工具

1. 实现 delegate_task 工具签名
2. 实现 _build_child_agent 函数
3. 实现 _run_single_child 函数
4. 实现单任务模式

### 阶段 2：并行执行

1. 实现 ThreadPoolExecutor 并行执行
2. 实现进度显示（CLI + Gateway）
3. 实现心跳机制
4. 实现结果排序和聚合

### 阶段 3：中断传播

1. 实现 _active_children 列表
2. 实现 interrupt 传播
3. 实现子 Agent 注册/注销
4. 实现资源清理

### 阶段 4：凭证管理

1. 实现凭证继承
2. 实现凭证池共享
3. 实现租赁机制
4. 实现凭证解析

### 阶段 5：Memory 集成

1. 实现 skip_memory 参数
2. 实现 on_delegation 钩子
3. 实现委托结果通知
4. 实现跨会话记忆

### 阶段 6：配置系统

1. 实现配置加载
2. 实现配置选项
3. 实现工具集选择策略
4. 实现深度限制

## 16. 总结

Hermes Agent 的 Multi-Agent 委托与协调系统是一个功能完整、设计精良的子 Agent 管理系统，核心设计原则包括：

- **会话隔离**：子 Agent 零知识启动，独立上下文和工具集
- **并行执行**：线程池模式，支持最多 3 个并发子 Agent
- **中断传播**：父 Agent 中断时传播到所有子 Agent
- **凭证管理**：继承机制 + 凭证池共享 + 租赁机制
- **Memory 集成**：子 Agent 跳过 Memory，委托结果通知父 Agent
- **深度限制**：防止递归委托（MAX_DEPTH=2）

该系统已成功支持多种委托模式，包括并行研究、代码审查、多文件重构、收集+分析等，是构建复杂 Agent 系统的核心基础设施。
