# Context Compression 实现研究报告

## 一、OpenClaw/Mini-Claw 现状分析

### 1.1 Mini-Claw Context 处理方式

Mini-Claw 是一个简化版的 Agent 实现，**完全没有上下文压缩机制**：

```python
# mini-claw/miniclaw/agent.py
class Agent:
    def __init__(self, llm, workspace, system_prompt, max_turns=10):
        self.history: list[Message] = []  # 线性追加，无限制

    async def run(self, user_message: str) -> AgentResult:
        self.history.append(Message(role="user", content=user_message))

        while self._turn_count < self.max_turns:
            response = await self.llm.chat(
                messages=self.history,  # 完整历史，无压缩
                system_prompt=self.system_prompt,
                tools=TOOLS,
            )

            if response.tool_calls:
                for tool_call in response.tool_calls:
                    # 工具结果直接追加到历史
                    self.history.append(Message(
                        role="user",
                        content=f"Tool '{tool_call.name}' result: {execution.result}",
                    ))
            # ...
```

**问题**：
- 消息历史无限增长
- 每次 API 调用都发送完整历史
- 没有 Token 计数和预算管理
- 没有对话摘要能力
- 长对话会导致 Token 超限或成本飙升

### 1.2 Hermes-Agent 的 Context Compression 架构

Hermes-Agent 实现了完整的上下文压缩系统：

```
┌─────────────────────────────────────────────────────────────┐
│                    ContextEngine (抽象基类)                    │
│  - update_from_response()  更新 Token 使用统计               │
│  - should_compress()      判断是否需要压缩                   │
│  - compress()             执行压缩                           │
│  - get_tool_schemas()    可选：提供工具                     │
├─────────────────────────────────────────────────────────────┤
│              ContextCompressor (默认实现)                     │
│  1. 预裁剪：工具输出替换为 1 行摘要                         │
│  2. 头部保护：保留系统提示 + 前 N 条消息                     │
│  3. 尾部保护：按 Token 预算保留最近消息                      │
│  4. LLM 摘要：用 LLM 生成结构化摘要                         │
│  5. 迭代更新：复用前一次摘要                                │
└─────────────────────────────────────────────────────────────┘
```

---

## 二、PI-Coding-Agent Context Compression 实现方案

### 2.1 核心组件设计

```
pi-coding-agent/
├── context/
│   ├── __init__.py
│   ├── engine.py           # ContextEngine 抽象基类
│   ├── compressor.py       # ContextCompressor 默认实现
│   ├── summarizer.py      # LLM 摘要生成器
│   └── token_tracker.py    # Token 计数和预算管理
```

### 2.2 抽象基类设计

```python
# context/engine.py
from abc import ABC, abstractmethod
from typing import List, Dict, Any, Optional

class ContextEngine(ABC):
    """上下文管理引擎抽象基类"""

    @property
    @abstractmethod
    def name(self) -> str:
        """引擎名称，如 'compressor', 'lcm'"""

    @property
    def threshold_percent(self) -> float:
        """触发压缩的上下文阈值百分比，默认 75%"""
        return 0.75

    @property
    def context_length(self) -> int:
        """模型上下文窗口大小"""
        return self._context_length

    @abstractmethod
    def update_from_response(self, usage: Dict[str, Any]) -> None:
        """从 API 响应更新 Token 使用统计"""

    @abstractmethod
    def should_compress(self, prompt_tokens: int = None) -> bool:
        """判断是否应该触发压缩"""

    @abstractmethod
    def compress(
        self,
        messages: List[Dict[str, Any]],
        current_tokens: int = None,
    ) -> List[Dict[str, Any]]:
        """压缩消息列表，返回压缩后的消息"""

    # --- 生命周期钩子 ---

    def on_session_start(self, session_id: str, **kwargs) -> None:
        """会话开始时调用"""

    def on_session_end(self, session_id: str, messages: List[Dict]) -> None:
        """会话结束时调用"""

    def on_session_reset(self) -> None:
        """重置会话时调用"""
```

### 2.3 Token 追踪器

```python
# context/token_tracker.py
from typing import Dict, Any

class TokenTracker:
    """Token 使用追踪器"""

    def __init__(self, context_length: int = 128000):
        self.context_length = context_length
        self.threshold_percent = 0.75

        # 统计
        self.last_prompt_tokens = 0
        self.last_completion_tokens = 0
        self.total_tokens_used = 0

        # 压缩计数
        self.compression_count = 0

    @property
    def threshold_tokens(self) -> int:
        """触发压缩的 Token 阈值"""
        return int(self.context_length * self.threshold_percent)

    @property
    def usage_percent(self) -> float:
        """当前使用百分比"""
        if self.context_length == 0:
            return 0
        return min(100, self.last_prompt_tokens / self.context_length * 100)

    def update(self, usage: Dict[str, Any]) -> None:
        """从 API 响应更新统计"""
        self.last_prompt_tokens = usage.get("prompt_tokens", 0)
        self.last_completion_tokens = usage.get("completion_tokens", 0)
        self.total_tokens_used += self.last_prompt_tokens + self.last_completion_tokens

    def should_compress(self) -> bool:
        """判断是否应该压缩"""
        if self.last_prompt_tokens < self.threshold_tokens:
            return False

        # 反抖动：如果最近两次压缩效率都低于 10%，跳过
        if self._ineffective_count >= 2:
            return False

        return True


def estimate_tokens(messages: List[Dict[str, Any]]) -> int:
    """
    估算消息列表的 Token 数量

    使用简单估算：1 Token ≈ 4 字符
    实际应使用 tiktoken 或 model's tokenizer
    """
    total = 0
    for msg in messages:
        content = msg.get("content", "")
        if isinstance(content, str):
            total += len(content) // 4 + 10  # 角色和元数据开销
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, dict):
                    total += len(part.get("text", "")) // 4

        # 工具调用开销
        if msg.get("tool_calls"):
            total += len(str(msg["tool_calls"])) // 4

    return total
```

### 2.4 压缩器实现

```python
# context/compressor.py
from typing import List, Dict, Any, Optional
from .token_tracker import TokenTracker, estimate_tokens
from .summarizer import generate_summary

# 摘要前缀标记
SUMMARY_PREFIX = (
    "[CONTEXT COMPACTION] Earlier conversation has been compacted. "
    "This is a reference summary, NOT new instructions. "
    "Do NOT answer questions from this summary; they were already addressed."
)

# 头部保护：保留前 3 条消息（系统提示等）
PROTECT_HEAD_COUNT = 3

# 尾部保护：保留最近 ~20K Tokens
TAIL_TOKEN_BUDGET = 20000


class ContextCompressor(ContextEngine):
    """
    默认上下文压缩器

    算法：
    1. 预裁剪：工具输出替换为 1 行摘要
    2. 保护头部：保留系统提示 + 第一轮对话
    3. 保护尾部：按 Token 预算保留最近消息
    4. 摘要中部：用 LLM 生成结构化摘要
    """

    def __init__(
        self,
        context_length: int = 128000,
        threshold_percent: float = 0.75,
        protect_first_n: int = PROTECT_HEAD_COUNT,
        tail_token_budget: int = TAIL_TOKEN_BUDGET,
        summarizer = None,  # LLM 摘要器
    ):
        self._context_length = context_length
        self.threshold_percent = threshold_percent
        self.protect_first_n = protect_first_n
        self.tail_token_budget = tail_token_budget
        self.summarizer = summarizer

        self._tracker = TokenTracker(context_length)
        self._previous_summary: Optional[str] = None
        self._ineffective_count = 0

    @property
    def name(self) -> str:
        return "compressor"

    @property
    def context_length(self) -> int:
        return self._context_length

    @context_length.setter
    def context_length(self, value: int) -> None:
        self._context_length = value
        self._tracker.context_length = value

    def update_from_response(self, usage: Dict[str, Any]) -> None:
        self._tracker.update(usage)

    def should_compress(self, prompt_tokens: int = None) -> bool:
        if prompt_tokens is not None:
            self._tracker.last_prompt_tokens = prompt_tokens
        return self._tracker.should_compress()

    def compress(
        self,
        messages: List[Dict[str, Any]],
        current_tokens: int = None,
    ) -> List[Dict[str, Any]]:
        """执行上下文压缩"""
        if len(messages) <= self.protect_first_n + 3:
            return messages  # 消息太少，无需压缩

        # 计算 Token
        tokens = current_tokens or estimate_tokens(messages)

        # Phase 1: 预裁剪工具输出
        messages = self._prune_tool_results(messages)

        # Phase 2: 确定压缩边界
        compress_start = self._find_compress_start(messages)
        compress_end = self._find_compress_end(messages, tokens)

        if compress_start >= compress_end:
            return messages

        # Phase 3: 生成摘要
        middle_messages = messages[compress_start:compress_end]
        summary = self._generate_summary(middle_messages)

        # Phase 4: 组装压缩后的消息
        compressed = []

        # 头部
        for i in range(compress_start):
            compressed.append(messages[i].copy())

        # 摘要
        if summary:
            compressed.append({
                "role": "user",
                "content": f"{SUMMARY_PREFIX}\n\n{summary}"
            })
            self._previous_summary = summary
        else:
            # 摘要生成失败，插入静态标记
            compressed.append({
                "role": "user",
                "content": (
                    f"{SUMMARY_PREFIX}\n\n"
                    f"[{len(middle_messages)} turns were removed to save context space]"
                )
            })

        # 尾部
        for i in range(compress_end, len(messages)):
            compressed.append(messages[i].copy())

        # 更新统计
        self._tracker.compression_count += 1
        new_tokens = estimate_tokens(compressed)
        savings = tokens - new_tokens

        if savings < tokens * 0.1:
            self._ineffective_count += 1
        else:
            self._ineffective_count = 0

        return compressed

    def _prune_tool_results(
        self, messages: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """
        预裁剪：工具输出替换为 1 行摘要

        不调用 LLM，成本低
        """
        result = []
        tool_counts: Dict[str, int] = {}

        for msg in messages:
            if msg.get("role") == "tool":
                content = msg.get("content", "")

                # 只有大结果才裁剪
                if len(content) > 200:
                    tool_name = self._get_tool_name_from_history(msg, result)
                    summary = self._summarize_tool_result(tool_name, content)
                    msg = {**msg, "content": summary}

                # 记录工具名
                if tool_name:
                    tool_counts[tool_name] = tool_counts.get(tool_name, 0) + 1

            result.append(msg)

        return result

    def _summarize_tool_result(self, tool_name: str, content: str) -> str:
        """为工具结果生成 1 行摘要"""
        lines = content.count("\n") + 1

        summaries = {
            "bash": f"[bash] exit 0, {lines} lines output",
            "read": f"[read] {lines} lines",
            "write": f"[write] file created/updated",
            "search": f"[search] {lines} lines of results",
        }

        return summaries.get(tool_name, f"[{tool_name}] {lines} lines output")

    def _find_compress_start(self, messages: List[Dict[str, Any]]) -> int:
        """找到压缩起始位置（跳过头部保护消息）"""
        return min(self.protect_first_n, len(messages) - 1)

    def _find_compress_end(
        self, messages: List[Dict[str, Any]], tokens: int
    ) -> int:
        """
        从后向前找，找到 Token 预算边界

        保证尾部有足够的上下文
        """
        budget = self.tail_token_budget
        accumulated = 0

        # 从后向前遍历
        for i in range(len(messages) - 1, -1, -1):
            msg = messages[i]
            content = msg.get("content", "")
            if isinstance(content, list):
                content = "".join(p.get("text", "") for p in content if isinstance(p, dict))

            msg_tokens = len(content) // 4 + 10

            if accumulated + msg_tokens > budget:
                return i + 1

            accumulated += msg_tokens

        return len(messages)

    def _generate_summary(
        self, messages: List[Dict[str, Any]]
    ) -> Optional[str]:
        """使用 LLM 生成结构化摘要"""
        if not self.summarizer:
            return None

        # 构建摘要提示
        prompt = self._build_summary_prompt(messages)

        try:
            # 如果有前一次摘要，进行增量更新
            if self._previous_summary:
                return self.summarizer.update(
                    previous=self._previous_summary,
                    new=messages,
                    prompt=prompt,
                )
            else:
                return self.summarizer.generate(messages, prompt)
        except Exception as e:
            logging.warning(f"Summary generation failed: {e}")
            return None

    def _build_summary_prompt(self, messages: List[Dict[str, Any]]) -> str:
        """构建摘要提示模板"""
        # 将消息格式化为文本
        formatted = self._format_messages_for_summary(messages)

        return f"""Create a structured summary of this conversation for a different assistant.

## Goal
[What the user is trying to accomplish]

## Completed Actions
[Numbered list of actions taken - include tool used, target, outcome]

## Current State
[Working state - modified files, test status, running processes]

## Remaining Work
[What still needs to be done]

## Conversation:
{formatted}

Target ~500 tokens. Be specific - include file paths, commands, results."""
```

### 2.5 摘要生成器

```python
# context/summarizer.py
from typing import List, Dict, Any, Optional, Callable

class LLMSummarizer:
    """LLM 摘要生成器"""

    def __init__(
        self,
        llm_client,  # LLM 客户端
        model: str = "gpt-4o-mini",
        summary_tokens: int = 2000,
    ):
        self.llm = llm_client
        self.model = model
        self.summary_tokens = summary_tokens

    def generate(
        self,
        messages: List[Dict[str, Any]],
        prompt: str,
    ) -> Optional[str]:
        """生成摘要"""
        response = self.llm.chat(
            model=self.model,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=self.summary_tokens,
        )

        return response.content.strip()

    def update(
        self,
        previous: str,
        new: List[Dict[str, Any]],
        prompt: str,
    ) -> Optional[str]:
        """增量更新摘要"""
        formatted = self._format_messages_for_summary(new)

        update_prompt = f"""Update this summary with new conversation turns.

PREVIOUS SUMMARY:
{previous}

NEW TURNS:
{formatted}

Update the summary following this structure:
## Completed Actions - add to existing list
## Current State - update with new state
## Remaining Work - update pending work
## Resolved Questions - add answered questions

Be specific and concise."""

        response = self.llm.chat(
            model=self.model,
            messages=[{"role": "user", "content": update_prompt}],
            max_tokens=self.summary_tokens,
        )

        return response.content.strip()
```

### 2.6 Agent 集成

```python
# agent.py 修改
class Agent:
    def __init__(
        self,
        llm,
        workspace,
        system_prompt,
        max_turns=10,
        context_length=128000,
        compression_enabled=True,
    ):
        # ... 现有初始化 ...

        # 上下文压缩
        if compression_enabled:
            from context import ContextCompressor, LLMSummarizer
            summarizer = LLMSummarizer(llm)
            self.context_engine = ContextCompressor(
                context_length=context_length,
                summarizer=summarizer,
            )
        else:
            self.context_engine = None

    async def run(self, user_message: str) -> AgentResult:
        self._turn_count = 0
        tool_executions = []

        # 添加用户消息
        self.history.append(Message(role="user", content=user_message))

        while self._turn_count < self.max_turns:
            self._turn_count += 1

            # 检查是否需要压缩
            if self.context_engine and self.context_engine.should_compress():
                self.history = self.context_engine.compress(self.history)
                logging.info(f"Context compressed, {len(self.history)} messages remaining")

            # 获取 LLM 响应
            response = await self.llm.chat(
                messages=self.history,
                system_prompt=self.system_prompt,
                tools=TOOLS,
            )

            # 更新 Token 统计
            if response.usage:
                self.context_engine.update_from_response(response.usage)

            # 处理响应...
```

---

## 三、实现优先级和注意事项

### 3.1 分阶段实现

**Phase 1: 基础 Token 追踪**
- 实现 `TokenTracker`
- 实现 `estimate_tokens()` 估算函数
- 在 Agent 中添加 Token 统计

**Phase 2: 简单裁剪**
- 实现工具输出预裁剪
- 实现头部/尾部保护
- 触发压缩但不生成摘要

**Phase 3: LLM 摘要**
- 实现 `LLMSummarizer`
- 实现结构化摘要模板
- 支持增量更新

**Phase 4: 集成优化**
- 与 Agent Loop 深度集成
- 支持手动触发 `/compress`
- 添加反抖动保护

### 3.2 注意事项

1. **Token 估算精度**
   - 简单字符估算不够精确
   - 建议使用 `tiktoken` 或模型对应的 tokenizer
   - 考虑消息格式（JSON vs 普通文本）

2. **工具结果重要性**
   - 工具输出是 Agent 工作证明
   - 完全删除会丢失重要上下文
   - 需要有意义的摘要

3. **摘要质量**
   - 摘要器本身的 Token 消耗
   - 摘要质量影响后续决策
   - 需要结构化格式保留关键信息

4. **与现有系统兼容**
   - 如果 PI-Coding-Agent 有自己的历史管理
   - 需要适配而不是替换
   - 考虑向后兼容

5. **性能考虑**
   - 压缩触发时的延迟
   - LLM 摘要的成本
   - 缓存已压缩的上下文

---

## 四、总结对比

| 特性 | Mini-Claw | Hermes-Agent | PI-Coding-Agent (目标) |
|------|-----------|-------------|------------------------|
| Token 追踪 | ❌ | ✅ | ✅ |
| 头部保护 | ❌ | ✅ | ✅ |
| 尾部保护 | ❌ | ✅ (Token 预算) | ✅ |
| 工具输出裁剪 | ❌ | ✅ (1行摘要) | ✅ |
| LLM 摘要 | ❌ | ✅ (结构化) | ✅ |
| 增量更新 | ❌ | ✅ | ✅ |
| 反抖动保护 | ❌ | ✅ | ✅ |
| 插件架构 | ❌ | ✅ (可插拔) | ✅ |

Hermes-Agent 的 Context Compression 实现是当前最完善的参考，PI-Coding-Agent 可以直接借鉴其架构设计。
