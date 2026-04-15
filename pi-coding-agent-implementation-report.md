# PI-Coding-Agent 技术实现研究报告：上下文压缩与 Prompt Caching

## 一、目标概述

本报告分析如何为 PI-Coding-Agent（基于 Mini-Claw）实现 Hermes Agent 的核心优化技术：

1. **上下文压缩** (Context Compression)
2. **Prompt Caching** (Anthropic 风格)
3. **Token 追踪与预算管理**
4. **工具输出裁剪**

---

## 二、当前 PI-Coding-Agent 现状分析

### 2.1 当前 Agent 实现（Mini-Claw）

```python
# mini-claw/miniclaw/agent.py
class Agent:
    def __init__(self, llm, workspace, system_prompt, max_turns=10):
        self.history: list[Message] = []  # 线性增长，无限制

    async def run(self, user_message: str) -> AgentResult:
        while self._turn_count < self.max_turns:
            response = await self.llm.chat(
                messages=self.history,  # 完整历史
                system_prompt=self.system_prompt,
                tools=TOOLS,
            )
            # 工具结果直接追加到历史
            self.history.append(Message(role="user", content=f"Tool result: {result}"))
```

### 2.2 缺失的关键功能

| 功能 | Mini-Claw | Hermes Agent | PI-Coding-Agent 目标 |
|------|-----------|-------------|---------------------|
| Token 追踪 | ❌ | ✅ | ✅ |
| 上下文压缩 | ❌ | ✅ (ContextCompressor) | ✅ |
| Prompt Caching | ❌ | ✅ (4 断点策略) | ✅ |
| 工具输出裁剪 | ❌ | ✅ (1 行摘要) | ✅ |
| 反抖动保护 | ❌ | ✅ | ✅ |
| 迭代摘要更新 | ❌ | ✅ | ✅ |

---

## 三、详细实现方案

### 3.1 模块结构设计

```
pi-coding-agent/
├── agent/
│   ├── __init__.py
│   ├── agent.py           # 修改现有 Agent 类
│   ├── context/
│   │   ├── __init__.py
│   │   ├── engine.py       # ContextEngine 抽象基类
│   │   ├── compressor.py   # ContextCompressor 实现
│   │   ├── summarizer.py  # LLM 摘要生成器
│   │   ├── tokenizer.py    # Token 估算（tiktoken 封装）
│   │   └── caching.py      # Prompt Caching 工具
│   ├── memory/
│   │   ├── __init__.py
│   │   └── memory.py       # 简单记忆系统
│   └── llm/
│       ├── __init__.py
│       ├── client.py        # LLM 客户端封装
│       └── anthropic.py     # Anthropic 适配器
```

### 3.2 Token 追踪器

```python
# agent/context/tokenizer.py
import tiktoken
from typing import List, Dict, Any

class TokenEstimator:
    """Token 估算器，支持多种编码"""

    def __init__(self, model: str = "claude-3"):
        # Claude 3 使用 cl100k_base 编码
        self.encoder = tiktoken.get_encoding("cl100k_base")

    def estimate_messages_tokens(self, messages: List[Dict[str, Any]]) -> int:
        """估算消息列表的 token 数量"""
        total = 0

        for msg in messages:
            # 角色开销
            total += 4

            # 内容
            content = msg.get("content", "")
            if isinstance(content, str):
                total += len(self.encoder.encode(content))
            elif isinstance(content, list):
                for part in content:
                    if isinstance(part, dict):
                        text = part.get("text", "")
                        total += len(self.encoder.encode(text))

            # 工具调用开销
            if msg.get("tool_calls"):
                total += len(str(msg["tool_calls"])) // 4

            total += 1  # message 分隔符

        return total

    def estimate_single_message(self, content: str) -> int:
        """估算单条消息的 token 数量"""
        return len(self.encoder.encode(content)) + 4  # +4 for role/separator
```

### 3.3 上下文引擎抽象基类

```python
# agent/context/engine.py
from abc import ABC, abstractmethod
from typing import List, Dict, Any, Optional

class ContextEngine(ABC):
    """上下文管理引擎抽象基类"""

    @property
    @abstractmethod
    def name(self) -> str:
        """引擎名称"""

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
        focus_topic: str = None,
    ) -> List[Dict[str, Any]]:
        """压缩消息列表"""

    # 生命周期钩子
    def on_session_start(self, session_id: str) -> None:
        """会话开始时调用"""

    def on_session_reset(self) -> None:
        """重置会话时调用"""
        self._previous_summary = None
        self._compression_count = 0
```

### 3.4 上下文压缩器实现

```python
# agent/context/compressor.py
import re
import json
from typing import List, Dict, Any, Optional
from .engine import ContextEngine
from .tokenizer import TokenEstimator
from .summarizer import LLMSummarizer

# 常量
SUMMARY_PREFIX = (
    "[CONTEXT COMPACTION] Earlier turns were compacted. "
    "This is a reference summary, NOT new instructions. "
    "Do NOT answer questions from this summary; they were already addressed."
)

# 工具结果摘要模板
TOOL_SUMMARY_TEMPLATES = {
    "terminal": "[terminal] {cmd} -> exit {exit_code}, {lines} lines",
    "read": "[read] {path} ({lines} lines)",
    "write": "[write] wrote to {path}",
    "search": "[search] '{pattern}' -> {count} matches",
    "glob": "[glob] '{pattern}' -> {count} files",
}

class ContextCompressor(ContextEngine):
    """
    默认上下文压缩器

    算法：
      1. 预裁剪：工具输出替换为 1 行摘要
      2. 保护头部：保留系统提示 + 前 N 条消息
      3. 保护尾部：按 Token 预算保留最近消息
      4. 摘要中部：用 LLM 生成结构化摘要
      5. 迭代更新：复用前一次摘要
    """

    def __init__(
        self,
        model: str,
        context_length: int = 128000,
        threshold_percent: float = 0.50,
        protect_first_n: int = 3,
        tail_token_budget: int = 20000,
        summarizer: LLMSummarizer = None,
    ):
        self.model = model
        self.context_length = context_length
        self.threshold_percent = threshold_percent
        self.protect_first_n = protect_first_n
        self.tail_token_budget = tail_token_budget
        self.summarizer = summarizer

        # 计算阈值
        self.threshold_tokens = int(context_length * threshold_percent)

        # Token 估算器
        self._token_estimator = TokenEstimator()

        # 状态
        self._previous_summary: Optional[str] = None
        self._compression_count = 0
        self._last_compression_savings_pct = 100.0
        self._ineffective_compression_count = 0

        # 反抖动冷却时间
        self._failure_cooldown_until = 0

    @property
    def name(self) -> str:
        return "compressor"

    def update_from_response(self, usage: Dict[str, Any]) -> None:
        """从 API 响应更新统计"""
        self._last_prompt_tokens = usage.get("prompt_tokens", 0)
        self._last_completion_tokens = usage.get("completion_tokens", 0)

    def should_compress(self, prompt_tokens: int = None) -> bool:
        """判断是否应该压缩"""
        import time

        # 检查冷却时间
        if time.monotonic() < self._failure_cooldown_until:
            return False

        # 检查阈值
        tokens = prompt_tokens or self._last_prompt_tokens
        if tokens < self.threshold_tokens:
            return False

        # 反抖动：如果最近两次压缩效率都低于 10%，跳过
        if self._ineffective_compression_count >= 2:
            return False

        return True

    def compress(
        self,
        messages: List[Dict[str, Any]],
        current_tokens: int = None,
        focus_topic: str = None,
    ) -> List[Dict[str, Any]]:
        """执行上下文压缩"""
        if len(messages) <= self.protect_first_n + 3:
            return messages

        # Phase 1: 预裁剪工具输出
        messages = self._prune_tool_results(messages)

        # Phase 2: 估算 Token
        tokens = current_tokens
        if tokens is None:
            tokens = self._token_estimator.estimate_messages_tokens(messages)

        # Phase 3: 确定压缩边界
        compress_start = self._find_compress_start(messages)
        compress_end = self._find_compress_end(messages, tokens)

        if compress_start >= compress_end:
            return messages

        # Phase 4: 生成摘要
        middle_messages = messages[compress_start:compress_end]
        summary = self._generate_summary(middle_messages, focus_topic)

        # Phase 5: 组装压缩后的消息
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
            compressed.append({
                "role": "user",
                "content": f"{SUMMARY_PREFIX}\n\n[{len(middle_messages)} turns were removed]"
            })

        # 尾部
        for i in range(compress_end, len(messages)):
            compressed.append(messages[i].copy())

        # Phase 6: 更新统计
        self._compression_count += 1
        new_tokens = self._token_estimator.estimate_messages_tokens(compressed)
        savings_pct = (tokens - new_tokens) / tokens * 100 if tokens > 0 else 0

        if savings_pct < 10:
            self._ineffective_compression_count += 1
        else:
            self._ineffective_compression_count = 0

        self._last_compression_savings_pct = savings_pct

        return compressed

    def _prune_tool_results(self, messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """预裁剪：工具输出替换为 1 行摘要"""
        result = []

        for msg in messages:
            if msg.get("role") == "tool":
                content = msg.get("content", "")

                # 只有大结果 (>200 chars) 才裁剪
                if len(content) > 200:
                    msg = self._summarize_tool_result(msg, result)
            result.append(msg)

        return result

    def _summarize_tool_result(
        self,
        msg: Dict[str, Any],
        history: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """为工具结果生成 1 行摘要"""
        # 尝试从历史中找工具名
        tool_name = self._get_tool_name_from_history(msg, history)

        content = msg.get("content", "")
        lines = content.count("\n") + 1

        # 模板摘要
        templates = {
            "terminal": f"[terminal] exit 0, {lines} lines output",
            "read": f"[read] {lines} lines",
            "write": "[write] file updated",
            "search": f"[search] {lines} lines of results",
        }

        summary = templates.get(tool_name, f"[{tool_name}] {lines} lines output")
        return {**msg, "content": summary}

    def _get_tool_name_from_history(
        self,
        msg: Dict[str, Any]],
        history: List[Dict[str, Any]],
    ) -> str:
        """从历史中提取工具名"""
        tool_call_id = msg.get("tool_call_id", "")

        # 向后查找对应的 tool_call
        for prev_msg in reversed(history):
            if prev_msg.get("role") == "assistant":
                tool_calls = prev_msg.get("tool_calls", [])
                for tc in tool_calls:
                    fn = tc.get("function", {}) if isinstance(tc, dict) else getattr(tc, "function", {})
                    if isinstance(fn, dict):
                        cid = tc.get("id", "")
                    else:
                        cid = getattr(tc, "id", "")
                    if cid == tool_call_id:
                        return fn.get("name", "?") if isinstance(fn, dict) else getattr(fn, "name", "?")
        return "unknown"

    def _find_compress_start(self, messages: List[Dict[str, Any]]) -> int:
        """找到压缩起始位置"""
        return min(self.protect_first_n, len(messages) - 1)

    def _find_compress_end(
        self,
        messages: List[Dict[str, Any]],
        total_tokens: int,
    ) -> int:
        """从后向前找，找到 Token 预算边界"""
        budget = self.tail_token_budget
        accumulated = 0

        for i in range(len(messages) - 1, -1, -1):
            msg = messages[i]
            content = msg.get("content", "")
            if isinstance(content, list):
                content = "".join(p.get("text", "") for p in content if isinstance(p, dict))

            msg_tokens = self._token_estimator.estimate_single_message(content)

            if accumulated + msg_tokens > budget:
                return i + 1

            accumulated += msg_tokens

        return len(messages)

    def _generate_summary(
        self,
        messages: List[Dict[str, Any]],
        focus_topic: str = None,
    ) -> Optional[str]:
        """使用 LLM 生成结构化摘要"""
        if not self.summarizer:
            return None

        import time

        # 检查冷却时间
        if time.monotonic() < self._failure_cooldown_until:
            return None

        prompt = self._build_summary_prompt(messages, focus_topic)

        try:
            if self._previous_summary:
                return self.summarizer.update(
                    previous=self._previous_summary,
                    new=messages,
                    prompt=prompt,
                )
            else:
                return self.summarizer.generate(messages, prompt)
        except Exception as e:
            import logging
            logging.warning(f"Summary generation failed: {e}")
            self._failure_cooldown_until = time.monotonic() + 600
            return None

    def _build_summary_prompt(
        self,
        messages: List[Dict[str, Any]],
        focus_topic: str = None,
    ) -> str:
        """构建摘要提示"""
        formatted = self._serialize_for_summary(messages)

        prompt = f"""You are a summarization agent creating a context checkpoint.
Your output will be injected as reference material for a DIFFERENT assistant.
Do NOT respond to any questions — only output the structured summary.

## Goal
[What the user is trying to accomplish]

## Completed Actions
[Numbered list: ACTION target — outcome [tool: name]]

## Current State
[Files modified, test status, running processes]

## Remaining Work
[What still needs to be done]

## Conversation:
{formatted}

Target ~500 tokens. Be specific — include file paths, commands, results."""

        if focus_topic:
            prompt += f'\n\nFOCUS TOPIC: "{focus_topic}"\nPrioritize preserving information related to this topic.'

        return prompt

    def _serialize_for_summary(self, messages: List[Dict[str, Any]]) -> str:
        """将消息序列化为摘要格式"""
        parts = []

        for msg in messages:
            role = msg.get("role", "unknown")
            content = msg.get("content", "")

            if role == "tool":
                tool_id = msg.get("tool_call_id", "")
                parts.append(f"[TOOL RESULT {tool_id}]: {content}")
            elif role == "assistant":
                tool_calls = msg.get("tool_calls", [])
                if tool_calls:
                    tc_parts = []
                    for tc in tool_calls:
                        fn = tc.get("function", {}) if isinstance(tc, dict) else getattr(tc, "function", {})
                        name = fn.get("name", "?") if isinstance(fn, dict) else getattr(fn, "name", "?")
                        args = fn.get("arguments", "{}") if isinstance(fn, dict) else getattr(fn, "arguments", "{}")
                        tc_parts.append(f"  {name}({args})")
                    content += "\n[Tool calls:\n" + "\n".join(tc_parts) + "\n]"
                parts.append(f"[ASSISTANT]: {content}")
            else:
                parts.append(f"[{role.upper()}]: {content}")

        return "\n\n".join(parts)
```

### 3.5 Prompt Caching 实现

```python
# agent/context/caching.py
import copy
from typing import List, Dict, Any

def apply_prompt_caching(
    messages: List[Dict[str, Any]],
    cache_ttl: str = "5m",
    provider: str = "anthropic",
) -> List[Dict[str, Any]]:
    """
    应用 Prompt Caching

    对于 Anthropic API：在指定位置添加 cache_control 断点
    对于 OpenAI API：添加带有 cache_control 的 content 块

    策略 "system_and_3"：
      1. 系统提示（静态）
      2-4. 最近 3 条非系统消息（滚动窗口）
    """
    messages = copy.deepcopy(messages)
    if not messages:
        return messages

    marker = {"type": "ephemeral"}
    if cache_ttl == "1h":
        marker["ttl"] = "1h"

    breakpoints_used = 0

    # 断点 1: 系统提示
    if messages and messages[0].get("role") == "system":
        _apply_cache_marker(messages[0], marker, provider)
        breakpoints_used += 1

    # 断点 2-4: 最近 3 条非系统消息
    remaining = 4 - breakpoints_used
    non_sys_indices = [i for i in range(len(messages)) if messages[i].get("role") != "system"]

    for idx in non_sys_indices[-remaining:]:
        _apply_cache_marker(messages[idx], marker, provider)

    return messages


def _apply_cache_marker(msg: dict, marker: dict, provider: str) -> None:
    """为消息添加 cache_control 标记"""
    role = msg.get("role", "")
    content = msg.get("content")

    # Anthropic 格式
    if provider == "anthropic":
        if role == "tool":
            msg["cache_control"] = marker
            return

        if content is None or content == "":
            msg["cache_control"] = marker
            return

        if isinstance(content, str):
            msg["content"] = [
                {"type": "text", "text": content, "cache_control": marker}
            ]
            return

        if isinstance(content, list) and content:
            last = content[-1]
            if isinstance(last, dict):
                last["cache_control"] = marker

    # OpenAI 格式（部分支持）
    elif provider == "openai":
        if isinstance(content, str):
            msg["content"] = [
                {"type": "text", "text": content, "cache_control": marker}
            ]
        elif isinstance(content, list) and content:
            last = content[-1]
            if isinstance(last, dict) and last.get("type") == "text":
                last["cache_control"] = marker


def check_caching_support(provider: str, model: str) -> bool:
    """检查 Provider 和模型是否支持 Prompt Caching"""
    supports_caching = {
        "anthropic": ["claude-3-5-sonnet", "claude-3-5-haiku", "claude-3-opus"],
        "openai": [],  # OpenAI 尚未广泛支持
        "openrouter": ["anthropic/*"],  # 通过 Anthropic 模型支持
    }

    if provider not in supports_caching:
        return False

    models = supports_caching[provider]
    if not models:  # 空列表表示完全不支持
        return False

    # 检查是否匹配任何支持的模型
    for supported in models:
        if "*" in supported:
            prefix = supported.replace("*", "")
            if model.startswith(prefix):
                return True
        elif model == supported:
            return True

    return False
```

### 3.6 LLM 摘要生成器

```python
# agent/context/summarizer.py
from typing import List, Dict, Any, Optional
import json

class LLMSummarizer:
    """LLM 摘要生成器"""

    def __init__(
        self,
        llm_client,
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
        try:
            response = self.llm.chat(
                model=self.model,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=self.summary_tokens,
                temperature=0.3,  # 低温度保证一致性
            )
            return response.content.strip()
        except Exception as e:
            import logging
            logging.error(f"Summary generation failed: {e}")
            return None

    def update(
        self,
        previous: str,
        new: List[Dict[str, Any]],
        prompt: str,
    ) -> Optional[str]:
        """增量更新摘要"""
        formatted = self._format_messages(new)

        update_prompt = f"""Update this summary with new conversation turns.

PREVIOUS SUMMARY:
{previous}

NEW TURNS:
{formatted}

Update the summary. PRESERVE relevant existing information.
ADD new completed actions. Update current state.
Remove obsolete information."""

        return self.generate(None, update_prompt)

    def _format_messages(self, messages: List[Dict[str, Any]]) -> str:
        """格式化消息为文本"""
        parts = []
        for msg in messages:
            role = msg.get("role", "unknown")
            content = msg.get("content", "")

            if role == "tool":
                tool_id = msg.get("tool_call_id", "")
                parts.append(f"[TOOL {tool_id}]: {content}")
            elif role == "assistant":
                tool_calls = msg.get("tool_calls", [])
                if tool_calls:
                    tc_names = [tc.get("function", {}).get("name", "?")
                               if isinstance(tc, dict) else getattr(getattr(tc, "function", None), "name", "?")
                               for tc in tool_calls]
                    content += f" [calling: {', '.join(tc_names)}]"
                parts.append(f"[ASSISTANT]: {content}")
            else:
                parts.append(f"[{role.upper()}]: {content}")

        return "\n\n".join(parts)
```

### 3.7 Agent 集成

```python
# agent/agent.py (修改现有 Agent 类)
from agent.context import ContextCompressor, LLMSummarizer, apply_prompt_caching
from agent.context.tokenizer import TokenEstimator

class Agent:
    def __init__(
        self,
        llm,
        workspace,
        system_prompt,
        max_turns=10,
        # 新参数
        context_length=128000,
        compression_threshold=0.50,
        enable_caching=True,
        enable_compression=True,
    ):
        self.llm = llm
        self.workspace = workspace
        self.max_turns = max_turns

        # 系统提示和历史
        self.system_prompt = system_prompt or self._build_system_prompt()
        self.history: list[Message] = []

        # Token 估算器
        self._token_estimator = TokenEstimator()

        # 上下文压缩
        if enable_compression:
            summarizer = LLMSummarizer(llm)
            self._context_engine = ContextCompressor(
                model=llm.model,
                context_length=context_length,
                threshold_percent=compression_threshold,
                summarizer=summarizer,
            )
        else:
            self._context_engine = None

        # Prompt Caching
        self._enable_caching = enable_caching and self._supports_caching()

    def _supports_caching(self) -> bool:
        """检查是否支持 Prompt Caching"""
        # 根据 LLM 类型判断
        provider = getattr(self.llm, "provider", "openai")
        model = getattr(self.llm, "model", "")

        from agent.context.caching import check_caching_support
        return check_caching_support(provider, model)

    async def run(self, user_message: str) -> AgentResult:
        self._turn_count = 0
        tool_executions = []

        self.history.append(Message(role="user", content=user_message))

        while self._turn_count < self.max_turns:
            self._turn_count += 1

            # 检查是否需要压缩
            if self._context_engine:
                current_tokens = self._token_estimator.estimate_messages_tokens(
                    self._build_messages()
                )
                if self._context_engine.should_compress(current_tokens):
                    self.history = self._context_engine.compress(
                        self.history,
                        current_tokens,
                    )
                    print(f"[Context compressed, {len(self.history)} messages remaining]")

            # 构建 API 请求
            messages = self._build_messages()

            # 应用 Prompt Caching
            if self._enable_caching:
                messages = apply_prompt_caching(messages)

            # 发送请求
            response = await self.llm.chat(
                messages=messages,
                system_prompt=self.system_prompt,
                tools=TOOLS,
            )

            # 更新压缩器统计
            if self._context_engine and response.usage:
                self._context_engine.update_from_response(response.usage)

            # 处理响应
            if response.tool_calls:
                for tool_call in response.tool_calls:
                    execution = await self._execute_tool(tool_call)
                    tool_executions.append(execution)

                    self.history.append(Message(
                        role="user",
                        content=f"Tool '{tool_call.name}' result: {execution.result}",
                    ))
            elif response.content:
                self.history.append(Message(role="assistant", content=response.content))

                if self._is_final_response(response.content):
                    return AgentResult(
                        response=response.content,
                        tool_executions=tool_executions,
                        usage=response.usage,
                        turns=self._turn_count,
                    )
            else:
                break

        return AgentResult(
            response=self.history[-1].content if self.history else "No response",
            tool_executions=tool_executions,
            usage=None,
            turns=self._turn_count,
        )

    def _build_messages(self) -> List[Dict[str, Any]]:
        """构建发送给 LLM 的消息列表"""
        messages = []

        for msg in self.history:
            if isinstance(msg, Message):
                messages.append({"role": msg.role, "content": msg.content})
            else:
                messages.append(msg)

        return messages
```

---

## 四、配置选项

```python
# agent/config.py
from dataclasses import dataclass

@dataclass
class ContextConfig:
    """上下文管理配置"""

    # 压缩设置
    enable_compression: bool = True
    compression_threshold: float = 0.50  # 50% context window
    protect_first_n: int = 3
    tail_token_budget: int = 20000

    # 摘要设置
    summary_model: str = "gpt-4o-mini"
    summary_tokens: int = 2000

    # Caching 设置
    enable_caching: bool = True
    cache_ttl: str = "5m"  # "5m" or "1h"

    # 工具输出裁剪
    tool_result_prune_threshold: int = 200  # chars

    @classmethod
    def from_dict(cls, data: dict) -> "ContextConfig":
        """从字典创建配置"""
        return cls(
            enable_compression=data.get("enable_compression", True),
            compression_threshold=data.get("compression_threshold", 0.50),
            protect_first_n=data.get("protect_first_n", 3),
            tail_token_budget=data.get("tail_token_budget", 20000),
            summary_model=data.get("summary_model", "gpt-4o-mini"),
            summary_tokens=data.get("summary_tokens", 2000),
            enable_caching=data.get("enable_caching", True),
            cache_ttl=data.get("cache_ttl", "5m"),
            tool_result_prune_threshold=data.get("tool_result_prune_threshold", 200),
        )
```

---

## 五、使用示例

```python
# 示例 1: 基本使用
from agent import Agent
from agent.llm import create_llm

llm = create_llm("anthropic", api_key="sk-...")
agent = Agent(
    llm=llm,
    workspace="/path/to/project",
    max_turns=50,
    context_length=128000,
    compression_threshold=0.50,
    enable_caching=True,
)

result = await agent.run("Fix the authentication bug in users.py")

# 示例 2: 手动触发压缩
agent.context_engine.compress(
    agent.history,
    focus_topic="authentication"
)

# 示例 3: 禁用压缩
agent = Agent(
    llm=llm,
    workspace="/path/to/project",
    enable_compression=False,  # 禁用压缩
)
```

---

## 六、实现优先级

### Phase 1: 基础 Token 追踪（1-2 天）
1. 实现 `TokenEstimator`
2. 在 Agent 中添加 Token 统计
3. 添加压缩触发日志

### Phase 2: 简单裁剪（2-3 天）
1. 实现工具输出预裁剪
2. 实现头部/尾部保护
3. 添加压缩触发条件判断

### Phase 3: LLM 摘要（3-5 天）
1. 实现 `LLMSummarizer`
2. 实现结构化摘要模板
3. 添加迭代摘要更新

### Phase 4: Prompt Caching（2-3 天）
1. 实现 `apply_prompt_caching()`
2. 添加 Provider 检测
3. 集成到 Agent Loop

### Phase 5: 优化（持续）
1. 反抖动保护
2. 工具对清理
3. 性能监控 Dashboard

---

## 七、注意事项

### 7.1 Prompt Caching 限制

- **Anthropic**: 需要模型支持（Claude 3.5+）
- **OpenAI**: 部分支持，需要检查模型
- **缓存失效**: 不要在缓存区域内修改历史消息

### 7.2 Token 估算精度

- 使用 `tiktoken` 或模型对应的 tokenizer
- 考虑工具调用 JSON 的编码开销
- 考虑消息格式差异

### 7.3 与现有系统兼容

- 如果 PI-Coding-Agent 有自己的历史管理，需要适配
- 考虑向后兼容

### 7.4 成本考虑

- 摘要生成需要额外的 LLM 调用
- 使用便宜模型（如 gpt-4o-mini）进行摘要
- 设置超时和冷却时间防止无限重试

---

## 八、参考实现

| 组件 | Hermes 实现 | 文件 |
|------|-----------|------|
| Token 估算 | `estimate_messages_tokens_rough()` | `agent/model_metadata.py` |
| ContextEngine 基类 | `ContextEngine` | `agent/context_engine.py` |
| ContextCompressor | `ContextCompressor` | `agent/context_compressor.py` |
| Prompt Caching | `apply_anthropic_cache_control()` | `agent/prompt_caching.py` |
| 工具输出摘要 | `_summarize_tool_result()` | `agent/context_compressor.py` |
| Agent 集成 | `_compress_context()` | `run_agent.py` |
