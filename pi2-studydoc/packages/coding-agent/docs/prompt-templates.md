> pi 可以创建 prompt template。让它为你的工作流构建一个。

# Prompt Templates

Prompt template 是展开为完整 prompt 的 Markdown 片段。在编辑器中输入 `/name` 来调用模板，其中 `name` 是不带 `.md` 的文件名。

## 位置

Pi 从以下位置加载 prompt template：

- 全局：`~/.pi/agent/prompts/*.md`
- 项目：`.pi/prompts/*.md`（仅在项目被信任之后）
- Packages：`prompts/` 目录或 `package.json` 中的 `pi.prompts` 条目
- Settings：包含文件或目录的 `prompts` 数组
- CLI：`--prompt-template <path>`（可重复）

使用 `--no-prompt-templates` 禁用发现。

## 格式

```markdown
---
description: Review staged git changes
---
Review the staged changes (`git diff --cached`). Focus on:
- Bugs and logic errors
- Security issues
- Error handling gaps
```

- 文件名会成为命令名。`review.md` 变成 `/review`。
- `description` 是可选的。如果缺失，则使用第一个非空行。
- `argument-hint` 是可选的。设置后，该提示会显示在自动补全下拉列表中 description 之前。

### 参数提示

在 frontmatter 中使用 `argument-hint` 在自动补全中显示预期的参数。使用 `<angle brackets>` 表示必需参数，使用 `[square brackets]` 表示可选参数：

```markdown
---
description: Review PRs from URLs with structured issue and code analysis
argument-hint: "<PR-URL>"
---
```

它在自动补全下拉列表中呈现为：

```
→ pr   <PR-URL>       — Review PRs from URLs with structured issue and code analysis
  is   <issue>        — Analyze GitHub issues (bugs or feature requests)
  wr   [instructions] — Finish the current task end-to-end
  cl   — Audit changelog entries before release
```

## 用法

在编辑器中输入 `/`，后跟模板名称。自动补全会显示可用模板及其 description。

```
/review                           # Expands review.md
/component Button                 # Expands with argument
/component Button "click handler" # Multiple arguments
```

## 参数

模板支持位置参数、默认值和简单的切片：

- `$1`、`$2`、... 位置参数
- `$@` 或 `$ARGUMENTS` 表示所有参数拼接
- `${1:-default}` 在参数 1 存在/非空时使用它，否则使用 `default`
- `${@:-default}` 或 `${ARGUMENTS:-default}` 在参数存在/非空时使用所有参数，否则使用 `default`
- `${@:N}` 表示从第 N 个位置开始的参数（从 1 开始索引）
- `${@:N:L}` 表示从 N 开始的 `L` 个参数

示例：

```markdown
---
description: Create a component
---
Create a React component named $1 with features: $@
```

默认值对于可选参数很有用：

```markdown
Summarize the current state in ${1:-7} bullet points.
```

用法：`/component Button "onClick handler" "disabled support"`

## 加载规则

- 在 `prompts/` 中的模板发现是非递归的。
- 如果你想要子目录中的模板，请通过 `prompts` 设置或 package manifest 显式添加它们。
