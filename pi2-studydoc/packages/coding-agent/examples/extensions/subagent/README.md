# Subagent 示例

将任务委派给具有隔离 Context 窗口的专用 subagent。

## 特性

- **隔离 Context**：每个 subagent 在独立的 `pi` 进程中运行
- **流式输出**：实时查看 tool 调用与进度
- **并行流式传输**：所有并行任务同时流式传输更新
- **Markdown 渲染**：最终输出以正确格式渲染（展开视图）
- **用量跟踪**：显示每个 agent 的轮次、token、成本与 Context 用量
- **中止支持**：Ctrl+C 会传播以终止 subagent 进程

## 结构

```
subagent/
├── README.md            # 本文件
├── index.ts             # extension（入口点）
├── agents.ts            # Agent 发现逻辑
├── agents/              # 示例 agent 定义
│   ├── scout.md         # 快速侦察，返回压缩后的 Context
│   ├── planner.md       # 创建实现计划
│   ├── reviewer.md      # 代码审查
│   └── worker.md        # 通用（完整能力）
└── prompts/             # 工作流预设（提示词模板）
    ├── implement.md     # scout -> planner -> worker
    ├── scout-and-plan.md    # scout -> planner（无实现）
    └── implement-and-review.md  # worker -> reviewer -> worker
```

## 安装

在仓库根目录下，为这些文件创建符号链接：

```bash
# Symlink the extension (must be in a subdirectory with index.ts)
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/index.ts" ~/.pi/agent/extensions/subagent/index.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/agents.ts" ~/.pi/agent/extensions/subagent/agents.ts

# Symlink agents
mkdir -p ~/.pi/agent/agents
for f in packages/coding-agent/examples/extensions/subagent/agents/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/agents/$(basename "$f")
done

# Symlink workflow prompts
mkdir -p ~/.pi/agent/prompts
for f in packages/coding-agent/examples/extensions/subagent/prompts/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/prompts/$(basename "$f")
done
```

## 安全模型

此 tool 会执行一个独立的 `pi` 子进程，并使用委派的系统提示词与 tool/模型配置。

**项目本地 agent**（`.pi/agents/*.md`）是由仓库控制的提示词，可以指示模型读取文件、运行 bash 命令等。

**默认行为：**仅从 `~/.pi/agent/agents` 加载**用户级 agent**。

要启用项目本地 agent，请传入 `agentScope: "both"`（或 `"project"`）。仅对您信任的仓库执行此操作。

在交互式运行时，该 tool 会在不受信任的项目中运行项目本地 agent 之前提示确认。受信任的项目会跳过额外的提示。设置 `confirmProjectAgents: false` 可禁用确认。

## 用法

### 单个 agent
```
Use scout to find all authentication code
```

### 并行执行
```
Run 2 scouts in parallel: one to find models, one to find providers
```

### 链式工作流
```
Use a chain: first have scout find the read tool, then have planner suggest improvements
```

### 工作流提示词
```
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Tool 模式

| 模式 | 参数 | 描述 |
|------|-----------|-------------|
| Single | `{ agent, task }` | 一个 agent，一个任务 |
| Parallel | `{ tasks: [...] }` | 多个 agent 并发运行（最多 8 个，4 个并发） |
| Chain | `{ chain: [...] }` | 顺序执行，使用 `{previous}` 占位符 |

## 输出显示

**折叠视图**（默认）：
- 状态图标（✓/✗/⏳）与 agent 名称
- 最后 5-10 项（tool 调用与文本）
- 用量统计：`3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**展开视图**（Ctrl+O）：
- 完整任务文本
- 所有 tool 调用及其格式化参数
- 最终输出以 Markdown 渲染
- 每任务用量（用于 chain/parallel）

**并行模式流式传输**：
- 显示所有任务及其实时状态（⏳ 运行中，✓ 完成，✗ 失败）
- 随每个任务取得进展而更新
- 显示 "2/3 done, 1 running" 状态
- 将每个已完成任务的最终输出返回给父模型，每个任务上限为 50 KB
- 当子进程在产生输出前退出时，从 stderr/错误消息返回失败诊断

**Tool 调用格式化**（模仿内置 tool）：
- bash 使用 `$ command`
- read 使用 `read ~/path:1-10`
- grep 使用 `grep /pattern/ in ~/path`
- 等等。

## Agent 定义

Agent 是带 YAML frontmatter 的 markdown 文件：

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: claude-haiku-4-5
---

System prompt for the agent goes here.
```

当省略 `model` 时，subagent 会继承发起调度的 Session 的活动模型与 thinking level。

**位置：**
- `~/.pi/agent/agents/*.md` - 用户级（始终加载）
- `.pi/agents/*.md` - 项目级（仅在 `agentScope: "project"` 或 `"both"` 时）

当 `agentScope: "both"` 时，项目 agent 会覆盖同名的用户 agent。

## 示例 Agent

| Agent | 用途 | Model | Tools |
|-------|---------|-------|-------|
| `scout` | 快速代码库侦察 | Haiku | read, grep, find, ls, bash |
| `planner` | 实现计划 | Sonnet | read, grep, find, ls |
| `reviewer` | 代码审查 | Sonnet | read, grep, find, ls, bash |
| `worker` | 通用 | Sonnet | （全部默认） |

## 工作流提示词

| 提示词 | 流程 |
|--------|------|
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |

## 错误处理

- **退出码 != 0**：tool 返回带 stderr/输出的错误
- **stopReason "error"**：LLM 错误随错误消息传播
- **stopReason "aborted"**：用户中止（Ctrl+C）终止子进程并抛出错误
- **Chain 模式**：在第一个失败的步骤停止，并报告哪个步骤失败

## 限制

- 折叠视图中输出截断为最后 10 项（展开以查看全部）
- 并行模式下模型可见的输出每个任务上限为 50 KB；完整结果保留在 tool details 中
- 每次调用时重新发现 agent（允许在 Session 中途编辑）
- 并行模式限制为 8 个任务，4 个并发
