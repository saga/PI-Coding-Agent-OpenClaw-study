# SDK 示例

通过 `createAgentSession()` 与 `createAgentSessionRuntime()` 对 pi-coding-agent 进行编程式使用。

runtime 示例展示了如何构建一个 recreate 函数，它闭包捕获进程全局的固定输入，并在活动 Session 的 cwd 变化时重建绑定到 cwd 的 service 与 Session。

## 示例

| 文件 | 描述 |
|------|-------------|
| `01-minimal.ts` | 使用所有默认值的最简用法 |
| `02-custom-model.ts` | 选择模型与 thinking level |
| `03-custom-prompt.ts` | 替换或修改系统提示词 |
| `04-skills.ts` | 发现、过滤或替换 skill |
| `05-tools.ts` | 内置 tool 允许列表 |
| `06-extensions.ts` | 日志记录、阻止、结果修改 |
| `07-context-files.ts` | AGENTS.md Context 文件 |
| `08-slash-commands.ts` | 基于文件的斜杠命令 |
| `09-api-keys-and-oauth.ts` | API key 解析、OAuth 配置 |
| `10-settings.ts` | 覆盖 Compaction、重试、终端设置 |
| `11-sessions.ts` | 内存中、持久化、继续、列出 Session |
| `12-full-control.ts` | 替换一切，不做发现 |
| `13-session-runtime.ts` | 管理由 runtime 支持的 Session 替换 |

## 运行

```bash
cd packages/coding-agent
npx tsx examples/sdk/01-minimal.ts
```

## 快速参考

```typescript
import { getModel } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();

// Minimal
const { session } = await createAgentSession({ modelRuntime });

// Custom model
const model = getModel("anthropic", "claude-opus-4-5");
const { session } = await createAgentSession({ model, thinkingLevel: "high", modelRuntime });

// Modify prompt
const loader = new DefaultResourceLoader({
  systemPromptOverride: (base) => `${base}\n\nBe concise.`,
});
await loader.reload();
const { session } = await createAgentSession({ resourceLoader: loader, modelRuntime });

// Read-only
const { session } = await createAgentSession({ tools: ["read", "grep", "find", "ls"], modelRuntime });

// In-memory
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  modelRuntime,
});

// Full control
const customRuntime = await ModelRuntime.create({
  authPath: "/my/app/auth.json",
  modelsPath: "/my/app/models.json",
});
await customRuntime.setRuntimeApiKey("anthropic", process.env.MY_KEY!);

const resourceLoader = new DefaultResourceLoader({
  systemPromptOverride: () => "You are helpful.",
  extensionFactories: [myExtension],
  skillsOverride: () => ({ skills: [], diagnostics: [] }),
  agentsFilesOverride: () => ({ agentsFiles: [] }),
  promptsOverride: () => ({ prompts: [], diagnostics: [] }),
});
await resourceLoader.reload();

const { session } = await createAgentSession({
  model,
  modelRuntime: customRuntime,
  resourceLoader,
  tools: ["read", "bash", "my_tool"],
  customTools: [myTool],
  sessionManager: SessionManager.inMemory(),
  settingsManager: SettingsManager.inMemory(),
});

// Run prompts
session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});
await session.prompt("Hello");
```

## 选项

| 选项 | 默认值 | 描述 |
|--------|---------|-------------|
| `modelRuntime` | 使用 `agentDir/auth.json` 与 `models.json` 的 Runtime | 规范模型与认证 runtime |
| `cwd` | `process.cwd()` | 工作目录 |
| `agentDir` | `~/.pi/agent` | 配置目录 |
| `model` | 来自 settings/第一个可用的 | 要使用的模型 |
| `thinkingLevel` | 来自 settings/"off" | off、low、medium、high |
| `tools` | `["read", "bash", "edit", "write"]` 内置 | 跨内置、extension 与自定义 tool 的允许列表 tool 名称 |
| `customTools` | `[]` | 额外的 tool 定义 |
| `resourceLoader` | DefaultResourceLoader | 用于 extension、skill、提示词、theme 与 Context 文件的资源加载器 |
| `sessionManager` | `SessionManager.create(cwd)` | 持久化 |
| `settingsManager` | `SettingsManager.create(cwd, agentDir)` | 设置覆盖 |

## 事件

```typescript
session.subscribe((event) => {
  switch (event.type) {
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
      break;
    case "tool_execution_start":
      console.log(`Tool: ${event.toolName}`);
      break;
    case "tool_execution_end":
      console.log(`Result: ${event.result}`);
      break;
    case "agent_settled":
      console.log("Done");
      break;
  }
});
```
