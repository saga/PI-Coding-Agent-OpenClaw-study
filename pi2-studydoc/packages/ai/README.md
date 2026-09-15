# @earendil-works/pi-ai

统一的 LLM API，具备 provider 集合、自动 auth 解析、token 与 cost 追踪，以及简单的 context 持久化和在 session 中途移交给其他 model 的能力。

**注意**：本库只包含支持 tool calling（function calling）的 model，因为这对 agentic 工作流至关重要。

## 目录

- [支持的 provider](#supported-providers)
- [安装](#installation)
- [快速开始](#quick-start)
- [provider 与 model](#providers-and-models)
  - [provider 工厂](#provider-factories)
  - [全部内置 provider](#all-built-in-providers)
  - [查询 model](#querying-models)
  - [静态目录读取](#static-catalog-reads)
  - [动态 provider](#dynamic-providers)
- [Auth](#auth)
  - [auth 如何解析](#how-auth-resolves)
  - [转换请求 header](#transforming-request-headers)
  - [凭据存储](#credential-store)
  - [环境变量](#environment-variables)
- [工具](#tools)
  - [定义工具](#defining-tools)
  - [处理 tool call](#handling-tool-calls)
  - [使用部分 JSON streaming tool call](#streaming-tool-calls-with-partial-json)
  - [校验工具参数](#validating-tool-arguments)
  - [完整事件参考](#complete-event-reference)
  - [紧凑的 assistant message frame](#compact-assistant-message-frames)
- [图像输入](#image-input)
- [图像生成](#image-generation)
- [Thinking/Reasoning](#thinkingreasoning)
  - [统一接口（streamSimple/completeSimple）](#unified-interface-streamsimplecompletesimple)
  - [provider 专属选项（stream/complete）](#provider-specific-options-streamcomplete)
  - [streaming thinking 内容](#streaming-thinking-content)
- [停止原因](#stop-reasons)
- [错误处理](#error-handling)
  - [中止请求](#aborting-requests)
  - [中止后继续](#continuing-after-abort)
  - [调试 provider payload](#debugging-provider-payloads)
- [自定义 provider](#custom-providers)
  - [createProvider()](#createprovider)
  - [直接调用 API 实现](#calling-api-implementations-directly)
  - [OpenAI 兼容性设置](#openai-compatibility-settings)
- [用于测试的 faux provider](#faux-provider-for-tests)
- [跨 provider 移交](#cross-provider-handoffs)
- [Context 序列化](#context-serialization)
- [浏览器用法](#browser-usage)
- [打包与 Tree Shaking](#bundling-and-tree-shaking)
- [OAuth provider](#oauth-providers)
  - [Vertex AI](#vertex-ai)
  - [CLI 登录](#cli-login)
  - [以编程方式使用 OAuth](#programmatic-oauth)
- [从旧的全局 API 迁移](#migrating-from-the-old-global-api)
- [开发](#development)
- [许可证](#license)

## 支持的 provider

- **OpenAI**
- **Ant Ling**
- **Azure OpenAI (Responses)**
- **OpenAI Codex**（ChatGPT Plus/Pro 订阅，需要 OAuth，见下文）
- **DeepSeek**
- **NVIDIA NIM**
- **Anthropic**
- **Google**
- **Vertex AI**（通过 Vertex AI 使用 Gemini）
- **Mistral**
- **Groq**
- **Cerebras**
- **Cloudflare AI Gateway**
- **Cloudflare Workers AI**
- **xAI**
- **OpenRouter**
- **Vercel AI Gateway**
- **ZAI Coding Plan (Global)**（另有独立的 China provider）
- **MiniMax**（另有独立的 China provider）
- **Together AI**
- **Baseten**
- **Hugging Face**
- **Moonshot AI**（另有独立的 China provider）
- **GitHub Copilot**（需要 OAuth，见下文）
- **Amazon Bedrock**
- **OpenCode Zen**
- **OpenCode Go**
- **Fireworks**（使用 OpenAI 与 Anthropic 兼容的 API）
- **Kimi For Coding**（Moonshot AI 订阅端点，使用 Anthropic 兼容的 API）
- **Qwen Token Plan**（独立的 Individual 与现有目录，另有独立的 China provider）
- **Xiaomi MiMo**（默认使用 API billing 端点，另有针对 `cn`/`ams`/`sgp` 区域的独立 Token Plan provider）
- **任何 OpenAI 兼容的 API**：Ollama、vLLM、LM Studio 等。

## 安装

```bash
npm install @earendil-works/pi-ai
```

TypeBox 导出从 `@earendil-works/pi-ai` 重新导出：`Type`、`Static` 和 `TSchema`。

## 快速开始

你构建一个由各 provider 组成的 `Models` 集合，并通过它进行 streaming。最快的起步方式是注册全部内置 provider；关注包体积的应用则改为注册单个 provider（参见 [provider 工厂](#provider-factories) 与 [打包与 Tree Shaking](#bundling-and-tree-shaking)）。

```typescript
import { Type, type Context, type Tool } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

// A Models collection with every built-in provider registered
const models = builtinModels();

// Sync lookup against the collection
const model = models.getModel('openai', 'gpt-4o-mini')!;

// Define tools with TypeBox schemas for type safety and validation
const tools: Tool[] = [{
  name: 'get_time',
  description: 'Get the current time',
  parameters: Type.Object({
    timezone: Type.Optional(Type.String({ description: 'Optional timezone (e.g., America/New_York)' }))
  })
}];

// Build a conversation context (easily serializable and transferable between models)
const context: Context = {
  systemPrompt: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: 'What time is it?', timestamp: Date.now() }],
  tools
};

// Option 1: Streaming with all event types.
// Auth resolves through the provider (OPENAI_API_KEY from the environment here).
const s = models.stream(model, context);

for await (const event of s) {
  switch (event.type) {
    case 'start':
      console.log(`Starting with ${event.partial.model}`);
      break;
    case 'text_start':
      console.log('\n[Text started]');
      break;
    case 'text_delta':
      process.stdout.write(event.delta);
      break;
    case 'text_end':
      console.log('\n[Text ended]');
      break;
    case 'thinking_start':
      console.log('[Model is thinking...]');
      break;
    case 'thinking_delta':
      process.stdout.write(event.delta);
      break;
    case 'thinking_end':
      console.log('[Thinking complete]');
      break;
    case 'toolcall_start':
      console.log(`\n[Tool call started: index ${event.contentIndex}]`);
      break;
    case 'toolcall_delta':
      // Partial tool arguments are being streamed
      const partialCall = event.partial.content[event.contentIndex];
      if (partialCall.type === 'toolCall') {
        console.log(`[Streaming args for ${partialCall.name}]`);
      }
      break;
    case 'toolcall_end':
      console.log(`\nTool called: ${event.toolCall.name}`);
      console.log(`Arguments: ${JSON.stringify(event.toolCall.arguments)}`);
      break;
    case 'done':
      console.log(`\nFinished: ${event.reason}`);
      break;
    case 'error':
      console.error(`Error: ${event.error.errorMessage}`);
      break;
  }
}

// Get the final message after streaming, add it to the context
const finalMessage = await s.result();
context.messages.push(finalMessage);

// Handle tool calls if any
const toolCalls = finalMessage.content.filter(b => b.type === 'toolCall');
for (const call of toolCalls) {
  const result = call.name === 'get_time'
    ? new Date().toLocaleString('en-US', {
        timeZone: call.arguments.timezone || 'UTC',
        dateStyle: 'full',
        timeStyle: 'long'
      })
    : 'Unknown tool';

  // Add tool result to context (supports text and images)
  context.messages.push({
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text: result }],
    isError: false,
    timestamp: Date.now()
  });
}

// Continue if there were tool calls
if (toolCalls.length > 0) {
  const continuation = await models.complete(model, context);
  context.messages.push(continuation);
  console.log('After tool execution:', continuation.content);
}

console.log(`Total tokens: ${finalMessage.usage.input} in, ${finalMessage.usage.output} out`);
console.log(`Cost: $${finalMessage.usage.cost.total.toFixed(4)}`);

// Option 2: Get complete response without streaming
const response = await models.complete(model, context);

for (const block of response.content) {
  if (block.type === 'text') {
    console.log(block.text);
  } else if (block.type === 'toolCall') {
    console.log(`Tool: ${block.name}(${JSON.stringify(block.arguments)})`);
  }
}
```

本 README 其余部分中的代码片段假定已按上述方式设置好一个 `models` 集合（并注册了相关的 provider）。

## provider 与 model

**provider** 是运行时单元：它拥有自己的 model 目录、自己的 auth（API key 解析、OAuth 流程）以及自己的 stream 行为。一个 `Models` 集合持有各 provider，并把每个请求路由到拥有该 model 的 provider。

provider 在内部共享 **API 实现**（即线上协议）：Anthropic 的 model 使用 `anthropic-messages`，OpenAI 使用 `openai-responses`，而 xAI、Groq、Cerebras、OpenRouter 以及大多数其他 provider 共享 `openai-completions`。混合 API 的 provider（GitHub Copilot、OpenCode Zen）按 model 分派。

### provider 工厂

对于只需要特定 provider 的应用，每个内置 provider 都有一个工厂，每个工厂都是一个子路径导入，只拉取该 provider 的目录：

```typescript
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { amazonBedrockProvider } from '@earendil-works/pi-ai/providers/amazon-bedrock';
// ...one module per provider in the Supported Providers list

const models = createModels();
models.setProvider(anthropicProvider());
models.setProvider(openrouterProvider());
```

provider 工厂会导入其 model 目录和一个惰性 API wrapper。它们不导入其他 provider。借助 bundler 的代码分割，SDK 实现（`@anthropic-ai/sdk`、`openai`、`@google/genai` 等）会留在惰性 chunk 中，在首次向该 API 的某个 model 发起请求时才加载。

### 全部内置 provider

对于想要全部内容的应用（如快速开始中那样）：

```typescript
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

const models = builtinModels(); // a Models collection with every built-in provider registered
```

这会导入所有目录以及每个内置 provider 工厂。它是重量级的显式入口点。`builtinModels()` 接受与 `createModels()` 相同的选项（`credentials`、`authContext`）；如果你想把它们注册到你自己的集合上，`builtinProviders()` 会返回 provider 数组。

### 查询 model

读取是同步的，返回最近已知的列表：

```typescript
const providers = models.getProviders();           // registered Provider objects
const provider = models.getProvider('anthropic');  // one provider

const all = models.getModels();                    // every model across providers
const anthropicModels = models.getModels('anthropic');
const model = models.getModel('anthropic', 'claude-sonnet-4-5');

for (const m of anthropicModels) {
  console.log(`${m.id}: ${m.name}`);
  console.log(`  API: ${m.api}`);
  console.log(`  Context: ${m.contextWindow} tokens`);
  console.log(`  Vision: ${m.input.includes('image')}`);
  console.log(`  Reasoning: ${m.reasoning}`);
}
```

动态列出的 model 类型为 `Model<Api>`。当你需要 API 专属的选项类型时，用 `hasApi()` 守卫来收窄：

```typescript
import { hasApi } from '@earendil-works/pi-ai';

const m = models.getModel('anthropic', 'claude-sonnet-4-5');
if (m && hasApi(m, 'anthropic-messages')) {
  // m: Model<'anthropic-messages'> — stream options fully typed
  models.stream(m, context, { thinkingEnabled: true, thinkingBudgetTokens: 2048 });
}
```

### 静态目录读取

对于想要生成的 built-in 目录、且带有完整字面量类型（provider 与 model ID 自动补全）并独立于任何集合的工具：

```typescript
import { getBuiltinModel, getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';

const model = getBuiltinModel('openai', 'gpt-4o-mini'); // typed Model<'openai-responses'>
const providers = getBuiltinProviders();
const anthropic = getBuiltinModels('anthropic');
```

### 动态 provider

provider 可能有动态的 model 列表（一个 llama.cpp 服务器、一个实时的 OpenRouter 列表）。读取保持同步；抓取是一个显式的异步动词：

```typescript
// getModels() returns the last-known list (empty before the first refresh)
await models.refresh({ providers: ['llamacpp'] }); // refresh one provider
await models.refresh();                            // refresh all providers concurrently, best-effort
const fresh = models.getModel('llamacpp', 'qwen3-30b');
```

静态内置 provider 对 `refresh()` 是 no-op。构建动态 provider 请参见 [createProvider()](#createprovider)。

## Auth

每个 provider 都拥有自己的 auth：API key 如何解析（存储的凭据、环境变量、AWS profile 或 gcloud ADC 这类环境来源），以及在支持的情况下，OAuth 登录/刷新流程。

### auth 如何解析

当你调用 `models.stream()` 时，集合会通过拥有该 model 的 provider 解析 auth，并将其合并进请求。每次请求中显式传入的值总是优先：

```typescript
// Resolved through the provider (env var, stored credential, OAuth token):
await models.complete(model, context);

// Explicit key wins over anything the provider would resolve:
await models.complete(model, context, { apiKey: 'sk-explicit' });
```

你可以在不发起请求的情况下检查解析结果。传入一个 provider ID 可获得 provider 作用域的 auth，或传入一个 model 以包含其静态 `model.headers`：

```typescript
const providerAuth = await models.getAuth(model.provider);
const modelAuth = await models.getAuth(model);

if (modelAuth) {
  console.log(`configured via ${modelAuth.source}`); // e.g. "ANTHROPIC_API_KEY", "OAuth", "stored credential"
  console.log(modelAuth.auth.headers);              // Provider auth headers + model.headers
} else {
  console.log('not configured');
}
```

两个重载都会解析凭据、在必要时刷新已过期的 OAuth，并可能返回由 auth 派生的 `apiKey`、`headers` 或 `baseUrl`。对于未配置的 provider，`getAuth()` 解析为 `undefined`；当确实出问题时，会以 `ModelsError` reject（`"oauth"`：token 刷新失败，凭据会保留以便重新登录；`"auth"`：key 解析或凭据存储失败）。请求路径会把同样的失败表现为 stream error。

`getAuth()`、`checkAuth()`、`getAvailable()`、login 和 logout 通过其现有的 options 或 interaction 对象接受可选的调用方取消，并且在未提供 signal 时保持无界。provider 的 `login`、`ApiKeyAuth.check`、`ApiKeyAuth.resolve` 和 `OAuthAuth.refresh` 实现总是会收到一个具体的 signal，并且必须为阻塞性工作遵守它。

### 转换请求 header

`Models.stream()`、`complete()`、`streamSimple()` 和 `completeSimple()` 接受一个仅属于 Models 的 `transformHeaders` 选项。它在 provider auth、`model.headers` 和显式的 `options.headers` 合并之后、但在 provider 分派之前运行一次：

```typescript
const response = await models.completeSimple(model, context, {
  headers: { "X-Client": "my-app" },
  transformHeaders: async (headers) => ({
    ...headers,
    "X-Request-ID": crypto.randomUUID(),
  }),
});
```

顺序是：

```text
provider auth headers -> model.headers -> explicit options.headers -> transformHeaders -> Provider.stream*()
```

header 名称以大小写不敏感的方式合并。显式 header 覆盖 auth/model header，而 transform 拥有最终控制权；为某个 header 返回 `null` 会抑制支持删除的低层级默认值。

`transformHeaders` 属于 `Models`，而不属于 `Provider`。`Models` 实现必须消费它，并在调用 `Provider.stream*()` 之前将其移除。provider 实现继续接收普通的 `ApiStreamOptions` 或 `SimpleStreamOptions`，自身从不处理该 transform。请使用这个选项，而不是在 `stream*()` 之前调用 `getAuth(model)`——后者会解析两次请求 auth。

### 凭据存储

存储的凭据（交互式输入的 API key、OAuth token）存放在 `CredentialStore` 中——每个 provider 一个带类型标记的凭据。pi-ai 自带一个内存中的默认实现；应用可注入持久化存储：

```typescript
import { createModels, type CredentialStore } from '@earendil-works/pi-ai';

const models = createModels({ credentials: myFileBackedStore });
// builtinModels() takes the same options:
// const models = builtinModels({ credentials: myFileBackedStore });
```

契约很小：`read(providerId)`、用于非机密 `{ providerId, type }` 元数据的 `list()`、`modify(providerId, fn)`（唯一的写入路径——一次序列化的 read-modify-write），以及 `delete(providerId)`。每个操作都接受可选的取消选项。枚举不得解析机密，也不得执行已配置的 key 命令。OAuth token 刷新在 `modify` 内运行，因此并发的请求和进程无法对已轮换的 token 进行双重刷新。存储的凭据*拥有*其 provider：只有在没有任何存储内容时才会查询环境变量，而失败的刷新绝不会静默回退到 env key。

API-key 凭据使用与 pi 的 `auth.json` 相同的判别字段，并且可以携带 provider 作用域的 env/config 值：

```typescript
const credential = {
  type: 'api_key',
  key: '...',
  env: {
    CLOUDFLARE_ACCOUNT_ID: 'account-id',
    CLOUDFLARE_GATEWAY_ID: 'gateway-id'
  }
} as const;
```

### 环境变量

内置 provider 会解析这些 env var（Node.js；在浏览器中请显式传入 `apiKey`）：

| provider | 环境变量 |
|----------|------------------------|
| OpenAI | `OPENAI_API_KEY` |
| Ant Ling | `ANT_LING_API_KEY` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_BASE_URL`（例如 `https://{resource}.ai.azure.com`）或 `AZURE_OPENAI_RESOURCE_NAME`。支持 `*.openai.azure.com`、`*.cognitiveservices.azure.com` 和 `*.ai.azure.com`；根端点会自动规范化为 `/openai/v1`。可选：`AZURE_OPENAI_API_VERSION`（默认 `v1`）、`AZURE_OPENAI_DEPLOYMENT_NAME_MAP`。 |
| Anthropic | `ANTHROPIC_API_KEY` 或 `ANTHROPIC_OAUTH_TOKEN` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| NVIDIA NIM | `NVIDIA_API_KEY` |
| Google | `GEMINI_API_KEY` |
| Vertex AI | `GOOGLE_CLOUD_API_KEY` 或 `GOOGLE_CLOUD_PROJECT`（或 `GCLOUD_PROJECT`）+ `GOOGLE_CLOUD_LOCATION` + ADC |
| Mistral | `MISTRAL_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Cerebras | `CEREBRAS_API_KEY` |
| Cloudflare AI Gateway | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_GATEWAY_ID` |
| Cloudflare Workers AI | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` |
| xAI | `XAI_API_KEY` |
| Fireworks | `FIREWORKS_API_KEY` |
| Together AI | `TOGETHER_API_KEY` |
| Baseten | `BASETEN_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` |
| ZAI Coding Plan (Global) | `ZAI_API_KEY` |
| ZAI Coding Plan (China) | `ZAI_CODING_CN_API_KEY` |
| MiniMax (Global) | `MINIMAX_API_KEY` |
| MiniMax (China) | `MINIMAX_CN_API_KEY` |
| Moonshot AI / Moonshot AI (China) | `MOONSHOT_API_KEY` |
| Hugging Face | `HF_TOKEN` |
| OpenCode Zen / OpenCode Go | `OPENCODE_API_KEY` |
| Kimi For Coding | `KIMI_API_KEY` |
| Qwen Token Plan (existing catalog) | `QWEN_TOKEN_PLAN_API_KEY` |
| Qwen Token Plan (Individual) | `QWEN_TOKEN_PLAN_API_KEY` |
| Qwen Token Plan (China) | `QWEN_TOKEN_PLAN_CN_API_KEY` |
| Xiaomi MiMo (API billing) | `XIAOMI_API_KEY` |
| Xiaomi MiMo Token Plan (China) | `XIAOMI_TOKEN_PLAN_CN_API_KEY` |
| Xiaomi MiMo Token Plan (Amsterdam) | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` |
| Xiaomi MiMo Token Plan (Singapore) | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` |

`qwen-token-plan-individual` 和 `qwen-token-plan` 共享国际端点与
`QWEN_TOKEN_PLAN_API_KEY`。Individual provider 只暴露为 Individual
订阅所记录的 model，而现有的 provider 为了向后兼容保留了更广泛的目录。
存储的凭据仍保持 provider 作用域，因此请把 key 保存在你所注册的 provider ID 下。

Amazon Bedrock 会解析环境中的 AWS 凭据（`AWS_PROFILE`、access key 对、`AWS_BEARER_TOKEN_BEDROCK`、ECS task role、web identity token）；其 provider 自有的登录流程支持 bearer token、AWS profile 以及现有的凭据链。Vertex AI 会解析显式 key，或 gcloud Application Default Credentials 加上 project/location，并提供 provider 自有的登录流程以支持 API key、ADC 和 service-account 文件。

## 工具

工具让 LLM 能够与外部系统交互。本库使用 TypeBox schema 来实现类型安全的工具定义，并借助 TypeBox 内置的校验器和值转换工具进行自动校验。TypeBox schema 可以序列化和反序列化为普通 JSON，因此非常适合分布式系统。

### 定义工具

```typescript
import { Type, type Tool, StringEnum } from '@earendil-works/pi-ai';

// Define tool parameters with TypeBox
const weatherTool: Tool = {
  name: 'get_weather',
  description: 'Get current weather for a location',
  parameters: Type.Object({
    location: Type.String({ description: 'City name or coordinates' }),
    units: StringEnum(['celsius', 'fahrenheit'], { default: 'celsius' })
  })
};

// Note: For Google API compatibility, use StringEnum helper instead of Type.Enum
// Type.Enum generates anyOf/const patterns that Google doesn't support

const bookMeetingTool: Tool = {
  name: 'book_meeting',
  description: 'Schedule a meeting',
  parameters: Type.Object({
    title: Type.String({ minLength: 1 }),
    startTime: Type.String({ format: 'date-time' }),
    endTime: Type.String({ format: 'date-time' }),
    attendees: Type.Array(Type.String({ format: 'email' }), { minItems: 1 })
  })
};
```

### 工具的受约束采样

工具可以选择启用 provider 侧的受约束采样。对于 JSON-schema 工具，`strict: 'prefer'` 在受支持时使用 provider 侧的严格 schema 强制，否则回退到普通的 tool calling。当当前活跃的 provider/model 无法满足时，`strict: 'require'` 会让请求失败。设置 `constrainedSampling: false` 可显式退出；其行为与省略该字段相同。

```typescript
const strictTool: Tool = {
  name: 'edit_file',
  description: 'Edit a file',
  parameters: Type.Object({
    path: Type.String(),
    content: Type.String()
  }, { additionalProperties: false }),
  constrainedSampling: { type: 'json_schema', strict: 'prefer' }
};
```

严格的 JSON-schema 受约束采样在 OpenAI、Anthropic、受支持的 Amazon Bedrock Converse model、Mistral，以及通过 Google Generative AI 和 Vertex 适配器的 Gemini 3 tool call 上受支持。Google 使用 `VALIDATED` function-calling 模式（在显式请求时使用 `ANY`）；更早的 Gemini 版本对 `strict: 'prefer'` 会回退，并且拒绝 `strict: 'require'`，因为它们不强制必填参数。Bedrock 的 strict-tool 能力由 model 的 structured-output 元数据生成；自定义 Bedrock model 可以覆盖 `compat.supportsStrictMode`。OpenAI Responses 和 Chat Completions 也可以发出带语法约束的自定义工具，使用 OpenAI Lark 或 regex 语法变体。如果提供了多个 OpenAI 变体，Lark 优先于 regex。当活跃的 model 支持 grammar tool 时会强制语法约束；否则该工具回退到普通的 function/JSON-schema 处理。grammar tool 能力属于 model 元数据：生成的目录会为通过 OpenAI 自定义工具的端点上（OpenAI、OpenAI Codex、Azure OpenAI Responses、GitHub Copilot、opencode 和 Cloudflare AI Gateway）的 GPT-5+ model 设置 `compat.supportsOpenAIGrammarTools`。OpenAI 会拒绝 GPT-5 之前 model 的 `type: "custom"` 工具，而会对工具 schema 做规范化的网关（例如 OpenRouter）会把它们弄乱，因此该标志在其他地方保持关闭。自定义 model 定义可以通过 `compat` 选择启用。具备语法能力的 model 会拒绝没有非空受支持变体的语法配置。原生 grammar tool 必须具有一个对象参数 schema，且其中恰好有一个必填的字符串属性：

```typescript
const patchTool: Tool = {
  name: 'apply_patch',
  description: 'Apply a patch',
  parameters: Type.Object({
    input: Type.String()
  }, { additionalProperties: false }),
  constrainedSampling: {
    type: 'grammar',
    variants: {
      openai_lark: 'start: /.+/s'
    }
  }
};
```

### 处理 tool call

工具结果使用 content block，并且可以同时包含文本和图像：

```typescript
import { readFileSync } from 'fs';

const context: Context = {
  messages: [{ role: 'user', content: 'What is the weather in London?', timestamp: Date.now() }],
  tools: [weatherTool]
};

const response = await models.complete(model, context);

// Check for tool calls in the response
for (const block of response.content) {
  if (block.type === 'toolCall') {
    // Execute your tool with the arguments
    // See "Validating Tool Arguments" section for validation
    const result = await executeWeatherApi(block.arguments);

    // Add tool result with text content
    context.messages.push({
      role: 'toolResult',
      toolCallId: block.id,
      toolName: block.name,
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: false,
      timestamp: Date.now()
    });
  }
}

// Tool results can also include images (for vision-capable models)
const imageBuffer = readFileSync('chart.png');
context.messages.push({
  role: 'toolResult',
  toolCallId: 'tool_xyz',
  toolName: 'generate_chart',
  content: [
    { type: 'text', text: 'Generated chart showing temperature trends' },
    { type: 'image', data: imageBuffer.toString('base64'), mimeType: 'image/png' }
  ],
  isError: false,
  timestamp: Date.now()
});
```

### 使用部分 JSON streaming tool call

在 streaming 期间，tool call 的参数会随着到达而逐步解析。这使得在完整参数可用之前就能进行实时的 UI 更新：

```typescript
const s = models.stream(model, context);

for await (const event of s) {
  if (event.type === 'toolcall_delta') {
    const toolCall = event.partial.content[event.contentIndex];

    // toolCall.arguments contains partially parsed JSON during streaming
    // This allows for progressive UI updates
    if (toolCall.type === 'toolCall' && toolCall.arguments) {
      // BE DEFENSIVE: arguments may be incomplete
      // Example: Show file path being written even before content is complete
      if (toolCall.name === 'write_file' && toolCall.arguments.path) {
        console.log(`Writing to: ${toolCall.arguments.path}`);

        // Content might be partial or missing
        if (toolCall.arguments.content) {
          console.log(`Content preview: ${toolCall.arguments.content.substring(0, 100)}...`);
        }
      }
    }
  }

  if (event.type === 'toolcall_end') {
    // Here toolCall.arguments is complete (but not yet validated)
    const toolCall = event.toolCall;
    console.log(`Tool completed: ${toolCall.name}`, toolCall.arguments);
  }
}
```

**关于部分 tool 参数的重要说明：**
- 在 `toolcall_delta` 事件期间，`arguments` 包含对部分 JSON 的尽力而为解析
- 字段可能缺失或不完整——使用前务必检查其是否存在
- 字符串值可能在词中被截断
- 数组可能不完整
- 嵌套对象可能只被部分填充
- 至少，`arguments` 会是一个空对象 `{}`，绝不会是 `undefined`
- Google provider 不支持 function call streaming。取而代之，你会收到一个带有完整参数的单个 `toolcall_delta` 事件。

### 校验工具参数

在实现你自己的工具执行循环时，请使用 `validateToolCall` 在把参数传给工具之前对其进行校验：

```typescript
import { validateToolCall, type Tool } from '@earendil-works/pi-ai';

const tools: Tool[] = [weatherTool, calculatorTool];
const s = models.stream(model, { messages, tools });

for await (const event of s) {
  if (event.type === 'toolcall_end') {
    const toolCall = event.toolCall;

    try {
      // Validate arguments against the tool's schema (throws on invalid args)
      const validatedArgs = validateToolCall(tools, toolCall);
      const result = await executeMyTool(toolCall.name, validatedArgs);
      // ... add tool result to context
    } catch (error) {
      // Validation failed - return error as tool result so model can retry
      context.messages.push({
        role: 'toolResult',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: 'text', text: error.message }],
        isError: true,
        timestamp: Date.now()
      });
    }
  }
}
```

### 完整事件参考

成功的生成遵循 `start → updates* → done`。生成开始之后的失败遵循 `start → updates* → error`。请求设置可能在生成开始之前失败，此时 stream 只包含 `error`；在 `start` 之前，`done` 和 update 事件是无效的。当请求 auth 缺失时，直接调用 API 的 `streamSimple()` 会同步抛出异常。

每个非终止事件的 `partial` 都是共享的、实时更新的「截至目前响应」辅助对象。它有意不是一个事件时刻的 snapshot：随着生成推进，provider 可能修改同一个 message 和 content block，包括在较旧事件还在 stream 队列中等待时。请在处理事件时检查它，而不要把它当作历史状态保留。文本块和普通 thinking 块在其 `*_start` 事件发出时为空，并且只通过匹配的 `*_delta` 事件增长，直到权威的 `*_end`；被隐去的 thinking 在开始时可能已完整，并且不发出任何 delta。`toolcall_start` 处的 tool-call 参数因 provider 而异；`toolcall_delta` 携带随后的 JSON 更新。

在 assistant message 生成期间发出的所有 streaming 事件：

| 事件类型 | 描述 | 关键属性 |
|------------|-------------|----------------|
| `start` | Stream 开始 | `partial`：初始 assistant message 结构 |
| `text_start` | 文本块开始 | `contentIndex`：在 content 数组中的位置 |
| `text_delta` | 收到文本 chunk | `delta`：新文本，`contentIndex`：位置 |
| `text_end` | 文本块完成 | `content`：完整文本，`contentIndex`：位置 |
| `thinking_start` | thinking 块开始 | `contentIndex`：在 content 数组中的位置 |
| `thinking_delta` | 收到 thinking chunk | `delta`：新文本，`contentIndex`：位置 |
| `thinking_end` | thinking 块完成 | `content`：完整 thinking，`contentIndex`：位置 |
| `toolcall_start` | tool call 开始 | `contentIndex`：在 content 数组中的位置 |
| `toolcall_delta` | tool 参数 streaming | `delta`：JSON chunk，`partial.content[contentIndex].arguments`：部分解析后的参数 |
| `toolcall_end` | tool call 完成 | `toolCall`：完整但尚未经 schema 校验的 tool call，包含 `id`、`name`、`arguments` |
| `done` | Stream 完成 | `reason`：停止原因（"stop"、"length"、"toolUse"），`message`：最终 assistant message |
| `error` | 发生错误 | `reason`：错误类型（"error" 或 "aborted"），`error`：带有部分内容的 AssistantMessage |

针对不同 content block 的 streaming 事件不保证连续。provider 可能在同一个上游 chunk 中发出 text、thinking 和 tool call 的 delta，而 pi 可能把对应事件交错呈现，例如 `text_start`、`text_delta`、`toolcall_start`、`text_delta`、`toolcall_delta`。消费者必须使用 `contentIndex` 把每个 delta/end 事件关联到其所属块，并且不得假定某个块的 `*_start`/`*_delta`/`*_end` 序列不会被其他块的事件打断。

### 紧凑的 assistant message frame

`AssistantMessageFrameEncoder` 把一个 stream 转换为紧凑、可持久化的 `AssistantMessageFrame` 值。为每个 stream 创建一个 encoder，并按顺序把每个事件喂给它。该 encoder 理解 `partial` 是实时的：在 provider 已经排队了后续 delta 之后才被消费到的 block-start 事件，会对当前块做一次 snapshot，而被覆盖的已排队 text/thinking delta 不会产生重复的 frame。它只保留按打开块计数的计数器，以及（临时地）同步一个已经推进过的 tool call 所需的原始前缀。它从不为每个 token 克隆不断增长的整体 partial。

start frame 包含带有空 content 的 message 元数据。text 和 thinking frame 在权威的 end frame 之前，最多存储每个生成的字符一次。在 start 事件被消费时已经推进过的 tool call，会在普通 delta 恢复之前使用一个紧凑的 JSON checkpoint。终止性的 `done` 和 `error` 事件不产生 frame，因为最终 message 的结算（settlement）是独立的。因此，生成之前的 `error` 不产生任何 frame。

`reduceAssistantMessageFrames()` 是规范化的纯 reducer。它重建 text、thinking 和 tool-call 参数，包括由 `contentIndex` 标识的交错块，并拒绝格式错误的序列。它对可迭代对象执行单次遍历，并在没有 start frame 时返回 `undefined`。end frame 用 provider 权威的已完成 content 和元数据替换块。该 reducer 不会根据 TypeBox schema 校验 tool 参数；请在执行前调用 `validateToolCall`。

```typescript
import {
  AssistantMessageFrameEncoder,
  reduceAssistantMessageFrames,
  type AssistantMessageFrame,
} from '@earendil-works/pi-ai';

const encoder = new AssistantMessageFrameEncoder();
const frames: AssistantMessageFrame[] = [];
for await (const event of s) {
  const frame = encoder.encode(event);
  if (frame) frames.push(frame);
}

const reconstructedPartial = reduceAssistantMessageFrames(frames);
const finalMessage = await s.result(); // Persist terminal settlement separately.
```

encoder 会拒绝重复的 start、start 之前的 update、start 之前的 `done`、终止事件之后的事件、重复的 block start，以及块类型不匹配。start 之前的 `error` 是有效的，并返回 no frame。

## 图像输入

具备视觉能力的 model 可以处理图像。你可以通过 `input` 属性检查某个 model 是否支持图像。如果你把图像传给不具备视觉能力的 model，它们会被静默忽略。

```typescript
import { readFileSync } from 'fs';

const model = models.getModel('openai', 'gpt-4o-mini')!;

// Check if model supports images
if (model.input.includes('image')) {
  console.log('Model supports vision');
}

const imageBuffer = readFileSync('image.png');
const base64Image = imageBuffer.toString('base64');

const response = await models.complete(model, {
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'What is in this image?' },
      { type: 'image', data: base64Image, mimeType: 'image/png' }
    ],
    timestamp: Date.now()
  }]
});

// Access the response
for (const block of response.content) {
  if (block.type === 'text') {
    console.log(block.text);
  }
}
```

## 图像生成

图像生成使用与文本/chat 生成分离的 API surface，并镜像 chat 侧的设计：`ImagesModels` 集合持有 `ImagesProvider`，读取是同步的，auth 通过拥有该 model 的 provider 解析。图像生成是一次性 API：`generateImages()` 等待 provider 响应并返回最终的 `AssistantImages` 结果——不要为此使用 chat/stream API。

### 基础图像生成

```typescript
import { builtinImagesModels } from '@earendil-works/pi-ai/providers/all';

// Every built-in image-generation provider; accepts the same options as createModels()
const imagesModels = builtinImagesModels();

const model = imagesModels.getModel('openrouter', 'google/gemini-2.5-flash-image')!;

// Auth resolves through the provider (OPENROUTER_API_KEY here); explicit apiKey wins
const result = await imagesModels.generateImages(model, {
  input: [{ type: 'text', text: 'Generate a red circle on a plain white background.' }]
});

for (const block of result.output) {
  if (block.type === 'text') {
    console.log(block.text);
  } else if (block.type === 'image') {
    console.log(block.mimeType);
    console.log(block.data.substring(0, 32));
  }
}
```

与 chat 侧一样，你可以用各个部件来构建集合：`createImagesModels({ credentials?, authContext? })`、来自 `@earendil-works/pi-ai/providers/openrouter-images` 的 `openrouterImagesProvider()` 工厂，以及用于自定义图像 provider 的 `createImagesProvider({ id, auth, models, refreshModels?, api })`（动态列表可用 `imagesModels.refresh(provider?)`）。失败从不会 reject——它们返回一个带有 `stopReason: "error"` 的 `AssistantImages`。集合的 provider 作用域 `getAuth(providerId)` 的行为与 chat 侧的完全一致。

旧的全局 API（`getImageModel()` / `getImageModels()` / `getImageProviders()` / `generateImages()`）仍可在 [compat 入口点](#migrating-from-the-old-global-api) 上使用：

```typescript
import { getImageModel, generateImages } from '@earendil-works/pi-ai/compat';

const model = getImageModel('openrouter', 'google/gemini-2.5-flash-image');
const result = await generateImages(model, {
  input: [{ type: 'text', text: 'Generate a red circle on a plain white background.' }]
}, {
  apiKey: process.env.OPENROUTER_API_KEY
});
```

部分 model 还支持图像输入：

```typescript
import { readFileSync } from 'fs';

const imageBuffer = readFileSync('input.png');
const result = await imagesModels.generateImages(model, {
  input: [
    { type: 'text', text: 'Create a variation of this image with a blue background.' },
    { type: 'image', data: imageBuffer.toString('base64'), mimeType: 'image/png' }
  ]
});
```

在 model 元数据上检查能力：

```typescript
console.log(model.input);   // ['text', 'image']
console.log(model.output);  // ['image'] or ['image', 'text']
```

### 说明与限制

- 图像 model 位于 `ImagesModels` 集合中，chat model 位于 `Models` 集合中；两者是彼此分离的 surface。
- 使用 `generateImages()`，而不是 chat/stream API。
- 图像生成 model 不参与 tool calling。
- 输出在 `AssistantImages.output` 中返回，可以同时包含 base64 编码的 `ImageContent` 块和 `TextContent` 块。
- 部分 model 只返回图像，另一些返回图像加文本。请检查 `model.output`。
- 部分 model 接受图像输入，另一些仅支持 text-to-image。请检查 `model.input`。
- 与 streaming API 一样，图像生成支持 `apiKey`、`signal`、`headers`、`onPayload` 和 `onResponse` 等选项，结果中可能包含 `stopReason`、`responseId` 和 `usage`。
- 如果你想让 model 在对话中分析图像或调用工具，请使用常规 chat API 并搭配支持图像输入的 model。
- 目前，图像生成只能通过一个 provider 使用，即 OpenRouter。

## Thinking/Reasoning

许多 model 支持 thinking/reasoning 能力，可以展示其内部思考过程。你可以通过 `reasoning` 属性检查某个 model 是否支持 reasoning。如果你把 reasoning 选项传给不支持 reasoning 的 model，它们会被静默忽略。

### 统一接口（streamSimple/completeSimple）

```typescript
// Many models across providers support thinking/reasoning
const model = models.getModel('anthropic', 'claude-sonnet-4-5')!;
// or models.getModel('openai', 'gpt-5-mini');
// or models.getModel('google', 'gemini-2.5-flash');
// or models.getModel('xai', 'grok-4.6');

// Check if model supports reasoning
if (model.reasoning) {
  console.log('Model supports reasoning/thinking');
}

// Use the simplified reasoning option
const response = await models.completeSimple(model, {
  messages: [{ role: 'user', content: 'Solve: 2x + 5 = 13', timestamp: Date.now() }]
}, {
  reasoning: 'medium'  // 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
});

// Access thinking and text blocks
for (const block of response.content) {
  if (block.type === 'thinking') {
    console.log('Thinking:', block.thinking);
  } else if (block.type === 'text') {
    console.log('Response:', block.text);
  }
}
```

`xhigh` 和 `max` 是 model 专属的、需选择启用的级别。使用 `getSupportedThinkingLevels(model)` 判断某个具体 model 是否暴露这两个级别中的任意一个；诸如 GPT-5.6 这样的 model 可以同时暴露两者。

### provider 专属选项（stream/complete）

`models.stream()`/`complete()` 接受拥有该 model 的 API 的完整选项集。使用 `hasApi()` 把动态查找到的 model 收窄到其 API，以获得完整的选项类型：

```typescript
import { hasApi } from '@earendil-works/pi-ai';

// OpenAI Reasoning (o1, o3, gpt-5)
const openaiModel = models.getModel('openai', 'gpt-5-mini')!;
if (hasApi(openaiModel, 'openai-responses')) {
  await models.complete(openaiModel, context, {
    reasoningEffort: 'medium',
    reasoningSummary: 'detailed'  // OpenAI Responses API only
  });
}

// Anthropic Thinking
const anthropicModel = models.getModel('anthropic', 'claude-sonnet-4-5')!;
if (hasApi(anthropicModel, 'anthropic-messages')) {
  await models.complete(anthropicModel, context, {
    thinkingEnabled: true,
    thinkingBudgetTokens: 8192  // Optional token limit
  });
}

// Google Gemini Thinking
const googleModel = models.getModel('google', 'gemini-2.5-flash')!;
if (hasApi(googleModel, 'google-generative-ai')) {
  await models.complete(googleModel, context, {
    thinking: {
      enabled: true,
      budgetTokens: 8192  // -1 for dynamic, 0 to disable
    }
  });
}
```

### streaming thinking 内容

在 streaming 时，thinking 内容通过特定事件传递：

```typescript
const s = models.streamSimple(model, context, { reasoning: 'high' });

for await (const event of s) {
  switch (event.type) {
    case 'thinking_start':
      console.log('[Model started thinking]');
      break;
    case 'thinking_delta':
      process.stdout.write(event.delta);  // Stream thinking content
      break;
    case 'thinking_end':
      console.log('\n[Thinking complete]');
      break;
  }
}
```

## 停止原因

每个 `AssistantMessage` 都包含一个 `stopReason` 字段，指示生成是如何结束的：

- `"pending"` - 仅在我们不知道停止原因会是什么时出现在部分 message 中
- `"stop"` - 这是 model 本轮将产生的最终 message
- `"length"` - 输出达到了最大 token 上限
- `"toolUse"` - model 正在调用工具并期待工具结果
- `"error"` - 生成期间发生错误
- `"aborted"` - 请求通过 abort signal 被取消

`AssistantMessage` 还可能包含 `responseId`，即当底层 API 暴露时，provider 专属的上游响应或 message 标识符。不要假定它在各 provider 上总是存在。

## 错误处理

在 stream 被返回之后的请求失败从不抛出：当请求以错误结束（包括中止和 tool call 校验错误）时，streaming API 会发出一个 error 事件，最终 message 会携带详细信息。设置失败可能发出 `error` 而没有 `start`；生成开始之后的失败会发出 `start`、任何观察到的 update，然后是 `error`。当请求 auth 缺失时，直接调用 API 的 `streamSimple()` 会同步抛出异常：

```typescript
// In streaming
for await (const event of s) {
  if (event.type === 'error') {
    // event.reason is either "error" or "aborted"
    // event.error is the AssistantMessage with partial content
    console.error(`Error (${event.reason}):`, event.error.errorMessage);
    console.log('Partial content:', event.error.content);
  }
}

// The final message will have the error details
const message = await s.result();
if (message.stopReason === 'error' || message.stopReason === 'aborted') {
  console.error('Request failed:', message.errorMessage);
  // message.content contains any partial content received before the error
  // message.usage contains partial token counts and costs
}
```

在使用 provider 集合时，auth 失败（OAuth 刷新失败、未知 provider）会表现为带有 `stopReason: "error"` 的 stream error。而直接调用 API 的 `streamSimple()` 在其所需的 auth 缺失时会同步抛出异常。

### 中止请求

abort signal 允许你取消进行中的请求。被中止的请求具有 `stopReason === 'aborted'`：

```typescript
const controller = new AbortController();

// Abort after 2 seconds
setTimeout(() => controller.abort(), 2000);

const s = models.stream(model, {
  messages: [{ role: 'user', content: 'Write a long story', timestamp: Date.now() }]
}, {
  signal: controller.signal
});

for await (const event of s) {
  if (event.type === 'text_delta') {
    process.stdout.write(event.delta);
  } else if (event.type === 'error') {
    // event.reason tells you if it was "error" or "aborted"
    console.log(`${event.reason === 'aborted' ? 'Aborted' : 'Error'}:`, event.error.errorMessage);
  }
}

// Get results (may be partial if aborted)
const response = await s.result();
if (response.stopReason === 'aborted') {
  console.log('Request was aborted:', response.errorMessage);
  console.log('Partial content received:', response.content);
  console.log('Tokens used:', response.usage);
}
```

### 中止后继续

被中止的 message 可以加入对话 context，并在后续请求中继续：

```typescript
const context = {
  messages: [
    { role: 'user', content: 'Explain quantum computing in detail', timestamp: Date.now() }
  ]
};

// First request gets aborted after 2 seconds
const controller1 = new AbortController();
setTimeout(() => controller1.abort(), 2000);

const partial = await models.complete(model, context, { signal: controller1.signal });

// Add the partial response to context
context.messages.push(partial);
context.messages.push({ role: 'user', content: 'Please continue', timestamp: Date.now() });

// Continue the conversation
const continuation = await models.complete(model, context);
```

### 调试 provider payload

使用 `onPayload` 回调来检查发送给 provider 的请求 payload。这对于调试请求格式问题或 provider 校验错误很有用。

```typescript
const response = await models.complete(model, context, {
  onPayload: (payload) => {
    console.log('Provider payload:', JSON.stringify(payload, null, 2));
  }
});
```

该回调由 `stream`、`complete`、`streamSimple` 和 `completeSimple` 支持。

## 自定义 provider

### createProvider()

`createProvider()` 从各个部件构建 provider：身份、auth、model 列表和 API 实现。可用于本地推理服务器、代理，或任何 OpenAI/Anthropic 兼容的端点：

```typescript
import { createModels, createProvider, envApiKeyAuth, type Model } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

const ollamaModel: Model<'openai-completions'> = {
  id: 'llama-3.1-8b',
  name: 'Llama 3.1 8B (Ollama)',
  api: 'openai-completions',
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 32000
};

const ollama = createProvider({
  id: 'ollama',
  name: 'Ollama',
  baseUrl: 'http://localhost:11434/v1',
  // Every provider declares auth; keyless local servers resolve as configured with no key.
  auth: { apiKey: { name: 'Ollama', resolve: async () => ({ auth: {} }) } },
  models: [ollamaModel],
  api: openAICompletionsApi(),
});

const models = createModels();
models.setProvider(ollama);

await models.complete(models.getModel('ollama', 'llama-3.1-8b')!, context);
```

对于使用真实 key 的 provider，`envApiKeyAuth(displayName, envVars)` 提供标准行为（存储的凭据优先，然后是第一个已设置的 env var）：

```typescript
const proxy = createProvider({
  id: 'my-proxy',
  auth: { apiKey: envApiKeyAuth('My proxy API key', ['MY_PROXY_API_KEY']) },
  models: [/* ... */],
  api: openAICompletionsApi(),
});
```

混合 API 的 provider 传入一个以 `model.api` 为键的 map；每个 model 分派到其 API 的实现：

```typescript
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';

const gateway = createProvider({
  id: 'my-gateway',
  auth: { apiKey: envApiKeyAuth('Gateway key', ['GATEWAY_API_KEY']) },
  models: [/* models with api: 'anthropic-messages' or 'openai-responses' */],
  api: {
    'anthropic-messages': anthropicMessagesApi(),
    'openai-responses': openAIResponsesApi(),
  },
});
```

provider 范围的端点或请求转换应放在该 provider 的 API 实现中：包装你作为 `api` 传入的 `ProviderStreams`，让每个请求在分派之前都经过该转换。Cloudflare provider 就以此从解析出的 provider env 中实体化 account/gateway 端点占位符：

```typescript
function tenantStreams(streams: ProviderStreams): ProviderStreams {
  const withTenant = (model: Model<Api>) => ({ ...model, baseUrl: model.baseUrl.replace('{tenant}', tenantId) });
  return {
    stream: (model, context, options) => streams.stream(withTenant(model), context, options),
    streamSimple: (model, context, options) => streams.streamSimple(withTenant(model), context, options),
  };
}

const tenantGateway = createProvider({
  id: 'tenant-gateway',
  auth: { apiKey: envApiKeyAuth('Gateway key', ['GATEWAY_API_KEY']) },
  models: [/* ... */],
  api: tenantStreams(openAICompletionsApi()),
});
```

动态 model 列表使用 `fetchModels`。`Models.refresh()` 会刷新每个已配置的动态 provider，并传入其有效的 API-key 或刷新后的 OAuth 凭据。`ModelsStore` 持久化动态目录；两个 store 都默认使用内存中的实现。它的 `read`、`write` 和 `delete` 操作接受可选的取消，而 `Models` 会把这些等待绑定到 provider 的 refresh signal。

```typescript
const models = createModels({ credentials, modelsStore });
const llamacpp = createProvider({
  id: 'llamacpp',
  auth: { apiKey: { name: 'llama.cpp', resolve: async () => ({ auth: {} }) } },
  models: [],
  fetchModels: async ({ signal }) => fetchModelsFromServer('http://localhost:8080', signal),
  api: openAICompletionsApi(),
});

models.setProvider(llamacpp);
const result = await models.refresh({ signal });
if (result.aborted) console.log('refresh cancelled');
for (const [provider, error] of result.errors) console.error(provider, error);
```

当省略可选的 signal 时，`Models.refresh()` 是无界的。provider 总是会收到一个具体的 `RefreshModelsContext.signal`，并且必须为网络请求和其他阻塞性工作遵守它。当调用方提供 signal 时，即使某个自定义 provider 未能配合，`Models.refresh()` 也会在取消后立即返回 `aborted: true`；该 provider 仍必须遵守该 signal 以停止其底层工作。

使用 `models.refresh({ providers: ['openrouter'] })` 把工作限制在选定的 provider 上，使用 `models.refresh({ allowNetwork: false })` 在不访问网络的情况下恢复已持久化的目录，或使用 `models.refresh({ force: true })` 绕过 provider 的新鲜度检查。model 读取保持同步，并返回最近一次恢复或刷新的列表。

`createProvider()` 会自动处理动态发布与持久化。手写的 `Provider.refreshModels()` 实现会收到只读的 `context.stored` snapshot，并通过 `context.publish({ persist?, update? })` 进行发布。省略 `persist` 可保持存储不变，传入一个 `ModelsStoreEntry` 可写入它，或传入 `persist: null` 可删除它。发布经过 generation 检查；请把同步的内存目录变更放在 `update` 中，而不是在发布之前改动状态。

自定义 model 可以携带 `headers`（例如位于 bot 检测之后的代理）和 `compat` 标志。`Models.getAuth(model)` 会包含这些 model header，而 stream 方法会在显式请求 header 和 `transformHeaders` 之前合并它们。参见 [OpenAI 兼容性设置](#openai-compatibility-settings)。

部分 OpenAI 兼容服务器不理解用于支持 reasoning 的 model 的 `developer` role。对于这些 provider，请把 `compat.supportsDeveloperRole` 设为 `false`，这样 system prompt 会改为以 `system` message 发送。如果该服务器也不支持 `reasoning_effort`，请同时把 `compat.supportsReasoningEffort` 设为 `false`。这通常适用于 Ollama、vLLM、SGLang 以及类似的 OpenAI 兼容服务器。

使用 model 级别的 `thinkingLevelMap` 描述 model 专属的 thinking 控制。键是 pi 的 thinking 级别（`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`）。直到 `high` 为止缺失的标准级别使用 provider 默认值；`xhigh` 和 `max` 需选择启用，并要求 map 条目非 null。字符串值会发送给 provider，`null` 标记某个级别不受支持，而 map 可以跳过级别。

```typescript
const ollamaReasoningModel: Model<'openai-completions'> = {
  id: 'gpt-oss:20b',
  name: 'GPT-OSS 20B (Ollama)',
  api: 'openai-completions',
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131072,
  maxTokens: 32000,
  thinkingLevelMap: {
    minimal: null,
    low: null,
    medium: null,
    high: 'high',
    xhigh: null,
  },
  compat: {
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
  }
};
```

### 直接调用 API 实现

这些 API 实现可以单独导入。每个模块恰好导出 `stream` 和 `streamSimple`，并带有该 API 的完整选项类型。直接调用会绕过 provider auth——请显式传入 `apiKey`：

```typescript
import { stream } from '@earendil-works/pi-ai/api/anthropic-messages';

const s = stream(claudeModel, context, {
  apiKey: process.env.ANTHROPIC_API_KEY,
  thinkingEnabled: true,
  thinkingBudgetTokens: 2048,
});
```

内置 API 实现位于 `./api/<api-id>` 下：

| API id | Options 类型 |
|--------|--------------|
| `anthropic-messages` | `AnthropicOptions` |
| `openai-completions` | `OpenAICompletionsOptions` |
| `openai-responses` | `OpenAIResponsesOptions` |
| `openai-codex-responses` | `OpenAICodexResponsesOptions` |
| `azure-openai-responses` | `AzureOpenAIResponsesOptions` |
| `google-generative-ai` | `GoogleOptions` |
| `google-vertex` | `GoogleVertexOptions` |
| `mistral-conversations` | `MistralOptions` |
| `bedrock-converse-stream` | `BedrockOptions` |

导入一个实现模块会加载其 SDK。`./api/<id>.lazy` wrapper（由 provider 工厂使用）在运行时或 bundler 支持动态 import 分块时，会把该加载推迟到首次请求。旧版本中遗留的原始 API 子路径（`./anthropic`、`./google`、`./mistral`、`./openai-completions` 等）已被移除；请使用 `@earendil-works/pi-ai/api/<api-id>`。

### OpenAI 兼容性设置

`openai-completions` API 由许多 provider 实现，彼此存在细微差异。默认情况下，本库会针对一小组已知的 OpenAI 兼容 provider（Cerebras、xAI、Chutes、DeepSeek、NVIDIA NIM、Together AI、zAi、OpenCode、Cloudflare Workers AI 等）根据 `baseUrl` 自动检测兼容性设置。对于自定义代理或未知端点，你可以通过 `compat` 字段覆盖这些设置。对于 `openai-responses` model，compat 字段支持 Responses 专属的标志。

```typescript
interface OpenAICompletionsCompat {
  supportsStore?: boolean;           // Whether provider supports the `store` field (default: true)
  supportsDeveloperRole?: boolean;   // Whether provider supports `developer` role vs `system` (default: true)
  supportsReasoningEffort?: boolean; // Whether provider supports `reasoning_effort` (default: true)
  supportsUsageInStreaming?: boolean; // Whether provider supports `stream_options: { include_usage: true }` (default: true)
  supportsStrictMode?: boolean;      // Whether provider supports `strict` in tool definitions (default: true)
  supportsOpenAIGrammarTools?: boolean; // Whether to emit OpenAI custom Lark/regex grammar tools; false falls back to normal function tools (default: false; the generated catalog enables it for capable models)
  sendSessionAffinityHeaders?: boolean; // Send session-affinity data from `sessionId` (default: true for OpenRouter, false otherwise)
  sessionAffinityFormat?: 'openai' | 'openai-nosession' | 'openrouter'; // Format for session affinity: 'openai' uses `prompt_cache_key`, `session_id`, `x-client-request-id`, and `x-session-affinity`; 'openai-nosession' uses `prompt_cache_key`, `x-client-request-id`, and `x-session-affinity`; 'openrouter' uses `x-session-id` (default: auto-detected)
  maxTokensField?: 'max_completion_tokens' | 'max_tokens';  // Which field name to use (default: max_completion_tokens)
  requiresToolResultName?: boolean;  // Whether tool results require the `name` field (default: false)
  requiresAssistantAfterToolResult?: boolean; // Whether tool results must be followed by an assistant message (default: false)
  requiresThinkingAsText?: boolean;  // Whether thinking blocks must be converted to text (default: false)
  requiresReasoningContentOnAssistantMessages?: boolean; // Whether all replayed assistant messages must include empty reasoning_content when reasoning is enabled (default: auto-detected for DeepSeek)
  thinkingFormat?: 'openai' | 'openrouter' | 'deepseek' | 'together' | 'baseten' | 'zai' | 'qwen' | 'chat-template' | 'qwen-chat-template' | 'string-thinking' | 'ant-ling'; // Format for reasoning param: 'openai' uses reasoning_effort, 'openrouter' uses reasoning: { effort }, 'deepseek' uses thinking: { type } plus reasoning_effort when supported, 'together' uses reasoning: { enabled } plus reasoning_effort when supported, 'baseten' uses configurable chat_template_args plus reasoning_effort when supported, 'zai' uses thinking: { type }, 'qwen' uses enable_thinking, 'chat-template' uses configurable chat_template_kwargs, 'qwen-chat-template' uses chat_template_kwargs.enable_thinking and preserve_thinking, 'string-thinking' uses top-level thinking, 'ant-ling' uses reasoning: { effort } only for mapped efforts (default: openai)
  chatTemplateKwargs?: Record<string, string | number | boolean | null | { '$var': 'thinking.enabled' | 'thinking.effort' | 'thinking.budget'; omitWhenOff?: boolean }>; // chat_template_kwargs values; use $var for pi-controlled thinking values
  chatTemplateArgs?: Record<string, string | number | boolean | null | { '$var': 'thinking.enabled' | 'thinking.effort' | 'thinking.budget'; omitWhenOff?: boolean }>; // chat_template_args values for thinkingFormat: 'baseten'; use $var for pi-controlled thinking values
  thinkingTokenBudgetField?: 'thinking_token_budget' | 'thinking_budget' | 'thinking_budget_tokens'; // Top-level field that caps reasoning tokens from thinkingBudgets (vLLM / Qwen / llama.cpp). Off by default.
  supportsThinkingTokenBudget?: boolean; // Alias for thinkingTokenBudgetField: 'thinking_token_budget' (vLLM). Prefer thinkingTokenBudgetField. Default: false.
  cacheControlFormat?: 'anthropic';  // Anthropic-style cache_control on system prompt, last tool, and last user/assistant text content
  openRouterRouting?: OpenRouterRouting; // OpenRouter routing preferences (default: {})
  vercelGatewayRouting?: VercelGatewayRouting; // Vercel AI Gateway routing preferences (default: {})
}

interface OpenAIResponsesCompat {
  supportsDeveloperRole?: boolean;   // Whether provider supports `developer` role vs `system` (default: true)
  sessionAffinityFormat?: 'openai' | 'openai-nosession' | 'openrouter'; // Session-affinity header format: 'openai' sends `session_id` and `x-client-request-id`; 'openai-nosession' sends `x-client-request-id`; 'openrouter' sends `x-session-id`. Does not affect the `prompt_cache_key` body param (default: auto-detected)
  supportsLongCacheRetention?: boolean; // Whether provider supports `prompt_cache_retention: "24h"` (default: true)
  supportsStrictMode?: boolean;      // Whether provider supports strict JSON-schema function tools (default: false; enabled in metadata for built-in OpenAI models)
  supportsOpenAIGrammarTools?: boolean; // Whether to emit OpenAI custom Lark/regex grammar tools; false falls back to normal function tools (default: false; the generated catalog enables it for capable models)
}
```

当 prompt caching 启用时，OpenRouter 请求会从 `sessionId` 发送 `x-session-id`。Chat Completions 和 Anthropic Messages 都会自动检测 OpenRouter 端点，除非 `sendSessionAffinityHeaders` 显式为 false。在 Anthropic 兼容的 model 上，`sessionAffinityFormat: "openrouter"` 会选择 `x-session-id`；未设置时，使用现有的 `x-session-affinity` 格式。显式请求 header 优先于生成的 header。

如果未设置 `compat`，本库会回退到基于 URL 的检测。如果 `compat` 只被部分设置，未指定的字段会使用检测到的默认值。这适用于以下情况：

- **LiteLLM 代理**：可能不支持 `store` 字段
- **自定义推理服务器**：可能使用非标准的字段名
- **自托管端点**：可能具有不同的特性支持

## 用于测试的 faux provider

`fauxProvider()` 构建一个内存中的 provider，带有为测试和演示准备的脚本化响应：

```typescript
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai';

const faux = fauxProvider({
  tokensPerSecond: 50 // optional
});

const models = createModels();
models.setProvider(faux.provider);

const model = faux.getModel();
const context = {
  messages: [{ role: 'user', content: 'Summarize package.json and then call echo', timestamp: Date.now() }]
};

faux.setResponses([
  fauxAssistantMessage([
    fauxThinking('Need to inspect package metadata first.'),
    fauxToolCall('echo', { text: 'package.json' })
  ], { stopReason: 'toolUse' })
]);

const first = await models.complete(model, context, {
  sessionId: 'session-1',
  cacheRetention: 'short'
});
context.messages.push(first);

context.messages.push({
  role: 'toolResult',
  toolCallId: first.content.find((block) => block.type === 'toolCall')!.id,
  toolName: 'echo',
  content: [{ type: 'text', text: 'package.json contents here' }],
  isError: false,
  timestamp: Date.now()
});

faux.setResponses([
  fauxAssistantMessage([
    fauxThinking('Now I can summarize the tool output.'),
    fauxText('Here is the summary.')
  ])
]);

const s = models.stream(model, context);
for await (const event of s) {
  console.log(event.type);
}

// Optional: multiple faux models for model-switching tests
const multiModel = fauxProvider({
  provider: 'faux-multi',
  models: [
    { id: 'faux-fast', reasoning: false },
    { id: 'faux-thinker', reasoning: true }
  ]
});
models.setProvider(multiModel.provider);
const thinker = multiModel.getModel('faux-thinker');

console.log(thinker?.reasoning);
console.log(faux.getPendingResponseCount());
console.log(faux.state.callCount);
```

说明：
- 响应按请求开始顺序从队列中消费。
- 如果队列为空，faux provider 会返回一条 assistant error message，其中 `errorMessage: "No more faux responses queued"`。
- 使用 `faux.setResponses([...])` 替换剩余的队列，使用 `faux.appendResponses([...])` 添加更多响应。
- `faux.models` 暴露所有 faux model。`faux.getModel()` 返回第一个，`faux.getModel(id)` 返回指定的那一个。
- 使用 `fauxAssistantMessage(...)` 生成脚本化的 assistant 回复。使用 `fauxText(...)`、`fauxThinking(...)` 和 `fauxToolCall(...)` 构建 content block，无需手动填写低层字段。
- usage 按大约每 4 个字符 1 个 token 估算。当存在 `sessionId` 且 `cacheRetention` 不为 `"none"` 时，prompt cache 的读取和写入会被自动模拟。
- tool call 参数通过 `toolcall_delta` chunk 增量 streaming。
- 默认情况下，每个 streamed chunk 都在自己的 microtask 上发出。设置 `tokensPerSecond` 可实时控制 chunk 的投递节奏。
- 预期用法是每个 handle 对应一个确定性的脚本化流程。如果你需要相互独立的并发流程，请创建具有不同 `provider` id 的独立 faux provider。

## 跨 provider 移交

本库支持在同一对话内不同 LLM provider 之间的无缝移交。这让你可以在对话中途切换 model，同时保留 context，包括 thinking 块、tool call 和工具结果。

当一个 provider 的 message 被发送到另一个不同的 provider 时，本库会自动转换它们以保持兼容：

- **用户 message 和工具结果 message** 原样透传
- **来自同一 provider/API 的 assistant message** 原样保留
- **来自不同 provider 的 assistant message** 其 thinking 块会被转换为带 `<thinking>` 标签的文本
- **tool call 和普通文本** 原样保留

```typescript
import { createModels, type Context } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';

const models = createModels();
models.setProvider(anthropicProvider());
models.setProvider(openaiProvider());
models.setProvider(googleProvider());

const context: Context = { messages: [] };

// Start with Claude
const claude = models.getModel('anthropic', 'claude-sonnet-4-5')!;
context.messages.push({ role: 'user', content: 'What is 25 * 18?', timestamp: Date.now() });
context.messages.push(await models.completeSimple(claude, context, { reasoning: 'medium' }));

// Switch to GPT-5 - it will see Claude's thinking as <thinking> tagged text
const gpt5 = models.getModel('openai', 'gpt-5-mini')!;
context.messages.push({ role: 'user', content: 'Is that calculation correct?', timestamp: Date.now() });
context.messages.push(await models.complete(gpt5, context));

// Switch to Gemini
const gemini = models.getModel('google', 'gemini-2.5-flash')!;
context.messages.push({ role: 'user', content: 'What was the original question?', timestamp: Date.now() });
const geminiResponse = await models.complete(gemini, context);
```

所有 provider 都能处理来自其他 provider 的 message——文本、tool call 与结果（包括图像）、thinking 块（转换为带标签的文本），以及带有部分内容的被中止 message。这实现了灵活的工作流：先用一个快速的 model 开始，遇到复杂 reasoning 时切换到能力更强的 model，或在 provider 故障期间保持连续性。

## Context 序列化

`Context` 对象可以使用标准 JSON 方法轻松地序列化和反序列化，从而让持久化对话、实现 chat history 或在 service 之间传递 context 变得简单：

```typescript
const context: Context = {
  systemPrompt: 'You are a helpful assistant.',
  messages: [
    { role: 'user', content: 'What is TypeScript?', timestamp: Date.now() }
  ]
};

const model = models.getModel('openai', 'gpt-4o-mini')!;
const response = await models.complete(model, context);
context.messages.push(response);

// Serialize the entire context
const serialized = JSON.stringify(context);

// Save to database, localStorage, file, etc.
localStorage.setItem('conversation', serialized);

// Later: deserialize and continue the conversation
const restored: Context = JSON.parse(localStorage.getItem('conversation')!);
restored.messages.push({ role: 'user', content: 'Tell me more about its type system', timestamp: Date.now() });

// Continue with any model
const newModel = models.getModel('anthropic', 'claude-3-5-haiku-20241022')!;
const continuation = await models.complete(newModel, restored);
```

model 也只是普通的可序列化数据——不附带任何函数或实现——因此持久化「这个对话用的是哪个 model」只差一次 `JSON.stringify`。

> **注意**：如果 context 包含图像（如「图像输入」一节所示以 base64 编码），它们也会被序列化。

## 浏览器用法

本库支持浏览器环境。核心入口点和 provider 工厂无副作用，可以干净地打包。浏览器中无法使用环境变量，因此请显式传入 API key——或注入一个 `CredentialStore`（例如由 localStorage 支撑），让 provider auth 从存储的凭据中解析：

```typescript
import { createModels } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';

const models = createModels();
models.setProvider(anthropicProvider());

const model = models.getModel('anthropic', 'claude-3-5-haiku-20241022')!;
const response = await models.complete(model, {
  messages: [{ role: 'user', content: 'Hello!', timestamp: Date.now() }]
}, {
  apiKey: 'your-api-key'
});
```

> **安全警告**：在前端代码中暴露 API key 是危险的。任何人都可以提取并滥用你的 key。仅在内部工具或演示中使用这种方式。对于生产应用，请使用后端代理来保证你的 API key 安全。

浏览器兼容性说明：

- Amazon Bedrock（`bedrock-converse-stream`）在浏览器环境中不受支持。它仍可能出现在 model 列表中；调用会在运行时失败。
- OAuth 登录流程仅限 Node。它们通过 bundler 不可见的 import 惰性加载，因此注册一个支持 OAuth 的 provider 不会把仅限 Node 的代码拉进浏览器 bundle——只有真正登录时才会。
- 如果你需要从 web 应用使用 Bedrock 或基于 OAuth 的 auth，请使用服务端代理或后端 service。

## 打包与 Tree Shaking

为了获得更小的 bundle，只导入你需要的 provider：

```typescript
import { createModels } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';

const models = createModels();
models.setProvider(openaiProvider());
```

规则：

- `@earendil-works/pi-ai` 是核心入口点，不导入内置目录、provider 工厂或 SDK 实现。
- `@earendil-works/pi-ai/providers/<provider>` 只导入该 provider 的目录和惰性 API wrapper。
- `@earendil-works/pi-ai/providers/all` 导入每个内置 provider 工厂以及所有目录。只有在你想要完整的内置集合时才使用它。
- 使用代码分割时，provider SDK 会留在惰性 chunk 中，并在首次请求时加载。
- 不使用代码分割时，bundler 会把可到达的惰性 API 实现折叠进单个 bundle。此时单 provider 的 bundle 会包含该 provider 的 SDK；`providers/all` 会包含所有静态可见的 SDK。Bedrock 是例外：它的 AWS SDK 实现通过 bundler 不可见的、仅限 Node 的 import 加载。
- 直接导入 `@earendil-works/pi-ai/api/<api-id>` 会立即加载该 API 实现及其 SDK。

在新的打包应用中避免使用 `@earendil-works/pi-ai/compat`；它保留了旧的全局 API，并导入完整的内置目录 surface。

对于单文件 Node ESM bundle，某些 SDK 依赖在内部可能仍使用动态 CommonJS `require()`。如果你看到诸如 `Dynamic require of "child_process" is not supported` 的错误，请向 bundle 添加一个 Node `require` shim。使用 esbuild 时：

```bash
esbuild app.js --bundle --platform=node --format=esm \
  --banner:js='import { createRequire } from "module";const require = createRequire(import.meta.url);' \
  --outfile=app.bundle.js
```

这仅适用于 Node bundle；它不是浏览器或 Cloudflare Workers 的变通方案。

Bedrock 仅限 Node。像其他任何 provider 一样添加它：

```typescript
import { createModels } from '@earendil-works/pi-ai';
import { amazonBedrockProvider } from '@earendil-works/pi-ai/providers/amazon-bedrock';

const models = createModels();
models.setProvider(amazonBedrockProvider());
```

在常规的 Node 包用法和代码分割的 bundle 中，Bedrock 会惰性加载其 AWS SDK 实现。对于必须包含 Bedrock 支持的独立单文件 bundle，请显式注册该实现模块：

```typescript
import { setBedrockProviderModule } from '@earendil-works/pi-ai/api/bedrock-converse-stream.lazy';
import { bedrockProviderModule } from '@earendil-works/pi-ai/bedrock-provider';

setBedrockProviderModule(bedrockProviderModule);
```

该显式覆盖会打包 AWS SDK。若不这样做，Bedrock 不可见的运行时 import 会期望该包的 Bedrock 实现文件在运行时可用。

### provider 作用域的环境覆盖

在 stream options 中传入 `env`，可把 provider 配置限定到某次请求。对于 provider auth 以及 Cloudflare account ID、Azure OpenAI 设置、Vertex project/location、Bedrock 设置、`PI_CACHE_RETENTION` 和 `HTTP_PROXY`/`HTTPS_PROXY` 之类的配置，`env` 中的值会先于进程环境变量被使用。

```typescript
const models = builtinModels();
const model = models.getModel('cloudflare-ai-gateway', 'workers-ai/@cf/moonshotai/kimi-k2.6')!;

const response = await models.complete(model, context, {
  env: {
    CLOUDFLARE_API_KEY: '...',
    CLOUDFLARE_ACCOUNT_ID: 'account-id',
    CLOUDFLARE_GATEWAY_ID: 'gateway-id'
  }
});
```

当一个进程需要为每次请求使用不同的 provider 设置，或者当环境中的环境变量不应泄漏到 provider 调用中时，请使用它。

## OAuth provider

多个 provider 支持 OAuth 认证，而不使用静态 API key：

- **Anthropic**（Claude Pro/Max 订阅）
- **OpenAI Codex**（ChatGPT Plus/Pro 订阅，可访问 GPT-5.x Codex model）
- **GitHub Copilot**（Copilot 订阅）
- **OpenRouter**（OAuth PKCE，会铸造一个由用户控制的 API key）

这些 provider 中的每一个都在 `provider.auth.oauth` 上带有一个 `OAuthAuth`，并具有三个操作：`login(interaction)` 使用 provider 中立的 `AuthInteraction.prompt()`/`notify()` 协议并返回一个凭据；`refresh(credential, signal)` 在适用时刷新即将过期的凭据；`toAuth(credential)` 派生请求 auth（GitHub Copilot 按账号区分的 base URL 就来自这里）。provider 的登录 interaction 和 refresh 调用总是携带一个具体的 abort signal。刷新是自动的：`models.getAuth(providerId)` 和请求路径会在凭据存储锁之下刷新已过期的 token，因此并发的请求和进程无法进行双重刷新。OpenRouter 的 OAuth 流程则返回一个永久 API key，因此其 refresh 操作是 no-op。

```typescript
import { createModels } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';

const models = createModels({ credentials: myStore }); // persistent CredentialStore
models.setProvider(anthropicProvider());

// Login: Models drives the flow and persists the credential
await models.login('anthropic', 'oauth', {
  prompt: async (p) => {
    // p.type: 'text' | 'secret' | 'select' | 'manual_code'
    // manual_code prompts race a local callback server; p.signal aborts them when the server wins
    return await askUser(p.message);
  },
  notify: (event) => {
    // event.type: 'info' | 'auth_url' | 'device_code' | 'progress'
    if (event.type === 'info') {
      console.log(event.message);
      for (const link of event.links ?? []) console.log(`${link.label ?? 'More information'}: ${link.url}`);
    }
    if (event.type === 'auth_url') console.log(`Open: ${event.url}`);
    if (event.type === 'device_code') console.log(`Code: ${event.userCode} at ${event.verificationUri}`);
    if (event.type === 'progress') console.log(event.message);
  },
});

// From here on, requests resolve and refresh the token automatically
const model = models.getModel('anthropic', 'claude-sonnet-4-5')!;
await models.complete(model, context);

// Logout
await models.logout('anthropic');
```

### Vertex AI

Vertex AI model 支持 Google Cloud API key 或 Application Default Credentials (ADC)。其 provider 自有的 API-key 登录流程可以配置这两种方式：

- **API key**：设置 `GOOGLE_CLOUD_API_KEY` 或在调用选项中传入 `apiKey`。
- **本地开发（ADC）**：运行 `gcloud auth application-default login`
- **CI/生产环境（ADC）**：设置 `GOOGLE_APPLICATION_CREDENTIALS` 指向一个 service account JSON key 文件

使用 ADC 时，还需设置 `GOOGLE_CLOUD_PROJECT`（或 `GCLOUD_PROJECT`）和 `GOOGLE_CLOUD_LOCATION`。你也可以在调用选项中传入 `project`/`location`。使用 `GOOGLE_CLOUD_API_KEY` 时，`project` 和 `location` 不是必需的。

```bash
# Local (uses your user credentials)
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT="my-project"
export GOOGLE_CLOUD_LOCATION="us-central1"

# CI/Production (service account key file)
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"
```

官方文档：[Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials)

### CLI 登录

最快的认证方式：

```bash
npx @earendil-works/pi-ai login              # interactive provider selection
npx @earendil-works/pi-ai login anthropic    # login to specific provider
npx @earendil-works/pi-ai list               # list available providers
```

凭据会保存到当前目录下的 `auth.json`。

### 以编程方式使用 OAuth

内置的登录和刷新流程是 provider 的私有实现。请使用 provider 自有的 `OAuthAuth`，它可以与 `CredentialStore` 组合，并通过 `Models` 获得带锁的自动刷新。`@earendil-works/pi-ai/oauth` 入口点仅保留 coding-agent 扩展 OAuth 兼容性所需的类型声明。

provider 说明：

**OpenAI Codex**：需要 ChatGPT Plus 或 Pro 订阅。提供对 GPT-5.x Codex model 的访问，具有扩展的 context window 和 reasoning 能力。当在 stream options 中提供 `sessionId` 时，本库会自动处理基于 session 的 prompt caching，除非 `cacheRetention` 为 `"none"`。你可以在 stream options 中把 `transport` 设为 `"sse"`、`"websocket"` 或 `"auto"`，以选择 Codex Responses 传输方式。当使用 WebSocket 并带有 `sessionId` 且启用了 cache retention 时，连接会按 session 复用，并在闲置 5 分钟后过期。

**Azure OpenAI (Responses)**：仅使用 Responses API。设置 `AZURE_OPENAI_API_KEY` 以及 `AZURE_OPENAI_BASE_URL` 或 `AZURE_OPENAI_RESOURCE_NAME` 之一。`AZURE_OPENAI_BASE_URL` 同时支持 `https://<resource>.openai.azure.com` 和 `https://<resource>.cognitiveservices.azure.com`；根端点会自动规范化为 `.../openai/v1`。如有需要，可使用 `AZURE_OPENAI_API_VERSION`（默认为 `v1`）覆盖 API 版本。部署名默认被视为 model ID，可用 `azureDeploymentName` 或 `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` 覆盖，后者使用以逗号分隔的 `model-id=deployment` 对（例如 `gpt-4o-mini=my-deployment,gpt-4o=prod`）。基于部署的旧式 URL 被有意设为不支持。

**GitHub Copilot**：如果你遇到 "The requested model is not supported" 错误，请在 VS Code 中手动启用该 model：打开 Copilot Chat，点击 model 选择器，选择该 model（警告图标），然后点击 "Enable"。

## 从旧的全局 API 迁移

较早的版本暴露了一个全局 API：通过全局注册表按 `model.api` 分派的 `stream()`/`complete()`、同步的 `getModel()`/`getModels()`/`getProviders()` 目录读取、`registerApiProvider()`、`getEnvApiKey()`，以及各 API 的惰性 stream 函数。该 surface 原封不动地存在于 **compat 入口点** 上：

```typescript
// Before
import { getModel, complete } from '@earendil-works/pi-ai';

// After (verbatim behavior, one import-path change)
import { getModel, complete } from '@earendil-works/pi-ai/compat';
```

Compat 是根入口点的严格超集，因此一个文件可以整体切换其 import 路径。它将在未来的版本中被移除；请迁移到 `createModels()` + provider 工厂：

| 旧 | 新 |
|-----|-----|
| `getModel('openai', 'gpt-4o-mini')` | `models.getModel('openai', 'gpt-4o-mini')` 或来自 `providers/all` 的 `getBuiltinModel()` |
| `getModels('anthropic')` / `getProviders()` | `models.getModels('anthropic')` / `models.getProviders()` 或 `getBuiltin*` |
| `stream(model, ctx, opts)`（env-key 注入） | `models.stream(model, ctx, opts)`（provider auth 解析） |
| `registerApiProvider({ api, stream, streamSimple })` | `createProvider({ id, auth, models, api })` + `models.setProvider()` |
| `getEnvApiKey('openai')` | `await models.getAuth(model.provider)` |
| `streamAnthropic(model, ctx, opts)` | 来自 `@earendil-works/pi-ai/api/anthropic-messages` 的 `stream`，或集合中的某个 provider |
| `registerFauxProvider()` | `fauxProvider()` + `models.setProvider()` |

## 开发

### 添加新 provider

添加一个新的 LLM provider 需要在多个文件中进行修改。分层布局为：API 实现位于 `src/api/`，provider 工厂位于 `src/providers/`，稳定的生成目录 wrapper 位于 `src/providers/<id>.models.ts`，而 `src/models.generated.ts` 负责注册它们。本清单涵盖了所有必要的步骤：

#### 1. 核心类型（`src/types.ts`）

- 如果是新的 API，把该 API 标识符添加到 `KnownApi`（例如 `"bedrock-converse-stream"`）
- 把 provider 名称添加到 `KnownProvider`（例如 `"amazon-bedrock"`）
- 把 options 类型添加到 `ApiOptionsMap`

#### 2. API 实现（`src/api/<api-id>.ts`，仅针对新 API）

创建一个新的 API 实现文件（例如 `bedrock-converse-stream.ts`），它恰好导出 `stream` 和 `streamSimple`，外加：

- 一个扩展 `StreamOptions` 的 options 接口（例如 `BedrockOptions`）
- 用于把 `Context` 转换为 provider 格式的 message 转换函数
- 如果 provider 支持工具，则进行 tool 转换
- 解析响应以发出标准化事件（`text`、`tool_call`、`thinking`、`usage`、`stop`）

添加一个惰性 wrapper `src/api/<api-id>.lazy.ts`（通过 `lazyApi()` 得到 `<name>Api()`），这样 provider 可以在不导入其 SDK 的情况下引用该实现。在 `src/index.ts` 中添加任何应继续可从 `@earendil-works/pi-ai` 使用的根级 `export type` 重导出。

#### 3. model 生成（`scripts/generate-models.ts`、`scripts/generate-image-models.ts`）

- 添加从 provider 的来源（例如 models.dev API）抓取并解析 model 的逻辑
- 通过 `scripts/generate-models.ts` 把支持 chat/tool 的 provider model 数据映射到标准化的 `Model` 接口；hydration 按 API 对被忽略的 `src/providers/data/<id>.json` 值进行分组，而稳定的 `src/providers/<id>.models.ts` wrapper 直接从这些 JSON 键派生精确的 model/API 类型
- 通过 `scripts/generate-image-models.ts` 把图像生成 provider 的 model 数据映射到标准化的 `ImagesModel` 接口
- 处理 provider 专属的特殊情况（定价格式、能力标志、model ID 转换）

#### 4. provider 工厂（`src/providers/<id>.ts`）

- `createProvider()` 把目录 + auth + 惰性 API wrapper 连接起来
- Auth：标准 key provider 使用 `envApiKeyAuth`，环境 auth（AWS profile、ADC）使用自定义的 `ApiKeyAuth`，存在 OAuth 流程的地方使用 `lazyOAuth`
- 在 `src/providers/all.ts` 中注册该工厂
- 如果是新的 API：在 `src/compat.ts` 的内置列表中注册它，并在 `package.json` 中添加包的子路径导出

#### 5. 测试（`test/`）

创建或更新测试文件以覆盖新的 provider：

- `stream.test.ts` - 基础 streaming 与工具使用
- `tokens.test.ts` - token 用量报告
- `abort.test.ts` - 请求取消
- `empty.test.ts` - 空 message 处理
- `context-overflow.test.ts` - Context 上限错误
- `image-limits.test.ts` - 图像支持（如适用）
- `unicode-surrogate.test.ts` - Unicode 处理
- `tool-call-without-result.test.ts` - 孤立的 tool call
- `image-tool-result.test.ts` - 工具结果中的图像
- `total-tokens.test.ts` - token 计数准确性
- `cross-provider-handoff.test.ts` - 跨 provider 的 context 重放
- `providers.test.ts` - provider 列举与 auth 解析

对于 `cross-provider-handoff.test.ts`，至少添加一对 provider/model。如果该 provider 暴露多个 model 家族（例如 GPT 和 Claude），则每个家族至少添加一对。

对于使用非标准 auth 的 provider（AWS、Google Vertex），创建一个类似 `bedrock-utils.ts` 的工具，其中包含凭据检测辅助函数。

#### 6. Coding Agent 集成（`../coding-agent/`）

更新 `src/core/model-resolver.ts`：

- 在 `DEFAULT_MODELS` 中为该 provider 添加默认 model ID

更新 `src/cli/args.ts`：

- 在帮助文本中添加环境变量文档

更新 `README.md`：

- 把该 provider 添加到 providers 章节，并附上设置说明

#### 7. 文档

更新 `packages/ai/README.md`：

- 添加到 Supported Providers 表
- 记录任何 provider 专属的选项或认证要求
- 在 Environment Variables 章节中添加环境变量

#### 8. 变更日志

在 `packages/ai/CHANGELOG.md` 的 `## [Unreleased]` 下添加一条条目：

```markdown
### Added
- Added support for [Provider Name] provider ([#PR](link) by [@author](link))
```

## 许可证

MIT

