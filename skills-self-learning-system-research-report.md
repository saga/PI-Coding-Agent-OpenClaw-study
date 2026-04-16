# Skills 自我学习系统研究报告

## 一、概述

Hermes Agent 的 Skills 系统是一种**渐进式知识管理**机制，让 Agent 能够：
- 从经验中自动提取可复用技能
- 在执行复杂任务后创建技能文档
- 持续改进现有技能
- 跨会话持久化知识

**核心特点**：
- 灵感来自 Anthropic 的 Claude Skills 系统
- 采用 agentskills.io 开放标准
- 支持渐进式披露（Progressive Disclosure）
- 内置自我进化机制

---

## 二、系统架构

### 2.1 核心组件

```
┌─────────────────────────────────────────────────────────────────┐
│                        Skills System                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐       │
│  │ skills_list │    │  skill_view  │    │ skill_manage │       │
│  │  (Tier 1)   │    │   (Tier 2)   │    │   (进化)     │       │
│  └──────────────┘    └──────────────┘    └──────────────┘       │
│         │                   │                   │                  │
│         └───────────────────┴───────────────────┘                  │
│                            │                                      │
│                            ▼                                      │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    SKILLS_DIR                              │   │
│  │              (~/.hermes/skills/)                           │   │
│  │                                                           │   │
│  │   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │   │
│  │   │ my-skill/   │  │ devops/     │  │ research/   │     │   │
│  │   │ ├── SKILL.md│  │ ├── deploy/ │  │ ├── arxiv/ │     │   │
│  │   │ ├── refs/   │  │ └── SKILL.md│  │ └── SKILL.md│     │   │
│  │   │ └── tmpls/ │  │             │  │             │     │   │
│  │   └─────────────┘  └─────────────┘  └─────────────┘     │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 渐进式披露架构

| 层级 | 工具 | 披露内容 | Token 消耗 |
|------|------|----------|-----------|
| Tier 1 | `skills_list` | 元数据（name, description） | ~500 tokens |
| Tier 2 | `skill_view` | 完整技能内容 | ~2,000-5,000 tokens |
| Tier 3 | 支持文件 | references, templates | 按需加载 |

---

## 三、SKILL.md 格式规范

### 3.1 标准结构

```markdown
---
name: skill-name                    # 必需，最大 64 字符
description: 简短描述               # 必需，最大 1024 字符
version: 1.0.0                     # 可选
license: MIT                        # 可选
platforms: [macos, linux]          # 可选，限制操作系统
author: Author Name                # 可选

metadata:                           # agentskills.io 标准
  hermes:
    tags: [tag1, tag2]             # 标签
    related_skills: [other-skill] # 相关技能
    requires_toolsets: [web]        # 依赖工具集
    config:                        # 配置项
      - key: my.setting
        description: "配置说明"
        default: "默认值"
---

# Skill Title

## When to Use
何时应该加载这个技能。

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
        description: Wiki 知识库目录路径
        default: "~/wiki"
        prompt: Wiki 目录路径
      - key: wiki.domain
        description: Wiki 覆盖的领域
        default: ""
        prompt: Wiki 领域 (如 AI/ML research)
```

### 3.3 环境变量依赖

```yaml
required_environment_variables:
  - name: TENOR_API_KEY
    prompt: "Tenor API key"
    help: "从 https://tenor.com 获取"
    required_for: "GIF 搜索功能"
```

---

## 四、自我进化机制

### 4.1 触发机制

Hermes 使用**计数器+间隔触发**的方式：

```python
# 初始化
self._skill_nudge_interval = 10    # 默认每 10 次迭代触发一次
self._iters_since_skill = 0       # 当前计数器

# 在每次工具调用迭代时递增
if self._skill_nudge_interval > 0:
    self._iters_since_skill += 1

# 当 skill_manage 被调用时重置
if tool_name == "skill_manage":
    self._iters_since_skill = 0
```

### 4.2 触发条件

```python
# 检查是否触发审查
if (self._skill_nudge_interval > 0
        and self._iters_since_skill >= self._skill_nudge_interval
        and "skill_manage" in self.valid_tool_names):
    _should_review_skills = True
    self._iters_since_skill = 0
```

### 4.3 后台审查线程

```python
def _spawn_background_review(self, messages_snapshot):
    """启动后台线程审查对话，用于保存技能"""
    
    # 创建独立的审查 Agent
    review_agent = AIAgent(
        model=self.model,
        max_iterations=8,    # 审查用的迭代次数更少
        quiet_mode=True,      # 不输出到用户界面
    )
    
    # 关闭审查 Agent 的技能触发（避免递归）
    review_agent._skill_nudge_interval = 0
    
    # 运行审查
    review_agent.run_conversation(
        user_message=self._SKILL_REVIEW_PROMPT,
        conversation_history=messages_snapshot,
    )
```

### 4.4 审查提示词

```python
_SKILL_REVIEW_PROMPT = """
Review the conversation above and consider saving or updating a skill if appropriate.

Focus on:
- Was a non-trivial approach used to complete a task?
- Did it require trial and error?
- Did the user expect or desire a different method?

If a relevant skill already exists, update it with what you learned.
Otherwise, create a new skill if the approach is reusable.
If nothing is worth saving, just say 'Nothing to save.' and stop.
"""
```

---

## 五、技能管理工具

### 5.1 skill_manage 操作

```python
def skill_manage(action, name=None, content=None, **kwargs):
    """
    Actions:
      create     -- 创建新技能 (SKILL.md + 目录结构)
      edit       -- 完全重写现有技能
      patch      -- 精确替换 SKILL.md 内容
      delete     -- 删除技能
      write_file -- 添加支持文件
      remove_file-- 移除支持文件
    """
```

### 5.2 创建新技能

```python
# 调用示例
skill_manage(
    action="create",
    name="python-deployment",
    content="""---
name: python-deployment
description: Deploy Python apps to production
---

# Python Production Deployment

## When to Use
...

## Procedure
1. Create virtual environment
2. Install dependencies
3. Run with gunicorn
"""
)
```

### 5.3 更新现有技能

```python
# 编辑现有技能
skill_manage(
    action="edit",
    name="python-deployment",
    content="更新的内容..."
)

# 精确修补
skill_manage(
    action="patch",
    name="python-deployment",
    find="old text",
    replace="new text"
)
```

---

## 六、工具实现

### 6.1 skills_list

```python
def skills_list(
    query: Optional[str] = None,
    category: Optional[str] = None,
) -> str:
    """
    列出所有可用技能（元数据）
    支持按名称/描述过滤
    支持按类别筛选
    """
    # 扫描 ~/.hermes/skills/ 目录
    # 解析每个 SKILL.md 的 frontmatter
    # 返回技能列表
```

### 6.2 skill_view

```python
def skill_view(
    name: str,
    file_path: Optional[str] = None,
) -> str:
    """
    加载技能完整内容
    支持加载支持文件 (references/, templates/)
    """
    # 加载 SKILL.md
    # 解析 frontmatter
    # 检查平台兼容性
    # 返回完整内容
```

### 6.3 目录结构

```
~/.hermes/skills/
├── my-skill/
│   ├── SKILL.md              # 主技能文档（必需）
│   ├── references/            # 参考文档
│   │   ├── api.md
│   │   └── examples.md
│   ├── templates/            # 模板文件
│   │   └── config.yaml
│   └── scripts/               # 辅助脚本
│       └── setup.sh
└── another-skill/
    └── SKILL.md
```

---

## 七、命令行集成

### 7.1 Slash 命令

```bash
# 直接调用技能
/hermes-skill-name

# 示例
/deploy-python
/git-workflow
```

### 7.2 技能注册

```python
# skill_commands.py
def scan_skill_commands() -> Dict[str, Dict[str, Any]]:
    """扫描 ~/.hermes/skills/ 并返回命令映射"""
    for skill_md in scan_dir.rglob("SKILL.md"):
        # 解析 frontmatter
        # 注册为 slash 命令
        _skill_commands[f"/{skill_name}"] = {
            "name": name,
            "description": description,
            "skill_md_path": str(skill_md),
        }
```

### 7.3 自动补全

```
用户输入: /dep<TAB>
自动补全: /deploy-python
```

---

## 八、Skills Hub 集成

### 8.1 Hub 安装

```bash
hermes skills install pytorch-lightning
hermes skills install docker-deployment
```

### 8.2 搜索 Hub

```bash
hermes skills search "deployment"
```

### 8.3 技能更新

```bash
hermes skills update pytorch-lightning
```

---

## 九、与 PI-Coding-Agent 的集成建议

### 9.1 简化实现

```python
# pi-coding-agent/agent/skills.py
from pathlib import Path
import yaml
from typing import Dict, List, Optional

class SkillStore:
    """技能存储管理"""
    
    def __init__(self, skills_dir: Path):
        self.skills_dir = skills_dir
        self.skills_dir.mkdir(parents=True, exist_ok=True)
    
    def list_skills(self, query: str = None) -> List[Dict]:
        """列出所有技能"""
        skills = []
        for skill_dir in self.skills_dir.iterdir():
            if not skill_dir.is_dir():
                continue
            skill_md = skill_dir / "SKILL.md"
            if not skill_md.exists():
                continue
            
            # 解析 frontmatter
            frontmatter, body = self._parse_frontmatter(skill_md.read_text())
            
            if query:
                # 过滤匹配
                if query.lower() not in frontmatter.get("description", "").lower():
                    continue
            
            skills.append({
                "name": frontmatter.get("name", skill_dir.name),
                "description": frontmatter.get("description", ""),
            })
        
        return skills
    
    def view_skill(self, name: str, file_path: str = None) -> str:
        """加载技能内容"""
        skill_dir = self.skills_dir / name
        if not skill_dir.exists():
            raise FileNotFoundError(f"Skill '{name}' not found")
        
        if file_path:
            # 加载支持文件
            target = skill_dir / file_path
        else:
            # 加载主技能文档
            target = skill_dir / "SKILL.md"
        
        return target.read_text()
    
    def create_skill(self, name: str, content: str) -> Dict:
        """创建新技能"""
        skill_dir = self.skills_dir / name
        skill_dir.mkdir(parents=True, exist_ok=True)
        
        skill_md = skill_dir / "SKILL.md"
        skill_md.write_text(content)
        
        return {"success": True, "path": str(skill_md)}
```

### 9.2 技能管理工具

```python
# pi-coding-agent/agent/tools/skill_manage.py
def skill_manage(
    action: str,
    name: str = None,
    content: str = None,
    find: str = None,
    replace: str = None,
) -> str:
    """
    技能管理工具
    """
    store = SkillStore(Path("~/.pi-agent/skills"))
    
    if action == "create":
        return store.create_skill(name, content)
    
    elif action == "edit":
        return store.edit_skill(name, content)
    
    elif action == "patch":
        return store.patch_skill(name, find, replace)
    
    elif action == "delete":
        return store.delete_skill(name)
    
    elif action == "write_file":
        return store.write_file(name, file_path, content)
    
    elif action == "remove_file":
        return store.remove_file(name, file_path)
    
    else:
        return json.dumps({"error": f"Unknown action: {action}"})
```

### 9.3 自我进化机制

```python
# pi-coding-agent/agent/self_evolution.py
class SkillEvolution:
    """技能自我进化"""
    
    def __init__(self, agent, skill_store):
        self.agent = agent
        self.skill_store = skill_store
        self.nudge_interval = 10
        self.counter = 0
    
    def on_iteration(self, tool_name: str):
        """每次工具调用迭代时调用"""
        self.counter += 1
        
        if tool_name == "skill_manage":
            self.counter = 0
    
    def should_review(self) -> bool:
        """检查是否应该触发审查"""
        return (
            self.nudge_interval > 0
            and self.counter >= self.nudge_interval
            and "skill_manage" in self.agent.valid_tools
        )
    
    def spawn_review(self, messages):
        """启动后台审查"""
        import threading
        
        def review():
            review_agent = AIAgent(
                model=self.agent.model,
                max_iterations=8,
                quiet_mode=True,
            )
            review_agent._skill_nudge_interval = 0
            
            prompt = """Review the conversation and consider saving a skill.
            Focus on non-trivial approaches, trial and error, or user preferences.
            If worth saving, use skill_manage to create or update a skill.
            Otherwise say 'Nothing to save.'"""
            
            review_agent.run(prompt, messages)
        
        thread = threading.Thread(target=review, daemon=True)
        thread.start()
        
        self.counter = 0
```

---

## 十、配置选项

### 10.1 config.yaml

```yaml
skills:
  # 每 N 次工具调用迭代后提醒 Agent 考虑保存技能
  creation_nudge_interval: 10
  
  # 外部技能目录（只读）
  external_dirs:
    - ~/.shared-skills
    - /shared/team-skills
```

### 10.2 禁用进化

```yaml
skills:
  creation_nudge_interval: 0  # 设置为 0 禁用
```

---

## 十一、现有 Skills 分类

### 11.1 内置 Skills

| 类别 | 技能 | 说明 |
|------|------|------|
| Software Development | test-driven-development | TDD 工作流 |
| | systematic-debugging | 系统调试方法 |
| | plan | 任务规划 |
| Research | arxiv | 论文搜索 |
| | llm-wiki | LLM 知识库 |
| | blogwatcher | 博客监控 |

### 11.2 Optional Skills

| 类别 | 技能 | 说明 |
|------|------|------|
| Security | 1password | 密码管理 |
| | sherlock | OSINT 工具 |
| MLOps | pytorch-lightning | PyTorch Lightning |
| | axolotl | 微调配置 |
| | trl-fine-tuning | RLHF 训练 |
| DevOps | docker-management | Docker 操作 |
| | webhook-subscriptions | Webhook 自动化 |
| Health | fitness-nutrition | 健康追踪 |
| Apple | imessage | iMessage 集成 |
| | apple-reminders | 提醒事项 |

---

## 十二、总结

### 核心价值

| 能力 | 说明 |
|------|------|
| 知识持久化 | 成功的模式保存为 SKILL.md |
| 自动进化 | 从经验中学习，无需人工干预 |
| 渐进披露 | 按需加载，控制 Token 消耗 |
| 开放标准 | 兼容 agentskills.io |
| 工具集成 | 与现有工具系统无缝集成 |

### 与 Memory 的区别

| | Memory | Skills |
|--|--------|--------|
| 内容 | 事实性知识 | 程序性知识 |
| 格式 | 键值对 | 结构化文档 |
| 使用 | 宽泛的信息 | 具体的操作步骤 |
| 示例 | "用户喜欢深色模式" | "如何部署到 Kubernetes" |

### PI-Coding-Agent 实现要点

1. **SkillStore**：管理技能的文件存储
2. **skill_manage 工具**：创建、编辑、删除技能
3. **计数器机制**：控制进化触发频率
4. **后台审查**：独立线程分析对话
5. **SKILL.md 格式**：遵循 agentskills.io 标准

---

## 参考文件

| 文件 | 作用 |
|------|------|
| `agent/skill_commands.py` | Slash 命令扫描与注册 |
| `tools/skills_tool.py` | skills_list, skill_view 实现 |
| `agent/skill_utils.py` | 工具函数 |
| `hermes_cli/skills_hub.py` | Hub 集成 |
| `optional-skills/*/SKILL.md` | 技能示例 |
