# Hermes Agent 自进化技能系统详解

## 1. 核心概念

Hermes Agent 的**自进化技能系统**（Self-Evolving Skill System）是一种让 Agent 自动从任务执行中提炼可复用技能的机制。这个系统让 Agent 不仅能完成任务，还能**记住成功的模式**并在未来复用。

### 1.1 技能的本质

技能（Skill）是 Agent 的**程序性记忆**（Procedural Memory）：

- **技能**：如何做事情的步骤（"如何部署到 Kubernetes"）
- **记忆**：事实性知识（"用户喜欢深色模式"）

技能是**窄而深**的，专注于特定任务；记忆是**宽而浅**的，存储通用信息。

---

## 2. 实现原理

### 2.1 技能提取触发机制

Hermes 使用**计数器+间隔触发**的方式判断是否应该提炼技能：

```python
# 初始化时设置
self._skill_nudge_interval = 10  # 默认每 10 次迭代触发一次
self._iters_since_skill = 0      # 当前计数器

# 在 run_conversation 中检查
if (self._skill_nudge_interval > 0
        and self._iters_since_skill >= self._skill_nudge_interval
        and "skill_manage" in self.valid_tool_names):
    _should_review_skills = True
    self._iters_since_skill = 0
```

**关键点**：
- 计数器在每次 tool-calling 迭代时递增
- 当 `skill_manage` 工具被实际调用时，计数器重置为 0
- 只有计数器达到阈值才会触发技能审查

### 2.2 技能审查流程

触发审查后，系统会启动一个**后台审查线程**：

```python
def _spawn_background_review(
    self,
    messages_snapshot: List[Dict],
    review_memory: bool = False,
    review_skills: bool = False,
) -> None:
    """启动后台线程审查对话，用于保存记忆/技能"""
    
    # 创建独立的审查 Agent
    review_agent = AIAgent(
        model=self.model,
        max_iterations=8,  # 审查用的迭代次数更少
        quiet_mode=True,   # 不输出到用户界面
        platform=self.platform,
        provider=self.provider,
    )
    
    # 复制主 Agent 的记忆存储
    review_agent._memory_store = self._memory_store
    review_agent._memory_enabled = self._memory_enabled
    
    # 关闭审查 Agent 的技能触发（避免递归）
    review_agent._skill_nudge_interval = 0
    
    # 根据触发类型选择审查提示词
    if review_memory and review_skills:
        prompt = self._COMBINED_REVIEW_PROMPT
    elif review_memory:
        prompt = self._MEMORY_REVIEW_PROMPT
    else:
        prompt = self._SKILL_REVIEW_PROMPT
    
    # 运行审查
    review_agent.run_conversation(
        user_message=prompt,
        conversation_history=messages_snapshot,
    )
```

**审查 Agent 的特点**：
- 独立的线程执行，不阻塞主任务
- 使用相同的模型和工具
- 不向用户显示输出
- 专门负责分析对话历史

### 2.3 审查提示词

系统定义了三种审查提示词：

#### 2.3.1 技能审查提示词

```python
_SKILL_REVIEW_PROMPT = (
    "Review the conversation above and consider saving or updating a skill if appropriate.\n\n"
    "Focus on: was a non-trivial approach used to complete a task that required trial "
    "and error, or changing course due to experiential findings along the way, or did "
    "the user expect or desire a different method or outcome?\n\n"
    "If a relevant skill already exists, update it with what you learned. "
    "Otherwise, create a new skill if the approach is reusable.\n"
    "If nothing is worth saving, just say 'Nothing to save.' and stop."
)
```

**审查重点**：
- 是否使用了非平凡的方法
- 是否经历了试错过程
- 是否根据经验调整了策略
- 用户是否对方法或结果有不同期望

#### 2.3.2 组合审查提示词

```python
_COMBINED_REVIEW_PROMPT = (
    "Review the conversation above and consider two things:\n\n"
    "**Memory**: Has the user revealed things about themselves — their persona, "
    "desires, preferences, or personal details? Has the user expressed expectations "
    "about how you should behave, their work style, or ways they want you to operate? "
    "If so, save using the memory tool.\n\n"
    "**Skills**: Was a non-trivial approach used to complete a task that required trial "
    "and error, or changing course due to experiential findings along the way, or did "
    "the user expect or desire a different method or outcome? If a relevant skill "
    "already exists, update it. Otherwise, create a new one if the approach is reusable.\n\n"
    "Only act if there's something genuinely worth saving. "
    "If nothing stands out, just say 'Nothing to save.' and stop."
)
```

### 2.4 技能保存与更新

审查 Agent 使用 `skill_manage` 工具执行实际的技能创建/更新：

```python
def skill_manage(action: str, **kwargs) -> Dict[str, Any]:
    """
    Skill Manager Tool -- Agent-Managed Skill Creation & Editing
    
    Actions:
      create     -- Create a new skill (SKILL.md + directory structure)
      edit       -- Replace the SKILL.md content of a user skill (full rewrite)
      patch      -- Targeted find-and-replace within SKILL.md or any supporting file
      delete     -- Remove a user skill entirely
      write_file -- Add/overwrite a supporting file (reference, template, script, asset)
      remove_file-- Remove a supporting file from a user skill
    """
```

**支持的操作**：
- `create`：创建新技能
- `edit`：完全重写现有技能
- `patch`：对技能文件进行精确替换
- `delete`：删除技能
- `write_file`：添加支持文件
- `remove_file`：移除支持文件

---

## 3. 技能文件格式

### 3.1 SKILL.md 结构

```markdown
---
name: my-skill
description: Brief description of what this skill does
version: 1.0.0
author: Your Name
license: MIT
platforms: [macos, linux]          # 可选：限制特定操作系统
metadata:
  hermes:
    tags: [Category, Keywords]
    related_skills: [other-skill-name]
    requires_toolsets: [web]        # 可选：依赖特定工具集
    requires_tools: [web_search]    # 可选：依赖特定工具
    config:                         # 可选：配置项
      - key: my.setting
        description: "What this setting controls"
        default: "sensible-default"
        prompt: "Display prompt for setup"
---

# Skill Title

Brief intro.

## When to Use
触发条件 — 何时应该加载这个技能？

## Quick Reference
常用命令或 API 调用的表格。

## Procedure
Agent 应遵循的逐步说明。

## Pitfalls
已知的失败模式及处理方法。

## Verification
Agent 如何确认成功？
```

### 3.2 配置项示例

```yaml
metadata:
  hermes:
    config:
      - key: wiki.path
        description: Path to the LLM Wiki knowledge base directory
        default: "~/wiki"
        prompt: Wiki directory path
      - key: wiki.domain
        description: Domain the wiki covers
        default: ""
        prompt: Wiki domain (e.g., AI/ML research)
```

### 3.3 环境变量依赖

```yaml
required_environment_variables:
  - name: TENOR_API_KEY
    prompt: "Tenor API key"
    help: "Get your key at https://tenor.com"
    required_for: "GIF search functionality"
```

### 3.4 支持文件结构

```
my-skill/
├── SKILL.md                    # 主技能文档（必需）
├── references/                 # 参考文档（可选）
│   ├── api-docs.md
│   └── examples.md
├── templates/                  # 模板文件（可选）
│   └── config.yaml
└── scripts/                    # 辅助脚本（可选）
    └── setup.sh
```

---

## 4. 计数器管理机制

### 4.1 技能计数器递增

在每次 tool-calling 迭代时递增：

```python
# Track tool-calling iterations for skill nudge.
# Counter resets whenever skill_manage is actually used.
if (self._skill_nudge_interval > 0
        and "skill_manage" in self.valid_tool_names):
    self._iters_since_skill += 1
```

### 4.2 技能计数器重置

当 `skill_manage` 工具被实际调用时重置：

```python
def handle_tool_call(tool_calls, ...):
    for tool_call in tool_calls:
        function_name = tool_call.function.name
        
        # Reset nudge counters
        if function_name == "memory":
            self._turns_since_memory = 0
        elif function_name == "skill_manage":
            self._iters_since_skill = 0
```

### 4.3 记忆计数器对比

系统同时维护记忆和技能两个计数器：

```python
self._memory_nudge_interval = 10   # 记忆审查间隔
self._turns_since_memory = 0       # 记忆计数器
self._skill_nudge_interval = 10    # 技能审查间隔
self._iters_since_skill = 0        # 技能计数器
```

**区别**：
- 记忆计数器基于**用户回合数**（user turns）
- 技能计数器基于**工具调用迭代数**（tool-calling iterations）

---

## 5. 配置方式

### 5.1 CLI 配置

在 `cli-config.yaml` 中配置：

```yaml
skills:
  # Nudge the agent to create skills after complex tasks.
  # Every N tool-calling iterations, remind the model to consider saving a skill.
  # Set to 0 to disable.
  creation_nudge_interval: 15
```

### 5.2 配置项说明

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `creation_nudge_interval` | int | 10 | 每 N 次工具调用迭代后提醒 Agent 考虑保存技能 |
| `external_dirs` | list | null | 外部技能目录（只读） |

### 5.3 禁用技能进化

```yaml
skills:
  creation_nudge_interval: 0  # 设置为 0 禁用
```

---

## 6. 技能进化流程示例

### 6.1 完整流程

```
用户请求 → Agent 执行任务 → 多次迭代 → 使用 skill_manage
    ↓
计数器递增 (iters_since_skill++)
    ↓
达到阈值 (iters_since_skill >= nudge_interval)
    ↓
触发后台审查 (_spawn_background_review)
    ↓
审查 Agent 分析对话历史
    ↓
决定：创建/更新技能 or 无需保存
    ↓
使用 skill_manage 执行实际操作
    ↓
技能保存到 ~/.hermes/skills/
    ↓
计数器重置 (iters_since_skill = 0)
```

### 6.2 实际案例

**场景**：用户要求部署一个 Python 应用到生产环境

1. **第一次尝试**：Agent 使用 `pip install`，失败（缺少依赖）
2. **第二次尝试**：Agent 添加 `requirements.txt`，失败（权限问题）
3. **第三次尝试**：Agent 使用虚拟环境，成功

**触发审查**：
- 经历了 3 次迭代（trial and error）
- 最终找到了可靠的方法
- Agent 决定保存为技能

**生成的技能**：
```markdown
---
name: python-production-deployment
description: Deploy Python apps to production with virtualenv and pip
version: 1.0.0
---

# Python Production Deployment

## When to Use
Use this skill when deploying Python applications to production environments.

## Procedure
1. Create a virtual environment
2. Install dependencies from requirements.txt
3. Run the application with gunicorn

## Pitfalls
- Permission errors: Use virtualenv instead of system Python
- Missing dependencies: Always use requirements.txt
```

---

## 7. 与 pi-coding-agent 的集成方案

### 7.1 pi-coding-agent SDK 架构

pi-coding-agent 使用 SDK 集成方式，需要：

1. **工具注册机制**：将 `skill_manage` 注册为可用工具
2. **技能存储后端**：实现技能的保存/加载
3. **审查触发逻辑**：实现计数器和间隔检查
4. **后台审查线程**：实现独立的审查 Agent

### 7.2 实现步骤

#### 步骤 1：注册技能管理工具

```python
# 在 pi-coding-agent 的工具注册系统中添加
from pi_agent_sdk.tool import Tool, ToolRegistry

def skill_manage(action: str, **kwargs) -> Dict[str, Any]:
    """Skill Manager Tool"""
    # 实现与 hermes-agent 相同的逻辑
    pass

registry = ToolRegistry()
registry.register(
    Tool(
        name="skill_manage",
        description="Create, update, delete skills",
        parameters={
            "action": {"type": "string", "enum": ["create", "edit", "patch", "delete"]},
            # ... 其他参数
        },
        func=skill_manage
    )
)
```

#### 步骤 2：实现技能存储

```python
from pathlib import Path
import yaml

class SkillStore:
    """技能存储管理"""
    
    def __init__(self, skills_dir: Path):
        self.skills_dir = skills_dir
        self.skills_dir.mkdir(parents=True, exist_ok=True)
    
    def load_skill(self, name: str) -> Dict[str, Any]:
        """加载技能"""
        skill_path = self.skills_dir / name / "SKILL.md"
        if not skill_path.exists():
            raise FileNotFoundError(f"Skill '{name}' not found")
        
        with open(skill_path) as f:
            content = f.read()
        
        # 解析 frontmatter
        frontmatter, body = self._parse_frontmatter(content)
        return {
            "name": name,
            "content": body,
            "frontmatter": frontmatter,
            "path": str(skill_path)
        }
    
    def save_skill(self, name: str, content: str) -> Dict[str, Any]:
        """保存技能"""
        skill_dir = self.skills_dir / name
        skill_dir.mkdir(parents=True, exist_ok=True)
        
        skill_path = skill_dir / "SKILL.md"
        with open(skill_path, 'w') as f:
            f.write(content)
        
        return {
            "success": True,
            "message": f"Skill '{name}' saved",
            "path": str(skill_path)
        }
    
    def _parse_frontmatter(self, content: str) -> tuple:
        """解析 YAML frontmatter"""
        # 实现与 hermes-agent 相同的解析逻辑
        pass
```

#### 步骤 3：实现计数器机制

```python
class Agent:
    def __init__(self, ...):
        # 技能进化配置
        self._skill_nudge_interval = 10
        self._iters_since_skill = 0
        
        # 加载配置
        self._load_skill_config()
    
    def _load_skill_config(self):
        """从配置文件加载技能设置"""
        config = self._load_config()
        skills_config = config.get("skills", {})
        self._skill_nudge_interval = skills_config.get(
            "creation_nudge_interval", 10
        )
    
    def on_tool_iteration(self, tool_name: str):
        """每次工具调用迭代时调用"""
        # 递增计数器
        if self._skill_nudge_interval > 0:
            self._iters_since_skill += 1
        
        # 检查是否触发审查
        if tool_name == "skill_manage":
            self._iters_since_skill = 0
    
    def check_skill_review(self) -> bool:
        """检查是否应该触发技能审查"""
        if self._skill_nudge_interval <= 0:
            return False
        
        if self._iters_since_skill >= self._skill_nudge_interval:
            return True
        
        return False
```

#### 步骤 4：实现后台审查

```python
import threading
from typing import List, Dict

class BackgroundSkillReviewer:
    """后台技能审查器"""
    
    def __init__(self, agent: Agent, skill_store: SkillStore):
        self.agent = agent
        self.skill_store = skill_store
    
    def start_review(self, messages: List[Dict]):
        """启动后台审查"""
        thread = threading.Thread(
            target=self._run_review,
            args=(messages,),
            daemon=True,
            name="bg-skill-review"
        )
        thread.start()
    
    def _run_review(self, messages: List[Dict]):
        """执行审查"""
        # 创建审查 Agent
        review_agent = self._create_review_agent()
        
        # 准备审查提示词
        prompt = self._build_skill_review_prompt()
        
        # 运行审查
        review_agent.run_conversation(
            user_message=prompt,
            conversation_history=messages
        )
        
        # 处理审查结果
        self._process_review_results(review_agent)
    
    def _create_review_agent(self) -> Agent:
        """创建审查用的 Agent"""
        # 使用相同的模型和工具
        # 但设置更少的迭代次数（如 8 次）
        # 关闭技能触发避免递归
        review_agent = Agent(
            model=self.agent.model,
            max_iterations=8,
            quiet_mode=True
        )
        review_agent._skill_nudge_interval = 0
        return review_agent
    
    def _build_skill_review_prompt(self) -> str:
        """构建审查提示词"""
        return (
            "Review the conversation above and consider saving or updating a skill if appropriate.\n\n"
            "Focus on: was a non-trivial approach used to complete a task that required trial "
            "and error, or changing course due to experiential findings along the way, or did "
            "the user expect or desire a different method or outcome?\n\n"
            "If a relevant skill already exists, update it with what you learned. "
            "Otherwise, create a new skill if the approach is reusable.\n"
            "If nothing is worth saving, just say 'Nothing to save.' and stop."
        )
```

#### 步骤 5：集成到主流程

```python
class Agent:
    def run_conversation(self, user_message: str, ...):
        # ... 主任务执行逻辑 ...
        
        # 检查是否需要触发技能审查
        if self.check_skill_review():
            # 启动后台审查
            reviewer = BackgroundSkillReviewer(self, self.skill_store)
            reviewer.start_review(messages)
            
            # 重置计数器
            self._iters_since_skill = 0
        
        return response
```

### 7.3 配置文件示例

```yaml
# pi-coding-agent-config.yaml
skills:
  # 每 10 次工具调用迭代后提醒 Agent 考虑保存技能
  creation_nudge_interval: 10
  
  # 外部技能目录（可选）
  external_dirs:
    - ~/.agents/skills
    - /shared/team-skills

# 技能存储路径
skill_store:
  path: ~/.pi-agent/skills
```

---

## 8. 关键设计亮点

### 8.1 非阻塞式审查

- **后台线程执行**：审查不影响主任务响应
- **独立 Agent 实例**：使用相同的模型但更少的迭代
- **静默模式**：不向用户显示审查过程

### 8.2 智能计数器

- **基于工具迭代**：比基于回合数更适合技能提取
- **自动重置**：使用技能后立即重置，避免重复触发
- **可配置间隔**：用户可以调整触发频率

### 8.3 安全机制

- **工具可用性检查**：只有 `skill_manage` 可用时才触发
- **计数器阈值**：避免过于频繁的审查
- **后台隔离**：审查失败不影响主任务

### 8.4 渐进式披露

- **按需加载**：技能只在需要时加载
- **支持文件**：大型技能可以拆分为多个文件
- **零成本存储**：未使用的技能不消耗 tokens

---

## 9. 最佳实践

### 9.1 何时启用技能进化

**建议启用**：
- 复杂的多步骤任务
- 需要试错的场景
- 有明确成功模式的任务

**建议禁用**：
- 简单的单步任务
- 实验性任务
- 临时性任务

### 9.2 调整触发间隔

```yaml
# 频繁触发（开发阶段）
skills:
  creation_nudge_interval: 5

# 稀疏触发（生产阶段）
skills:
  creation_nudge_interval: 20
```

### 9.3 技能组织

```
~/.hermes/skills/
├── devops/              # DevOps 相关技能
│   ├── deploy-python/
│   ├── setup-docker/
│   └── monitor-app/
├── research/            # 研究相关技能
│   ├── arxiv-search/
│   └── paper-analysis/
└── productivity/        # 生产力技能
    ├── git-workflow/
    └── pdf-processing/
```

---

## 10. 与 pi-coding-agent 的差异

| 特性 | hermes-agent | pi-coding-agent (建议实现) |
|------|--------------|---------------------------|
| 工具注册 | 内置 | SDK 注册 |
| 存储后端 | 文件系统 | 文件系统 |
| 审查触发 | 计数器+间隔 | 计数器+间隔 |
| 后台线程 | threading | threading |
| 配置方式 | YAML | YAML |
| 技能格式 | SKILL.md | SKILL.md |

**核心差异**：
- hermes-agent 是完整框架，pi-coding-agent 是 SDK
- pi-coding-agent 需要通过 SDK 注册工具
- pi-coding-agent 需要实现存储后端

---

## 11. 总结

Hermes Agent 的自进化技能系统通过以下机制实现：

1. **计数器监控**：跟踪工具调用迭代次数
2. **间隔触发**：达到阈值后启动后台审查
3. **独立审查**：使用独立 Agent 分析对话历史
4. **智能保存**：使用 `skill_manage` 工具保存技能
5. **配置化**：通过 YAML 配置调整行为

这个系统让 Agent 能够**自动从经验中学习**，将成功的模式转化为可复用的技能，实现真正的"进化"。

---

## 12. 参考资料

- [Hermes Agent Skills Documentation](https://hermes-agent.nousresearch.com)
- [Creating Skills](https://hermes-agent.nousresearch.com/docs/developer-guide/creating-skills)
- [Working with Skills](https://hermes-agent.nousresearch.com/docs/guides/work-with-skills)
- [Skills System](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)
