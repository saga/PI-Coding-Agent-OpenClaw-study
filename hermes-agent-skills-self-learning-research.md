# Hermes Agent Skills 自我学习系统研究

**研究日期**: 2026-04-16  
**研究对象**: Hermes Agent 的 Skills 自我学习系统（Agent-Managed Skills）

---

## 执行摘要

Hermes Agent 的 Skills 自我学习系统是其最强大的能力之一，允许 Agent **自动从任务中提炼可复用的技能**，并将这些技能保存为可重用的 procedural memory（过程性记忆）。

这个系统的核心创新在于：

1. **自动提炼**：Agent 在完成复杂任务后，自动评估是否值得创建技能
2. **程序性记忆**：技能是"如何做"的流程性知识，而不是"是什么"的事实性知识
3. **安全审查**：所有 Agent 创建的技能都经过安全扫描
4. **渐进式更新**：支持创建、编辑、补丁（patch）、删除等多种操作
5. **后台审查**：使用独立的 review agent 进行后台技能审查，不阻塞主流程

这个系统让 Hermes 能够**不断进化和优化自己的工作流程**，形成个人化的知识库。

---

## 一、核心概念

### 1.1 什么是 Skills（技能）？

Skills 是**程序性记忆（Procedural Memory）**，用于存储"如何做"的流程性知识：

| 类型 | 用途 | 示例 |
|------|------|------|
| **Skills** | "如何做"的流程性知识 | "如何部署 Python 应用到 Fly.io" |
| **Memory** | "是什么"的事实性知识 | "用户喜欢 dark mode" |
| **User Profile** | 用户个人资料 | "用户住在 PST 时区" |

**关键区别**：
- **Skills**：专注于特定任务的完整工作流程，通常包含多个步骤
- **Memory**：简短的事实性信息，用于个性化
- **User Profile**：用户的基本信息和偏好

### 1.2 何时创建 Skills？

Agent 在以下情况下会考虑创建技能：

1. **完成复杂任务**（5+ tool calls）后成功完成
2. **遇到错误或死胡同**，并找到了解决方案
3. **用户纠正了 Agent 的方法**
4. **发现非平凡的工作流程**

**审查触发条件**（run_agent.py）：
```python
# 背景审查触发器
if (self._skill_nudge_interval > 0
        and self._iters_since_skill >= self._skill_nudge_interval
        and "skill_manage" in self.valid_tool_names):
    _should_review_skills = True
    self._iters_since_skill = 0
```

**审查提示**（run_agent.py）：
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

### 1.3 技能的结构

```
~/.hermes/skills/
├── category-name/
│   └── skill-name/
│       ├── SKILL.md              # 主要技能文档（必需）
│       ├── references/           # 支持文档
│       │   ├── api-docs.md
│       │   └── examples.md
│       ├── templates/            # 输出模板
│       │   └── config.yaml
│       ├── scripts/              # 辅助脚本
│       │   └── setup.sh
│       └── assets/               # 补充文件
│           └── logo.png
```

**SKILL.md 格式**：
```markdown
---
name: my-skill
description: Brief description of what this skill does
version: 1.0.0
metadata:
  hermes:
    tags: [python, automation]
    category: devops
---

# Skill Title

## When to Use
Use this skill when the user asks about [specific topic] or needs to [specific task].

## Procedure
1. First, check if [prerequisite] is available
2. Run `command --with-flags`
3. Parse the output and present results

## Pitfalls
- Common failure: [description]. Fix: [solution]
- Watch out for [edge case]

## Verification
Run `check-command` to confirm the result is correct.
```

---

## 二、实现细节

### 2.1 核心组件

#### 1. 技能管理工具（skill_manager_tool.py）

**位置**：`tools/skill_manager_tool.py`

**主要功能**：
- 创建技能（create）
- 编辑技能（edit）
- 补丁技能（patch）
- 删除技能（delete）
- 写入文件（write_file）
- 移除文件（remove_file）

**工具签名**：
```python
def skill_manage(
    action: str,
    name: str,
    content: str = None,
    category: str = None,
    file_path: str = None,
    file_content: str = None,
    old_string: str = None,
    new_string: str = None,
    replace_all: bool = False,
) -> str:
```

**注册到工具集**：
```python
# run_agent.py (line 2222-2230)
self._register_tool(
    name="skill_manage",
    toolset="skills",
    schema={
        "name": "skill_manage",
        "description": "Manage user-created skills (create, edit, patch, delete, write_file, remove_file)",
        "parameters": {...}
    },
    handler=self._skill_manage_handler,
)
```

#### 2. 技能列表工具（skills_tool.py）

**位置**：`tools/skills_tool.py`

**主要功能**：
- `skills_list()`：列出所有技能（仅元数据，~3k tokens）
- `skill_view(name)`：加载技能完整内容
- `skill_view(name, file_path)`：加载技能的特定文件

**渐进式披露**：
```
Level 0: skills_list()           → [{name, description, category}, ...]   (~3k tokens)
Level 1: skill_view(name)        → Full content + metadata       (varies)
Level 2: skill_view(name, path)  → Specific reference file       (varies)
```

#### 3. 技能审查工具（skill_utils.py）

**位置**：`agent/skill_utils.py`

**主要功能**：
- 解析 frontmatter（YAML 头部）
- 平台匹配检查（macos/linux/windows）
- 获取禁用的技能列表
- 提取技能条件（fallback_for_toolsets, requires_toolsets）
- 提取技能配置变量

### 2.2 技能创建流程

#### 1. 验证技能名称

```python
def _validate_name(name: str) -> Optional[str]:
    """Validate a skill name. Returns error message or None if valid."""
    if not name:
        return "Name is required."
    if len(name) > MAX_NAME_LENGTH:
        return f"Name must be {MAX_NAME_LENGTH} characters or less."
    if not VALID_NAME_RE.match(name):
        return (
            "Name must start with a letter or number and contain only "
            "letters, numbers, dots, underscores, and hyphens."
        )
    return None
```

**命名规则**：
- 以字母或数字开头
- 只包含字母、数字、点、下划线、连字符
- 最大长度 64 字符

#### 2. 创建技能目录

```python
def _create_skill(name: str, content: str, category: str = None) -> Dict[str, Any]:
    """Create a new user skill with SKILL.md content."""
    # Validate name
    err = _validate_name(name)
    if err:
        return {"success": False, "error": err}
    
    # Validate content
    err = _validate_frontmatter(content)
    if err:
        return {"success": False, "error": err}
    
    err = _validate_content_size(content)
    if err:
        return {"success": False, "error": err}
    
    # Create directory
    skill_dir = SKILLS_DIR / (category or "") / name
    skill_dir.mkdir(parents=True, exist_ok=True)
    
    # Write SKILL.md atomically
    skill_md = skill_dir / "SKILL.md"
    _atomic_write_text(skill_md, content)
    
    # Security scan
    scan_error = _security_scan_skill(skill_dir)
    if scan_error:
        shutil.rmtree(skill_dir, ignore_errors=True)
        return {"success": False, "error": scan_error}
    
    return {"success": True, "message": f"Skill '{name}' created."}
```

**原子写入**：
```python
def _atomic_write_text(path: Path, content: str) -> None:
    """Write content to path atomically using a temp file."""
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(tmp, path)
    except Exception:
        os.unlink(tmp)
        raise
```

#### 3. 安全扫描

```python
def _security_scan_skill(skill_dir: Path) -> Optional[str]:
    """Scan a skill directory after write. Returns error string if blocked, else None."""
    if not _GUARD_AVAILABLE:
        return None
    try:
        result = scan_skill(skill_dir, source="agent-created")
        allowed, reason = should_allow_install(result)
        if allowed is False:
            report = format_scan_report(result)
            return f"Security scan blocked this skill ({reason}):\n{report}"
        if allowed is None:
            report = format_scan_report(result)
            logger.warning("Agent-created skill blocked (dangerous findings): %s", reason)
            return f"Security scan blocked this skill ({reason}):\n{report}"
    except Exception as e:
        logger.warning("Security scan failed for %s: %s", skill_dir, e, exc_info=True)
    return None
```

**扫描内容**：
- 数据泄露（data exfiltration）
- 提示注入（prompt injection）
- 破坏性命令（destructive commands）
- 供应链信号（supply-chain signals）
- 其他威胁

### 2.3 技能更新流程

#### 1. 补丁更新（patch）

```python
def _patch_skill(
    name: str,
    old_string: str,
    new_string: str,
    file_path: str = None,
    replace_all: bool = False,
) -> Dict[str, Any]:
    """Targeted find-and-replace within a skill file."""
    existing = _find_skill(name)
    if not existing:
        return {"success": False, "error": f"Skill '{name}' not found."}
    
    skill_dir = existing["path"]
    
    if file_path:
        # Patching a supporting file
        target, err = _resolve_skill_target(skill_dir, file_path)
    else:
        # Patching SKILL.md
        target = skill_dir / "SKILL.md"
    
    content = target.read_text(encoding="utf-8")
    
    # Use fuzzy matching engine
    from tools.fuzzy_match import fuzzy_find_and_replace
    
    new_content, match_count, _strategy, match_error = fuzzy_find_and_replace(
        content, old_string, new_string, replace_all
    )
    
    if match_error:
        return {"success": False, "error": match_error}
    
    # Security scan
    scan_error = _security_scan_skill(skill_dir)
    if scan_error:
        _atomic_write_text(target, original_content)
        return {"success": False, "error": scan_error}
    
    return {"success": True, "message": f"Patched {target} in skill '{name}'."}
```

**模糊匹配优势**：
- 处理空白符规范化
- 处理缩进差异
- 处理转义序列
- 处理块锚点匹配

#### 2. 完全编辑（edit）

```python
def _edit_skill(name: str, content: str) -> Dict[str, Any]:
    """Replace the SKILL.md of any existing skill (full rewrite)."""
    err = _validate_frontmatter(content)
    if err:
        return {"success": False, "error": err}
    
    err = _validate_content_size(content)
    if err:
        return {"success": False, "error": err}
    
    existing = _find_skill(name)
    if not existing:
        return {"success": False, "error": f"Skill '{name}' not found."}
    
    skill_md = existing["path"] / "SKILL.md"
    
    # Back up original content for rollback
    original_content = skill_md.read_text(encoding="utf-8")
    _atomic_write_text(skill_md, content)
    
    # Security scan
    scan_error = _security_scan_skill(existing["path"])
    if scan_error:
        _atomic_write_text(skill_md, original_content)
        return {"success": False, "error": scan_error}
    
    return {"success": True, "message": f"Skill '{name}' updated."}
```

### 2.4 技能删除流程

```python
def _delete_skill(name: str) -> Dict[str, Any]:
    """Delete a skill."""
    existing = _find_skill(name)
    if not existing:
        return {"success": False, "error": f"Skill '{name}' not found."}
    
    skill_dir = existing["path"]
    shutil.rmtree(skill_dir)
    
    # Clean up empty category directories
    parent = skill_dir.parent
    if parent != SKILLS_DIR and parent.exists() and not any(parent.iterdir()):
        parent.rmdir()
    
    return {"success": True, "message": f"Skill '{name}' deleted."}
```

### 2.5 技能文件管理

#### 1. 写入文件

```python
def _write_file(name: str, file_path: str, file_content: str) -> Dict[str, Any]:
    """Add or overwrite a supporting file within any skill directory."""
    err = _validate_file_path(file_path)
    if err:
        return {"success": False, "error": err}
    
    # Check size limits
    content_bytes = len(file_content.encode("utf-8"))
    if content_bytes > MAX_SKILL_FILE_BYTES:
        return {"success": False, "error": f"File too large: {content_bytes} bytes"}
    
    existing = _find_skill(name)
    if not existing:
        return {"success": False, "error": f"Skill '{name}' not found."}
    
    target, err = _resolve_skill_target(existing["path"], file_path)
    if err:
        return {"success": False, "error": err}
    
    target.parent.mkdir(parents=True, exist_ok=True)
    
    # Back up for rollback
    original_content = target.read_text(encoding="utf-8") if target.exists() else None
    _atomic_write_text(target, file_content)
    
    # Security scan
    scan_error = _security_scan_skill(existing["path"])
    if scan_error:
        if original_content is not None:
            _atomic_write_text(target, original_content)
        return {"success": False, "error": scan_error}
    
    return {"success": True, "message": f"File '{file_path}' written to skill '{name}'."}
```

#### 2. 移除文件

```python
def _remove_file(name: str, file_path: str) -> Dict[str, Any]:
    """Remove a supporting file from a user skill."""
    existing = _find_skill(name)
    if not existing:
        return {"success": False, "error": f"Skill '{name}' not found."}
    
    target, err = _resolve_skill_target(existing["path"], file_path)
    if err:
        return {"success": False, "error": err}
    
    if not target.exists():
        return {"success": False, "error": f"File not found: {file_path}"}
    
    target.unlink()
    
    # Clean up empty subdirectories
    parent = target.parent
    if parent != skill_dir and parent.exists() and not any(parent.iterdir()):
        parent.rmdir()
    
    return {"success": True, "message": f"File '{file_path}' removed from skill '{name}'."}
```

### 2.6 技能审查机制

#### 1. 审查提示

```python
# run_agent.py (line 2268-2276)
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

#### 2. 后台审查线程

```python
# run_agent.py (line 2298-2376)
def _spawn_background_review(
    self,
    messages_snapshot: List[Dict],
    review_memory: bool = False,
    review_skills: bool = False,
) -> None:
    """Spawn a background thread to review the conversation for memory/skill saves."""
    import threading
    
    # Pick the right prompt based on which triggers fired
    if review_memory and review_skills:
        prompt = self._COMBINED_REVIEW_PROMPT
    elif review_memory:
        prompt = self._MEMORY_REVIEW_PROMPT
    else:
        prompt = self._SKILL_REVIEW_PROMPT
    
    def _run_review():
        import contextlib, os as _os
        review_agent = None
        try:
            with open(_os.devnull, "w") as _devnull, \
                 contextlib.redirect_stdout(_devnull), \
                 contextlib.redirect_stderr(_devnull):
                review_agent = AIAgent(
                    model=self.model,
                    max_iterations=8,
                    quiet_mode=True,
                    platform=self.platform,
                    provider=self.provider,
                )
                review_agent._memory_store = self._memory_store
                review_agent._memory_enabled = self._memory_enabled
                review_agent._user_profile_enabled = self._user_profile_enabled
                review_agent._memory_nudge_interval = 0
                review_agent._skill_nudge_interval = 0
                
                review_agent.run_conversation(
                    user_message=prompt,
                    conversation_history=messages_snapshot,
                )
            
            # Scan the review agent's messages for successful tool actions
            actions = []
            for msg in getattr(review_agent, "_session_messages", []):
                if not isinstance(msg, dict) or msg.get("role") != "tool":
                    continue
                try:
                    data = json.loads(msg.get("content", "{}"))
                except (json.JSONDecodeError, TypeError):
                    continue
                if not data.get("success"):
                    continue
                message = data.get("message", "")
                target = data.get("target", "")
                if "created" in message.lower():
                    actions.append(message)
                elif "updated" in message.lower():
                    actions.append(message)
            
            if actions:
                summary = " · ".join(dict.fromkeys(actions))
                self._safe_print(f"  💾 {summary}")
        
        except Exception as e:
            logger.debug("Background memory/skill review failed: %s", e)
        finally:
            if review_agent is not None:
                try:
                    review_agent.close()
                except Exception:
                    pass
    
    t = threading.Thread(target=_run_review, daemon=True, name="bg-review")
    t.start()
```

**审查流程**：
1. 创建独立的 review agent（与主 agent 共享 model、tools、context）
2. 使用审查提示作为用户消息
3. 在后台线程运行（不阻塞主流程）
4. 扫描审查 agent 的工具调用结果
5. 如果有技能创建/更新，向用户显示摘要

#### 3. 迭代计数器

```python
# run_agent.py (line 1205)
self._iters_since_skill = 0

# run_agent.py (line 1314-1320)
self._skill_nudge_interval = 10
try:
    skills_config = _agent_cfg.get("skills", {})
    self._skill_nudge_interval = int(skills_config.get("creation_nudge_interval", 10))
except Exception:
    pass

# run_agent.py (line 7301-7302)
elif function_name == "skill_manage":
    self._iters_since_skill = 0

# run_agent.py (line 11069-11075)
if (self._skill_nudge_interval > 0
        and self._iters_since_skill >= self._skill_nudge_interval
        and "skill_manage" in self.valid_tool_names):
    _should_review_skills = True
    self._iters_since_skill = 0
```

**计数器机制**：
- 每次迭代增加计数器
- 使用 `skill_manage` 工具后重置计数器
- 达到阈值后触发审查
- 默认阈值：10 次迭代

### 2.7 工具注册

```python
# run_agent.py (line 2222-2230)
self._register_tool(
    name="skill_manage",
    toolset="skills",
    schema={
        "name": "skill_manage",
        "description": (
            "Manage user-created skills. "
            "Use 'create' to make a new skill, 'edit' to replace SKILL.md, "
            "'patch' for targeted updates, 'delete' to remove a skill, "
            "'write_file' to add supporting files, 'remove_file' to delete them."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["create", "edit", "patch", "delete", "write_file", "remove_file"],
                    "description": "Action to perform"
                },
                "name": {
                    "type": "string",
                    "description": "Skill name"
                },
                "content": {
                    "type": "string",
                    "description": "Full SKILL.md content (create/edit)"
                },
                "category": {
                    "type": "string",
                    "description": "Category directory (create)"
                },
                "file_path": {
                    "type": "string",
                    "description": "Path within skill directory (write_file/remove_file)"
                },
                "file_content": {
                    "type": "string",
                    "description": "File content (write_file)"
                },
                "old_string": {
                    "type": "string",
                    "description": "Text to replace (patch)"
                },
                "new_string": {
                    "type": "string",
                    "description": "Replacement text (patch)"
                },
                "replace_all": {
                    "type": "boolean",
                    "description": "Replace all occurrences (patch)"
                },
            },
            "required": ["action", "name"],
        },
    },
    handler=self._skill_manage_handler,
)
```

---

## 三、使用模式

### 3.1 创建技能

```python
skill_manage(
    action="create",
    name="deploy-python-to-flyio",
    category="devops",
    content="""
---
name: deploy-python-to-flyio
description: Deploy a Python app to Fly.io in 5 minutes
version: 1.0.0
metadata:
  hermes:
    tags: [python, deployment, flyio]
    category: devops
---

# Deploy Python App to Fly.io

## When to Use
Use this skill when the user wants to deploy a Python application to Fly.io.

## Procedure
1. Check if flyctl is installed: `flyctl --version`
2. Login to Fly.io: `flyctl auth login`
3. Create app: `flyctl launch --no-deploy`
4. Set Python version: `flyctl platform set python`
5. Deploy: `flyctl deploy`

## Pitfalls
- Common failure: flyctl not installed. Fix: `brew install flyctl`
- Common failure: authentication failed. Fix: `flyctl auth login`

## Verification
Run `flyctl apps list` to confirm the app was created.
"""
)
```

### 3.2 补丁更新技能

```python
skill_manage(
    action="patch",
    name="deploy-python-to-flyio",
    old_string="5. Deploy: `flyctl deploy`",
    new_string="5. Deploy: `flyctl deploy --auto-confirm`\n6. Open app: `flyctl open`",
    file_path=None,
    replace_all=False
)
```

### 3.3 完全编辑技能

```python
skill_manage(
    action="edit",
    name="deploy-python-to-flyio",
    content="""
---
name: deploy-python-to-flyio
description: Deploy a Python app to Fly.io with database
version: 2.0.0
metadata:
  hermes:
    tags: [python, deployment, flyio, database]
    category: devops
---

# Deploy Python App to Fly.io

## When to Use
Use this skill when the user wants to deploy a Python application to Fly.io with PostgreSQL.

## Procedure
1. Check if flyctl is installed: `flyctl --version`
2. Login to Fly.io: `flyctl auth login`
3. Create app: `flyctl launch --no-deploy`
4. Provision database: `flyctl postgres create`
5. Deploy: `flyctl deploy --auto-confirm`

## Pitfalls
- Common failure: database connection failed. Fix: check connection string in .env

## Verification
Run `flyctl apps list` and `flyctl status` to confirm everything is running.
"""
)
```

### 3.4 写入参考文件

```python
skill_manage(
    action="write_file",
    name="deploy-python-to-flyio",
    file_path="references/deployment-checklist.md",
    file_content="""
# Deployment Checklist

- [ ] Python version specified in runtime.txt
- [ ] requirements.txt is up to date
- [ ] .env.example exists with all required variables
- [ ] Database migrations are ready
- [ ] Environment variables are set
- [ ] Tests pass locally
- [ ] Dockerfile exists (optional)
"""
)
```

### 3.5 删除技能

```python
skill_manage(
    action="delete",
    name="deploy-python-to-flyio"
)
```

---

## 四、配置选项

### 4.1 技能创建提示间隔

```yaml
# ~/.hermes/config.yaml

skills:
  creation_nudge_interval: 10  # Default: 10 iterations
```

**作用**：每 N 次迭代后提示创建技能

**默认值**：10

**范围**：0（禁用）或正整数

### 4.2 技能配置变量

```yaml
# ~/.hermes/config.yaml

skills:
  config:
    wiki.path: ~/wiki
    api.timeout: 30
```

**作用**：存储技能所需的配置值

### 4.3 平台禁用技能

```yaml
# ~/.hermes/config.yaml

skills:
  platform_disabled:
    telegram:
      - macos-specific-skills
      - apple-reminders
    discord:
      - windows-specific-skills
```

**作用**：在特定平台上禁用技能

---

## 五、最佳实践

### 5.1 技能命名

**好的命名**：
- `deploy-python-to-flyio`（动词-对象-目标）
- `setup-react-project`（动词-对象）
- `debug-flask-app`（动词-对象）

**避免的命名**：
- `my-skill`（太模糊）
- `the-best-way`（主观）
- `how-to-1`（无意义）

### 5.2 技能内容

**好的结构**：
```markdown
# Skill Title

## When to Use
Specific trigger conditions.

## Procedure
1. Step one (with exact commands)
2. Step two (with exact commands)
3. Step three (with exact commands)

## Pitfalls
- Common failure: [description]. Fix: [solution]

## Verification
Specific command to verify success.
```

**避免**：
- 太长的技能（超过 100 行）
- 太模糊的技能（"如何编程"）
- 太宽泛的技能（"所有 DevOps 工作"）

### 5.3 技能更新

**更新策略**：
1. **遇到新问题** → 补丁更新
2. **流程有重大变化** → 完全编辑
3. **发现更好的方法** → 创建新技能

**更新时机**：
- 用户纠正了方法
- 遇到了未预见的错误
- 发现了更高效的流程

---

## 六、与 pi-coding-agent 的集成方案

### 6.1 核心组件实现

#### 1. 技能管理工具

```python
# pi-coding-agent/tools/skill_manager_tool.py

import json
import logging
import os
import shutil
import tempfile
from pathlib import Path
from typing import Dict, Any, Optional

logger = logging.getLogger(__name__)

# 技能目录
HERMES_HOME = Path.home() / ".hermes"
SKILLS_DIR = HERMES_HOME / "skills"

MAX_NAME_LENGTH = 64
MAX_DESCRIPTION_LENGTH = 1024
MAX_SKILL_CONTENT_CHARS = 100_000
MAX_SKILL_FILE_BYTES = 1_048_576

VALID_NAME_RE = re.compile(r'^[a-z0-9][a-z0-9._-]*$')
ALLOWED_SUBDIRS = {"references", "templates", "scripts", "assets"}


def skill_manage(
    action: str,
    name: str,
    content: str = None,
    category: str = None,
    file_path: str = None,
    file_content: str = None,
    old_string: str = None,
    new_string: str = None,
    replace_all: bool = False,
) -> Dict[str, Any]:
    """
    Manage user-created skills.
    
    Args:
        action: create, edit, patch, delete, write_file, remove_file
        name: Skill name
        content: Full SKILL.md content (create/edit)
        category: Category directory (create)
        file_path: Path within skill directory (write_file/remove_file)
        file_content: File content (write_file)
        old_string: Text to replace (patch)
        new_string: Replacement text (patch)
        replace_all: Replace all occurrences (patch)
    
    Returns:
        Dict with success, message, and optional error
    """
    if action == "create":
        return _create_skill(name, content, category)
    elif action == "edit":
        return _edit_skill(name, content)
    elif action == "patch":
        return _patch_skill(name, old_string, new_string, file_path, replace_all)
    elif action == "delete":
        return _delete_skill(name)
    elif action == "write_file":
        return _write_file(name, file_path, file_content)
    elif action == "remove_file":
        return _remove_file(name, file_path)
    else:
        return {"success": False, "error": f"Unknown action '{action}'"}


def _create_skill(name: str, content: str, category: str = None) -> Dict[str, Any]:
    """Create a new user skill."""
    # Validate name
    if not name:
        return {"success": False, "error": "Name is required."}
    if len(name) > MAX_NAME_LENGTH:
        return {"success": False, "error": f"Name must be {MAX_NAME_LENGTH} chars or less."}
    if not VALID_NAME_RE.match(name):
        return {"success": False, "error": "Name must start with letter/number, only letters/numbers/dots/underscores/hyphens."}
    
    # Validate content
    if not content:
        return {"success": False, "error": "Content is required for create."}
    if len(content) > MAX_SKILL_CONTENT_CHARS:
        return {"success": False, "error": f"Content too large: {len(content)} chars"}
    
    # Create directory
    skill_dir = SKILLS_DIR / (category or "") / name
    skill_dir.mkdir(parents=True, exist_ok=True)
    
    # Write SKILL.md
    skill_md = skill_dir / "SKILL.md"
    _atomic_write_text(skill_md, content)
    
    return {"success": True, "message": f"Skill '{name}' created.", "path": str(skill_dir.relative_to(SKILLS_DIR))}


def _patch_skill(name: str, old_string: str, new_string: str, file_path: str = None, replace_all: bool = False) -> Dict[str, Any]:
    """Patch a skill file."""
    if not old_string:
        return {"success": False, "error": "old_string is required for patch."}
    
    skill_dir = SKILLS_DIR / name
    if not skill_dir.exists():
        return {"success": False, "error": f"Skill '{name}' not found."}
    
    target = skill_dir / (file_path or "SKILL.md")
    if not target.exists():
        return {"success": False, "error": f"File not found: {target}"}
    
    content = target.read_text(encoding="utf-8")
    
    # Simple string replacement
    if replace_all:
        new_content = content.replace(old_string, new_string)
    else:
        new_content = content.replace(old_string, new_string, 1)
    
    if new_content == content:
        return {"success": False, "error": "No matches found."}
    
    _atomic_write_text(target, new_content)
    
    return {"success": True, "message": f"Patched {target.name} in skill '{name}'."}


def _edit_skill(name: str, content: str) -> Dict[str, Any]:
    """Edit a skill (full rewrite)."""
    if not content:
        return {"success": False, "error": "Content is required for edit."}
    
    skill_dir = SKILLS_DIR / name
    if not skill_dir.exists():
        return {"success": False, "error": f"Skill '{name}' not found."}
    
    skill_md = skill_dir / "SKILL.md"
    _atomic_write_text(skill_md, content)
    
    return {"success": True, "message": f"Skill '{name}' updated."}


def _delete_skill(name: str) -> Dict[str, Any]:
    """Delete a skill."""
    skill_dir = SKILLS_DIR / name
    if not skill_dir.exists():
        return {"success": False, "error": f"Skill '{name}' not found."}
    
    shutil.rmtree(skill_dir)
    
    return {"success": True, "message": f"Skill '{name}' deleted."}


def _write_file(name: str, file_path: str, file_content: str) -> Dict[str, Any]:
    """Write a supporting file."""
    if not file_content:
        return {"success": False, "error": "file_content is required."}
    
    skill_dir = SKILLS_DIR / name
    if not skill_dir.exists():
        return {"success": False, "error": f"Skill '{name}' not found."}
    
    # Validate file path
    if not file_path:
        return {"success": False, "error": "file_path is required."}
    
    # Check allowed subdirs
    parts = Path(file_path).parts
    if parts and parts[0] not in ALLOWED_SUBDIRS:
        return {"success": False, "error": f"Invalid path. Must start with one of: {ALLOWED_SUBDIRS}"}
    
    target = skill_dir / file_path
    target.parent.mkdir(parents=True, exist_ok=True)
    
    _atomic_write_text(target, file_content)
    
    return {"success": True, "message": f"File '{file_path}' written to skill '{name}'."}


def _remove_file(name: str, file_path: str) -> Dict[str, Any]:
    """Remove a supporting file."""
    skill_dir = SKILLS_DIR / name
    if not skill_dir.exists():
        return {"success": False, "error": f"Skill '{name}' not found."}
    
    target = skill_dir / file_path
    if not target.exists():
        return {"success": False, "error": f"File not found: {file_path}"}
    
    target.unlink()
    
    # Clean up empty dirs
    parent = target.parent
    while parent != skill_dir and parent.exists() and not any(parent.iterdir()):
        parent.rmdir()
        parent = parent.parent
    
    return {"success": True, "message": f"File '{file_path}' removed from skill '{name}'."}


def _atomic_write_text(path: Path, content: str) -> None:
    """Write content to path atomically."""
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(tmp, path)
    except Exception:
        os.unlink(tmp)
        raise
```

#### 2. 技能列表工具

```python
# pi-coding-agent/tools/skills_list_tool.py

import json
import logging
from pathlib import Path
from typing import Dict, Any, List

logger = logging.getLogger(__name__)

SKILLS_DIR = Path.home() / ".hermes" / "skills"


def skills_list() -> List[Dict[str, Any]]:
    """List all skills with metadata."""
    skills = []
    
    if not SKILLS_DIR.exists():
        return skills
    
    for skill_dir in SKILLS_DIR.rglob("SKILL.md"):
        if any(part in (".git", ".github", ".hub") for part in skill_dir.parts):
            continue
        
        try:
            content = skill_dir.read_text(encoding="utf-8")[:4000]
            frontmatter, body = _parse_frontmatter(content)
            
            name = frontmatter.get("name", skill_dir.parent.name)[:64]
            description = frontmatter.get("description", "")
            
            if not description:
                for line in body.strip().split("\n"):
                    line = line.strip()
                    if line and not line.startswith("#"):
                        description = line
                        break
            
            if len(description) > 1024:
                description = description[:1021] + "..."
            
            category = _get_category_from_path(skill_dir)
            
            skills.append({
                "name": name,
                "description": description,
                "category": category,
            })
        except Exception as e:
            logger.debug(f"Failed to read skill {skill_dir}: {e}")
            continue
    
    return skills


def _parse_frontmatter(content: str) -> tuple:
    """Parse YAML frontmatter."""
    frontmatter = {}
    body = content
    
    if not content.startswith("---"):
        return frontmatter, body
    
    import re
    end_match = re.search(r"\n---\s*\n", content[3:])
    if not end_match:
        return frontmatter, body
    
    yaml_content = content[3:end_match.start() + 3]
    body = content[end_match.end() + 3:]
    
    try:
        import yaml
        parsed = yaml.safe_load(yaml_content)
        if isinstance(parsed, dict):
            frontmatter = parsed
    except Exception:
        pass
    
    return frontmatter, body


def _get_category_from_path(skill_path: Path) -> str:
    """Extract category from skill path."""
    try:
        rel_path = skill_path.relative_to(SKILLS_DIR)
        parts = rel_path.parts
        if len(parts) >= 3:
            return parts[0]
    except ValueError:
        pass
    return None
```

#### 3. 技能审查工具

```python
# pi-coding-agent/tools/skill_review_tool.py

import json
import logging
import threading
from typing import Dict, Any, List, Optional

logger = logging.getLogger(__name__)

MAX_DEPTH = 2
SKILL_REVIEW_INTERVAL = 10


class SkillReviewTool:
    """Skill review tool for pi-coding-agent."""
    
    def __init__(self, agent):
        self.agent = agent
        self._iters_since_skill = 0
        self._skill_nudge_interval = SKILL_REVIEW_INTERVAL
    
    def maybe_trigger_review(self, function_name: str, messages_snapshot: List[Dict]) -> None:
        """Maybe trigger skill review based on iteration count."""
        if function_name == "skill_manage":
            self._iters_since_skill = 0
            return
        
        self._iters_since_skill += 1
        
        if (self._skill_nudge_interval > 0
                and self._iters_since_skill >= self._skill_nudge_interval
                and "skill_manage" in self.agent.valid_tool_names):
            self._iters_since_skill = 0
            self._spawn_background_review(messages_snapshot)
    
    def _spawn_background_review(self, messages_snapshot: List[Dict]) -> None:
        """Spawn background thread to review conversation for skill saves."""
        def _run_review():
            try:
                # Create review agent
                review_agent = self._create_review_agent()
                
                # Run review
                review_agent.run_conversation(
                    user_message=self._get_skill_review_prompt(),
                    conversation_history=messages_snapshot,
                )
                
                # Scan for skill actions
                actions = []
                for msg in getattr(review_agent, "_session_messages", []):
                    if not isinstance(msg, dict) or msg.get("role") != "tool":
                        continue
                    try:
                        data = json.loads(msg.get("content", "{}"))
                    except Exception:
                        continue
                    if not data.get("success"):
                        continue
                    message = data.get("message", "")
                    if "created" in message.lower() or "updated" in message.lower():
                        actions.append(message)
                
                if actions:
                    summary = " · ".join(dict.fromkeys(actions))
                    self.agent._safe_print(f"  💾 {summary}")
            
            except Exception as e:
                logger.debug(f"Background skill review failed: {e}")
        
        t = threading.Thread(target=_run_review, daemon=True, name="bg-skill-review")
        t.start()
    
    def _create_review_agent(self):
        """Create a review agent."""
        from pi_agent_sdk.agent import Agent as PI-Agent
        
        review_agent = PI-Agent(
            model=self.agent.model,
            max_iterations=8,
            quiet_mode=True,
            platform=self.agent.platform,
            provider=self.agent.provider,
        )
        
        # Copy memory settings
        review_agent._memory_store = self.agent._memory_store
        review_agent._memory_enabled = self.agent._memory_enabled
        review_agent._user_profile_enabled = self.agent._user_profile_enabled
        
        return review_agent
    
    def _get_skill_review_prompt(self) -> str:
        """Get skill review prompt."""
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

#### 4. 集成到 pi-coding-agent

```python
# pi-coding-agent/agent/agent.py

from tools.skill_manager_tool import skill_manage
from tools.skills_list_tool import skills_list
from tools.skill_review_tool import SkillReviewTool


class PI-Agent:
    """PI-Coding-Agent with skill management."""
    
    def __init__(self, ...):
        # ... existing code ...
        
        # Register skill management tools
        self._register_tool(
            name="skill_manage",
            toolset="skills",
            schema={
                "name": "skill_manage",
                "description": "Manage user-created skills (create, edit, patch, delete, write_file, remove_file)",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {"type": "string", "enum": ["create", "edit", "patch", "delete", "write_file", "remove_file"]},
                        "name": {"type": "string"},
                        "content": {"type": "string"},
                        "category": {"type": "string"},
                        "file_path": {"type": "string"},
                        "file_content": {"type": "string"},
                        "old_string": {"type": "string"},
                        "new_string": {"type": "string"},
                        "replace_all": {"type": "boolean"},
                    },
                    "required": ["action", "name"],
                },
            },
            handler=self._skill_manage_handler,
        )
        
        # Register skills list tool
        self._register_tool(
            name="skills_list",
            toolset="skills",
            schema={
                "name": "skills_list",
                "description": "List all available skills with metadata",
                "parameters": {
                    "type": "object",
                    "properties": {},
                },
            },
            handler=lambda **kwargs: json.dumps(skills_list(), ensure_ascii=False),
        )
        
        # Initialize skill review tool
        self._skill_review_tool = SkillReviewTool(self)
    
    def _skill_manage_handler(self, **kwargs) -> str:
        """Handle skill_manage tool calls."""
        result = skill_manage(**kwargs)
        return json.dumps(result, ensure_ascii=False)
    
    def _on_tool_call(self, function_name: str, **kwargs):
        """Called after each tool call."""
        # ... existing code ...
        
        # Trigger skill review if needed
        if hasattr(self, '_skill_review_tool'):
            messages_snapshot = self._get_messages_snapshot()
            self._skill_review_tool.maybe_trigger_review(function_name, messages_snapshot)
```

---

## 七、总结

### 7.1 核心创新

1. **自动提炼**：Agent 在完成复杂任务后，自动评估是否值得创建技能
2. **程序性记忆**：技能是"如何做"的流程性知识，而不是"是什么"的事实性知识
3. **安全审查**：所有 Agent 创建的技能都经过安全扫描
4. **渐进式更新**：支持创建、编辑、补丁（patch）、删除等多种操作
5. **后台审查**：使用独立的 review agent 进行后台技能审查，不阻塞主流程

### 7.2 设计哲学

- **渐进式披露**：先显示元数据，按需加载完整内容
- **原子操作**：所有文件写入都是原子的，防止损坏
- **安全优先**：所有技能都经过安全扫描
- **非阻塞审查**：使用后台线程进行审查，不阻塞主流程
- **灵活更新**：支持多种更新方式（patch/edit/create）

### 7.3 与 pi-coding-agent 的集成要点

1. **技能管理工具**：实现 create、edit、patch、delete、write_file、remove_file
2. **技能列表工具**：实现 skills_list()，仅返回元数据
3. **技能审查工具**：实现后台审查线程
4. **迭代计数器**：跟踪迭代次数，触发审查
5. **工具注册**：注册 skill_manage 和 skills_list 工具

---

## 八、参考资料

### 官方文档
- [Skills System](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills.md)
- [Working with Skills](https://hermes-agent.nousresearch.com/docs/guides/work-with-skills.md)
- [Build a Hermes Plugin](https://hermes-agent.nousresearch.com/docs/guides/build-a-hermes-plugin.md)

### 源码
- [skill_manager_tool.py](file:///Users/saga/code-repos/PI-Coding-Agent-OpenClaw-study/hermes-agent-source-code/tools/skill_manager_tool.py)
- [skills_tool.py](file:///Users/saga/code-repos/PI-Coding-Agent-OpenClaw-study/hermes-agent-source-code/tools/skills_tool.py)
- [skill_utils.py](file:///Users/saga/code-repos/PI-Coding-Agent-OpenClaw-study/hermes-agent-source-code/agent/skill_utils.py)
- [run_agent.py](file:///Users/saga/code-repos/PI-Coding-Agent-OpenClaw-study/hermes-agent-source-code/run_agent.py) (skill review lines 2268-2376)

---

**文档完成日期**: 2026-04-16  
**作者**: AI Assistant
