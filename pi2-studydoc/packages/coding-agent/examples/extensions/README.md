# Extension 示例

pi-coding-agent 的示例 extension。

## 用法

```bash
# Load an extension with --extension flag
pi --extension examples/extensions/permission-gate.ts

# Or copy to extensions directory for auto-discovery
cp permission-gate.ts ~/.pi/agent/extensions/
```

## 示例

### 生命周期与安全

| Extension | 描述 |
|-----------|-------------|
| `permission-gate.ts` | 在危险的 bash 命令（rm -rf、sudo 等）执行前提示确认 |
| `project-trust.ts` | 演示针对用户级/全局与 CLI extension 的 `project_trust` 事件 |
| `protected-paths.ts` | 阻止对受保护路径（.env、.git/、node_modules/）的写入 |
| `confirm-destructive.ts` | 在破坏性 Session 操作（clear、switch、fork）前进行确认 |
| `dirty-repo-guard.ts` | 在存在未提交 git 变更时阻止 Session 变更 |
| `sandbox/` | 使用 `@anthropic-ai/sandbox-runtime` 的 OS 级沙箱，支持按项目配置 |
| `gondolin/` | 将内置 tool 与 `!` 命令路由到 Gondolin micro-VM |

### 自定义 Tool

| Extension | 描述 |
|-----------|-------------|
| `todo.ts` | Todo 列表 tool + `/todos` 命令，带自定义渲染与状态持久化 |
| `hello.ts` | 最小自定义 tool 示例 |
| `question.ts` | 演示使用 `ctx.ui.select()` 通过自定义 UI 向用户提问 |
| `questionnaire.ts` | 多问题输入，问题之间通过标签栏导航 |
| `tool-override.ts` | 覆盖内置 tool（例如为 `read` 添加日志/访问控制） |
| `dynamic-tools.ts` | 在启动后（`session_start`）以及运行时通过命令注册 tool，带提示词片段与 tool 专属提示词指南 |
| `kimi-deferred-tools.ts` | 为 Kimi 的 deferred-tool 加载协议搜索并渐进式激活 tool |
| `structured-output.ts` | 最终结构化输出 tool，返回 `terminate: true`，使 agent 能以该 tool 调用结束 |
| `built-in-tool-renderer.ts` | 为内置 tool（read、bash、edit、write）提供自定义紧凑渲染，同时保留原有行为 |
| `minimal-mode.ts` | 覆盖内置 tool 渲染以实现极简显示（仅 tool 调用，折叠模式下无输出） |
| `truncated-tool.ts` | 包装 ripgrep，提供正确的输出截断（50KB/2000 行） |
| `ssh.ts` | 通过 SSH 使用可插拔 Operation 将所有 tool 委派到远程机器 |
| `subagent/` | 将任务委派给具有隔离 Context 窗口的专用 subagent |

### 命令与 UI

| Extension | 描述 |
|-----------|-------------|
| `preset.ts` | 通过 `--preset` 标志与 `/preset` 命令，为模型、thinking level、tool 与指令提供命名预设 |
| `plan-mode/` | Claude Code 风格的 plan 模式，通过 `/plan` 命令与步骤跟踪进行只读探索 |
| `tools.ts` | 交互式 `/tools` 命令，可启用/禁用 tool，并具备 Session 持久化 |
| `handoff.ts` | 通过 `/handoff <goal>` 将 Context 转移到新的聚焦 Session |
| `qna.ts` | 通过 `ctx.ui.setEditorText()` 从上次响应中提取问题到编辑器 |
| `status-line.ts` | 通过 `ctx.ui.setStatus()` 在页脚显示轮次进度，使用主题化颜色 |
| `github-issue-autocomplete.ts` | 通过叠加自定义自动补全 provider 添加 `#1234` issue 补全，该 provider 会从 `gh issue list` 预加载未关闭的 issue |
| `widget-placement.ts` | 通过 `ctx.ui.setWidget()` 的放置参数在编辑器上方和下方显示 widget |
| `hidden-thinking-label.ts` | 通过 `ctx.ui.setHiddenThinkingLabel()` 自定义折叠的 thinking 标签 |
| `working-indicator.ts` | 通过 `ctx.ui.setWorkingIndicator()` 自定义流式工作指示器 |
| `model-status.ts` | 通过 `model_select` Hook 在状态栏显示模型变更 |
| `snake.ts` | 贪吃蛇游戏，带自定义 UI、键盘处理与 Session 持久化 |
| `tic-tac-toe.ts` | 与 agent 对战的井字棋，使用 `executionMode: "sequential"` 的 tool 来防止共享光标状态上的竞态条件 |
| `send-user-message.ts` | 演示使用 `pi.sendUserMessage()` 从 extension 发送用户消息 |
| `timed-confirm.ts` | 演示使用 AbortSignal 自动关闭 `ctx.ui.confirm()` 与 `ctx.ui.select()` 对话框 |
| `rpc-demo.ts` | 演练所有 RPC 支持的 extension UI 方法；与 [`examples/rpc-extension-ui.ts`](../rpc-extension-ui.ts) 配合使用 |
| `modal-editor.ts` | 通过 `ctx.ui.setEditorComponent()` 实现类 vim 的自定义模态编辑器 |
| `rainbow-editor.ts` | 通过自定义编辑器实现动画彩虹文字效果 |
| `notify.ts` | agent 完成时通过 OSC 777 发送桌面通知（Ghostty、iTerm2、WezTerm） |
| `titlebar-spinner.ts` | agent 工作时在终端标题中显示盲文 spinner 动画 |
| `summarize.ts` | 使用 GPT-5.2 总结对话并在临时 UI 中显示 |
| `custom-footer.ts` | 通过 `ctx.ui.setFooter()` 实现带 git 分支与 token 统计的自定义页脚 |
| `custom-header.ts` | 通过 `ctx.ui.setHeader()` 实现自定义页眉 |
| `overlay-test.ts` | 测试覆盖层合成，包含内联文本输入与边界情况 |
| `overlay-qa-tests.ts` | 全面的覆盖层 QA 测试：锚点、边距、堆叠、溢出、动画 |
| `doom-overlay/` | DOOM 游戏以覆盖层形式运行，35 FPS（演示实时游戏渲染） |
| `shutdown-command.ts` | 添加 `/quit` 命令，演示 `ctx.shutdown()` |
| `reload-runtime.ts` | 添加 `/reload-runtime` 与 `reload_runtime` tool，展示安全重载流程 |
| `interactive-shell.ts` | 通过 `user_bash` Hook 以完整终端运行交互式命令（vim、htop） |
| `inline-bash.ts` | 通过 `input` 事件转换展开提示词中的 `!{command}` 模式 |
| `input-transform-streaming.ts` | 通过 `streamingBehavior` 为流中途转向跳过昂贵的输入预处理 |

### Git 集成

| Extension | 描述 |
|-----------|-------------|
| `git-checkpoint.ts` | 在每个轮次创建 git stash 检查点，以便在 Fork 时恢复代码 |
| `auto-commit-on-exit.ts` | 退出时自动提交，使用最后一条 assistant 消息作为提交信息 |

### 系统提示词与 Compaction

| Extension | 描述 |
|-----------|-------------|
| `pirate.ts` | 演示使用 `systemPromptAppend` 动态修改系统提示词 |
| `claude-rules.ts` | 扫描 `.claude/rules/` 文件夹并在系统提示词中列出规则 |
| `custom-compaction.ts` | 自定义 Compaction，总结整个对话 |
| `trigger-compact.ts` | 当 Context 使用量超过 100k token 时触发 Compaction，并添加 `/trigger-compact` 命令 |

### 系统集成

| Extension | 描述 |
|-----------|-------------|
| `mac-system-theme.ts` | 将 pi theme 与 macOS 深色/浅色模式同步 |

### 资源

| Extension | 描述 |
|-----------|-------------|
| `dynamic-resources/` | 使用 `resources_discover` 加载 skill、提示词与 theme |

### 消息与通信

| Extension | 描述 |
|-----------|-------------|
| `message-renderer.ts` | 通过 `registerMessageRenderer` 实现带颜色与可展开详情的自定义消息渲染 |
| `entry-renderer.ts` | 通过 `appendEntry` 与 `registerEntryRenderer` 实现仅 TUI 的 Session 条目渲染 |
| `event-bus.ts` | 通过 `pi.events` 进行 extension 间通信 |

### Session 元数据

| Extension | 描述 |
|-----------|-------------|
| `session-name.ts` | 通过 `setSessionName` 为 Session 选择器命名 Session |
| `bookmark.ts` | 通过 `setLabel` 为 `/tree` 导航标记带标签的条目 |

### 自定义 Provider

| Extension | 描述 |
|-----------|-------------|
| `custom-provider-anthropic/` | 自定义 Anthropic provider，支持 OAuth 与自定义流式传输实现 |
| `custom-provider-gitlab-duo/` | GitLab Duo provider，通过代理使用 pi-ai 内置的 Anthropic/OpenAI 流式传输 |

### 外部依赖

| Extension | 描述 |
|-----------|-------------|
| `with-deps/` | 带有自己 package.json 与依赖的 extension（演示 jiti 模块解析） |
| `file-trigger.ts` | 监视触发文件并将内容注入对话 |

## 编写 Extension

完整文档见 [docs/extensions.md](../../docs/extensions.md)。

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  // Subscribe to lifecycle events
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
      const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
      if (!ok) return { block: true, reason: "Blocked by user" };
    }
  });

  // Register custom tools
  pi.registerTool({
    name: "greet",
    label: "Greeting",
    description: "Generate a greeting",
    parameters: Type.Object({
      name: Type.String({ description: "Name to greet" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return {
        content: [{ type: "text", text: `Hello, ${params.name}!` }],
        details: {},
      };
    },
  });

  // Register commands
  pi.registerCommand("hello", {
    description: "Say hello",
    handler: async (args, ctx) => {
      ctx.ui.notify("Hello!", "info");
    },
  });
}
```

## 关键模式

**对字符串参数使用 StringEnum**（Google API 兼容性所需）：
```typescript
import { StringEnum } from "@earendil-works/pi-ai";

// Good
action: StringEnum(["list", "add"] as const)

// Bad - doesn't work with Google
action: Type.Union([Type.Literal("list"), Type.Literal("add")])
```

**通过 details 实现状态持久化：**
```typescript
// Store state in tool result details for proper forking support
return {
  content: [{ type: "text", text: "Done" }],
  details: { todos: [...todos], nextId },  // Persisted in session
};

// Reconstruct on session events
pi.on("session_start", async (_event, ctx) => {
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.toolName === "my_tool") {
      const details = entry.message.details;
      // Reconstruct state from details
    }
  }
});
```
