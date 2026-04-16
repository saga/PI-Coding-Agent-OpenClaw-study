# Hermes Agent 值得借鉴的思想研究报告

**研究日期**: 2026-04-16  
**研究对象**: Hermes Agent 开源项目  
**参考来源**: 社区评价、官方文档、源码分析

---

## 执行摘要

Hermes Agent 作为一个开源的自托管 AI Agent，自 2026 年初发布以来迅速获得 42K+ GitHub Stars。除了大家熟知的**冻结快照模式**和**Memory Provider 插件化架构**，它还有许多值得借鉴的设计思想。

本报告总结了 8 个最值得借鉴的核心思想：

1. **自进化技能系统**：Agent 自动从任务中提炼可复用的技能
2. **分层记忆架构**：持久化 + 会话 + 用户模型 + 技能的四层设计
3. **自注册工具模式**：工具文件自包含，自动发现和注册
4. **多终端后端抽象**：统一接口支持 6 种不同的执行环境
5. **网关-代理分离架构**：消息路由与核心逻辑解耦
6. **定时任务调度器**：Cron 任务在独立会话中运行
7. **ACP 代理通信协议**：IDE 和工具集成的标准接口
8. **RL 训练环境集成**：Atropos 强化学习训练支持

---

## 一、自进化技能系统（Self-Evolving Skills）

### 1.1 核心思想

> **让 Agent 自己学会如何学习**

Hermes Agent 最大的创新是**自进化技能系统**：Agent 不仅记住事实（Memory），还能记住方法（Skills），并且能从自己的经验中提炼出新的技能。

### 1.2 工作流程

```
【用户请求】
"帮我分析竞争对手的定价策略"

【Agent 执行】
├─ 调用 web_search 工具搜索
├─ 调用 file_write 工具保存结果
├─ 调用 terminal 工具生成图表
└─ 完成任务

【自进化循环】
├─ 审视整个推理路径
├─ 提取可复用的模式
├─ 生成技能文件：skills/competitor_analysis.md
└─ 下次遇到类似任务，直接使用技能
```

### 1.3 技能文件结构

```markdown
# Competitor Analysis

**Description**: Analyze competitors' pricing and positioning

**When to use**: When asked to research competitor pricing, market positioning, or competitive analysis

**Steps**:
1. Use web_search to find competitor websites and pricing pages
2. Extract pricing tiers, features, and positioning
3. Create a comparison table in markdown format
4. Save to `~/.hermes/workspace/competitor_analysis.md`

**Example**:
User: "分析竞争对手的定价策略"
→ web_search("competitor pricing website:example.com")
→ file_write("competitor_analysis.md", table)
```

### 1.4 自动更新机制

技能文件不是静态的，Agent 会根据后续使用效果自动优化：

```
【第一次使用】
技能版本：v1.0
→ 用 web_search 搜索
→ 保存结果

【后续使用】
效果好 → 保持不变
效果差 → 标记为"需要优化"

【每 15 个任务】
→ 触发性能评估
→ 分析成功/失败案例
→ 优化技能提示词
→ 生成 v2.0
```

### 1.5 社区评价

> "比较骚的是，它完成一个复杂任务之后，会自动回头审视整个推理路径，提取出可复用的模式，生成一个 `.md` 技能文件。这个文件不是死的，后来如果发现了更好的做法，它会自动更新。"

> "一个 Agent 在用你的任务数据慢慢进化自己的技能库...这个思路，是真的有点意思。"

### 1.6 值得借鉴的点

| 特性 | 传统 Agent | Hermes Agent |
|------|-----------|--------------|
| 技能来源 | 手动编写 | 自动提炼 |
| 技能更新 | 手动维护 | 自动优化 |
| 知识沉淀 | 分散在对话中 | 结构化技能文件 |
| 复用性 | 低 | 高 |

### 1.7 实现参考

- **技能存储**: `~/.hermes/skills/`
- **技能标准**: 遵循 [agentskills.io](https://agentskills.io) 开放标准
- **自进化子项目**: `hermes-agent-self-evolution`（使用遗传算法优化提示词）

---

## 二、分层记忆架构（Layered Memory）

### 2.1 核心思想

> **不同类型的内存，用不同的存储策略**

Hermes 的记忆系统不是简单的"对话历史"，而是**四层分层架构**：

```
┌─────────────────────────────────────────────────────────┐
│                    Layered Memory                        │
├─────────────────────────────────────────────────────────┤
│ 1. Persistent Notes (MEMORY.md + USER.md)              │
│    - Agent 的个人笔记                                  │
│    - 用户画像                                          │
│    - 存储策略：文件系统                                │
│                                                         │
│ 2. Session History (SQLite FTS5)                       │
│    - 所有历史对话                                      │
│    - 支持全文搜索                                      │
│    - 存储策略：SQLite + FTS5                           │
│                                                         │
│ 3. User Model (Honcho dialectic)                       │
│    - 对用户的深度理解                                  │
│    - 通过 Q&A 建模                                     │
│    - 存储策略：外部 Provider                           │
│                                                         │
│ 4. Procedural Memory (Skills)                          │
│    - 可复用的方法                                      │
│    - 任务模式提炼                                      │
│    - 存储策略：Markdown 文件                           │
└─────────────────────────────────────────────────────────┘
```

### 2.2 各层职责

| 层级 | 存储内容 | 查询方式 | 更新时机 | 用途 |
|------|---------|---------|---------|------|
| **Persistent Notes** | 项目状态、偏好、约定 | 直接读取 | 工具调用时 | 构建系统提示 |
| **Session History** | 所有历史对话 | FTS5 全文搜索 | 对话结束时 | 检索相关上下文 |
| **User Model** | 用户偏好、习惯、风格 | 语义搜索 | 对话同步时 | 个性化响应 |
| **Procedural Memory** | 可复用技能 | 关键词匹配 | 任务完成时 | 复用工作流 |

### 2.3 技术实现

```python
# Persistent Notes
MEMORY.md  # Agent 笔记（2200 chars）
USER.md    # 用户画像（1375 chars）

# Session History
SQLite + FTS5  # 全文索引覆盖所有历史

# User Model
Honcho dialectic  # 外部 Provider 插件

# Procedural Memory
skills/*.md  # Markdown 技能文件
```

### 2.4 值得借鉴的点

**传统 Agent 的问题**：
- 记忆散落在对话中，无法检索
- 没有区分"事实"和"方法"
- 没有用户建模

**Hermes 的创新**：
- 四层分层，各司其职
- 持久化 + 会话 + 模型 + 技能
- 支持外部 Provider 插件化

---

## 三、自注册工具模式（Self-Registering Tools）

### 3.1 核心思想

> **每个工具文件自包含，自动发现和注册**

Hermes 的工具系统遵循"**约定优于配置**"的设计原则：

```
tools/
├── web_search.py
├── terminal.py
├── file_write.py
└── email.py

# 每个文件自包含：
# 1. 工具 Schema
# 2. 工具处理器
# 3. 自动注册逻辑
```

### 3.2 工具文件结构

```python
# tools/web_search.py

"""Web Search Tool - Search the web for information."""

import json
import logging
from typing import Dict, Any

logger = logging.getLogger(__name__)

# 1. 工具 Schema（JSON Schema）
TOOL_SCHEMA = {
    "name": "web_search",
    "description": "Search the web for information",
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Search query"
            }
        },
        "required": ["query"]
    }
}

# 2. 工具处理器
def handle_web_search(query: str) -> Dict[str, Any]:
    """Execute web search and return results."""
    # ... implementation ...
    return {"results": results}

# 3. 自动注册
def register() -> None:
    """Register this tool with the tool registry."""
    from tools.registry import register_tool
    register_tool(TOOL_SCHEMA, handle_web_search)
```

### 3.3 自动发现机制

```python
# tools/model_tools.py

"""Model tools orchestration layer."""

import importlib
import pkgutil
from pathlib import Path

# 1. 扫描所有工具模块
TOOL_DIR = Path(__file__).parent

def discover_tools() -> None:
    """Discover and register all tools."""
    for importer, modname, ispkg in pkgutil.walk_packages(
        path=[str(TOOL_DIR)],
        prefix="tools."
    ):
        if modname == "tools.model_tools":
            continue  # Skip orchestration layer
        
        # 2. 导入模块（触发 register()）
        importlib.import_module(modname)

# 3. 启动时调用
if __name__ == "__main__":
    discover_tools()
```

### 3.4 工具分组

工具按功能分组，可以按需启用：

```yaml
# ~/.hermes/config.yaml

toolsets:
  web: true      # Web search, browser
  terminal: true # Terminal execution
  file: true     # File operations
  browser: true  # Browser automation
  email: false   # Email (disabled by default)
  calendar: false # Calendar (disabled by default)
```

### 3.5 值得借鉴的点

| 特性 | 传统方式 | Hermes Agent |
|------|---------|--------------|
| 工具定义 | 分散在多处 | 单文件自包含 |
| 工具注册 | 手动配置 | 自动发现 |
| 工具分组 | 全局启用/禁用 | 按 toolset 分组 |
| 扩展性 | 需修改核心代码 | 新增文件即可 |

---

## 四、多终端后端抽象（Multi-Terminal Backend）

### 4.1 核心思想

> **统一接口，支持多种执行环境**

Hermes 支持 6 种不同的终端后端，但对外提供统一的工具接口：

```
┌─────────────────────────────────────────────────────────┐
│              Terminal Backend Abstraction                │
├─────────────────────────────────────────────────────────┤
│  Local Backend   →  Local shell commands                │
│  Docker Backend  →  Docker containers                   │
│  SSH Backend     →  Remote SSH servers                  │
│  Daytona Backend →  Cloud dev environments              │
│  Singularity     →  HPC containers                      │
│  Modal Backend   →  Serverless functions                │
└─────────────────────────────────────────────────────────┘
              ↓
    Unified Tool Interface
              ↓
    tools/terminal.py (single implementation)
```

### 4.2 统一接口

```python
# tools/terminal.py

def run_command(command: str, backend: str = "local") -> Dict[str, Any]:
    """Run command on specified backend.
    
    Args:
        command: Shell command to run
        backend: One of: local, docker, ssh, daytona, singularity, modal
    
    Returns:
        {
            "stdout": str,
            "stderr": str,
            "exit_code": int
        }
    """
    if backend == "local":
        return _run_local(command)
    elif backend == "docker":
        return _run_docker(command)
    elif backend == "ssh":
        return _run_ssh(command)
    # ... etc
```

### 4.3 配置方式

```yaml
# ~/.hermes/config.yaml

terminal:
  default_backend: docker  # or local, ssh, daytona, etc.
  
  docker:
    image: python:3.11-slim
    volumes:
      - ~/.hermes/workspace:/workspace
    working_dir: /workspace
  
  ssh:
    host: your-server.com
    username: your-username
    key_path: ~/.ssh/id_rsa
```

### 4.4 值得借鉴的点

**传统 Agent 的问题**：
- 工具与执行环境耦合
- 切换环境需要重写工具
- 无法灵活选择执行环境

**Hermes 的创新**：
- 工具与执行环境解耦
- 统一接口，自动路由
- 灵活切换执行环境

---

## 五、网关-代理分离架构（Gateway-Agent Separation）

### 5.1 核心思想

> **消息路由与核心逻辑解耦**

Hermes 将消息路由（Gateway）与核心代理逻辑（Agent）分离：

```
┌─────────────────────────────────────────────────────────┐
│                    Gateway Layer                         │
│  Telegram  →  Normalized Message  →                     │
│  Discord   →  Normalized Message  →                     │
│  Slack     →  Normalized Message  →  AIAgent Loop      │
│  WhatsApp  →  Normalized Message  →                     │
│  CLI       →  Normalized Message  →                     │
└─────────────────────────────────────────────────────────┘
              ↓
    Unified Protocol
              ↓
┌─────────────────────────────────────────────────────────┐
│                   Agent Core                             │
│  AIAgent Loop (reasoning, tool execution, learning)    │
└─────────────────────────────────────────────────────────┘
```

### 5.2 消息标准化

```python
# Gateway 收到消息后，标准化为统一格式

{
    "type": "message",
    "platform": "telegram",  # or discord, slack, etc.
    "channel_id": "123456",
    "user_id": "789012",
    "message_id": "abc-def-ghi",
    "timestamp": "2026-04-16T10:30:00Z",
    "content": "你好，请帮我分析一下...",
    "metadata": {
        "reply_to": null,
        "mentions": [],
        "attachments": []
    }
}
```

### 5.3 多平台共享状态

```
用户在 Telegram 发消息
├─ Gateway 接收
├─ 标准化
├─ AIAgent 处理
├─ 更新 MEMORY.md
└─ 更新 SQLite 历史

用户在 Slack 发消息
├─ Gateway 接收
├─ 标准化
├─ AIAgent 处理
├─ 读取 MEMORY.md（Telegram 写入的）
├─ 读取 SQLite 历史（Telegram 写入的）
└─ 保持上下文连续性
```

### 5.4 值得借鉴的点

**传统 Agent 的问题**：
- 每个平台单独实现
- 状态无法共享
- 代码重复

**Hermes 的创新**：
- 网关层只负责路由
- 核心逻辑统一实现
- 多平台共享状态

---

## 六、定时任务调度器（Cron Scheduler）

### 6.1 核心思想

> **定时任务在独立会话中运行**

Hermes 内置 Cron 调度器，支持定时任务：

```yaml
# ~/.hermes/cron.yaml

tasks:
  - name: "daily briefing"
    cron: "0 8 * * *"  # Every day at 8 AM
    command: |
      1. 搜索今天的 AI 新闻
      2. 整理成摘要
      3. 发送到我的飞书
      
  - name: "weekly report"
    cron: "0 9 * * 1"  # Every Monday at 9 AM
    command: |
      1. 汇总本周的 GitHub Star 变化
      2. 生成趋势图
      3. 保存到 ~/.hermes/reports/
```

### 6.2 独立会话

```python
# Cron 任务在独立会话中运行

def run_cron_task(task_name: str) -> None:
    """Run a cron task in a fresh session."""
    # 1. 创建新会话（不继承之前的上下文）
    session_id = create_fresh_session()
    
    # 2. 加载任务命令
    command = load_cron_command(task_name)
    
    # 3. 执行任务
    agent = AIAgent(session_id=session_id)
    agent.run(command)
    
    # 4. 保存结果
    save_task_result(task_name, agent.output)
```

### 6.3 值得借鉴的点

**传统 Agent 的问题**：
- 定时任务需要外部调度器
- 无法直接使用 Agent 的能力

**Hermes 的创新**：
- 内置 Cron 调度器
- 任务直接使用 Agent 能力
- 独立会话，避免上下文污染

---

## 七、ACP 代理通信协议（ACP Integration）

### 7.1 核心思想

> **IDE 和工具集成的标准接口**

Hermes 支持 ACP（Agent Communication Protocol），允许 IDE 和工具集成：

```
┌─────────────────────────────────────────────────────────┐
│                   IDE Integration                        │
│                                                          │
│  VS Code  →  ACP Client  →  Hermes Agent               │
│  Cursor   →  ACP Client  →  Hermes Agent               │
│  JetBrains → ACP Client  →  Hermes Agent               │
└─────────────────────────────────────────────────────────┘
```

### 7.2 ACP 功能

```python
# ACP 提供的标准接口

class ACPAgent:
    """Agent Communication Protocol server."""
    
    async def chat(self, message: str) -> str:
        """Send a message to the agent."""
        pass
    
    async def execute_tool(self, tool_name: str, args: Dict) -> Any:
        """Execute a tool."""
        pass
    
    async def get_skills(self) -> List[Skill]:
        """Get all available skills."""
        pass
    
    async def add_skill(self, skill: Skill) -> None:
        """Add a new skill."""
        pass
    
    async def get_memory(self) -> Dict:
        """Get agent's memory."""
        pass
```

### 7.3 值得借鉴的点

**传统 Agent 的问题**：
- 缺乏标准的 IDE 集成接口
- 每个 IDE 单独实现

**Hermes 的创新**：
- ACP 标准接口
- 多 IDE 支持
- 工具集成

---

## 八、RL 训练环境集成（RL Training）

### 8.1 核心思想

> **用强化学习训练 Agent**

Hermes 集成了 Nous Research 的 Atropos RL 环境：

```
┌─────────────────────────────────────────────────────────┐
│              Reinforcement Learning Loop                 │
│                                                          │
│  Agent Action  →  Environment  →  Reward  →  Policy    │
│     ↓                ↓              ↓              ↓    │
│  Tool Call    》  Task State  》  Success  》  Update   │
└─────────────────────────────────────────────────────────┘
```

### 8.2 Trajectory 导出

```python
# 导出训练数据

def export_trajectory(agent: AIAgent) -> Trajectory:
    """Export agent's trajectory for RL training."""
    return Trajectory(
        states=agent.conversation_history,
        actions=agent.tool_calls,
        rewards=agent.success_metrics,
        metadata={
            "session_id": agent.session_id,
            "timestamp": agent.start_time,
            "model": agent.model_name
        }
    )
```

### 8.3 值得借鉴的点

**传统 Agent 的问题**：
- 缺乏训练数据收集机制
- 无法用 RL 优化

**Hermes 的创新**：
- 内置 RL 环境
- Trajectory 导出
- 持续优化

---

## 九、综合对比

### 9.1 与 OpenClaw 对比

| 特性 | OpenClaw | Hermes Agent |
|------|---------|--------------|
| **技能系统** | 5700+ 社区技能 | 自进化技能（自动提炼） |
| **记忆系统** | 基础记忆 | 四层分层记忆 |
| **自进化** | ❌ 无 | ✅ 自动提炼技能 |
| **工具注册** | 手动配置 | 自注册 |
| **终端后端** | 1 种 | 6 种 |
| **网关架构** | 单一网关 | 网关-代理分离 |
| **定时任务** | ❌ 无 | ✅ 内置 Cron |
| **IDE 集成** | 有限 | ACP 标准 |
| **RL 训练** | ❌ 无 | ✅ Atropos 集成 |
| **安装复杂度** | 中等 | 简单 |
| **稳定性** | 高 | 中等（更新快） |

### 9.2 设计哲学对比

**OpenClaw**:
- **目标**: 成熟的生产力工具
- **哲学**: 稳定优先，开箱即用
- **适合**: 团队、重度集成场景

**Hermes Agent**:
- **目标**: 会成长的实验伙伴
- **哲学**: 创新优先，持续进化
- **适合**: 个人开发者、实验性项目

---

## 十、值得借鉴的设计原则

### 10.1 自举原则（Bootstrapping）

> **让 Agent 自己帮助自己进化**

Hermes 的设计充满了"自举"思想：
- Agent 自己提炼技能
- Agent 自己优化提示词
- Agent 自己评估性能

**借鉴点**：
- 不要只做"工具"，要做"能自我改进的系统"
- 让 Agent 有机会审视自己的行为

### 10.2 分层原则（Layering）

> **不同关注点，不同层处理**

Hermes 的分层设计：
- Gateway 层：消息路由
- Agent 层：核心逻辑
- Tool 层：功能实现
- Backend 层：执行环境

**借鉴点**：
- 清晰的分层，职责明确
- 每层可以独立演进

### 10.3 约定优于配置原则（Convention over Configuration）

> **默认行为合理，配置可选**

Hermes 的约定：
- 工具文件自包含，自动注册
- 默认终端后端：local
- 默认技能存储：`~/.hermes/skills/`

**借鉴点**：
- 合理的默认值，降低使用门槛
- 配置是可选的，不是必须的

### 10.4 插件化原则（Plugin Architecture）

> **核心稳定，扩展灵活**

Hermes 的插件化：
- Memory Provider 插件（8+ 个）
- Toolset 插件（40+ 个）
- Backend 插件（6 种）

**借鉴点**：
- 核心代码稳定
- 功能通过插件扩展
- 插件可以独立开发

---

## 十一、总结

### 11.1 核心创新

Hermes Agent 最值得借鉴的 8 个思想：

1. **自进化技能系统**：Agent 自己提炼和优化技能
2. **分层记忆架构**：持久化 + 会话 + 模型 + 技能
3. **自注册工具模式**：工具文件自包含，自动发现
4. **多终端后端抽象**：统一接口，支持 6 种环境
5. **网关-代理分离**：消息路由与核心逻辑解耦
6. **定时任务调度器**：Cron 任务在独立会话中运行
7. **ACP 代理通信协议**：IDE 和工具集成的标准接口
8. **RL 训练环境集成**：用强化学习持续优化

### 11.2 设计哲学

- **自举原则**：让 Agent 自己帮助自己进化
- **分层原则**：不同关注点，不同层处理
- **约定优于配置**：默认行为合理，配置可选
- **插件化原则**：核心稳定，扩展灵活

### 11.3 适用场景

**适合使用 Hermes Agent**：
- 个人开发者
- 实验性项目
- 需要持续进化的 Agent
- 对创新功能有需求

**适合使用 OpenClaw**：
- 团队协作
- 生产环境
- 需要稳定技能库
- 追求开箱即用

### 11.4 借鉴建议

**对于 pi-mono SDK 集成**：

1. **自注册工具模式**
   - 工具文件自包含
   - 自动发现和注册
   - 降低集成成本

2. **分层记忆架构**
   - 持久化 + 会话 + 模型
   - 支持外部 Provider
   - 提高记忆质量

3. **网关-代理分离**
   - 消息路由与核心逻辑解耦
   - 多平台共享状态
   - 提高可扩展性

4. **自进化技能系统**
   - Agent 自己提炼技能
   - 从任务中学习
   - 持续优化

---

## 十二、参考资料

### 官方文档
- [Hermes Agent Architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture/)
- [Memory System](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/)
- [Skills & Tools](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/)

### 社区评价
- [掘金：Hermes Agent-会记住你习惯的开源Agent助手](https://juejin.cn/post/7626660633338708018)
- [Lushbinary：Hermes Agent Developer Guide](https://lushbinary.com/blog/hermes-agent-developer-guide-setup-skills-self-improving-ai/)

### 源码
- [Hermes Agent](https://github.com/NousResearch/hermes-agent)
- [hermes-agent-self-evolution](https://github.com/NousResearch/hermes-agent-self-evolution)

### 相关项目
- [OpenClaw](https://github.com/OpenClaw/openclaw)
- [Atropos RL](https://github.com/NousResearch/atropos)

---

**报告完成日期**: 2026-04-16  
**作者**: AI Assistant
