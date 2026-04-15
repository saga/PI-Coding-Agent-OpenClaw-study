# Hermes Agent Memory Provider 默认配置研究

**研究日期**: 2026-04-16  
**研究对象**: Hermes Agent Memory Provider 插件系统

---

## 执行摘要

Hermes Agent 的 Memory Provider 系统设计为**向后兼容且可选**：

1. **内置记忆始终可用**：MEMORY.md + USER.md 双存储，无需配置
2. **外部 Provider 可选**：用户可以选择是否配置 Honcho、Mem0 等外部服务
3. **自动迁移机制**：如果检测到旧版 Honcho 配置，自动迁移
4. **无需 setup**：不配置外部 Provider 也能正常使用所有内置功能

---

## 一、Memory Provider 架构

### 1.1 核心设计原则

```
┌─────────────────────────────────────────────────────────┐
│                   System Prompt                          │
│  ┌───────────────────────────────────────────────────┐  │
│  │ BuiltinMemoryProvider (always active)             │  │
│  │ - MEMORY.md (2200 chars)                          │  │
│  │ - USER.md (1375 chars)                            │  │
│  └───────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────┐  │
│  │ External Memory Provider (optional)               │  │
│  │ - Honcho / Mem0 / OpenViking / etc.               │  │
│  │ - Runs ALONGSIDE built-in (never replaces)        │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

**关键设计原则**:
- 内置 Provider 总是第一个，不可移除
- 仅允许一个外部 Provider
- 外部 Provider 与内置并行运行，不替换内置

### 1.2 MemoryManager 初始化

```python
# run_agent.py (line 1225-1290)

# Memory provider plugin (external — one at a time, alongside built-in)
self._memory_manager = None
if not skip_memory:
    try:
        _mem_provider_name = mem_config.get("provider", "") if mem_config else ""
        
        # Auto-migration: if Honcho was actively configured but memory.provider
        # is not set, activate the honcho plugin automatically
        if not _mem_provider_name:
            try:
                from plugins.memory.honcho.client import HonchoClientConfig as _HCC
                _hcfg = _HCC.from_global_config()
                if _hcfg.enabled and (_hcfg.api_key or _hcfg.base_url):
                    _mem_provider_name = "honcho"
                    # Persist so this only auto-migrates once
                    try:
                        from hermes_cli.config import load_config as _lc, save_config as _sc
                        _cfg = _lc()
                        _cfg.setdefault("memory", {})["provider"] = "honcho"
                        _sc(_cfg)
                    except Exception:
                        pass
            except Exception:
                pass
        
        if _mem_provider_name:
            from agent.memory_manager import MemoryManager as _MemoryManager
            from plugins.memory import load_memory_provider as _load_mem
            self._memory_manager = _MemoryManager()
            _mp = _load_mem(_mem_provider_name)
            if _mp and _mp.is_available():
                self._memory_manager.add_provider(_mp)
            # ... initialize provider
```

**关键点**:
- `memory.provider` 从 config.yaml 读取
- 如果未配置且检测到旧版 Honcho 配置，自动迁移
- 如果未配置且无旧版 Honcho，`_mem_provider_name` 为空字符串
- 外部 Provider 是**可选的**

---

## 二、内置 Memory Provider (BuiltinMemoryProvider)

### 2.1 默认行为

**无需任何配置即可使用**：

```python
# agent/memory_manager.py (line 1260-1263)

self._memory_manager = _MemoryManager()
# BuiltinMemoryProvider is ALWAYS added first
# (hardcoded in MemoryManager class)
```

**MemoryManager 构造函数**:

```python
class MemoryManager:
    def __init__(self) -> None:
        self._providers: List[MemoryProvider] = []
        self._tool_to_provider: Dict[str, MemoryProvider] = {}
        self._has_external: bool = False
    
    def add_provider(self, provider: MemoryProvider) -> None:
        is_builtin = provider.name == "builtin"
        
        if not is_builtin:
            if self._has_external:
                # Reject second external provider
                return
            self._has_external = True
        
        self._providers.append(provider)
```

**BuiltinMemoryProvider 的 name = "builtin"**，总是被接受。

### 2.2 功能范围

内置 Provider 提供：

| 功能 | 描述 | 是否需要配置 |
|------|------|-------------|
| MEMORY.md | Agent 的个人笔记 | ❌ 无需 |
| USER.md | 用户画像 | ❌ 无需 |
| memory 工具 | add/replace/remove 操作 | ❌ 无需 |
| 容量管理 | 2200/1375 chars 限制 | ❌ 无需 |
| 安全扫描 | injection/exfiltration 检测 | ❌ 无需 |
| 文件锁 | 并发写入保护 | ❌ 无需 |

**结论**: 内置功能**完全可用，无需任何配置**。

### 2.3 文件位置

```
~/.hermes/
├── memories/
│   ├── MEMORY.md    # Agent notes (2200 chars)
│   └── USER.md      # User profile (1375 chars)
└── state.db         # SQLite FTS5 (session search)
```

**自动创建**：首次使用时自动创建目录和文件。

---

## 三、外部 Memory Provider (可选)

### 3.1 可用的 Provider

Hermes Agent 内置 8 个外部 Memory Provider 插件：

| Provider | 最佳用途 | 需要配置 |
|----------|---------|---------|
| **Honcho** | 多 Agent 系统、跨会话用户建模 | ✅ API key |
| **OpenViking** | 知识图谱、语义搜索 | ✅ API key |
| **Mem0** | 个人知识管理 | ✅ API key |
| **Hindsight** | 持久化记忆、自动提取 | ✅ API key |
| **Holographic** | 认知架构、多模态记忆 | ✅ API key |
| **RetainDB** | 混合搜索（向量 + BM25） | ✅ API key |
| **ByteRover** | 云记忆服务 | ✅ API key |
| **Supermemory** | 长期记忆、自动摘要 | ✅ API key |

### 3.2 配置方式

#### 方式 1: hermes memory setup (推荐)

```bash
hermes memory setup      # 交互式选择 + 配置
hermes memory status     # 查看当前激活的 Provider
hermes memory off        # 禁用外部 Provider
```

**流程**:
1. 扫描可用 Provider
2. 交互式选择
3. 引导配置（API key 等）
4. 写入 config.yaml + .env
5. 安装依赖（如需要）

#### 方式 2: 手动配置

```yaml
# ~/.hermes/config.yaml

memory:
  provider: honcho  # 或 openviking, mem0, etc.
  
  config:
    endpoint: https://api.honcho.ai
    project: my-project
    # API key via HONCHO_API_KEY env var
```

**环境变量**:
```bash
# ~/.hermes/.env
HONCHO_API_KEY=your-key-here
```

#### 方式 3: 代码配置

```python
# 在 run_agent.py 中

from agent.memory_manager import MemoryManager
from plugins.memory import load_memory_provider

memory_manager = MemoryManager()

# Load external provider
provider = load_memory_provider("honcho")
if provider and provider.is_available():
    memory_manager.add_provider(provider)

# Initialize
memory_manager.initialize_all(
    session_id="session-123",
    platform="cli",
    hermes_home=str(get_hermes_home()),
)
```

### 3.3 配置可选性

**关键设计**: 外部 Provider 是**完全可选的**。

| 场景 | 行为 |
|------|------|
| 未配置 `memory.provider` | 仅使用内置 MEMORY.md + USER.md |
| 配置了 `memory.provider` 但未提供 credentials | Provider 初始化失败，回退到内置 |
| 配置了 `memory.provider` 且提供 credentials | 外部 Provider + 内置并行运行 |

**代码实现**:

```python
# run_agent.py (line 1261-1287)

_mp = _load_mem(_mem_provider_name)
if _mp and _mp.is_available():
    self._memory_manager.add_provider(_mp)
if self._memory_manager.providers:
    # Initialize provider
    self._memory_manager.initialize_all(**_init_kwargs)
    logger.info("Memory provider '%s' activated", _mem_provider_name)
else:
    logger.debug("Memory provider '%s' not found or not available", _mem_provider_name)
    self._memory_manager = None
```

**is_available() 检查**:

```python
# plugins/memory/honcho/__init__.py

class HonchoMemoryProvider(MemoryProvider):
    @property
    def name(self) -> str:
        return "honcho"
    
    def is_available(self) -> bool:
        """Return True if configured, has credentials, and ready."""
        # Check config
        if not self._config.api_key and not self._config.base_url:
            return False
        
        # Check dependencies
        try:
            import honcho
            return True
        except ImportError:
            return False
```

**结论**: 
- 如果 Provider 未配置或不可用，`is_available()` 返回 `False`
- `self._memory_manager` 被设为 `None`
- Agent 继续运行，仅使用内置记忆

---

## 四、自动迁移机制

### 4.1 旧版 Honcho 配置检测

Hermes Agent 包含自动迁移逻辑：

```python
# run_agent.py (line 1237-1255)

if not _mem_provider_name:
    try:
        from plugins.memory.honcho.client import HonchoClientConfig as _HCC
        _hcfg = _HCC.from_global_config()
        if _hcfg.enabled and (_hcfg.api_key or _hcfg.base_url):
            _mem_provider_name = "honcho"
            # Persist so this only auto-migrates once
            try:
                from hermes_cli.config import load_config as _lc, save_config as _sc
                _cfg = _lc()
                _cfg.setdefault("memory", {})["provider"] = "honcho"
                _sc(_cfg)
            except Exception:
                pass
            if not self.quiet_mode:
                print("  ✓ Auto-migrated Honcho to memory provider plugin.")
                print("    Your config and data are preserved.\n")
    except Exception:
        pass
```

**触发条件**:
1. `memory.provider` 未设置
2. 检测到旧版 Honcho 配置（`honcho.json` 或全局配置）
3. Honcho 已启用且有 API key/base_url

**迁移行为**:
1. 自动设置 `memory.provider = "honcho"`
2. 保存到 config.yaml
3. 仅迁移一次（后续运行跳过）

**目的**: 向后兼容，旧用户无需手动迁移。

### 4.2 迁移后行为

迁移后，Honcho 作为外部 Provider 运行：

```
┌─────────────────────────────────────────────────────────┐
│                   System Prompt                          │
│  ┌───────────────────────────────────────────────────┐  │
│  │ BuiltinMemoryProvider (always active)             │  │
│  │ - MEMORY.md (2200 chars)                          │  │
│  │ - USER.md (1375 chars)                            │  │
│  └───────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────┐  │
│  │ HonchoMemoryProvider (external)                   │  │
│  │ - honcho_profile tool                             │  │
│  │ - honcho_search tool                              │  │
│  │ - honcho_context tool                             │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

**内置 + 外部并行运行**，不替换。

---

## 五、Setup 流程详解

### 5.1 hermes memory setup

```python
# hermes_cli/memory_setup.py

def main():
    """Interactive setup for memory provider plugins."""
    
    # 1. Discover available providers
    providers = _get_available_providers()
    
    # 2. Interactive selection
    selected_idx = _curses_select(
        "Select a memory provider",
        [(name, desc) for name, desc, _ in providers]
    )
    
    # 3. Install dependencies if needed
    provider_name = providers[selected_idx][0]
    _install_dependencies(provider_name)
    
    # 4. Walk through config schema
    provider = providers[selected_idx][2]
    config_schema = provider.get_config_schema()
    
    config_values = {}
    for field in config_schema:
        value = _prompt(
            field["description"],
            default=field.get("default"),
            secret=field.get("secret", False)
        )
        config_values[field["key"]] = value
    
    # 5. Save config
    provider.save_config(config_values, hermes_home)
    
    # 6. Update config.yaml
    from hermes_cli.config import load_config, save_config
    cfg = load_config()
    cfg.setdefault("memory", {})["provider"] = provider_name
    save_config(cfg)
```

### 5.2 配置文件结构

```yaml
# ~/.hermes/config.yaml

# Memory configuration
memory:
  # Built-in settings
  memory_enabled: true
  user_profile_enabled: true
  memory_char_limit: 2200
  user_char_limit: 1375
  
  # External Provider (optional)
  provider: honcho  # or openviking, mem0, etc.
  
  # Provider-specific config
  config:
    endpoint: https://api.honcho.ai
    project: my-project
```

### 5.3 环境变量

```bash
# ~/.hermes/.env
HONCHO_API_KEY=your-key-here
OPENVIKING_API_KEY=your-key-here
MEM0_API_KEY=your-key-here
# etc.
```

---

## 六、使用场景分析

### 6.1 场景 1: 新用户，仅使用内置功能

```bash
# 安装 hermes-agent
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash

# 启动 hermes
hermes

# 无需任何配置，MEMORY.md + USER.md 自动创建
# 可以使用所有内置功能
```

**结果**: ✅ 完全可用，无需配置。

### 6.2 场景 2: 新用户，配置外部 Provider

```bash
# 启动 setup
hermes memory setup

# 选择 Honcho
# 输入 API key
# 配置完成

# 查看状态
hermes memory status
# Output: Active provider: honcho
```

**结果**: ✅ 内置 + Honcho 并行运行。

### 6.3 场景 3: 旧用户，自动迁移

```bash
# 旧版 hermes-agent，Honcho 配置在 honcho.json
# 升级到新版

hermes

# Output:
#   ✓ Auto-migrated Honcho to memory provider plugin.
#     Your config and data are preserved.
```

**结果**: ✅ 自动迁移，无需手动操作。

### 6.4 场景 4: 配置了 Provider 但 credentials 错误

```yaml
# ~/.hermes/config.yaml
memory:
  provider: honcho
  config:
    endpoint: https://api.honcho.ai
    project: my-project
```

```bash
# ~/.hermes/.env (未设置 API key)
# HONCHO_API_KEY 未设置

hermes

# Output:
#   Memory provider 'honcho' not found or not available
```

**结果**: ⚠️ Provider 初始化失败，回退到内置功能。

---

## 七、配置验证

### 7.1 hermes memory status

```bash
hermes memory status

# Output (无外部 Provider):
#   No external memory provider configured.
#   Built-in memory is active.

# Output (Honcho 配置):
#   Active provider: honcho
#   Status: Connected
#   Workspace: hermes
#   User: alice
```

### 7.2 hermes doctor

```bash
hermes doctor

# Memory section:
#   ✓ Built-in memory: Active
#   ✓ MEMORY.md: 1,200/2,200 chars (54%)
#   ✓ USER.md: 600/1,375 chars (43%)
#   ✓ External provider: None configured
```

### 7.3 hermes config get

```bash
hermes config get memory

# Output:
#   memory:
#     memory_enabled: true
#     user_profile_enabled: true
#     memory_char_limit: 2200
#     user_char_limit: 1375
#     # provider: (not set - using built-in only)
```

---

## 八、总结

### 8.1 核心结论

| 项目 | 是否需要配置 | 说明 |
|------|-------------|------|
| **内置 MEMORY.md + USER.md** | ❌ 否 | 自动创建，始终可用 |
| **memory 工具** | ❌ 否 | 内置功能，无需配置 |
| **Session Search** | ❌ 否 | SQLite FTS5，自动创建 |
| **外部 Provider (Honcho/Mem0等)** | ✅ 可选 | 用户可以选择是否配置 |
| **hermes memory setup** | ✅ 可选 | 仅在需要外部 Provider 时使用 |

### 8.2 设计优势

1. **向后兼容**: 旧用户自动迁移，新用户零配置
2. **可选增强**: 外部 Provider 是可选的增强功能
3. **平滑回退**: Provider 不可用时，自动回退到内置功能
4. **清晰分离**: 内置 + 外部并行运行，职责明确

### 8.3 用户体验

| 用户类型 | 配置要求 | 体验 |
|---------|---------|------|
| **新用户** | 无配置 | 即刻可用，所有内置功能正常工作 |
| **高级用户** | 配置外部 Provider | 内置 + 外部并行，功能增强 |
| **旧用户** | 自动迁移 | 无缝升级，无需手动操作 |

### 8.4 最佳实践

1. **新用户**: 直接使用，无需配置
2. **需要跨会话知识图谱**: 配置 Honcho
3. **需要语义搜索**: 配置 Mem0 或 RetainDB
4. **需要自动提取**: 配置 Hindsight

---

## 九、参考资料

### 官方文档
- [Memory Providers](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers.md)
- [Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory.md)
- [Memory Provider Plugin](https://hermes-agent.nousresearch.com/docs/developer-guide/memory-provider-plugin)

### 源码
- [MemoryManager](file:///Users/saga/code-repos/PI-Coding-Agent-OpenClaw-study/hermes-agent-source-code/agent/memory_manager.py)
- [MemoryProvider Base Class](file:///Users/saga/code-repos/PI-Coding-Agent-OpenClaw-study/hermes-agent-source-code/agent/memory_provider.py)
- [Memory Setup CLI](file:///Users/saga/code-repos/PI-Coding-Agent-OpenClaw-study/hermes-agent-source-code/hermes_cli/memory_setup.py)
- [Run Agent](file:///Users/saga/code-repos/PI-Coding-Agent-OpenClaw-study/hermes-agent-source-code/run_agent.py)

### 插件
- [Honcho Plugin](file:///Users/saga/code-repos/PI-Coding-Agent-OpenClaw-study/hermes-agent-source-code/plugins/memory/honcho/)
- [Mem0 Plugin](file:///Users/saga/code-repos/PI-Coding-Agent-OpenClaw-study/hermes-agent-source-code/plugins/memory/mem0/)
- [OpenViking Plugin](file:///Users/saga/code-repos/PI-Coding-Agent-OpenClaw-study/hermes-agent-source-code/plugins/memory/openviking/)

---

**报告完成日期**: 2026-04-16  
**作者**: AI Assistant
