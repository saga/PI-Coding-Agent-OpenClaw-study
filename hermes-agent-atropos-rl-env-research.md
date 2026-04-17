# Hermes Agent — Atropos RL 训练环境 研究报告

## 1. 概述

Hermes Agent 通过 **Atropos**（NousResearch 的强化学习框架）实现了 agentic LLM 的多轮工具调用训练。这套系统使模型能够通过 RL（如 GRPO/PPO）学习如何有效使用工具完成任务。

核心理念：
- **两阶段架构**：Phase 1（OpenAI 服务器，用于评估/SFT 数据生成）和 Phase 2（VLLM ManagedServer，用于完整 RL 训练）
- **ToolContext**：奖励函数可无限制访问所有 hermes-agent 工具，在同一沙箱中验证模型输出
- **沙箱隔离**：每个 rollout 获得独立的终端/浏览器会话，状态完全隔离
- **可扩展环境**：继承 `HermesAgentBaseEnv`，只需实现 5 个抽象方法即可创建新训练环境

---

## 2. 整体架构

```
                        Atropos Framework
                    ┌───────────────────────────┐
                    │       BaseEnv              │  (atroposlib)
                    │  - 服务器管理               │
                    │  - Worker 调度              │
                    │  - Wandb 日志               │
                    │  - CLI (serve/process/     │
                    │    evaluate)               │
                    └─────────────┬─────────────┘
                                  │ 继承
                    ┌─────────────┴─────────────┐
                    │  HermesAgentBaseEnv        │  hermes_base_env.py
                    │  - 终端后端配置             │
                    │  - 工具集解析               │
                    │  - Agent Loop 编排          │
                    │  - ToolContext 创建         │
                    │  - ScoredDataGroup 构建     │
                    └─────────────┬─────────────┘
                                  │ 继承
              ┌───────────────────┼───────────────────┐
              │                   │                    │
     TerminalTestEnv       HermesSweEnv       TerminalBench2EvalEnv
     (栈验证)              (SWE 训练)          (TB2 基准评估)
```

### 继承链

| 层级 | 类 | 职责 |
|------|-----|------|
| 基础层 | `BaseEnv` (atroposlib) | 服务器管理、Worker 调度、Wandb 集成、CLI 接口 |
| 适配层 | `HermesAgentBaseEnv` | 终端后端配置、工具集解析、Agent Loop 编排、ToolContext 创建 |
| 具体层 | `HermesSweEnv` 等 | 数据集加载、提示格式化、奖励计算、评估逻辑 |

---

## 3. 两阶段操作模式

### 3.1 Phase 1：OpenAI 服务器（评估 / SFT 数据生成）

使用 `server.chat_completion()` 直接调用。服务器（VLLM、SGLang、OpenRouter、OpenAI）原生处理工具调用解析，返回 `ChatCompletion` 对象，包含结构化的 `tool_calls`。使用占位符 token（不适合训练，但允许数据管道工作）。

**适用场景**：评估、SFT 数据生成、测试

```bash
vllm serve YourModel --tool-parser hermes
run-api
python environments/hermes_swe_env.py serve \
    --openai.base_url http://localhost:8000/v1 \
    --openai.model_name YourModel \
    --openai.server_type openai \
    --env.terminal_backend modal
```

### 3.2 Phase 2：VLLM ManagedServer（完整 RL 训练）

使用 ManagedServer 通过 `/generate` 端点获取精确 token IDs + logprobs。客户端工具调用解析器（`tool_call_parsers/`）从原始输出重建结构化 `tool_calls`。真实的 token、mask 和 logprobs 流入训练管道。

**适用场景**：完整 RL 训练（GRPO/PPO）

```bash
python environments/hermes_swe_env.py serve \
    --openai.base_url http://localhost:8000/v1 \
    --openai.model_name YourModel \
    --openai.server_type vllm \
    --env.tool_call_parser hermes \
    --env.terminal_backend modal
```

### 3.3 模式检测逻辑

```python
def _use_managed_server(self) -> bool:
    if not self.server.servers:
        return False
    server = self.server.servers[0]
    from atroposlib.envs.server_handling.openai_server import OpenAIServer
    return not isinstance(server, OpenAIServer)
```

---

## 4. 核心组件详解

### 4.1 HermesAgentBaseEnv 配置

```python
class HermesAgentEnvConfig(BaseEnvConfig):
    # 工具集配置
    enabled_toolsets: Optional[List[str]] = None
    disabled_toolsets: Optional[List[str]] = None
    distribution: Optional[str] = None  # 概率分布名称（互斥）
    
    # Agent Loop 配置
    max_agent_turns: int = 30
    system_prompt: Optional[str] = None
    agent_temperature: float = 1.0
    
    # 终端后端
    terminal_backend: str = "local"  # local/docker/modal/daytona/ssh/singularity
    terminal_timeout: int = 120
    terminal_lifetime: int = 3600
    
    # 数据集
    dataset_name: Optional[str] = None
    dataset_split: str = "train"
    prompt_field: str = "prompt"
    
    # 线程池
    tool_pool_size: int = 128
    
    # Phase 2 工具调用解析
    tool_call_parser: str = "hermes"
    
    # 工具结果预算
    default_result_size_chars: int = ...
    turn_budget_chars: int = ...
    preview_size_chars: int = ...
    tool_result_overrides: Optional[Dict] = None
```

### 4.2 工具集解析（按组）

```python
def _resolve_tools_for_group(self) -> Tuple[List[Dict], Set[str]]:
    config = self.config
    if config.distribution:
        group_toolsets = sample_toolsets_from_distribution(config.distribution)
    else:
        group_toolsets = config.enabled_toolsets
    
    tools = get_tool_definitions(
        enabled_toolsets=group_toolsets,
        disabled_toolsets=config.disabled_toolsets,
        quiet_mode=True,
    )
    valid_names = {t["function"]["name"] for t in tools} if tools else set()
    return tools, valid_names
```

### 4.3 核心轨迹收集流程

```python
async def collect_trajectories(self, item: Item):
    # 1. 为组解析工具集（组内所有 rollout 共享）
    self._current_group_tools = self._resolve_tools_for_group()
    # 2. 委托给默认实现（调用 collect_trajectory() group_size 次）
    return await super().collect_trajectories(item)

async def collect_trajectory(self, item: Item):
    task_id = str(uuid.uuid4())
    tools, valid_names = self._current_group_tools
    
    messages = []
    if self.config.system_prompt:
        messages.append({"role": "system", "content": self.config.system_prompt})
    messages.append({"role": "user", "content": self.format_prompt(item)})
    
    # 运行 Agent Loop
    if self._use_managed_server():
        async with self.server.managed_server(
            tokenizer=self.tokenizer,
            preserve_think_blocks=bool(self.config.thinking_mode),
        ) as managed:
            agent = HermesAgentLoop(
                server=managed, tool_schemas=tools, valid_tool_names=valid_names,
                max_turns=self.config.max_agent_turns, task_id=task_id,
                temperature=self.config.agent_temperature,
                budget_config=self.config.build_budget_config(),
            )
            result = await agent.run(messages)
    else:
        agent = HermesAgentLoop(
            server=self.server, tool_schemas=tools, valid_tool_names=valid_names,
            max_turns=self.config.max_agent_turns, task_id=task_id,
            temperature=self.config.agent_temperature,
            budget_config=self.config.build_budget_config(),
        )
        result = await agent.run(messages)
    
    # 跳过无意义的 rollout
    only_system_and_user = all(
        msg.get("role") in ("system", "user") for msg in result.messages
    )
    if result.turns_used == 0 or only_system_and_user:
        reward = 0.0
    else:
        ctx = ToolContext(task_id)
        try:
            reward = await self.compute_reward(item, result, ctx)
        except Exception:
            reward = 0.0
        finally:
            ctx.cleanup()
    
    # 构建 ScoredDataItem
    nodes = (result.managed_state or {}).get("nodes", [])
    if nodes:
        node = nodes[-1]
        scored_item = {
            "tokens": node.tokens, "masks": node.masked_tokens, "scores": reward,
        }
        if hasattr(node, "logprobs") and node.logprobs:
            scored_item["advantages"] = None
            scored_item["ref_logprobs"] = None
    else:
        full_text = "\n".join(msg.get("content", "") for msg in result.messages)
        tokens = self.tokenizer.encode(full_text, add_special_tokens=True)
        scored_item = {"tokens": tokens, "masks": [-100] + tokens[1:], "scores": reward}
    
    scored_item["messages"] = result.messages
    return scored_item, []
```

### 4.4 HermesAgentLoop 多轮引擎

```python
class HermesAgentLoop:
    async def run(self, messages: List[Dict]) -> AgentResult:
        reasoning_per_turn = []
        tool_errors = []
        _todo_store = TodoStore()
        
        for turn in range(self.max_turns):
            response = await self.server.chat_completion(
                messages=messages, tools=self.tool_schemas,
                temperature=self.temperature,
            )
            assistant_msg = response.choices[0].message
            reasoning = _extract_reasoning_from_message(assistant_msg)
            reasoning_per_turn.append(reasoning)
            
            if assistant_msg.tool_calls:
                messages.append({"role": "assistant", "content": assistant_msg.content,
                    "tool_calls": [...], "reasoning_content": reasoning})
                
                for tc in assistant_msg.tool_calls:
                    tool_name = tc.function.name
                    tool_args = json.loads(tc.function.arguments)
                    
                    if tool_name not in self.valid_tool_names:
                        tool_result = json.dumps({"error": f"Unknown tool '{tool_name}'"})
                    elif tool_name == "todo":
                        tool_result = _todo_tool(todos=tool_args.get("todos"), store=_todo_store)
                    elif tool_name == "memory":
                        tool_result = json.dumps({"error": "Memory not available in RL"})
                    else:
                        # 线程池执行，避免 asyncio.run() 死锁
                        loop = asyncio.get_event_loop()
                        tool_result = await loop.run_in_executor(
                            _tool_executor,
                            lambda: handle_function_call(tool_name, tool_args, task_id=self.task_id, user_task=_user_task),
                        )
                    
                    tool_result = maybe_persist_tool_result(
                        content=tool_result, tool_name=tool_name,
                        tool_use_id=tc.id, env=get_active_env(self.task_id),
                        config=self.budget_config,
                    )
                    messages.append({"role": "tool", "tool_call_id": tc.id, "content": tool_result})
            else:
                messages.append({"role": "assistant", "content": assistant_msg.content})
                return AgentResult(messages=messages, turns_used=turn+1, finished_naturally=True,
                    reasoning_per_turn=reasoning_per_turn, tool_errors=tool_errors)
        
        return AgentResult(messages=messages, turns_used=self.max_turns, finished_naturally=False,
            reasoning_per_turn=reasoning_per_turn, tool_errors=tool_errors)
```

### 4.5 ToolContext 无限制工具访问

```python
class ToolContext:
    """每个 rollout 的句柄，奖励函数可直接访问所有 hermes-agent 工具"""
    
    def __init__(self, task_id: str):
        self.task_id = task_id
    
    def terminal(self, command: str, timeout: int = 180) -> Dict[str, Any]:
        result = _run_tool_in_thread("terminal", {"command": command, "timeout": timeout}, self.task_id)
        return json.loads(result)
    
    def read_file(self, path: str) -> Dict[str, Any]: ...
    def write_file(self, path: str, content: str) -> Dict[str, Any]: ...
    def upload_file(self, local_path: str, remote_path: str) -> Dict[str, Any]: ...
    def download_file(self, remote_path: str, local_path: str) -> Dict[str, Any]: ...
    def search(self, query: str, path: str = ".") -> Dict[str, Any]: ...
    def web_search(self, query: str) -> Dict[str, Any]: ...
    def browser_navigate(self, url: str) -> Dict[str, Any]: ...
    def browser_snapshot(self) -> Dict[str, Any]: ...
    def call_tool(self, tool_name: str, arguments: Dict[str, Any]) -> str: ...
    
    def cleanup(self):
        process_registry.kill_all(task_id=self.task_id)
        cleanup_vm(self.task_id)
        cleanup_browser(self.task_id)
```

**奖励函数示例**：

```python
async def compute_reward(self, item, result, ctx: ToolContext):
    # 在模型的沙箱中运行测试
    test = ctx.terminal("pytest -v")
    if test["exit_code"] == 0:
        return 1.0
    
    # 检查是否创建了文件
    content = ctx.read_file("/workspace/solution.py")
    if content.get("content"):
        return 0.5
    
    return 0.0
```

---

## 5. Reward Function 设计模式

### 5.1 二元奖励（Binary Reward）

```python
async def compute_reward(self, item, result, ctx):
    test_result = ctx.terminal(item["test_command"], timeout=60)
    return 1.0 if test_result["exit_code"] == 0 else 0.0
```

### 5.2 分级奖励（Graded Reward）

```python
async def compute_reward(self, item, result, ctx):
    test_result = ctx.terminal("pytest -v", timeout=60)
    if test_result["exit_code"] == 0:
        return 1.0
    
    file_check = ctx.terminal("find /workspace -name '*.py' | head -5")
    if file_check.get("output", "").strip():
        return 0.5
    
    return 0.0
```

### 5.3 多条件奖励（Multi-Condition Reward）

```python
async def compute_reward(self, item, result, ctx):
    score = 0.0
    
    # 检查文件存在
    if ctx.read_file("/workspace/output.txt").get("content"):
        score += 0.3
    
    # 检查测试通过
    test = ctx.terminal("pytest tests/", timeout=60)
    if test["exit_code"] == 0:
        score += 0.5
    
    # 检查代码质量
    lint = ctx.terminal("ruff check /workspace", timeout=30)
    if lint["exit_code"] == 0:
        score += 0.2
    
    return score
```

---

## 6. ToolContext 验证机制

### 6.1 沙箱隔离

每个 rollout 获得独立的 `task_id`，确保：
- 终端会话隔离（不同的 Docker 容器/Modal 沙箱）
- 文件系统隔离（不同的工作目录）
- 浏览器会话隔离（不同的 Playwright 实例）
- 进程隔离（独立的进程注册表）

### 6.2 文件传输

```python
# 上传文件（二进制安全）
def upload_file(self, local_path: str, remote_path: str):
    raw = Path(local_path).read_bytes()
    b64 = base64.b64encode(raw).decode("ascii")
    # 大文件分块传输
    chunk_size = 60_000
    if len(b64) <= chunk_size:
        self.terminal(f"printf '%s' '{b64}' | base64 -d > {remote_path}")
    else:
        # 分块写入 base64，然后解码
        ...

# 下载文件（二进制安全）
def download_file(self, remote_path: str, local_path: str):
    result = self.terminal(f"base64 {remote_path} 2>/dev/null")
    raw = base64.b64decode(result["output"])
    Path(local_path).write_bytes(raw)
```

### 6.3 资源清理

```python
def cleanup(self):
    # 1. 杀死后台进程
    process_registry.kill_all(task_id=self.task_id)
    # 2. 清理虚拟机
    cleanup_vm(self.task_id)
    # 3. 清理浏览器（抑制调试输出）
    os.environ["HERMES_QUIET"] = "1"
    cleanup_browser(self.task_id)
```

---

## 7. 具体环境实现

### 7.1 HermesSweEnv（SWE 训练）

```python
class HermesSweEnv(HermesAgentBaseEnv):
    name = "hermes-swe"
    
    @classmethod
    def config_init(cls):
        env_config = HermesSweEnvConfig(
            enabled_toolsets=["terminal", "file", "web"],
            max_agent_turns=30,
            system_prompt="You are a skilled software engineer...",
            terminal_backend="modal",
            dataset_name="bigcode/humanevalpack",
            group_size=4,
            steps_per_eval=50,
            total_steps=500,
        )
        server_configs = [APIServerConfig(
            base_url="http://localhost:8000/v1",
            model_name="NousResearch/DeepHermes-3-Llama-3-3B-Preview",
            server_type="openai",
        )]
        return env_config, server_configs
    
    async def setup(self):
        self.dataset = load_dataset(self.config.dataset_name, split=self.config.dataset_split)
        self.iter = 0
    
    async def get_next_item(self):
        item = self.dataset[self.iter % len(self.dataset)]
        self.iter += 1
        return item
    
    def format_prompt(self, item):
        prompt = item.get(self.config.prompt_field, "")
        test_info = item.get("test", "")
        if test_info:
            prompt += f"\n\nTests to pass:\n{test_info}"
        return prompt
    
    async def compute_reward(self, item, result, ctx):
        test_code = item.get("test", "")
        if test_code:
            test_result = ctx.terminal(f'cd /workspace && python3 -c "{test_code}"', timeout=60)
            if test_result["exit_code"] == 0:
                return 1.0
        
        file_check = ctx.terminal("find /workspace -name '*.py' -newer /tmp/.start_marker")
        if file_check.get("output", "").strip():
            return 0.1
        return 0.0
```

### 7.2 TerminalBench2EvalEnv（TB2 基准评估）

```python
class TerminalBench2EvalEnv(HermesAgentBaseEnv):
    """89 个终端任务，Modal 沙箱，二元奖励"""
    
    async def evaluate(self, *args, **kwargs):
        # 加载数据集
        self.dataset = load_dataset(self.config.dataset_name)
        
        # 并发控制
        semaphore = asyncio.Semaphore(self.config.max_concurrent_tasks)
        
        results = []
        for task in self.dataset:
            async with semaphore:
                result = await self.rollout_and_score_eval(task)
                results.append(result)
        
        # 聚合结果
        pass_rate = sum(1 for r in results if r["score"] == 1.0) / len(results)
        print(f"Overall pass rate: {pass_rate:.2%}")
```

---

## 8. Phase 1 vs Phase 2 权衡

| 维度 | Phase 1 (OpenAI) | Phase 2 (VLLM) |
|------|------------------|----------------|
| 服务器类型 | openai | vllm/sglang |
| API 端点 | /v1/chat/completions | /generate |
| 工具调用解析 | 服务器原生 | 客户端解析器 |
| Token 信息 | 占位符 | 精确 token IDs + logprobs |
| 训练适用性 | SFT 数据生成 | 完整 RL 训练 |
| 推理提取 | 服务器处理 | 客户端处理 |
| 复杂度 | 低 | 高 |
| 性能 | 快 | 慢（额外解析） |

---

## 9. 与 pi-coding-agent 的集成建议

### 9.1 最小可行实现

```python
# 1. 定义环境基类
class CodingAgentBaseEnv:
    def __init__(self, model, tools, max_turns=30):
        self.model = model
        self.tools = tools
        self.max_turns = max_turns
    
    async def collect_trajectory(self, item):
        task_id = str(uuid.uuid4())
        messages = [{"role": "user", "content": self.format_prompt(item)}]
        
        # 运行 Agent Loop
        result = await self.run_agent_loop(messages, task_id)
        
        # 计算奖励
        reward = await self.compute_reward(item, result, task_id)
        
        return {"messages": result.messages, "reward": reward}
    
    async def run_agent_loop(self, messages, task_id):
        for turn in range(self.max_turns):
            response = await self.model.chat_completion(messages, tools=self.tools)
            if not response.tool_calls:
                return AgentResult(messages=messages, turns_used=turn+1)
            
            for tc in response.tool_calls:
                result = await self.execute_tool(tc, task_id)
                messages.append({"role": "tool", "content": result})
        
        return AgentResult(messages=messages, turns_used=self.max_turns)
```

### 9.2 完整实现路线图

| 阶段 | 内容 |
|------|------|
| Phase 1 | 基础 Agent Loop + 工具执行 |
| Phase 2 | ToolContext 实现 + 奖励函数接口 |
| Phase 3 | 沙箱隔离（Docker/Modal） |
| Phase 4 | 两阶段模式（OpenAI/VLLM） |
| Phase 5 | 工具集解析 + 概率分布 |
| Phase 6 | Wandb 集成 + 轨迹展示 |
| Phase 7 | 具体环境实现（SWE/TB2） |
| Phase 8 | 评估流程 + 并发控制 |

---

## 10. 总结

Hermes Agent 的 Atropos RL 训练环境是一个**生产级**的 agentic LLM 训练框架，核心优势：

1. **两阶段架构**：Phase 1 用于评估/SFT，Phase 2 用于完整 RL 训练
2. **ToolContext**：奖励函数无限制访问所有工具，在同一沙箱中验证
3. **沙箱隔离**：每个 rollout 独立 task_id，状态完全隔离
4. **可扩展设计**：继承基类，实现 5 个抽象方法即可创建新环境
5. **线程池执行**：避免 asyncio.run() 死锁，支持并发 rollout
6. **工具结果预算**：控制 token 消耗，大结果持久化到磁盘
7. **多后端支持**：local/docker/modal/daytona/ssh/singularity
8. **Wandb 集成**：格式化轨迹展示，工具错误追踪

这套系统使 agentic LLM 能够通过 RL 学习如何有效使用工具完成任务，是训练 coding agent 的关键基础设施。
