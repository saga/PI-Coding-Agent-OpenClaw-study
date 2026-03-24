# OpenClaw 插件系统与 pi-coding-agent 关系研究

## 概述

本文档研究 OpenClaw 最新代码中插件系统的架构，以及与 pi-coding-agent 的依赖关系。

**核心结论**：OpenClaw **仍然依赖** pi-coding-agent，但在此基础上构建了**独立的插件系统**。两者是互补关系，而非替代关系。

## 依赖关系分析

### package.json 中的依赖

```json
{
  "@mariozechner/pi-agent-core": "0.61.1",
  "@mariozechner/pi-ai": "0.61.1",
  "@mariozechner/pi-coding-agent": "0.61.1",
  "@mariozechner/pi-tui": "0.61.1"
}
```

| 包名 | 用途 |
|------|------|
| `pi-ai` | 核心 LLM 抽象：`Model`, `streamSimple`, 消息类型, provider APIs |
| `pi-agent-core` | Agent 循环, 工具执行, `AgentMessage` 类型 |
| `pi-coding-agent` | 高级 SDK：`createAgentSession`, `SessionManager`, `AuthStorage`, `ModelRegistry` |
| `pi-tui` | 终端 UI 组件（用于 OpenClaw 的本地 TUI 模式） |

### pi-coding-agent 的使用方式

OpenClaw 采用**嵌入式集成**方式，而非子进程或 RPC：

```typescript
import { createAgentSession, SessionManager } from "@mariozechner/pi-coding-agent";

const { session } = await createAgentSession({
  cwd: resolvedWorkspace,
  agentDir,
  authStorage: params.authStorage,
  modelRegistry: params.modelRegistry,
  model: params.model,
  tools: builtInTools,
  customTools: allCustomTools,
  sessionManager,
  settingsManager,
  resourceLoader,
});
```

## OpenClaw 插件系统架构

### 目录结构

```
src/
├── plugins/                    # 插件系统核心
│   ├── types.ts               # 类型定义
│   ├── manifest.ts            # 插件清单解析
│   ├── registry.ts            # 插件注册表
│   ├── runtime.ts             # 运行时状态管理
│   ├── loader.ts              # 插件加载器
│   ├── install.ts             # 插件安装
│   ├── hooks.ts               # Hook 系统
│   ├── tools.ts               # 工具注册
│   ├── services.ts            # 服务注册
│   ├── commands.ts            # 命令注册
│   ├── http-registry.ts       # HTTP 路由注册
│   └── runtime/               # 运行时实现
│       ├── runtime-agent.ts
│       ├── runtime-channel.ts
│       ├── runtime-tools.ts
│       └── ...
├── plugin-sdk/                 # 插件开发 SDK
│   ├── core.ts                # 核心 API 导出
│   ├── plugin-entry.ts        # 插件入口定义
│   ├── channel-config-helpers.ts
│   ├── channel-pairing.ts
│   └── ...
└── agents/
    └── pi-embedded-runner/     # pi 集成层
        ├── run.ts
        ├── session-manager-init.ts
        ├── system-prompt.ts
        └── ...
```

### 插件清单格式

插件通过 `openclaw.plugin.json` 定义：

```typescript
type PluginManifest = {
  id: string;
  configSchema: Record<string, unknown>;
  enabledByDefault?: boolean;
  kind?: PluginKind;  // "memory" | "context-engine"
  channels?: string[];
  providers?: string[];
  providerAuthEnvVars?: Record<string, string[]>;
  providerAuthChoices?: PluginManifestProviderAuthChoice[];
  skills?: string[];
  name?: string;
  description?: string;
  version?: string;
  uiHints?: Record<string, PluginConfigUiHint>;
};
```

### 插件类型

OpenClaw 支持多种插件类型：

| 类型 | 说明 |
|------|------|
| **Channel Plugin** | 消息渠道插件（Discord, Telegram, Slack, WhatsApp 等） |
| **Provider Plugin** | AI 模型提供商插件（Anthropic, OpenAI, Google 等） |
| **Tool Plugin** | Agent 工具插件 |
| **Hook Plugin** | 生命周期钩子插件 |
| **Service Plugin** | 后台服务插件 |
| **Command Plugin** | CLI 命令插件 |
| **HTTP Route Plugin** | HTTP 路由插件 |
| **Web Search Plugin** | 网页搜索提供商插件 |
| **Speech Plugin** | TTS/STT 语音插件 |
| **Image Generation Plugin** | 图像生成插件 |

### 插件注册 API

```typescript
type OpenClawPluginApi = {
  // 工具注册
  registerTool(factory: OpenClawPluginToolFactory, options?: OpenClawPluginToolOptions): void;
  
  // Hook 注册
  registerHook(name: PluginHookName, handler: PluginHookHandler, options?: OpenClawPluginHookOptions): void;
  
  // 服务注册
  registerService(service: OpenClawPluginService): void;
  
  // 命令注册
  registerCommand(command: OpenClawPluginCommandDefinition): void;
  
  // HTTP 路由注册
  registerHttpRoute(route: OpenClawPluginHttpRouteParams): void;
  
  // Channel 注册
  registerChannel(channel: OpenClawPluginChannelRegistration): void;
  
  // Provider 注册
  registerProvider(provider: ProviderPlugin): void;
};
```

## 官方插件示例

### Discord 插件

```typescript
// extensions/discord/index.ts
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { discordPlugin } from "./src/channel.js";

export default defineChannelPluginEntry({
  id: "discord",
  name: "Discord",
  description: "Discord channel plugin",
  plugin: discordPlugin,
  setRuntime: setDiscordRuntime,
  registerFull: registerDiscordSubagentHooks,
});
```

### 插件目录结构

```
extensions/
├── discord/           # Discord 渠道插件
├── telegram/          # Telegram 渠道插件
├── slack/             # Slack 渠道插件
├── whatsapp/          # WhatsApp 渠道插件
├── anthropic/         # Anthropic 提供商插件
├── openai/            # OpenAI 提供商插件
├── brave/             # Brave 搜索插件
├── elevenlabs/        # ElevenLabs 语音插件
├── deepseek/          # DeepSeek 提供商插件
├── feishu/            # 飞书渠道插件
├── matrix/            # Matrix 渠道插件
└── ...
```

## pi-coding-agent 与 OpenClaw 插件系统的关系

### 职责划分

| 层级 | 职责 | 技术 |
|------|------|------|
| **pi-coding-agent** | AI Agent 核心：会话管理、工具执行、LLM 交互 | pi SDK |
| **OpenClaw Plugin System** | 扩展机制：渠道、提供商、工具、钩子 | 自研 |
| **OpenClaw Gateway** | 消息网关：多渠道路由、认证、安全 | 自研 |

### 集成方式

```
┌─────────────────────────────────────────────────────────────┐
│                     OpenClaw Gateway                         │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                  Plugin System                           │ │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │ │
│  │  │ Discord  │ │ Telegram │ │  Slack   │ │WhatsApp  │   │ │
│  │  │  Plugin  │ │  Plugin  │ │  Plugin  │ │  Plugin  │   │ │
│  │  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘   │ │
│  │       │            │            │            │          │ │
│  │       └────────────┴────────────┴────────────┘          │ │
│  │                         │                                │ │
│  │                    Plugin API                            │ │
│  └─────────────────────────┬───────────────────────────────┘ │
│                            │                                 │
│  ┌─────────────────────────▼───────────────────────────────┐ │
│  │              pi-embedded-runner                          │ │
│  │  ┌─────────────────────────────────────────────────────┐│ │
│  │  │            pi-coding-agent SDK                       ││ │
│  │  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐   ││ │
│  │  │  │SessionManager│ │ ModelRegistry│ │ AuthStorage │   ││ │
│  │  │  └─────────────┘ └─────────────┘ └─────────────┘   ││ │
│  │  │                    createAgentSession()             ││ │
│  │  └─────────────────────────────────────────────────────┘│ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### 数据流

1. **消息接收**：渠道插件接收消息 → Plugin System → Gateway
2. **Agent 处理**：Gateway → pi-embedded-runner → pi-coding-agent → LLM
3. **响应发送**：pi-coding-agent → pi-embedded-runner → Plugin System → 渠道插件

## 关键差异对比

| 方面 | pi-coding-agent | OpenClaw 插件系统 |
|------|-----------------|-------------------|
| **定位** | AI Agent 核心 SDK | 扩展机制 + 消息网关 |
| **工具管理** | 内置 coding tools | 自定义工具 + 策略过滤 |
| **会话存储** | `~/.pi/agent/sessions/` | `~/.openclaw/agents/<id>/sessions/` |
| **认证** | 单一凭证 | 多 Profile 轮换 + 故障转移 |
| **系统提示** | AGENTS.md + prompts | 动态按渠道/上下文构建 |
| **事件处理** | TUI 渲染 | 回调式（onBlockReply 等） |

## OpenClaw 对 pi 的扩展

### 1. 自定义工具

```typescript
// OpenClaw 替换了 pi 的默认工具
export function splitSdkTools(options: { tools: AnyAgentTool[]; sandboxEnabled: boolean }) {
  return {
    builtInTools: [], // 空。完全覆盖
    customTools: toToolDefinitions(options.tools),
  };
}
```

### 2. 自定义扩展

```typescript
// Compaction Safeguard 扩展
if (resolveCompactionMode(params.cfg) === "safeguard") {
  setCompactionSafeguardRuntime(params.sessionManager, { maxHistoryShare });
  paths.push(resolvePiExtensionPath("compaction-safeguard"));
}

// Context Pruning 扩展
if (cfg?.agents?.defaults?.contextPruning?.mode === "cache-ttl") {
  setContextPruningRuntime(params.sessionManager, { ... });
  paths.push(resolvePiExtensionPath("context-pruning"));
}
```

### 3. 自定义系统提示

```typescript
const systemPromptOverride = createSystemPromptOverride(appendPrompt);
applySystemPromptOverrideToSession(session, systemPromptOverride);
```

## OpenClaw 实现细节

### Hook 系统

OpenClaw 插件系统通过 Hook 机制在各个生命周期阶段注入自定义逻辑。

#### 支持的 Hook 类型

```typescript
type PluginHookName =
  // Agent 生命周期
  | "before_model_resolve"    // 模型解析前
  | "before_prompt_build"     // 提示构建前
  | "before_agent_start"      // Agent 启动前（兼容旧版）
  | "llm_input"               // LLM 输入时
  | "llm_output"              // LLM 输出时
  | "agent_end"               // Agent 结束时
  
  // 会话管理
  | "before_compaction"       // 压缩前
  | "after_compaction"        // 压缩后
  | "before_reset"            // 重置前
  | "session_start"           // 会话开始
  | "session_end"             // 会话结束
  
  // 消息处理
  | "inbound_claim"           // 入站消息认领
  | "message_received"        // 消息接收
  | "message_sending"         // 消息发送前
  | "message_sent"            // 消息发送后
  
  // 工具调用
  | "before_tool_call"        // 工具调用前
  | "after_tool_call"         // 工具调用后
  | "tool_result_persist"     // 工具结果持久化
  | "before_message_write"    // 消息写入前
  
  // 子代理
  | "subagent_spawning"       // 子代理创建中
  | "subagent_delivery_target"// 子代理投递目标
  | "subagent_spawned"        // 子代理已创建
  | "subagent_ended"          // 子代理结束
  
  // Gateway
  | "gateway_start"           // Gateway 启动
  | "gateway_stop";           // Gateway 停止
```

#### Hook 事件详情

##### 1. Agent 生命周期 Hook

**before_model_resolve** - 模型解析前
```typescript
type PluginHookBeforeModelResolveEvent = {
  prompt: string;  // 用户提示
};

type PluginHookBeforeModelResolveResult = {
  modelOverride?: string;    // 覆盖模型
  providerOverride?: string; // 覆盖提供商
};
```

**before_prompt_build** - 提示构建前
```typescript
type PluginHookBeforePromptBuildEvent = {
  prompt: string;
  messages: unknown[];  // 会话消息
};

type PluginHookBeforePromptBuildResult = {
  systemPrompt?: string;        // 完全替换系统提示
  prependContext?: string;      // 前置上下文
  prependSystemContext?: string; // 前置系统上下文（可缓存）
  appendSystemContext?: string;  // 后置系统上下文（可缓存）
};
```

**llm_input / llm_output** - LLM 输入输出监控
```typescript
type PluginHookLlmInputEvent = {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  historyMessages: unknown[];
  imagesCount: number;
};

type PluginHookLlmOutputEvent = {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  assistantTexts: string[];
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
};
```

##### 2. 消息处理 Hook

**inbound_claim** - 入站消息认领
```typescript
type PluginHookInboundClaimEvent = {
  content: string;           // 消息内容
  body?: string;             // 消息体
  bodyForAgent?: string;     // 给 Agent 的内容
  transcript?: string;       // 转录文本
  timestamp?: number;
  channel: string;           // 渠道 ID
  accountId?: string;
  conversationId?: string;
  parentConversationId?: string;
  senderId?: string;
  senderName?: string;
  senderUsername?: string;
  threadId?: string | number;
  messageId?: string;
  isGroup: boolean;
  commandAuthorized?: boolean;
  wasMentioned?: boolean;
  metadata?: Record<string, unknown>;
};

type PluginHookInboundClaimResult = {
  handled: boolean;  // true 表示已处理，不再传递
};
```

**message_sending** - 消息发送前
```typescript
type PluginHookMessageSendingEvent = {
  to: string;
  content: string;
  metadata?: Record<string, unknown>;
};

type PluginHookMessageSendingResult = {
  content?: string;  // 修改内容
  cancel?: boolean;  // 取消发送
};
```

##### 3. 工具调用 Hook

**before_tool_call** - 工具调用前
```typescript
type PluginHookBeforeToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
};

type PluginHookBeforeToolCallResult = {
  params?: Record<string, unknown>;  // 修改参数
  block?: boolean;                   // 阻止调用
  blockReason?: string;              // 阻止原因
};
```

**after_tool_call** - 工具调用后
```typescript
type PluginHookAfterToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
  result?: unknown;
  error?: string;
  durationMs?: number;
};
```

##### 4. 子代理 Hook

**subagent_spawning** - 子代理创建
```typescript
type PluginHookSubagentSpawningEvent = {
  childSessionKey: string;
  agentId: string;
  label?: string;
  mode: "run" | "session";
  requester?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
  threadRequested: boolean;
};

type PluginHookSubagentSpawningResult =
  | { status: "ok"; threadBindingReady?: boolean; }
  | { status: "error"; error: string; };
```

### Hook 执行机制

```typescript
// Hook 运行器核心逻辑
function getHooksForName<K extends PluginHookName>(
  registry: PluginRegistry,
  hookName: K,
): PluginHookRegistration<K>[] {
  return (registry.typedHooks as PluginHookRegistration<K>[])
    .filter((h) => h.hookName === hookName)
    .toSorted((a, b) => (b.priority ?? 0) - (a.priority ?? 0)); // 按优先级排序
}
```

Hook 按优先级执行，高优先级先执行。每个 Hook 可以：
- 修改事件数据
- 返回结果影响后续流程
- 阻止操作（如 `block: true`）

### 消息流转

```
用户消息
    │
    ▼
┌─────────────────┐
│ inbound_claim   │ ← 渠道插件认领消息
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ message_received│ ← 记录/处理消息
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│before_model_resolve│ ← 决定使用哪个模型
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│before_prompt_build│ ← 构建系统提示
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│before_agent_start│ ← Agent 启动前最后检查
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   llm_input     │ ← 发送到 LLM
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   llm_output    │ ← 接收 LLM 响应
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ message_sending │ ← 发送响应前
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  message_sent   │ ← 响应已发送
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   agent_end     │ ← Agent 运行结束
└─────────────────┘
```

### 插件注册示例

```typescript
// 注册 Hook
api.registerHook("before_tool_call", async (event, ctx) => {
  // 检查敏感工具调用
  if (event.toolName === "bash" && event.params.command?.includes("rm")) {
    return {
      block: true,
      blockReason: "Dangerous command blocked"
    };
  }
  return;
});

// 注册工具
api.registerTool((ctx) => ({
  name: "my_custom_tool",
  description: "A custom tool",
  parameters: { ... },
  execute: async (toolCallId, params, signal, onUpdate) => {
    // 工具实现
    return result;
  }
}));

// 注册服务
api.registerService({
  id: "my-service",
  start: async () => { ... },
  stop: async () => { ... },
});
```

### 渠道插件实现

渠道插件需要实现以下接口：

```typescript
type ChannelPlugin = {
  id: string;
  name: string;
  
  // 消息发送
  send?: (params: SendParams) => Promise<SendResult>;
  
  // 消息接收处理
  onMessage?: (message: InboundMessage) => Promise<void>;
  
  // 配置适配器
  configAdapter?: ConfigAdapter;
  
  // 安全策略
  securityAdapter?: SecurityAdapter;
  
  // 配对机制
  pairingAdapter?: PairingAdapter;
  
  // 状态查询
  statusAdapter?: StatusAdapter;
  
  // 目录服务
  directoryAdapter?: DirectoryAdapter;
};
```

### Provider 插件实现

Provider 插件支持以下功能：

```typescript
type ProviderPlugin = {
  id: string;
  name: string;
  
  // 模型目录
  catalog?: ProviderPluginCatalog;
  
  // 认证方法
  authMethods?: ProviderAuthMethod[];
  
  // 运行时准备
  prepareRuntimeAuth?: (ctx) => Promise<ProviderPreparedRuntimeAuth>;
  
  // 动态模型解析
  resolveDynamicModel?: (ctx) => Model | null;
  
  // 流包装
  wrapStreamFn?: (ctx) => StreamFn;
  
  // 缓存 TTL 判断
  cacheTtlEligibility?: (ctx) => boolean | undefined;
  
  // 思考策略
  thinkingPolicy?: (ctx) => ThinkingPolicy;
};
```

## 总结

1. **pi-coding-agent 仍是核心依赖**：OpenClaw 使用 pi SDK 的 `createAgentSession()` 作为 AI Agent 的核心引擎

2. **OpenClaw 构建了独立插件系统**：用于扩展渠道、提供商、工具、钩子等，与 pi 的工具系统是互补关系

3. **嵌入式集成模式**：OpenClaw 直接导入 pi SDK，而非子进程或 RPC，获得完全控制权

4. **扩展点**：
   - 工具：完全替换 pi 的 coding tools
   - 系统提示：动态构建
   - 扩展：加载自定义 pi 扩展
   - 会话管理：包装 SessionManager 增加安全检查

5. **插件系统价值**：
   - 统一的扩展机制
   - 支持第三方插件
   - 渠道/提供商解耦
   - 热插拔能力

## 参考文件

- `docs/pi.md` - Pi 集成架构文档
- `src/plugins/types.ts` - 插件类型定义
- `src/plugins/registry.ts` - 插件注册表
- `src/plugin-sdk/core.ts` - 插件 SDK 核心
- `extensions/` - 官方插件目录
