# Hermes Agent — Skills 自我学习系统 研究报告

## 1. 概述

Hermes Agent 的 Skills 自我学习系统是一个完整的技能生命周期管理体系，使 Agent 能够**自动发现、创建、编辑、同步、检索和复用**可操作的过程性知识（procedural knowledge）。

核心理念：
- **Skills 是 Agent 的过程性记忆**：与通用记忆（MEMORY.md、USER.md）的声明式、宽泛不同，Skills 是**窄范围、可执行**的操作指南。
- **渐进式披露（Progressive Disclosure）**：先展示元数据（名称+描述），按需加载完整内容，最小化 token 消耗。
- **单一事实源**：所有 Skills 统一存放在 `~/.hermes/skills/`，Agent 编辑、Hub 安装、内置 Skills 共存。

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                     Skills 自我学习系统                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │ 技能发现与检索│  │ 技能创建与编辑│  │ 技能安全扫描与审核   │   │
│  │ skills_tool  │  │skill_manager │  │   skills_guard       │   │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘   │
│         │                 │                      │               │
│  ┌──────▼─────────────────▼──────────────────────▼───────────┐   │
│  │              ~/.hermes/skills/  (单一事实源)               │   │
│  │  ├── my-skill/                                            │   │
│  │  │   ├── SKILL.md          ← 主指令文件                   │   │
│  │  │   ├── references/       ← 参考文档                     │   │
│  │  │   ├── templates/        ← 输出模板                     │   │
│  │  │   ├── scripts/          ← 辅助脚本                     │   │
│  │  │   └── assets/           ← 资源文件                     │   │
│  │  └── category/                                            │   │
│  │      └── another-skill/                                   │   │
│  └───────────────────────────────────────────────────────────┘   │
│         │                                                         │
│  ┌──────▼───────────────────────────────────────────────────┐     │
│  │              技能同步与 Hub 集成                           │     │
│  │  ┌─────────────┐  ┌─────────────┐  ┌──────────────────┐  │     │
│  │  │skills_sync  │  │skills_hub   │  │skill_commands    │  │     │
│  │  │(内置同步)   │  │(远程源适配) │  │(斜杠命令注册)    │  │     │
│  │  └─────────────┘  └─────────────┘  └──────────────────┘  │     │
│  └───────────────────────────────────────────────────────────┘     │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────┐     │
│  │              技能工具与辅助                                 │     │
│  │  ┌─────────────┐  ┌─────────────┐  ┌──────────────────┐  │     │
│  │  │skill_utils  │  │skill_index  │  │skill_config      │  │     │
│  │  │(元数据解析) │  │(索引与检索) │  │(配置变量注入)    │  │     │
│  │  └─────────────┘  └─────────────┘  └──────────────────┘  │     │
│  └───────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. 核心模块详解

### 3.1 技能发现与检索（`skills_tool.py`）

#### 3.1.1 渐进式披露架构

```
Tier 1: skills_list()     → 仅返回 name + description（最小 token）
Tier 2: skill_view(name)  → 加载完整 SKILL.md 内容
Tier 3: skill_view(name, file_path) → 按需加载参考文件/模板
```

#### 3.1.2 技能扫描流程

```python
def _find_all_skills(*, skip_disabled: bool = False) -> List[Dict[str, Any]]:
    """递归扫描 ~/.hermes/skills/ 和外部目录"""
    # 1. 加载被禁用的技能集合（一次性加载，非逐个检查）
    disabled = set() if skip_disabled else _get_disabled_skill_names()
    
    # 2. 按优先级扫描：本地目录 → 外部目录（本地优先）
    dirs_to_scan = []
    if SKILLS_DIR.exists():
        dirs_to_scan.append(SKILLS_DIR)
    dirs_to_scan.extend(get_external_skills_dirs())
    
    # 3. 遍历所有 SKILL.md 文件
    for scan_dir in dirs_to_scan:
        for skill_md in scan_dir.rglob("SKILL.md"):
            # 跳过排除目录
            if any(part in _EXCLUDED_SKILL_DIRS for part in skill_md.parts):
                continue
            
            # 解析 frontmatter
            content = skill_md.read_text(encoding="utf-8")[:4000]
            frontmatter, body = _parse_frontmatter(content)
            
            # 平台兼容性检查
            if not skill_matches_platform(frontmatter):
                continue
            
            # 去重 + 禁用过滤
            name = frontmatter.get("name", skill_dir.name)[:MAX_NAME_LENGTH]
            if name in seen_names or name in disabled:
                continue
            
            # 提取描述（优先 frontmatter，否则从正文提取）
            description = frontmatter.get("description", "")
            if not description:
                for line in body.strip().split("\n"):
                    line = line.strip()
                    if line and not line.startswith("#"):
                        description = line
                        break
            
            skills.append({
                "name": name,
                "description": description,
                "category": _get_category_from_path(skill_md),
            })
```

#### 3.1.3 SKILL.md 格式标准（兼容 agentskills.io）

```yaml
---
name: skill-name                    # 必填，最大 64 字符
description: Brief description      # 必填，最大 1024 字符
version: 1.0.0                      # 可选
license: MIT                        # 可选（agentskills.io 标准）
platforms: [macos]                  # 可选 — 限制操作系统
                                    #   有效值: macos, linux, windows
                                    #   省略 = 所有平台（默认）
prerequisites:                      # 可选 — 传统运行时要求
  env_vars: [API_KEY]               #   环境变量名
  commands: [curl, jq]              #   命令检查（仅建议性）
required_environment_variables:     # 可选 — 现代环境变量声明
  - name: OPENAI_API_KEY
    prompt: "Enter your OpenAI API key"
    help: "https://platform.openai.com/api-keys"
    required_for: "Chat completions"
setup:                              # 可选 — 设置指导
  help: "Get your API key from..."
  collect_secrets:                  # 可选 — 密钥收集
    - env_var: API_KEY
      prompt: "Enter API key"
      secret: true
      provider_url: "https://..."
compatibility: Requires X           # 可选（agentskills.io）
metadata:                           # 可选，任意键值对
  hermes:
    tags: [fine-tuning, llm]
    related_skills: [peft, lora]
    config:                         # 可选 — 配置变量声明
      - key: wiki.path
        description: Wiki 知识库路径
        default: "~/wiki"
        prompt: "Wiki 目录路径"
    fallback_for_toolsets: [...]    # 可选 — 工具集回退
    requires_tools: [...]           # 可选 — 工具依赖
---

# 技能标题

完整的操作指南、流程、示例...
```

### 3.2 技能创建与编辑（`skill_manager_tool.py`）

#### 3.2.1 核心操作

| 操作 | 说明 |
|------|------|
| `create` | 创建新技能（SKILL.md + 目录结构） |
| `edit` | 替换现有技能的 SKILL.md（完全重写） |
| `patch` | 在 SKILL.md 或支持文件中进行精确查找替换 |
| `delete` | 完全删除用户技能 |
| `write_file` | 添加/覆盖支持文件（参考、模板、脚本、资源） |
| `remove_file` | 从用户技能中删除支持文件 |

#### 3.2.2 创建技能流程

```python
def _create_skill(name: str, content: str, category: str = None) -> Dict[str, Any]:
    """创建新的用户技能"""
    # 1. 验证名称（正则：^[a-z0-9][a-z0-9._-]*$）
    err = _validate_name(name)
    if err:
        return {"success": False, "error": err}
    
    # 2. 验证分类
    err = _validate_category(category)
    if err:
        return {"success": False, "error": err}
    
    # 3. 验证 frontmatter（必须有 name、description）
    err = _validate_frontmatter(content)
    if err:
        return {"success": False, "error": err}
    
    # 4. 验证内容大小（限制 100,000 字符 ≈ 36k tokens）
    err = _validate_content_size(content)
    if err:
        return {"success": False, "error": err}
    
    # 5. 检查名称冲突（跨所有目录）
    existing = _find_skill(name)
    if existing:
        return {"success": False, "error": f"Skill '{name}' already exists"}
    
    # 6. 创建目录
    skill_dir = _resolve_skill_dir(name, category)
    skill_dir.mkdir(parents=True, exist_ok=True)
    
    # 7. 原子写入 SKILL.md
    skill_md = skill_dir / "SKILL.md"
    _atomic_write_text(skill_md, content)
    
    # 8. 安全扫描 — 如果被阻止则回滚
    scan_error = _security_scan_skill(skill_dir)
    if scan_error:
        shutil.rmtree(skill_dir, ignore_errors=True)
        return {"success": False, "error": scan_error}
    
    return {"success": True, "message": f"Skill '{name}' created."}
```

#### 3.2.3 原子写入机制

```python
def _atomic_write_text(file_path: Path, content: str, encoding: str = "utf-8") -> None:
    """原子写入文本内容到文件"""
    file_path.parent.mkdir(parents=True, exist_ok=True)
    # 在同目录创建临时文件
    fd, temp_path = tempfile.mkstemp(
        dir=str(file_path.parent),
        prefix=f".{file_path.name}.tmp.",
        suffix="",
    )
    try:
        with os.fdopen(fd, "w", encoding=encoding) as f:
            f.write(content)
        # 原子替换 — 保证目标文件永远不会处于部分写入状态
        os.replace(temp_path, file_path)
    except Exception:
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise
```

#### 3.2.4 模糊匹配补丁（Fuzzy Patch）

```python
def _patch_skill(name: str, old_string: str, new_string: str, ...):
    """在技能文件中进行精确查找替换"""
    # 使用与文件补丁工具相同的模糊匹配引擎
    # 处理：空白规范化、缩进差异、转义序列、块锚匹配
    from tools.fuzzy_match import fuzzy_find_and_replace
    
    new_content, match_count, _strategy, match_error = fuzzy_find_and_replace(
        content, old_string, new_string, replace_all
    )
    
    # 如果修改 SKILL.md，验证 frontmatter 仍然完整
    if not file_path:
        err = _validate_frontmatter(new_content)
        if err:
            return {"success": False, "error": f"Patch would break SKILL.md: {err}"}
    
    # 安全扫描 — 被阻止则回滚
    scan_error = _security_scan_skill(skill_dir)
    if scan_error:
        _atomic_write_text(target, original_content)  # 回滚
        return {"success": False, "error": scan_error}
```

### 3.3 技能安全扫描（`skills_guard.py`）

#### 3.3.1 信任级别体系

| 信任级别 | 来源 | 安全策略 |
|----------|------|----------|
| `builtin` | 随 Hermes 内置 | 始终允许，不扫描 |
| `trusted` | openai/skills、anthropics/skills | 允许 caution 级别 |
| `community` | 其他所有来源 | 任何发现 = 阻止（除非 --force） |
| `agent-created` | Agent 自行创建 | dangerous = 询问用户 |

```python
INSTALL_POLICY = {
    #              safe      caution    dangerous
    "builtin":    ("allow",  "allow",   "allow"),
    "trusted":    ("allow",  "allow",   "block"),
    "community":  ("allow",  "block",   "block"),
    "agent-created": ("allow", "allow", "ask"),
}
```

#### 3.3.2 威胁模式检测

```python
THREAT_PATTERNS = [
    # ── 数据泄露：泄露密钥的 shell 命令 ──
    (r'curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD)',
     "env_exfil_curl", "critical", "exfiltration", "curl 命令插值密钥环境变量"),
    
    # ── 数据泄露：读取凭证存储 ──
    (r'\$HOME/\.ssh|\~/\.ssh', "ssh_dir_access", "high", "exfiltration", "引用用户 SSH 目录"),
    (r'\$HOME/\.aws|\~/\.aws', "aws_dir_access", "high", "exfiltration", "引用 AWS 凭证目录"),
    (r'cat\s+[^\n]*(\.env|credentials|\.netrc)', "read_secrets_file", "critical", "exfiltration", "读取已知密钥文件"),
    
    # ── 提示注入 ──
    (r'ignore\s+(?:\w+\s+)*(previous|all|above|prior)\s+instructions',
     "prompt_injection_ignore", "critical", "injection", "提示注入：忽略先前指令"),
    (r'you\s+are\s+(?:\w+\s+)*now\s+', "role_hijack", "high", "injection", "尝试覆盖 Agent 角色"),
    (r'do\s+not\s+(?:\w+\s+)*tell\s+(?:\w+\s+)*the\s+user',
     "deception_hide", "critical", "injection", "指示 Agent 向用户隐藏信息"),
    
    # ── 破坏性操作 ──
    (r'rm\s+-rf\s+/', "destructive_root_rm", "critical", "destructive", "从根目录递归删除"),
    
    # ── 持久化 ──
    (r'crontab\s+-[a]', "cron_persistence", "high", "persistence", "添加 cron 任务"),
    
    # ── 网络 ──
    (r'nc\s+-[el]', "netcat_listener", "high", "network", "启动 netcat 监听器"),
    
    # ── 混淆 ──
    (r'eval\s*\(\s*base64', "eval_base64", "critical", "obfuscation", "base64 解码后执行"),
]
```

### 3.4 技能同步系统（`skills_sync.py`）

#### 3.4.1 Manifest 机制

Manifest 文件格式（v2）：每行 `skill_name:origin_hash`

```
axolotl:a1b2c3d4e5f6...
peft:f6e5d4c3b2a1...
lora:1234567890ab...
```

#### 3.4.2 同步逻辑

```python
def sync_skills(quiet: bool = False) -> dict:
    """使用 manifest 同步内置技能到 ~/.hermes/skills/"""
    # 1. 发现所有内置技能
    bundled_skills = _discover_bundled_skills(bundled_dir)
    manifest = _read_manifest()
    
    for skill_name, skill_src in bundled_skills:
        bundled_hash = _dir_hash(skill_src)  # 计算内置技能哈希
        
        if skill_name not in manifest:
            # ── 新技能 ──
            if dest.exists():
                skipped += 1  # 用户已有同名技能，不覆盖
                manifest[skill_name] = bundled_hash
            else:
                shutil.copytree(skill_src, dest)
                copied.append(skill_name)
                manifest[skill_name] = bundled_hash
        
        elif dest.exists():
            # ── 已存在技能 ──
            origin_hash = manifest.get(skill_name, "")
            user_hash = _dir_hash(dest)
            
            if user_hash != origin_hash:
                # 用户修改了技能 → 不覆盖
                user_modified.append(skill_name)
                continue
            
            if bundled_hash != origin_hash:
                # 内置版本更新 → 安全更新
                backup = dest.with_suffix(".bak")
                shutil.move(str(dest), str(backup))
                try:
                    shutil.copytree(skill_src, dest)
                    manifest[skill_name] = bundled_hash
                    updated.append(skill_name)
                except:
                    shutil.move(str(backup), str(dest))  # 失败回滚
        
        else:
            # ── 用户已删除 ──
            skipped += 1  # 尊重用户选择，不重新添加
    
    # 清理已移除的内置技能
    cleaned = sorted(set(manifest.keys()) - bundled_names)
    for name in cleaned:
        del manifest[name]
    
    _write_manifest(manifest)  # 原子写入 manifest
```

### 3.5 技能 Hub 集成（`skills_hub.py`）

#### 3.5.1 源适配器接口

```python
class SkillSource(ABC):
    """所有技能注册表适配器的抽象基类"""
    
    @abstractmethod
    def search(self, query: str, limit: int = 10) -> List[SkillMeta]:
        """搜索匹配查询字符串的技能"""
    
    @abstractmethod
    def fetch(self, identifier: str) -> Optional[SkillBundle]:
        """通过标识符下载技能包"""
    
    @abstractmethod
    def inspect(self, identifier: str) -> Optional[SkillMeta]:
        """获取技能元数据（不下载所有文件）"""
    
    @abstractmethod
    def source_id(self) -> str:
        """唯一源标识符（如 'github', 'clawhub'）"""
    
    def trust_level_for(self, identifier: str) -> str:
        """确定技能的信任级别"""
        return "community"
```

#### 3.5.2 GitHub 源适配器

```python
class GitHubSource(SkillSource):
    """通过 GitHub Contents API 获取技能"""
    
    DEFAULT_TAPS = [
        {"repo": "openai/skills", "path": "skills/"},
        {"repo": "anthropics/skills", "path": "skills/"},
        {"repo": "VoltAgent/awesome-agent-skills", "path": "skills/"},
        {"repo": "garrytan/gstack", "path": ""},
    ]
    
    def search(self, query: str, limit: int = 10) -> List[SkillMeta]:
        """在所有 taps 中搜索匹配的技能"""
        results = []
        query_lower = query.lower()
        
        for tap in self.taps:
            skills = self._list_skills_in_repo(tap["repo"], tap.get("path", ""))
            for skill in skills:
                searchable = f"{skill.name} {skill.description} {' '.join(skill.tags)}".lower()
                if query_lower in searchable:
                    results.append(skill)
        
        # 按名称去重，优先高信任级别
        _trust_rank = {"builtin": 2, "trusted": 1, "community": 0}
        seen = {}
        for r in results:
            if r.name not in seen:
                seen[r.name] = r
            elif _trust_rank.get(r.trust_level, 0) > _trust_rank.get(seen[r.name].trust_level, 0):
                seen[r.name] = r
        
        return list(seen.values())[:limit]
```

#### 3.5.3 技能包下载与隔离

```python
@dataclass
class SkillBundle:
    """下载的技能包，准备进行隔离/扫描/安装"""
    name: str
    files: Dict[str, Union[str, bytes]]   # 相对路径 → 文件内容
    source: str
    identifier: str
    trust_level: str
    metadata: Dict[str, Any] = field(default_factory=dict)

# Hub 目录结构
HUB_DIR = SKILLS_DIR / ".hub"
LOCK_FILE = HUB_DIR / "lock.json"           # 已安装技能的溯源
QUARANTINE_DIR = HUB_DIR / "quarantine"     # 隔离区
AUDIT_LOG = HUB_DIR / "audit.log"           # 审计日志
TAPS_FILE = HUB_DIR / "taps.json"           # 自定义源配置
INDEX_CACHE_DIR = HUB_DIR / "index-cache"   # 远程索引缓存（TTL 1 小时）
```

### 3.6 技能命令注册（`skill_commands.py`）

```python
def scan_skill_commands() -> Dict[str, Dict[str, Any]]:
    """扫描 ~/.hermes/skills/ 并返回 /command → 技能信息映射"""
    global _skill_commands
    _skill_commands = {}
    
    for scan_dir in dirs_to_scan:
        for skill_md in scan_dir.rglob("SKILL.md"):
            # 跳过排除目录
            if any(part in ('.git', '.github', '.hub') for part in skill_md.parts):
                continue
            
            # 解析 frontmatter
            content = skill_md.read_text(encoding='utf-8')
            frontmatter, body = _parse_frontmatter(content)
            
            # 平台兼容性 + 禁用过滤
            if not skill_matches_platform(frontmatter):
                continue
            if name in disabled:
                continue
            
            # 规范化为连字符分隔的 slug
            cmd_name = name.lower().replace(' ', '-').replace('_', '-')
            cmd_name = _SKILL_INVALID_CHARS.sub('', cmd_name)
            cmd_name = _SKILL_MULTI_HYPHEN.sub('-', cmd_name).strip('-')
            
            _skill_commands[f"/{cmd_name}"] = {
                "name": name,
                "description": description or f"Invoke the {name} skill",
                "skill_md_path": str(skill_md),
                "skill_dir": str(skill_md.parent),
            }
```

### 3.7 技能工具与辅助（`skill_utils.py`）

#### 3.7.1 外部技能目录支持

```python
def get_external_skills_dirs() -> List[Path]:
    """从 config.yaml 读取 skills.external_dirs 并返回验证后的路径"""
    # 每个条目展开（~ 和 ${VAR}）并解析为绝对路径
    # 仅返回实际存在的目录
    # 静默跳过重复项和指向 ~/.hermes/skills/ 的路径
    
    for entry in raw_dirs:
        expanded = os.path.expanduser(os.path.expandvars(entry))
        p = Path(expanded).resolve()
        if p == local_skills or p in seen:
            continue
        if p.is_dir():
            seen.add(p)
            result.append(p)
```

#### 3.7.2 技能配置变量注入

```python
def extract_skill_config_vars(frontmatter: Dict[str, Any]) -> List[Dict[str, Any]]:
    """从解析的 frontmatter 中提取配置变量声明"""
    # 技能声明需要的 config.yaml 设置：
    # metadata:
    #   hermes:
    #     config:
    #       - key: wiki.path
    #         description: LLM Wiki 知识库目录路径
    #         default: "~/wiki"
    #         prompt: Wiki 目录路径
    
    metadata = frontmatter.get("metadata", {})
    hermes = metadata.get("hermes", {})
    raw = hermes.get("config", [])
    
    result = []
    for item in raw:
        key = str(item.get("key", "")).strip()
        desc = str(item.get("description", "")).strip()
        if not key or not desc:
            continue
        entry = {
            "key": key,
            "description": desc,
            "default": item.get("default"),
            "prompt": item.get("prompt", desc),
        }
        result.append(entry)
    return result
```

#### 3.7.3 技能条件激活

```python
def extract_skill_conditions(frontmatter: Dict[str, Any]) -> Dict[str, List]:
    """从 frontmatter 中提取条件激活字段"""
    metadata = frontmatter.get("metadata", {})
    hermes = metadata.get("hermes", {})
    return {
        "fallback_for_toolsets": hermes.get("fallback_for_toolsets", []),
        "requires_toolsets": hermes.get("requires_toolsets", []),
        "fallback_for_tools": hermes.get("fallback_for_tools", []),
        "requires_tools": hermes.get("requires_tools", []),
    }
```

---

## 4. 技能自我学习工作流

### 4.1 从任务中提取技能

```
用户任务完成
     │
     ▼
┌─────────────────────────┐
│ Agent 识别可复用模式     │
│ "这个任务的方法可以复用" │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ Agent 调用 skill_manage  │
│ action='create'          │
│ 生成 SKILL.md 内容       │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ 安全扫描 (skills_guard)  │
│ 检查注入、泄露、破坏     │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ 原子写入 ~/.hermes/      │
│ skills/{name}/SKILL.md   │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ 技能立即可用             │
│ skills_list() 可发现     │
│ /skill-name 可调用       │
└─────────────────────────┘
```

### 4.2 技能迭代更新

```
技能已存在
     │
     ▼
┌─────────────────────────┐
│ Agent 调用 skill_manage  │
│ action='patch'           │
│ 精确查找替换             │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ 模糊匹配引擎             │
│ 处理空白、缩进差异       │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ 验证 frontmatter 完整性  │
│ 验证内容大小限制         │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ 安全扫描 → 失败则回滚    │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ 原子写入更新             │
└─────────────────────────┘
```

### 4.3 技能支持文件管理

```
┌─────────────────────────────────────────┐
│ 允许的子目录                              │
│ references/  ← 参考文档                  │
│ templates/   ← 输出模板                  │
│ scripts/     ← 辅助脚本                  │
│ assets/      ← 资源文件                  │
└─────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────┐
│ skill_manage(            │
│   action='write_file',   │
│   file_path='references/ │
│     api.md',             │
│   file_content='...'     │
│ )                        │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ 路径遍历检查             │
│ 验证在允许的子目录下     │
│ 大小限制（1 MiB/文件）   │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ 安全扫描 → 失败则回滚    │
└─────────────────────────┘
```

---

## 5. 关键技术特性

### 5.1 渐进式披露（Progressive Disclosure）

| 层级 | 方法 | 返回内容 | Token 消耗 |
|------|------|----------|------------|
| Tier 1 | `skills_list()` | name + description + category | 极低 |
| Tier 2 | `skill_view(name)` | 完整 SKILL.md 内容 | 中等 |
| Tier 3 | `skill_view(name, file_path)` | 特定支持文件 | 按需 |

### 5.2 平台兼容性

```python
_PLATFORM_MAP = {
    "macos": "darwin",
    "linux": "linux",
    "windows": "win32",
}

def skill_matches_platform(frontmatter: Dict[str, Any]) -> bool:
    """检查技能是否与当前 OS 平台兼容"""
    platforms = frontmatter.get("platforms")
    if not platforms:
        return True  # 省略 = 所有平台（向后兼容默认值）
    
    current = sys.platform
    for platform in platforms:
        normalized = str(platform).lower().strip()
        mapped = PLATFORM_MAP.get(normalized, normalized)
        if current.startswith(mapped):
            return True
    return False
```

### 5.3 环境变量与密钥管理

```python
def _capture_required_environment_variables(
    skill_name: str,
    missing_entries: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """捕获技能需要的环境变量"""
    # 1. 检查是否已持久化（在 .env 或系统环境中）
    # 2. 如果是 Gateway 表面，返回设置提示
    # 3. 否则调用密钥捕获回调，交互式收集
    # 4. 记录缺失的名称和跳过状态
    
    for entry in missing_entries:
        callback_result = _secret_capture_callback(
            entry["name"],
            entry["prompt"],
            {"skill_name": skill_name, "help": entry.get("help")},
        )
        # 成功则继续，失败则标记为跳过
```

### 5.4 技能索引与缓存

```python
# 远程索引缓存
INDEX_CACHE_TTL = 3600  # 1 小时

def _read_cache(self, cache_key: str) -> Optional[List[Dict]]:
    """读取缓存的远程索引"""
    cache_file = INDEX_CACHE_DIR / f"{cache_key}.json"
    if not cache_file.exists():
        return None
    
    cache_data = json.loads(cache_file.read_text())
    if time.time() - cache_data["timestamp"] > INDEX_CACHE_TTL:
        return None  # 缓存过期
    
    return cache_data["skills"]

def _write_cache(self, cache_key: str, skills: List[Dict]):
    """写入远程索引缓存"""
    cache_file = INDEX_CACHE_DIR / f"{cache_key}.json"
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    cache_data = {
        "timestamp": time.time(),
        "skills": skills,
    }
    cache_file.write_text(json.dumps(cache_data))
```

### 5.5 技能配置注入

```python
def _inject_skill_config(loaded_skill: dict, parts: list) -> None:
    """将技能声明的配置值注入到消息部分"""
    # 1. 解析 SKILL.md 的 frontmatter
    # 2. 提取 metadata.hermes.config 变量
    # 3. 从 config.yaml 解析当前值
    # 4. 注入为 [Skill config: key = value] 块
    
    frontmatter, _ = parse_frontmatter(raw_content)
    config_vars = extract_skill_config_vars(frontmatter)
    resolved = resolve_skill_config_values(config_vars)
    
    lines = ["", f"[Skill config (from {display_hermes_home()}/config.yaml):"]
    for key, value in resolved.items():
        display_val = str(value) if value else "(not set)"
        lines.append(f"  {key} = {display_val}")
    lines.append("]")
    parts.extend(lines)
```

---

## 6. 安全机制总结

| 机制 | 说明 |
|------|------|
| **威胁模式扫描** | 60+ 正则模式检测数据泄露、提示注入、破坏操作、持久化、网络、混淆 |
| **信任级别** | builtin > trusted > community > agent-created，不同级别不同策略 |
| **路径遍历防护** | 禁止 `..` 路径，限制在允许的子目录下 |
| **原子写入** | 临时文件 + os.replace()，保证不部分写入 |
| **回滚机制** | 安全扫描失败时自动回滚到原始内容 |
| **内容大小限制** | SKILL.md ≤ 100,000 字符，支持文件 ≤ 1 MiB |
| **隔离区** | Hub 下载的技能先进入 `.hub/quarantine/` 再扫描安装 |
| **审计日志** | 所有 Hub 操作记录到 `.hub/audit.log` |

---

## 7. 与 pi-coding-agent 的集成建议

### 7.1 最小可行实现

```python
# 1. 定义技能目录结构
SKILLS_DIR = Path.home() / ".pi-coding-agent" / "skills"

# 2. 实现技能扫描
def scan_skills() -> List[Dict]:
    skills = []
    for skill_md in SKILLS_DIR.rglob("SKILL.md"):
        frontmatter, body = parse_frontmatter(skill_md.read_text())
        skills.append({
            "name": frontmatter.get("name", skill_md.parent.name),
            "description": frontmatter.get("description", ""),
            "path": str(skill_md),
        })
    return skills

# 3. 实现技能创建（带安全扫描）
def create_skill(name: str, content: str) -> Dict:
    skill_dir = SKILLS_DIR / name
    skill_dir.mkdir(parents=True, exist_ok=True)
    
    # 原子写入
    skill_md = skill_dir / "SKILL.md"
    _atomic_write(skill_md, content)
    
    # 安全扫描
    if scan_for_threats(skill_dir):
        shutil.rmtree(skill_dir)
        return {"success": False, "error": "Security scan failed"}
    
    return {"success": True, "path": str(skill_dir)}

# 4. 实现渐进式披露
def skills_list():
    return json.dumps({"skills": scan_skills()})

def skill_view(name: str, file_path: str = None):
    skill = find_skill(name)
    if file_path:
        return (skill["path"] / file_path).read_text()
    return skill["path"].read_text()
```

### 7.2 完整实现路线图

| 阶段 | 内容 |
|------|------|
| Phase 1 | 基础技能扫描 + SKILL.md 解析 |
| Phase 2 | 技能创建/编辑/删除 + 原子写入 |
| Phase 3 | 安全扫描（威胁模式检测） |
| Phase 4 | 渐进式披露 + 支持文件管理 |
| Phase 5 | 技能 Hub 集成（GitHub 源适配器） |
| Phase 6 | 技能同步 + Manifest 机制 |
| Phase 7 | 斜杠命令注册 + 配置注入 |
| Phase 8 | 平台兼容性 + 环境变量管理 |

---

## 8. 总结

Hermes Agent 的 Skills 自我学习系统是一个**生产级**的技能生命周期管理框架，核心优势：

1. **渐进式披露**：最小化 token 消耗，按需加载
2. **单一事实源**：所有技能统一管理，避免碎片化
3. **安全优先**：多层扫描 + 信任级别 + 回滚机制
4. **可扩展**：插件化源适配器 + 外部技能目录
5. **原子操作**：保证数据一致性
6. **平台兼容**：跨 OS 支持 + 条件激活
7. **配置注入**：技能声明配置，系统自动解析
8. **同步机制**：Manifest 跟踪 + 用户修改保护

这套系统使 Agent 能够**从经验中学习**，将成功的方法转化为可复用的技能，并在后续任务中自动发现和应用。
