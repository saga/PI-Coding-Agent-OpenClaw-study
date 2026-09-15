> pi 可以创建 skill。让它为你的用例构建一个。

# Skills

Skill 是自包含的能力包，agent 会按需加载它们。一个 skill 为特定任务提供专门的工作流、设置说明、辅助脚本和参考文档。

Pi 实现了 [Agent Skills standard](https://agentskills.io/specification)，对大多数违规行为发出警告，但保持宽松。即使该标准不允许，Pi 也允许 skill 名称与其父目录不同；对于跨多个 agent harness 使用的共享 skill 目录来说，该规则并非最优。

## 目录

- [位置](#locations)
- [Skill 如何工作](#how-skills-work)
- [Skill 命令](#skill-commands)
- [Skill 结构](#skill-structure)
- [Frontmatter](#frontmatter)
- [验证](#validation)
- [示例](#example)
- [Skill 仓库](#skill-repositories)

## 位置

> **安全性：** Skill 可以指示模型执行任何操作，并且可能包含模型调用的可执行代码。使用前请审查 skill 内容。

Pi 从以下位置加载 skill：

- 全局：
  - `~/.pi/agent/skills/`
  - `~/.agents/skills/`
- 项目（仅在项目被信任之后）：
  - `.pi/skills/`
  - `cwd` 和祖先目录中的 `.agents/skills/`（直到 git 仓库根目录，不在仓库中时为文件系统根目录）
- Packages：`skills/` 目录或 `package.json` 中的 `pi.skills` 条目
- Settings：包含文件或目录的 `skills` 数组
- CLI：`--skill <path>`（可重复，即使与 `--no-skills` 一起使用也是增量的）

发现规则：
- 在 `~/.pi/agent/skills/` 和 `.pi/skills/` 中，直接位于根目录的 `.md` 文件在具有有效的 skill frontmatter 且 `description` 非空时，会被发现为单个 skill
- 在所有 skill 位置中，包含 `SKILL.md` 的目录会被递归发现
- 在 `~/.agents/skills/` 和项目 `.agents/skills/` 中，根目录的 `.md` 文件会被忽略，但分组文件夹中嵌套的 `.md` 文件在声明了 skill frontmatter 时会被发现
- 除 `SKILL.md` 之外、看起来不像 skill 的根 Markdown 文件会被静默忽略

使用 `--no-skills` 禁用发现（显式的 `--skill` 路径仍会加载）。

### 使用来自其他 Harness 的 Skill

要使用来自 Claude Code 或 OpenAI Codex 的 skill，请将其目录添加到 settings：

```json
{
  "skills": [
    "~/.claude/skills",
    "~/.codex/skills"
  ]
}
```

对于项目级的 Claude Code skill，请添加到 `.pi/settings.json`：

```json
{
  "skills": ["../.claude/skills"]
}
```

## Skill 如何工作

1. 启动时，pi 扫描 skill 位置并提取名称和 description
2. 系统 prompt 按 [specification](https://agentskills.io/integrate-skills) 以 XML 格式包含可用的 skill
3. 当任务匹配时，agent 使用 `read`，或在 `read` 不可用时使用 `bash`，来加载完整的 SKILL.md（模型并不总是这样做；使用 prompting 或 `/skill:name` 来强制它）
4. agent 遵循指令，使用相对路径引用脚本和资源

这就是 progressive disclosure：只有 description 始终位于 context 中，完整指令按需加载。

## Skill 命令

Skill 会注册为 `/skill:name` 命令：

```bash
/skill:brave-search           # Load and execute the skill
/skill:pdf-tools extract      # Load skill with arguments
```

命令之后的参数会以 `User: <args>` 的形式追加到 skill 内容中。

在交互模式下通过 `/settings` 或直接在 `settings.json` 中切换 skill 命令：

```json
{
  "enableSkillCommands": true
}
```

## Skill 结构

一个 skill 是一个包含 `SKILL.md` 文件的目录。其他一切都是自由形式的。

```
my-skill/
├── SKILL.md              # Required: frontmatter + instructions
├── scripts/              # Helper scripts
│   └── process.sh
├── references/           # Detailed docs loaded on-demand
│   └── api-reference.md
└── assets/
    └── template.json
```

### SKILL.md 格式

````markdown
---
name: my-skill
description: What this skill does and when to use it. Be specific.
---

# My Skill

## Setup

Run once before first use:
```bash
cd /path/to/skill && npm install
```

## Usage

```bash
./scripts/process.sh <input>
```
````

使用相对于 skill 目录的相对路径：

```markdown
See [the reference guide](references/REFERENCE.md) for details.
```

## Frontmatter

根据 [Agent Skills specification](https://agentskills.io/specification#frontmatter-required)：

| 字段 | 必需 | 描述 |
|-------|----------|-------------|
| `name` | 是 | 最多 64 个字符。小写 a-z、0-9、连字符。与该标准不同，Pi 不要求它与父目录匹配，因为该标准要求对于共享 skill 目录来说并非最优。 |
| `description` | 是 | 最多 1024 个字符。这个 skill 做什么以及何时使用它。 |
| `license` | 否 | 许可证名称或对捆绑文件的引用。 |
| `compatibility` | 否 | 最多 500 个字符。环境要求。 |
| `metadata` | 否 | 任意的键值映射。 |
| `allowed-tools` | 否 | 以空格分隔的预先批准的 tool 列表（实验性）。 |
| `disable-model-invocation` | 否 | 当为 `true` 时，skill 会从系统 prompt 中隐藏。用户必须使用 `/skill:name`。 |

### 名称规则

- 1-64 个字符
- 仅限小写字母、数字、连字符
- 没有开头/结尾的连字符
- 没有连续的连字符
Pi 不要求名称与父目录匹配。Agent Skills 标准要求如此，但对于被多个 tool 使用的共享 skill 目录来说，该要求并非最优。

有效：`pdf-processing`、`data-analysis`、`code-review`
无效：`PDF-Processing`、`-pdf`、`pdf--processing`

### Description 最佳实践

description 决定 agent 何时加载 skill。要具体。

好：
```yaml
description: Extracts text and tables from PDF files, fills PDF forms, and merges multiple PDFs. Use when working with PDF documents.
```

差：
```yaml
description: Helps with PDFs.
```

## 验证

Pi 根据 Agent Skills 标准验证 skill。大多数问题会产生警告，但仍会加载该 skill：

- 名称超过 64 个字符或包含无效字符
- 名称以连字符开头/结尾或包含连续的连字符
- Description 超过 1024 个字符

未知的 frontmatter 字段会被忽略。

声明了但缺少 description 的 skill 不会被加载。格式错误的 `SKILL.md` 文件以及没有 description 的 `SKILL.md` 文件会产生警告，并且不会被加载。其他没有有效 skill frontmatter 的 Markdown 文件会被忽略。

名称冲突（来自不同位置的相同名称）会发出警告，并保留最先找到的 skill。

## 示例

```
brave-search/
├── SKILL.md
├── search.js
└── content.js
```

**SKILL.md：**
````markdown
---
name: brave-search
description: Web search and content extraction via Brave Search API. Use for searching documentation, facts, or any web content.
---

# Brave Search

## Setup

```bash
cd /path/to/brave-search && npm install
```

## Search

```bash
./search.js "query"              # Basic search
./search.js "query" --content    # Include page content
```

## Extract Page Content

```bash
./content.js https://example.com
```
````

## Skill 仓库

- [Anthropic Skills](https://github.com/anthropics/skills) - 文档处理（docx、pdf、pptx、xlsx）、web 开发
- [Pi Skills](https://github.com/badlogic/pi-skills) - Web 搜索、浏览器自动化、Google API、转录
