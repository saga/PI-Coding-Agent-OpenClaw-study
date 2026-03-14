# 在 pi-coding-agent 中使用 financial-services-plugins Skills 的研究文档

**日期：** 2026-03-14  
**研究对象：** [badlogic/pi-mono](https://github.com/badlogic/pi-mono) — `@mariozechner/pi-coding-agent`  
**目标：** 分析如何将 anthropics/financial-services-plugins 的 skills 用于 pi-coding-agent

---

## 一、pi-coding-agent 的 Skill 机制

### 1.1 什么是 pi-coding-agent

pi 是一个极简的终端编码 agent CLI，核心设计哲学是"适配你的工作流，而不是反过来"。它实现了 **[Agent Skills 开放标准](https://agentskills.io/specification)**，这是一个跨 agent 平台的通用 skill 规范，支持 Claude Code、Cursor、GitHub Copilot、Gemini CLI 等 20+ 平台。

### 1.2 Skill 的工作原理

1. 启动时，pi 扫描所有 skill 目录，提取每个 skill 的 `name` 和 `description`
2. 将可用 skill 列表以 XML 格式注入系统 prompt（仅描述，不含全文）
3. 当任务匹配时，agent 用 `read` 工具加载完整的 SKILL.md 内容
4. 按照 skill 中的步骤执行

这是**渐进式上下文披露**：描述始终在上下文中，完整指令按需加载。

### 1.3 Skill 加载路径

pi 按以下优先级扫描 skill：

| 路径 | 范围 |
|---|---|
| `~/.pi/agent/skills/` | 全局（所有项目） |
| `~/.agents/skills/` | 全局（兼容其他 agent） |
| `.pi/skills/` | 项目级 |
| `.agents/skills/`（从 cwd 向上到 git root） | 项目级 |
| npm/git 包中的 `skills/` 目录 | 通过 `pi install` 安装 |

### 1.4 SKILL.md 格式规范（Agent Skills 标准）

```markdown
---
name: skill-name          # 必填，1-64字符，小写字母/数字/连字符，须与目录名一致
description: 描述...      # 必填，最多1024字符，决定agent何时自动加载此skill
license: MIT              # 可选
compatibility: ...        # 可选，环境要求
---

# Skill 标题

## 步骤...
```

**触发方式：**
- 自动：agent 根据 description 判断是否加载
- 手动：用户输入 `/skill:name` 强制加载

---

## 二、兼容性分析

### 2.1 格式兼容性：几乎完全兼容

这套 financial-services-plugins 的 SKILL.md 文件**完全符合 Agent Skills 标准**，因为 Claude Code 本身也实现了同一标准。

对比关键字段：

| 字段 | financial-services-plugins | Agent Skills 标准 | 兼容？ |
|---|---|---|---|
| `name` | ✅ 有，小写+连字符 | 必填 | ✅ |
| `description` | ✅ 有，含触发关键词 | 必填，≤1024字符 | ⚠️ 部分超长（见下） |
| 目录名与name一致 | ✅ 一致 | 必须一致 | ✅ |
| 正文结构 | Markdown 步骤 | 自由格式 Markdown | ✅ |

**唯一潜在问题：description 长度**

部分 skill 的 description 超过 1024 字符限制，例如 `comps-analysis` 的 description 包含大量使用场景说明。pi 会发出警告但仍会加载，不影响使用，但建议截短。

### 2.2 MCP 依赖：需要替代方案

原 plugin 依赖 `.mcp.json` 中配置的 11 个外部 MCP 服务器（Daloopa、FactSet、S&P Global 等）。

**pi 的立场：** pi 官方明确表示**不内置 MCP 支持**（"No MCP. Build CLI tools with READMEs, or build an extension that adds MCP support."）。

**影响评估：**

| Skill | MCP 依赖程度 | 无 MCP 时的降级行为 |
|---|---|---|
| `dcf-model` | 中（优先用 MCP，可降级） | 使用 web search + SEC filings |
| `comps-analysis` | 高（明确要求 MCP 优先） | 降级到 web search，数据质量下降 |
| `3-statement-model` | 低（主要是 Excel 操作） | 几乎不受影响 |
| `audit-xls` | 无 | 完全不受影响 |
| `clean-data-xls` | 无 | 完全不受影响 |
| `ib-check-deck` | 无 | 完全不受影响 |
| `deck-refresh` | 无 | 完全不受影响 |
| `lbo-model` | 低 | 基本不受影响 |
| `ai-readiness` | 高（依赖数据室/SharePoint） | 需要用户手动提供文件 |

**解决方案：**
- 方案 A：安装 MCP extension（社区有第三方实现）
- 方案 B：接受降级行为，skills 中的 MCP 引用会被 agent 忽略，转而使用 web search
- 方案 C：修改 skill 中的数据源优先级描述，去掉 MCP 相关指引

### 2.3 Commands 文件：不适用

`commands/*.md` 是 Claude Plugin 特有的命令入口机制，pi 没有对应概念。但这不是问题——pi 用户直接在对话中描述需求，或用 `/skill:name` 手动触发，效果等同。

### 2.4 Python 脚本依赖

`ib-check-deck` skill 依赖 `scripts/extract_numbers.py`。pi 的 agent 可以直接用 `bash` 工具执行该脚本，**完全兼容**，前提是 Python 环境可用。

---

## 三、所需修改

### 3.1 零修改方案（直接使用）

最简单的方式：将 skill 目录直接放入 pi 的扫描路径。

**步骤：**

```bash
# 方式一：全局安装（所有项目可用）
cp -r financial-analysis/skills/* ~/.pi/agent/skills/
cp -r private-equity/skills/* ~/.pi/agent/skills/
cp -r equity-research/skills/* ~/.pi/agent/skills/

# 方式二：项目级安装（仅当前项目可用）
mkdir -p .pi/skills
cp -r financial-analysis/skills/* .pi/skills/
```

然后启动 pi，直接对话即可：
```
pi
> 帮我对 AAPL 做一个 DCF 估值
```

pi 会根据 description 自动识别并加载 `dcf-model` skill。

**这个方案无需修改任何 SKILL.md 文件。**

### 3.2 推荐修改：截短超长 description

部分 skill 的 description 超过 1024 字符，pi 会警告。建议截短，保留核心触发关键词：

**示例（comps-analysis 原 description 约 600 字符，在限制内，但其他 skill 可能超出）：**

```yaml
# 修改前（过长示例）
description: Build institutional-grade comparable company analyses with operating metrics, valuation multiples, and statistical benchmarking in Excel/spreadsheet format. Perfect for: Public company valuation (M&A, investment analysis), Benchmarking performance vs. industry peers, Pricing IPOs or funding rounds...（超过1024字符）

# 修改后（截短至关键信息）
description: Build comparable company analyses with operating metrics, valuation multiples, and statistical benchmarking in Excel. Use for public company valuation, M&A analysis, IPO pricing, or benchmarking peers. Triggers on "comps", "comparable companies", "peer analysis", "trading multiples".
```

### 3.3 可选修改：去掉 MCP 强依赖描述

如果不打算配置 MCP，可以修改 `comps-analysis` 和 `dcf-model` 中的数据源优先级说明，避免 agent 反复尝试调用不存在的 MCP 工具：

**comps-analysis/SKILL.md 中找到：**
```markdown
## ⚠️ CRITICAL: Data Source Priority (READ FIRST)
1. **FIRST: Check for MCP data sources** - If S&P Kensho MCP, FactSet MCP, or Daloopa MCP are available...
2. **DO NOT use web search** if the above MCP data sources are available
```

**修改为：**
```markdown
## Data Source Priority
1. **User-provided data** - Files, spreadsheets, or data pasted directly
2. **Web search** - SEC EDGAR filings, company IR pages, financial news
3. **MCP data sources** - If configured (S&P Kensho, FactSet, Daloopa), use them for higher accuracy
```

### 3.4 可选：打包为 pi package

如果想方便分发和版本管理，可以将这些 skills 打包为 pi package：

**在仓库根目录的 `package.json` 中添加：**
```json
{
  "name": "financial-services-pi-skills",
  "version": "1.0.0",
  "keywords": ["pi-package"],
  "pi": {
    "skills": [
      "./financial-analysis/skills",
      "./equity-research/skills",
      "./private-equity/skills",
      "./investment-banking/skills",
      "./wealth-management/skills"
    ]
  }
}
```

然后任何人可以通过以下方式安装：
```bash
pi install git:github.com/saga/financial-services-plugins
```

---

## 四、实际使用示例

安装后，在 pi 中的使用方式：

```bash
# 自动触发（agent 根据描述判断）
> 帮我建一个 AAPL 的 DCF 模型

# 手动触发
> /skill:dcf-model AAPL

# 组合使用（dcf.md command 的等效表达）
> 先做 AAPL 的可比公司分析，再用结果校准 DCF 的终值假设

# 审计 Excel
> /skill:audit-xls 帮我检查这个模型.xlsx

# 清洗数据
> /skill:clean-data-xls 这个表格数据很乱，帮我清理一下
```

---

## 五、总结

| 维度 | 结论 |
|---|---|
| 格式兼容性 | ✅ 完全兼容，SKILL.md 无需改动即可使用 |
| MCP 依赖 | ⚠️ pi 不内置 MCP，数据密集型 skill 会降级到 web search |
| Python 脚本 | ✅ pi 的 bash 工具可直接执行 |
| 安装复杂度 | ✅ 极低，复制目录即可 |
| 推荐修改 | 截短超长 description；可选去掉 MCP 强依赖描述 |

**最小操作：** 将 `financial-analysis/skills/` 下的目录复制到 `~/.pi/agent/skills/`，启动 pi，直接使用。
