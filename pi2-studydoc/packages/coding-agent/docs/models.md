# 自定义模型

通过 `~/.pi/agent/models.json` 添加自定义 provider 和模型（Ollama、vLLM、LM Studio、代理）。

## 目录

- [最小示例](#minimal-example)
- [完整示例](#full-example)
- [支持的 API](#supported-apis)
- [Provider 配置](#provider-configuration)
- [模型配置](#model-configuration)
- [覆盖内置 Provider](#overriding-built-in-providers)
- [逐模型覆盖](#per-model-overrides)
- [Anthropic Messages 兼容性](#anthropic-messages-compatibility)
- [OpenAI 兼容性](#openai-compatibility)

## 最小示例

对于本地模型（Ollama、LM Studio、vLLM），每个模型只需提供 `id`：

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "llama3.1:8b" },
        { "id": "qwen2.5-coder:7b" }
      ]
    }
  }
}
```

`apiKey` 的值是一个占位符，因为 Ollama 会忽略它。pi 仍然认为模型需要认证后才会出现在 `/model` 中，因此无 key 的本地服务器应保留一个 dummy 值、用 `/login` 为该 provider 保存一个 key，或在选择该模型时传入 `--api-key`。

一些 OpenAI 兼容服务器不理解用于具备推理能力的模型的 `developer` role。对于这些 provider，将 `compat.supportsDeveloperRole` 设为 `false`，这样 pi 会把 system prompt 作为 `system` message 发送。如果该服务器同时也不支持 `reasoning_effort`，再将 `compat.supportsReasoningEffort` 设为 `false`。

你可以在 provider 层级设置 `compat` 以应用于所有模型，也可以在模型层级设置以覆盖特定模型。这通常适用于 Ollama、vLLM、SGLang 以及类似的 OpenAI 兼容服务器。

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "gpt-oss:20b",
          "reasoning": true
        }
      ]
    }
  }
}
```

## 完整示例

当你需要特定值时，覆盖默认值：

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        {
          "id": "llama3.1:8b",
          "name": "Llama 3.1 8B (Local)",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 32000,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

每次打开 `/model` 时该文件都会重新加载。在 session 期间编辑即可；无需重启。

## Google AI Studio 示例

使用 `google-generative-ai` 配合 `baseUrl` 来添加来自 Google AI Studio 的模型，包括自定义的 Gemma 4 条目：

```json
{
  "providers": {
    "my-google": {
      "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
      "api": "google-generative-ai",
      "apiKey": "$GEMINI_API_KEY",
      "models": [
        {
          "id": "gemma-4-31b-it",
          "name": "Gemma 4 31B",
          "input": ["text", "image"],
          "contextWindow": 262144,
          "reasoning": true
        }
      ]
    }
  }
}
```

向 `google-generative-ai` API 类型添加自定义模型时，`baseUrl` 是必需的。

## 支持的 API

| API | 描述 |
|-----|-------------|
| `openai-completions` | OpenAI Chat Completions（兼容性最好） |
| `openai-responses` | OpenAI Responses API |
| `anthropic-messages` | Anthropic Messages API |
| `google-generative-ai` | Google Generative AI |

在 provider 层级（作为所有模型的默认值）或模型层级（按模型覆盖）设置 `api`。

## Provider 配置

| 字段 | 描述 |
|-------|-------------|
| `baseUrl` | API endpoint URL |
| `api` | API 类型（见上文） |
| `apiKey` | 可选的 API key 配置（见下方的值解析）。当认证由 `/login`/`auth.json` 或 CLI `--api-key` 提供时，省略它。 |
| `oauth` | 动态 OAuth provider 类型。目前支持 `"radius"`；需要 gateway 的 `baseUrl`。 |
| `headers` | 自定义 headers（见下方的值解析） |
| `authHeader` | 设为 `true` 以自动添加 `Authorization: Bearer <apiKey>` |
| `models` | 模型配置的数组 |
| `modelOverrides` | 对此 provider 上内置或 extension 注册的模型的逐模型覆盖 |

对于带有 `models` 的 provider，非内置的 provider 配置需要在 provider 或模型层级提供 `baseUrl` 和一个 `api` 值。加载该文件并不需要 `apiKey`：当认证通过 `/login`/`auth.json`、CLI `--api-key` 或 provider 的 `apiKey` 配置好后，模型即可用。如果未配置任何认证，模型会加载，但在 `/model` 和 `--list-models` 中保持不可用。

### 值解析

`apiKey` 和 `headers` 字段支持命令执行、环境变量插值和字面量：

- **Shell 命令：** 值开头的 `"!command"` 会把整个值作为命令执行并使用 stdout
  ```json
  "apiKey": "!security find-generic-password -ws 'anthropic'"
  "apiKey": "!op read 'op://vault/item/credential'"
  ```
- **环境变量插值：** `"$ENV_VAR"` 或 `"${ENV_VAR}"` 使用所命名变量的值。插值在更大的字面量内部也有效。
  ```json
  "apiKey": "$MY_API_KEY"
  "apiKey": "${KEY_PREFIX}_${KEY_SUFFIX}"
  ```
  `$FOO_BAR` 表示变量 `FOO_BAR`；当 `BAR` 是字面文本时使用 `${FOO}_BAR`。环境变量缺失会使该值无法解析。
- **转义：** `"$$"` 输出一个字面量 `"$"`；`"$!"` 输出一个字面量 `"!"` 且不会触发命令执行。
  ```json
  "apiKey": "$$literal-dollar-prefix"
  "apiKey": "$!literal-bang-prefix"
  ```
- **字面量值：** 直接使用。诸如 `MY_API_KEY` 这样的纯大写字符串是字面量；环境变量请使用 `$MY_API_KEY`。
  ```json
  "apiKey": "sk-..."
  ```

对于 `models.json`，shell 命令在请求时解析。pi 有意不为任意命令应用内置的 TTL、过期复用或恢复逻辑。不同的命令需要不同的缓存与失败策略，pi 无法推断出正确的那一种。

如果你的命令较慢、开销大、受速率限制，或者在瞬时失败时应继续沿用先前的值，请把它包装进你自己的脚本或命令中，以实现你想要的缓存或 TTL 行为。

`/model` 的可用性检查使用已配置的认证是否存在，不会执行 shell 命令。

### 自定义 Headers

```json
{
  "providers": {
    "custom-proxy": {
      "baseUrl": "https://proxy.example.com/v1",
      "apiKey": "$MY_API_KEY",
      "api": "anthropic-messages",
      "headers": {
        "x-portkey-api-key": "$PORTKEY_API_KEY",
        "x-secret": "!op read 'op://vault/item/secret'"
      },
      "models": [...]
    }
  }
}
```

## 模型配置

| 字段 | 必需 | 默认值 | 描述 |
|-------|----------|---------|-------------|
| `id` | 是 | — | 模型标识符（传递给 API） |
| `name` | 否 | `id` | 人类可读的模型标签。用于匹配（`--model` pattern），并作为次级模型详情文本显示。 |
| `api` | 否 | provider 的 `api` | 为此模型覆盖 provider 的 API |
| `reasoning` | 否 | `false` | 支持扩展思考 |
| `thinkingLevelMap` | 否 | 省略 | 将 pi 的 thinking level 映射到 provider 值，并标记不受支持的 level（见下文） |
| `input` | 否 | `["text"]` | 输入类型：`["text"]` 或 `["text", "image"]` |
| `contextWindow` | 否 | `128000` | 以 token 计的 Context window 大小 |
| `maxTokens` | 否 | `16384` | 最大输出 token 数 |
| `samplingParams` | 否 | 省略 | 原样合并进每个请求体的采样参数（见下文） |
| `cost` | 否 | 全零 | 每百万 token 的费率，并可选择请求级别的输入定价档位 |
| `compat` | 否 | provider 的 `compat` | Provider 兼容性覆盖。当两者都设置时，与 provider 层级的 `compat` 合并。 |

一个 cost 档位提供一整套替代费率，并在总输入用量（`input + cacheRead + cacheWrite`）超过 `inputTokensAbove` 时应用于整个请求。当多个档位匹配时，阈值最高者胜出。

```json
{
  "cost": {
    "input": 5,
    "output": 30,
    "cacheRead": 0.5,
    "cacheWrite": 6.25,
    "tiers": [
      {
        "inputTokensAbove": 272000,
        "input": 10,
        "output": 45,
        "cacheRead": 1,
        "cacheWrite": 12.5
      }
    ]
  }
}
```

当前行为：
- `/model`、`--list-models` 和交互式 footer 按模型 `id` 显示条目。
- 配置的 `name` 用于模型匹配和次级模型详情文本。它不会替换 footer/status-bar 的 model id。

### 采样参数

`samplingParams` 是一个自由形式的对象，会在 pi 自行设置的字段之后原样合并进该模型的每个请求体，因此它的键会胜出。用它来发送 pi 未建模的采样参数——包括服务器特有的参数，例如 llama.cpp 的 `min_p` 或 vLLM 的 `top_k`：

```json
{
  "id": "deepseek-v4-flash",
  "samplingParams": {
    "temperature": 1.0,
    "top_p": 0.95,
    "top_k": 0,
    "min_p": 0.0
  }
}
```

只有 OpenAI 兼容的 API 会应用它（`openai-completions`、`openai-responses`、`azure-openai-responses`）；其他 API 会忽略它。这些键会覆盖 pi 的具名请求字段（例如这里的 `temperature` 键会胜过请求级别的 temperature），因此最好把它当作某个模型采样参数的唯一来源。在 `modelOverrides` 中，`samplingParams` 会按 key 与基础模型的值合并。

这里也可以放一个固定的 thinking token 上限，但它不会遵循 `thinkingBudgets`，也不会为答案留出空间。这种情况请优先使用 `compat.thinkingTokenBudgetField`（或 `supportsThinkingTokenBudget` 别名）。

### Thinking Level Map

在模型上使用 `thinkingLevelMap` 来描述模型特有的思考控制。键是 pi 的 thinking level：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。映射中可以有空洞；例如，一个模型可以暴露 `high` 和 `max` 而不暴露 `xhigh`。

值是三态的：

| 值 | 含义 |
|-------|---------|
| 省略 | 直到 `high` 的标准 level 使用 provider 的默认映射；扩展的 `xhigh` 和 `max` level 不受支持 |
| string | 该 level 受支持，且此值会发送给 provider |
| `null` | 该 level 不受支持，并被隐藏/跳过/钳制掉 |

一个只支持 off、high 和 max reasoning 的模型示例：

```json
{
  "id": "deepseek-v4-pro",
  "reasoning": true,
  "thinkingLevelMap": {
    "minimal": null,
    "low": null,
    "medium": null,
    "high": "high",
    "xhigh": null,
    "max": "max"
  }
}
```

一个无法禁用思考的模型示例：

```json
{
  "id": "always-thinking-model",
  "reasoning": true,
  "thinkingLevelMap": {
    "off": null
  }
}
```

迁移：使用 `compat.reasoningEffortMap` 的旧配置应把该映射迁移到模型层级的 `thinkingLevelMap`。对于不应出现在 UI 中的 level，使用 `null`。

## 覆盖内置 Provider

让内置 provider 经由代理路由，而无需重新定义模型：

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://my-proxy.example.com/v1"
    }
  }
}
```

所有内置的 Anthropic 模型仍然可用。现有的 OAuth 或 API key 认证继续有效。

要将自定义模型合并进内置 provider，请包含 `models` 数组：

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://my-proxy.example.com/v1",
      "apiKey": "$ANTHROPIC_API_KEY",
      "api": "anthropic-messages",
      "models": [...]
    }
  }
}
```

合并语义：
- 内置模型会被保留。
- 自定义模型在 provider 内按 `id` upsert。
- 如果自定义模型的 `id` 与某个内置模型的 `id` 匹配，自定义模型会替换该内置模型。
- 如果自定义模型的 `id` 是新的，它会与内置模型一起被添加。

## 逐模型覆盖

使用 `modelOverrides` 自定义内置模型以及匹配的 extension 注册模型，而无需替换 provider 的完整模型列表。

```json
{
  "providers": {
    "openrouter": {
      "modelOverrides": {
        "anthropic/claude-sonnet-4": {
          "name": "Claude Sonnet 4 (Bedrock Route)",
          "compat": {
            "openRouterRouting": {
              "only": ["amazon-bedrock"]
            }
          }
        }
      }
    }
  }
}
```

`modelOverrides` 支持每个模型的这些字段：`name`、`reasoning`、`thinkingLevelMap`、`input`、`cost`（部分）、`contextWindow`、`maxTokens`、`samplingParams`（按 key 合并）、`headers`、`compat`。

直连的 OpenAI GPT-5.6 Sol、Terra 和 Luna 默认使用 `272000` 的 Context window，以便请求保持在 OpenAI 的短上下文定价档位内。要选择启用 OpenAI 的 1.05M Context window，请为你使用的每个模型调大它：

```json
{
  "providers": {
    "openai": {
      "modelOverrides": {
        "gpt-5.6-sol": {
          "contextWindow": 1050000
        }
      }
    }
  }
}
```

该覆盖会保留内置的定价元数据。总输入 token 超过 272K 的请求会对整个请求使用 GPT-5.6 的长上下文费率。需要时，对 `gpt-5.6-terra` 或 `gpt-5.6-luna` 应用相同的覆盖。

行为说明：
- `modelOverrides` 会应用于内置 provider 的模型以及匹配的 extension 注册 provider 模型。
- 未知的模型 ID 会被忽略。
- 你可以将 provider 层级的 `baseUrl`/`headers` 与 `modelOverrides` 组合使用。
- 覆盖 `name` 只会改变模型匹配和次级详情文本；footer 和主模型列表继续显示模型的 `id`。
- 如果某个 provider 还定义了 `models`，自定义模型会在内置覆盖之后合并。`id` 相同的自定义模型会替换被覆盖的内置模型条目。

## Anthropic Messages 兼容性

对于使用 `api: "anthropic-messages"` 的 provider 或代理，使用 `compat` 来控制 Anthropic 特有的请求兼容性。

默认情况下，pi 会发送每个 tool 的 `eager_input_streaming: true`。如果某个代理或 Anthropic 兼容后端拒绝该字段，请将 `supportsEagerToolInputStreaming` 设为 `false`。这样 Pi 会省略 `tools[].eager_input_streaming`，改为对启用 tool 的请求发送旧版的 `fine-grained-tool-streaming-2025-05-14` beta header。

一些 Anthropic 模型需要自适应思考（`thinking.type: "adaptive"` 加 `output_config.effort`），而不是旧的基于 budget 的 thinking payload。内置模型会自动设置这一点。对于路由到这些模型的自定义 provider 或别名，请将 `forceAdaptiveThinking` 设为 `true`。

支持逐 turn effort 的 Claude 模型使用 `supportsMidConvoEffort`。Pi 随后会持久化每个响应的 provider effort，在后续请求中重建仅含 effort 的 system message，并发送带有 `prefix_mismatch_behavior: "drop_block"` 的 thinking 绑定控制，以避免过期的已签名 thinking 前缀导致持续的 400 响应。仅对忠实实现 Anthropic Messages 传输层的、确切受支持的那个 Claude 模型设置此项；不要对仅仅模仿 Messages 形态的 API 启用它。

一些 Anthropic 兼容的 provider 会发出签名为空的 thinking block，并且仍然期望在重放时带上它们。仅对这些 provider 将 `allowEmptySignature` 设为 `true`；真正的 Anthropic 会拒绝空的 thinking 签名。

内置的 Anthropic 模型在其模型元数据中启用了 `supportsStrictTools`。当自定义的 Anthropic 兼容模型的 endpoint 接受严格的 JSON-schema tool 定义时，必须将其设为 `true`。

```json
{
  "providers": {
    "anthropic-proxy": {
      "baseUrl": "https://proxy.example.com",
      "api": "anthropic-messages",
      "apiKey": "$ANTHROPIC_PROXY_KEY",
      "compat": {
        "supportsEagerToolInputStreaming": false,
        "supportsLongCacheRetention": true,
        "forceAdaptiveThinking": true,
        "allowEmptySignature": true
      },
      "models": [
        {
          "id": "claude-opus-4-7",
          "reasoning": true,
          "input": ["text", "image"]
        }
      ]
    }
  }
}
```

| 字段 | 描述 |
|-------|-------------|
| `supportsEagerToolInputStreaming` | provider 是否接受每个 tool 的 `eager_input_streaming`。默认值：`true`。设为 `false` 以省略该字段，并在启用 tool 的请求上使用旧版的 fine-grained tool streaming beta header。 |
| `supportsLongCacheRetention` | 当 cache retention 为 `long` 时，provider 是否接受 Anthropic 的长缓存保留（`cache_control.ttl: "1h"`）。默认值：`true`。 |
| `sendSessionAffinityHeaders` | 当缓存启用时，是否从 session id 发送 `x-session-affinity`。默认值：对已知 provider 自动检测。 |
| `supportsCacheControlOnTools` | provider 是否接受 tool 定义上的 Anthropic 风格 `cache_control` 标记。默认值：`true`。 |
| `forceAdaptiveThinking` | 是否为此模型发送自适应思考（`thinking.type: "adaptive"` 加 `output_config.effort`）。内置的自适应模型会自动设置此项。默认值：`false`。 |
| `supportsMidConvoEffort` | 确切的 Claude 模型传输层是否支持逐 turn effort 的 system message 以及 thinking 绑定控制。Pi 会持久化原生 effort level，并在启用时始终发送 `drop_block`。默认值：`false`。 |
| `allowEmptySignature` | 是否将空的 thinking 签名重放为 `signature: ""`，而不是把 thinking 转换为文本。默认值：`false`。 |
| `supportsStrictTools` | provider 是否接受严格的 JSON-schema tool 定义。默认值：`false`；内置的 Anthropic 模型在生成的元数据中启用它。 |

## OpenAI 兼容性

对于具有部分 OpenAI 兼容性的 provider，使用 `compat` 字段。

- Provider 层级的 `compat` 为该 provider 下的所有模型应用默认值。
- 模型层级的 `compat` 为该模型覆盖 provider 层级的值。

```json
{
  "providers": {
    "local-llm": {
      "baseUrl": "http://localhost:8080/v1",
      "api": "openai-completions",
      "compat": {
        "supportsUsageInStreaming": false,
        "maxTokensField": "max_tokens"
      },
      "models": [...]
    }
  }
}
```

| 字段 | 描述 |
|-------|-------------|
| `supportsStore` | provider 支持 `store` 字段 |
| `supportsDeveloperRole` | 使用 `developer` 还是 `system` role |
| `supportsReasoningEffort` | 对 `reasoning_effort` 参数的支持 |
| `supportsUsageInStreaming` | 支持 `stream_options: { include_usage: true }`（默认值：`true`） |
| `supportsFinishReason` | 流式响应是否包含 `finish_reason`。当为 `false` 时，pi 会在流结束时推断为 `stop` 或 `toolUse`。默认值：`true`。 |
| `maxTokensField` | 使用 `max_completion_tokens` 还是 `max_tokens` |
| `requiresToolResultName` | 在 tool result message 上包含 `name` |
| `requiresAssistantAfterToolResult` | 在 tool result 之后、user message 之前插入一条 assistant message |
| `requiresThinkingAsText` | 将 thinking block 转换为纯文本 |
| `requiresReasoningContentOnAssistantMessages` | 当 reasoning 启用时，在所有重放的 assistant message 上包含空的 `reasoning_content` |
| `thinkingFormat` | 使用 `reasoning_effort`、`openrouter`、`deepseek`、`together`、`baseten`、`zai`、`qwen`、`chat-template` 或 `qwen-chat-template` 的 thinking 参数 |
| `chatTemplateKwargs` | 用于 `thinkingFormat: "chat-template"` 的 `chat_template_kwargs` 值；对 pi 控制的 thinking 值使用 `{ "$var": "thinking.enabled" }`、`{ "$var": "thinking.effort" }` 或 `{ "$var": "thinking.budget" }` |
| `chatTemplateArgs` | 用于 `thinkingFormat: "baseten"` 的 `chat_template_args` 值；对 pi 控制的 thinking 值使用 `{ "$var": "thinking.enabled" }`、`{ "$var": "thinking.effort" }` 或 `{ "$var": "thinking.budget" }` |
| `thinkingTokenBudgetField` | 用于依据 `thinkingBudgets` 限制 reasoning token 的顶层请求字段，会被钳制以至少为答案保留 1024 个 token。`"thinking_token_budget"`（vLLM）、`"thinking_budget"`（Qwen/DashScope/SGLang）、`"thinking_budget_tokens"`（llama.cpp）。默认关闭；不会设置在生成的 catalog 上。 |
| `supportsThinkingTokenBudget` | `thinkingTokenBudgetField: "thinking_token_budget"`（vLLM）的别名。优先使用 `thinkingTokenBudgetField`。默认值：`false`。 |
| `cacheControlFormat` | 在 system prompt、最后一个 tool 定义，以及最后一个 user、assistant 或 tool-result 文本内容上使用 Anthropic 风格的 `cache_control` 标记。目前仅支持 `anthropic`。 |
| `sendSessionAffinityHeaders` | 对于 `openai-completions`，当缓存启用时从 session id 发送 session-affinity header。默认值：`false`。 |
| `sessionAffinityFormat` | 对于 `openai-completions` 和 `openai-responses`，session-affinity header 的格式：`openai` 发送 `session_id`/`x-client-request-id`（completions 还会发送 `x-session-affinity`），`openai-nosession` 省略含下划线的 `session_id` header，`openrouter` 发送 `x-session-id`。不影响 `prompt_cache_key` body 参数。默认值：自动检测。 |
| `supportsStrictMode` | provider 是否接受严格的 JSON-schema function tool 定义。默认值取决于 API；内置的 OpenAI 模型带有明确的能力元数据。 |
| `supportsOpenAIGrammarTools` | OpenAI 兼容的 API 是否发出自定义的 Lark/regex grammar tool。当为 `false` 时，受 grammar 约束的 tool 会回退为普通的 function tool。默认值：`false`；内置的模型 catalog 会在 OpenAI、OpenAI Codex、Azure OpenAI、GitHub Copilot、opencode 和 Cloudflare AI Gateway 上为 GPT-5+ 模型启用它。 |
| `deferredToolsMode` | 使用 provider 特有的 deferred tool 序列化。目前仅支持 `"kimi"`，用于 Kimi 的 OpenAI 兼容 Chat Completions 格式。 |
| `supportsLongCacheRetention` | 当 cache retention 为 `long` 时，provider 是否接受长缓存保留：对 GPT-5.6+ Responses 模型为 `prompt_cache_options.ttl: "30m"`，对更早的 OpenAI 模型为 `prompt_cache_retention: "24h"`，或者当 `cacheControlFormat` 为 `anthropic` 时为 `cache_control.ttl: "1h"`。默认值：`true`。 |
| `openRouterRouting` | OpenRouter provider 路由偏好。该对象会原样发送在 [OpenRouter API request](https://openrouter.ai/docs/guides/routing/provider-selection) 的 `provider` 字段中。 |
| `vercelGatewayRouting` | 用于 provider 选择的 Vercel AI Gateway 路由配置（`only`、`order`） |

`openrouter` 使用 `reasoning: { effort }`。`together` 使用 `reasoning: { enabled }`，并在 `supportsReasoningEffort` 启用时还使用 `reasoning_effort`。`qwen` 使用顶层的 `enable_thinking`。对于需要 `chat_template_kwargs.enable_thinking` 和 `preserve_thinking` 的本地 Qwen 兼容服务器，使用 `qwen-chat-template`。对于需要可配置 `chat_template_kwargs` 的 vLLM/Hugging Face chat template，使用 `chat-template`，例如针对 DeepSeek V3.x template 的 `chatTemplateKwargs: { "thinking": { "$var": "thinking.enabled" } }`。对于通过 `chat_template_args` 暴露开关控制、并可选支持顶层 `reasoning_effort` 的 provider，使用 `thinkingFormat: "baseten"` 配合 `chatTemplateArgs`。

`thinkingTokenBudgetField` 独立于 `thinkingFormat`。不要在生成的 Qwen catalog 上启用它：那些模型已经发送 `reasoning_effort`，而 DashScope 会拒绝 `thinking_budget` 与 `reasoning_effort` 同时出现。

`cacheControlFormat: "anthropic"` 用于那些通过文本内容和 tool 定义上的 `cache_control` 标记来暴露 Anthropic 风格 prompt caching 的 OpenAI 兼容 provider。

示例：

```json
{
  "providers": {
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "$OPENROUTER_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "openrouter/anthropic/claude-3.5-sonnet",
          "name": "OpenRouter Claude 3.5 Sonnet",
          "compat": {
            "openRouterRouting": {
              "allow_fallbacks": true,
              "require_parameters": false,
              "data_collection": "deny",
              "zdr": true,
              "enforce_distillable_text": false,
              "order": ["anthropic", "amazon-bedrock", "google-vertex"],
              "only": ["anthropic", "amazon-bedrock"],
              "ignore": ["gmicloud", "friendli"],
              "quantizations": ["fp16", "bf16"],
              "sort": {
                "by": "price",
                "partition": "model"
              },
              "max_price": {
                "prompt": 10,
                "completion": 20
              },
              "preferred_min_throughput": {
                "p50": 100,
                "p90": 50
              },
              "preferred_max_latency": {
                "p50": 1,
                "p90": 3,
                "p99": 5
              }
            }
          }
        }
      ]
    }
  }
}
```

Vercel AI Gateway 示例：

```json
{
  "providers": {
    "vercel-ai-gateway": {
      "baseUrl": "https://ai-gateway.vercel.sh/v1",
      "apiKey": "$AI_GATEWAY_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "moonshotai/kimi-k2.5",
          "name": "Kimi K2.5 (Fireworks via Vercel)",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": { "input": 0.6, "output": 3, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 262144,
          "maxTokens": 262144,
          "compat": {
            "vercelGatewayRouting": {
              "only": ["fireworks", "novita"],
              "order": ["fireworks", "novita"]
            }
          }
        }
      ]
    }
  }
}
```
