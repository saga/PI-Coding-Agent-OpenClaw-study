# Memory Provider 架构对比研究报告

## 一、概述

Hermes Agent 的 Memory Provider 系统采用**插件化架构**，支持多种外部记忆提供者与内置记忆系统共存。每个 Provider 都是一个独立的插件，实现了统一的抽象接口 `MemoryProvider`。

**核心设计原则**：
- 内置记忆（Built-in）始终启用，不可移除
- 外部 Provider 一次只能启用一个
- 所有 Provider 通过 `MemoryManager` 统一调度

---

## 二、架构设计

### 2.1 MemoryProvider 抽象基类

```python
class MemoryProvider(ABC):
    """记忆提供者抽象基类"""

    # 必需实现
    @property
    @abstractmethod
    def name(self) -> str: ...

    @abstractmethod
    def is_available(self) -> bool: ...

    @abstractmethod
    def initialize(self, session_id: str, **kwargs) -> None: ...

    @abstractmethod
    def get_tool_schemas(self) -> List[Dict]: ...

    # 核心生命周期
    def system_prompt_block(self) -> str: ...
    def prefetch(self, query: str, session_id: str) -> str: ...
    def queue_prefetch(self, query: str, session_id: str) -> None: ...
    def sync_turn(self, user: str, assistant: str, session_id: str) -> None: ...

    # 可选钩子
    def on_turn_start(...) -> None: ...
    def on_session_end(...) -> None: ...
    def on_pre_compress(...) -> str: ...
    def on_delegation(...) -> None: ...
    def on_memory_write(...) -> None: ...

    # 配置
    def get_config_schema(self) -> List[Dict]: ...
    def save_config(self, values: Dict, hermes_home: str) -> None: ...
```

### 2.2 MemoryManager 调度

```python
class MemoryManager:
    """统一调度多个记忆提供者"""

    def add_provider(self, provider: MemoryProvider) -> None:
        """注册提供者（内置优先，外部限一个）"""

    def build_system_prompt(self) -> str:
        """收集所有提供者的系统提示"""

    def prefetch_all(self, query: str) -> str:
        """收集所有提供者的预取上下文"""

    def sync_all(self, user: str, assistant: str) -> None:
        """同步所有提供者的对话"""

    def get_all_tool_schemas(self) -> List[Dict]:
        """收集所有工具模式"""
```

---

## 三、Provider 详细对比

### 3.1 内置记忆 (Built-in Memory)

**实现文件**：`tools/memory_tool.py`

| 特性 | 说明 |
|------|------|
| 存储方式 | 文件系统（MEMORY.md, USER.md） |
| 持久化 | 会话启动时快照注入系统提示 |
| 写入模式 | 立即写入文件，但不更新当前会话提示 |
| 字符限制 | 可配置（默认 memory=10000, user=2000） |
| 安全扫描 | 支持（注入/泄露检测） |

**工具**：
- `memory add/replace/remove/read` - 操作记忆条目

**特点**：
- 零依赖，始终可用
- 快速简单，适合轻量使用
- 无语义搜索能力

### 3.2 Mem0

**实现文件**：`plugins/memory/mem0/`

| 特性 | 说明 |
|------|------|
| 存储方式 | 云端 API |
| 依赖 | `pip install mem0ai` + Mem0 API Key |
| 成本 | $20/月起 |
| 搜索方式 | 语义搜索 + Rerank |
| 特点 | LLM 事实提取 |

**工具**：
| 工具 | 说明 | LLM 调用 |
|------|------|----------|
| `mem0_profile` | 用户记忆快照 | 否 |
| `mem0_search` | 语义搜索 | 否 |
| `mem0_conclude` | 原文存储 | 否 |

**配置**：
```bash
hermes config set memory.provider mem0
echo "MEM0_API_KEY=xxx" >> ~/.hermes/.env
```

### 3.3 Honcho

**实现文件**：`plugins/memory/honcho/`

| 特性 | 说明 |
|------|------|
| 存储方式 | 云端 API 或自托管 |
| 依赖 | `pip install honcho-ai` + Honcho API Key |
| 核心概念 | Peer Cards（对等卡片） |
| 推理方式 | 方言推理（Dialectic Reasoning） |

**工具**：
| 工具 | 说明 | LLM 调用 |
|------|------|----------|
| `honcho_profile` | 用户对等卡片 | 否 |
| `honcho_search` | 语义搜索（800 tok 默认） | 否 |
| `honcho_context` | 方言推理合成 | **是** |
| `honcho_conclude` | 持久事实写入 | 否 |

**Recall 模式**：
- `hybrid`：自动注入 + 工具
- `context`：仅自动注入
- `tools`：仅工具

**观察模式**：
```json
{
  "user": { "observeMe": true, "observeOthers": true },
  "ai":   { "observeMe": true, "observeOthers": true }
}
```

### 3.4 OpenViking

**实现文件**：`plugins/memory/openviking/`

| 特性 | 说明 |
|------|------|
| 存储方式 | 自托管服务器（ByteDance/Volcengine） |
| 依赖 | `pip install openviking` + 服务端 |
| 架构 | 文件系统式知识层级 |
| 检索 | 分层检索（fast/deep/auto） |

**工具**：
| 工具 | 说明 |
|------|------|
| `viking_search` | 语义搜索 |
| `viking_read` | 读取 viking:// URI |
| `viking_browse` | 文件系统式导航 |
| `viking_remember` | 提交时存储事实 |
| `viking_add_resource` | 摄入 URL/文档 |

### 3.5 Holographic

**实现文件**：`plugins/memory/holographic/`

| 特性 | 说明 |
|------|------|
| 存储方式 | 本地 SQLite |
| 依赖 | 无（可选 NumPy 用于 HRR） |
| 核心概念 | 全息记忆（Holographic Memory） |
| 算法 | HRR（谐波表示推理） |

**工具**：
| 工具 | 说明 |
|------|------|
| `fact_store` | 9 种操作：add, search, probe, related, reason, contradict, update, remove, list |
| `fact_feedback` | 反馈评分（训练信任分数） |

**特点**：
- 完全本地，无需网络
- HRR 代数支持组合检索
- 信任评分系统

### 3.6 Hindsight

**实现文件**：`plugins/memory/hindsight/`

| 特性 | 说明 |
|------|------|
| 存储方式 | 云端 / 本地嵌入 / 本地外部 |
| 依赖 | API Key 或 LLM Provider |
| 架构 | 知识图谱 + 实体解析 |
| 检索 | 多策略（语义 + 图谱） |

**三种模式**：
1. **Cloud**：连接 Hindsight Cloud API
2. **Local Embedded**：本地 PostgreSQL + LLM（自动启动守护进程）
3. **Local External**：指向现有 Hindsight 实例

**工具**：
| 工具 | 说明 |
|------|------|
| `hindsight_retain` | 存储信息（自动实体提取） |
| `hindsight_recall` | 多策略搜索 |
| `hindsight_reflect` | 跨记忆合成（LLM） |

### 3.7 RetainDB

**实现文件**：`plugins/memory/retaindb/`

| 特性 | 说明 |
|------|------|
| 存储方式 | 云端 API |
| 依赖 | RetainDB 账户 |
| 成本 | $20/月 |
| 搜索方式 | Vector + BM25 + Reranking |

**工具**：
| 工具 | 说明 |
|------|------|
| `retaindb_profile` | 用户稳定画像 |
| `retaindb_search` | 语义搜索 |
| `retaindb_context` | 任务相关上下文 |
| `retaindb_remember` | 带类型和重要性的存储 |
| `retaindb_forget` | 按 ID 删除记忆 |

### 3.8 ByteRover

**实现文件**：`plugins/memory/byterover/`

| 特性 | 说明 |
|------|------|
| 存储方式 | 本地优先 + 可选云同步 |
| 依赖 | `brv` CLI |
| 架构 | 分层知识树 |

**工具**：
| 工具 | 说明 |
|------|------|
| `brv_query` | 查询知识树 |
| `brv_curate` | 存储事实、决策、模式 |
| `brv_status` | CLI 版本、树统计、同步状态 |

### 3.9 Supermemory

**实现文件**：`plugins/memory/supermemory/`

| 特性 | 说明 |
|------|------|
| 存储方式 | 云端 API |
| 依赖 | `pip install supermemory` + API Key |
| 特点 | Profile 召回、语义搜索 |

**工具**：
| 工具 | 说明 |
|------|------|
| `supermemory_store` | 存储显式记忆 |
| `supermemory_search` | 语义相似度搜索 |
| `supermemory_forget` | 按 ID 或查询遗忘 |
| `supermemory_profile` | 持久画像和近期上下文 |

**特点**：
- 多容器支持（Profile 隔离）
- 自动对话摄入
- 混合搜索模式

---

## 四、综合对比表

### 4.1 核心特性对比

| Provider | 存储位置 | 依赖 | 成本 | 语义搜索 | 本地优先 | LLM 提取 |
|----------|----------|------|------|----------|----------|----------|
| Built-in | 文件 | 无 | 免费 | ❌ | ✅ | ❌ |
| Mem0 | 云端 | Mem0 API | $20/月+ | ✅ | ❌ | ✅ |
| Honcho | 云端/本地 | Honcho API | 免费/付费 | ✅ | ❌ | ✅ (dialectic) |
| OpenViking | 本地服务端 | OpenViking Server | 自托管 | ✅ | ✅ | ✅ |
| Holographic | 本地 SQLite | 无/NumPy | 免费 | ✅ | ✅ | ❌ |
| Hindsight | 云/本地 | API/LLM | 按需 | ✅ | ✅ (embedded) | ✅ |
| RetainDB | 云端 | RetainDB | $20/月 | ✅ (hybrid) | ❌ | ❌ |
| ByteRover | 本地+云 | brv CLI | 可选云 | ✅ | ✅ | ❌ |
| Supermemory | 云端 | API Key | 按需 | ✅ | ❌ | ✅ |

### 4.2 工具数量对比

| Provider | 工具数量 | 主要工具 |
|----------|----------|----------|
| Built-in | 1 | memory |
| Mem0 | 3 | mem0_profile, search, conclude |
| Honcho | 4 | profile, search, context, conclude |
| OpenViking | 5 | search, read, browse, remember, add_resource |
| Holographic | 2 | fact_store, fact_feedback |
| Hindsight | 3 | retain, recall, reflect |
| RetainDB | 5 | profile, search, context, remember, forget |
| ByteRover | 3 | query, curate, status |
| Supermemory | 4 | store, search, forget, profile |

### 4.3 复杂度与适用场景

| Provider | 复杂度 | 最佳场景 |
|----------|--------|----------|
| Built-in | ⭐ | 简单项目，零依赖 |
| Mem0 | ⭐⭐ | 需要 LLM 事实提取的云服务 |
| Honcho | ⭐⭐⭐ | 需要用户建模和方言推理 |
| OpenViking | ⭐⭐⭐ | 大型团队，本地可控 |
| Holographic | ⭐⭐ | 完全本地，简单部署 |
| Hindsight | ⭐⭐⭐⭐ | 需要知识图谱的高级场景 |
| RetainDB | ⭐⭐ | 混合搜索（Vector + BM25） |
| ByteRover | ⭐⭐ | 知识树管理，本地优先 |
| Supermemory | ⭐⭐ | Profile 隔离，多容器 |

---

## 五、集成钩子对比

### 5.1 必需钩子

| 钩子 | 说明 |
|------|------|
| `is_available()` | Provider 是否可用 |
| `initialize()` | 会话初始化 |
| `get_tool_schemas()` | 暴露的工具模式 |

### 5.2 可选钩子

| 钩子 | 说明 | 支持的 Provider |
|------|------|----------------|
| `system_prompt_block()` | 系统提示块 | Honcho, Hindsight |
| `prefetch()` | 预取上下文 | Mem0, Honcho, Hindsight, Supermemory |
| `queue_prefetch()` | 队列预取 | Honcho |
| `sync_turn()` | 同步对话轮次 | 所有 |
| `on_turn_start()` | 轮次开始 | Honcho |
| `on_session_end()` | 会话结束 | Holographic, Supermemory |
| `on_pre_compress()` | 压缩前提取 | Hindsight |
| `on_memory_write()` | 记忆写入镜像 | Honcho |
| `on_delegation()` | 委托完成 | 所有 |

---

## 六、配置方式对比

### 6.1 配置来源

| Provider | 配置文件 | 环境变量 | CLI |
|----------|----------|----------|-----|
| Built-in | - | - | - |
| Mem0 | `$HERMES_HOME/mem0.json` | MEM0_API_KEY | ✅ |
| Honcho | `$HERMES_HOME/honcho.json` | HONCHO_API_KEY | ✅ (hermes honcho setup) |
| OpenViking | - | OPENVIKING_ENDPOINT, OPENVIKING_API_KEY | ✅ |
| Holographic | `config.yaml` | - | ✅ |
| Hindsight | `$HERMES_HOME/hindsight/config.json` | HINDSIGHT_API_KEY | ✅ (自动守护进程) |
| RetainDB | - | RETAINDB_API_KEY | ✅ |
| ByteRover | - | BRV_API_KEY (可选) | ✅ |
| Supermemory | `$HERMES_HOME/supermemory.json` | SUPERMEMORY_API_KEY | ✅ |

### 6.2 关键配置项

| Provider | 关键配置 |
|----------|----------|
| Honcho | `recallMode`, `observationMode`, `writeFrequency`, `sessionStrategy` |
| Hindsight | `mode`, `recall_budget`, `auto_retain`, `llm_provider` |
| Holographic | `db_path`, `auto_extract`, `default_trust`, `hrr_dim` |
| Supermemory | `container_tag`, `auto_recall`, `auto_capture`, `search_mode` |

---

## 七、与 PI-Coding-Agent 的集成建议

### 7.1 简化实现

```python
# pi-coding-agent/agent/memory/base.py
from abc import ABC, abstractmethod
from typing import List, Dict, Any, Optional

class MemoryProvider(ABC):
    """简化的记忆提供者基类"""

    @property
    @abstractmethod
    def name(self) -> str: ...

    @abstractmethod
    def is_available(self) -> bool: ...

    @abstractmethod
    def initialize(self, session_id: str, **kwargs) -> None: ...

    @abstractmethod
    def get_tool_schemas(self) -> List[Dict[str, Any]]: ...

    def prefetch(self, query: str, session_id: str = "") -> str:
        """预取相关上下文"""
        return ""

    def sync_turn(self, user: str, assistant: str, session_id: str = "") -> None:
        """同步对话"""
        pass

    def shutdown(self) -> None:
        """清理资源"""
        pass
```

### 7.2 内置记忆简化实现

```python
# pi-coding-agent/agent/memory/builtin.py
from pathlib import Path
import json

class BuiltinMemoryProvider(MemoryProvider):
    """内置文件记忆"""

    def __init__(self, memory_dir: Path, memory_limit: int = 10000):
        self.memory_dir = memory_dir
        self.memory_limit = memory_limit
        self.memory_file = memory_dir / "MEMORY.md"
        self.user_file = memory_dir / "USER.md"

    @property
    def name(self) -> str:
        return "builtin"

    def is_available(self) -> bool:
        return True

    def initialize(self, session_id: str, **kwargs) -> None:
        self.memory_dir.mkdir(parents=True, exist_ok=True)

    def get_tool_schemas(self) -> List[Dict]:
        return [{
            "name": "memory",
            "description": "Manage persistent memory",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["add", "replace", "remove", "read"],
                    },
                    "content": {"type": "string"},
                    "target": {"type": "string", "enum": ["memory", "user"]},
                },
            },
        }]

    def handle_tool_call(self, name: str, args: Dict, **kwargs) -> str:
        action = args.get("action")
        content = args.get("content", "")
        target = args.get("target", "memory")

        file = self.memory_file if target == "memory" else self.user_file

        if action == "read":
            return json.dumps({"content": file.read_text() if file.exists() else ""})
        elif action == "add":
            with open(file, "a") as f:
                f.write(f"\n§\n{content}")
            return json.dumps({"success": True})
        elif action == "replace":
            file.write_text(content)
            return json.dumps({"success": True})
        elif action == "remove":
            # 实现删除逻辑
            pass

        return json.dumps({"error": f"Unknown action: {action}"})
```

### 7.3 语义搜索 Provider 示例

```python
# pi-coding-agent/agent/memory/vector.py
import json
from typing import List, Dict

class VectorMemoryProvider(MemoryProvider):
    """基于向量数据库的记忆提供者"""

    def __init__(self, api_key: str, endpoint: str):
        self.api_key = api_key
        self.endpoint = endpoint

    @property
    def name(self) -> str:
        return "vector"

    def is_available(self) -> bool:
        return bool(self.api_key)

    def initialize(self, session_id: str, **kwargs) -> None:
        # 连接向量数据库
        pass

    def get_tool_schemas(self) -> List[Dict]:
        return [
            {"name": "memory_search", "description": "Search memory"},
            {"name": "memory_store", "description": "Store memory"},
        ]

    def prefetch(self, query: str, session_id: str = "") -> str:
        # 语义搜索
        results = self._search(query, top_k=5)
        return self._format_results(results)

    def _search(self, query: str, top_k: int) -> List[Dict]:
        # 调用向量数据库 API
        pass

    def _format_results(self, results: List[Dict]) -> str:
        if not results:
            return ""
        lines = ["[Memory Recall]"]
        for r in results:
            lines.append(f"- {r['content']}")
        return "\n".join(lines)
```

### 7.4 MemoryManager 实现

```python
# pi-coding-agent/agent/memory/manager.py
from typing import List, Dict

class MemoryManager:
    """记忆管理器"""

    def __init__(self):
        self._providers: List[MemoryProvider] = []
        self._tool_map: Dict[str, MemoryProvider] = {}

    def add_provider(self, provider: MemoryProvider) -> None:
        self._providers.append(provider)
        for schema in provider.get_tool_schemas():
            tool_name = schema.get("name")
            if tool_name:
                self._tool_map[tool_name] = provider

    def prefetch_all(self, query: str, session_id: str = "") -> str:
        """收集所有 Provider 的预取结果"""
        parts = []
        for p in self._providers:
            result = p.prefetch(query, session_id)
            if result:
                parts.append(result)
        return "\n\n".join(parts)

    def sync_all(self, user: str, assistant: str, session_id: str = "") -> None:
        """同步所有 Provider"""
        for p in self._providers:
            p.sync_turn(user, assistant, session_id)

    def handle_tool(self, name: str, args: Dict, **kwargs) -> str:
        """分发工具调用"""
        provider = self._tool_map.get(name)
        if not provider:
            return json.dumps({"error": f"Unknown tool: {name}"})
        return provider.handle_tool_call(name, args, **kwargs)
```

---

## 八、选择指南

### 8.1 按场景选择

| 场景 | 推荐 Provider |
|------|-------------|
| 简单项目，零依赖 | Built-in |
| 需要 LLM 事实提取 | Mem0 / Hindsight |
| 需要用户建模 | Honcho |
| 完全本地部署 | Holographic |
| 需要知识图谱 | Hindsight |
| 团队协作 | OpenViking / RetainDB |
| Profile 隔离 | Supermemory |

### 8.2 按成本选择

| 预算 | 推荐 |
|------|------|
| 免费 | Built-in / Holographic |
| $20/月 | Mem0 / RetainDB |
| 按需付费 | Honcho / Supermemory / Hindsight |
| 自托管 | OpenViking |

### 8.3 按能力选择

| 需求 | Provider |
|------|----------|
| 语义搜索 | Mem0, Honcho, Hindsight, RetainDB, Supermemory |
| LLM 提取 | Mem0, Honcho, Hindsight, Supermemory |
| 本地优先 | Holographic, ByteRover, Hindsight (embedded) |
| 知识图谱 | Hindsight |
| HRR 代数 | Holographic |

---

## 九、总结

### 9.1 架构优势

1. **插件化**：通过统一的 `MemoryProvider` 接口支持多种后端
2. **共存性**：内置 + 外部 Provider 可同时使用
3. **可扩展**：新增 Provider 只需实现抽象接口
4. **灵活配置**：支持配置文件、环境变量、CLI 多种方式

### 9.2 各 Provider 定位

| Provider | 定位 |
|----------|------|
| Built-in | 简单、快速、零依赖 |
| Mem0 | 云端 SaaS，LLM 增强 |
| Honcho | 用户建模，方言推理 |
| OpenViking | 企业本地，知识层级 |
| Holographic | 完全本地，HRR 创新 |
| Hindsight | 知识图谱，多模式 |
| RetainDB | 混合搜索，企业级 |
| ByteRover | 知识树，本地优先 |
| Supermemory | Profile 隔离，多容器 |

### 9.3 PI-Coding-Agent 建议

对于 PI-Coding-Agent，建议：

1. **起步**：使用简化版 Built-in Provider（文件存储）
2. **扩展**：添加 Vector Memory Provider（语义搜索）
3. **高级**：集成 Honcho 或 Hindsight（用户建模/知识图谱）

---

## 参考文件

| 文件 | 说明 |
|------|------|
| `agent/memory_provider.py` | MemoryProvider 抽象基类 |
| `agent/memory_manager.py` | MemoryManager 调度器 |
| `tools/memory_tool.py` | 内置记忆实现 |
| `plugins/memory/*/README.md` | 各 Provider 文档 |
| `plugins/memory/*/__init__.py` | 各 Provider 实现 |
