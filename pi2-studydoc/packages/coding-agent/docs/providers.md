# Providers

Pi 支持通过 OAuth 使用基于 subscription 的 providers，也支持通过环境变量或 auth 文件使用 API key providers。内置 catalog 随 pi 一起发布；已配置的 providers 可以刷新更新的 catalogs 并将其缓存到 `~/.pi/agent/models-store.json` 以供离线使用。

## 目录

- [Subscriptions](#subscriptions)
- [API Keys](#api-keys)
- [Auth 文件](#auth-file)
- [Cloud Providers](#cloud-providers)
- [llama.cpp](#llamacpp)
- [自定义 Providers](#custom-providers)
- [解析顺序](#resolution-order)

## Subscriptions

在交互模式下使用 `/login`，然后选择一个 provider：

- ChatGPT Plus/Pro (Codex)
- Claude Pro/Max
- GitHub Copilot
- xAI（Grok/X subscription）
- OpenRouter（由 OAuth 生成的 API key，从 OpenRouter 额度计费）
- Radius

使用 `/logout` 清除凭据。Tokens 存储在 `~/.pi/agent/auth.json` 中，并在过期时自动刷新。OpenRouter 则改为生成一个由用户控制的 API key，它不会自动过期。

### OpenAI Codex

- 需要 ChatGPT Plus 或 Pro subscription
- 得到 OpenAI 官方认可：[Codex for OSS](https://developers.openai.com/community/codex-for-oss)

### Claude Pro/Max

Anthropic subscription auth 对 Claude Pro/Max 账号处于启用状态。第三方 harness 的使用量来自 [extra usage](https://claude.ai/settings/usage)，按 token 计费，而不占用 Claude 套餐限额。

### GitHub Copilot

- 直接按 Enter 使用 github.com，或输入你的 GitHub Enterprise Server 域名
- 如果出现 "model not supported"，请在 VS Code 中启用它：Copilot Chat → model selector → select model → "Enable"

### xAI（Grok/X subscription）

- 运行 `/login xai`，然后选择 **Use a subscription**
- `XAI_API_KEY` 仍可通过 **Use an API key** 使用

### OpenRouter

- 运行 `/login openrouter`，然后选择 **Sign in with OpenRouter** 以打开 OpenRouter PKCE 授权流程
- 该授权会创建一个由用户控制的 OpenRouter API key，从你的 OpenRouter 额度计费
- 在远程/无头机器上（例如通过 SSH），浏览器无法访问 loopback 回调；请改为将最终重定向 URL（或授权码）粘贴到登录提示中
- `OPENROUTER_API_KEY` 仍可通过 **Use an API key** 使用

### Radius

Radius 是一个动态的 `pi-messages` gateway。`/login radius` 将 OAuth tokens 存储在 `auth.json` 中；gateway catalog 独立刷新并缓存到 `models-store.json`。自定义 Radius gateways 可以在 `models.json` 中用 `"oauth": "radius"` 和一个 gateway `baseUrl` 声明。

## API Keys

### 环境变量或 Auth 文件

在交互模式下使用 `/login` 并选择一个 provider，将 API key 存储到 `auth.json`，或通过环境变量设置凭据：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pi
```

| Provider | 环境变量 | `auth.json` 键 |
|----------|----------------------|------------------|
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic` |
| Ant Ling | `ANT_LING_API_KEY` | `ant-ling` |
| Azure OpenAI Responses | `AZURE_OPENAI_API_KEY` | `azure-openai-responses` |
| OpenAI | `OPENAI_API_KEY` | `openai` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek` |
| NVIDIA NIM | `NVIDIA_API_KEY` | `nvidia` |
| Google Gemini | `GEMINI_API_KEY` | `google` |
| Amazon Bedrock | `AWS_BEARER_TOKEN_BEDROCK` | `amazon-bedrock` |
| Mistral | `MISTRAL_API_KEY` | `mistral` |
| Groq | `GROQ_API_KEY` | `groq` |
| Cerebras | `CEREBRAS_API_KEY` | `cerebras` |
| Cloudflare AI Gateway | `CLOUDFLARE_API_KEY` (+ `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_GATEWAY_ID`) | `cloudflare-ai-gateway` |
| Cloudflare Workers AI | `CLOUDFLARE_API_KEY` (+ `CLOUDFLARE_ACCOUNT_ID`) | `cloudflare-workers-ai` |
| xAI | `XAI_API_KEY` | `xai` |
| OpenRouter | `OPENROUTER_API_KEY` | `openrouter` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` | `vercel-ai-gateway` |
| ZAI Coding Plan (Global) | `ZAI_API_KEY` | `zai` |
| ZAI Coding Plan (China) | `ZAI_CODING_CN_API_KEY` | `zai-coding-cn` |
| OpenCode Zen | `OPENCODE_API_KEY` | `opencode` |
| OpenCode Go | `OPENCODE_API_KEY` | `opencode-go` |
| Radius | `RADIUS_API_KEY` | `radius` |
| Hugging Face | `HF_TOKEN` | `huggingface` |
| Fireworks | `FIREWORKS_API_KEY` | `fireworks` |
| Together AI | `TOGETHER_API_KEY` | `together` |
| Baseten | `BASETEN_API_KEY` | `baseten` |
| Kimi For Coding | `KIMI_API_KEY` | `kimi-coding` |
| MiniMax | `MINIMAX_API_KEY` | `minimax` |
| MiniMax (China) | `MINIMAX_CN_API_KEY` | `minimax-cn` |
| Qwen Token Plan (existing catalog) | `QWEN_TOKEN_PLAN_API_KEY` | `qwen-token-plan` |
| Qwen Token Plan (Individual) | `QWEN_TOKEN_PLAN_API_KEY` | `qwen-token-plan-individual` |
| Qwen Token Plan (China) | `QWEN_TOKEN_PLAN_CN_API_KEY` | `qwen-token-plan-cn` |
| Xiaomi MiMo | `XIAOMI_API_KEY` | `xiaomi` |
| Xiaomi MiMo Token Plan (China) | `XIAOMI_TOKEN_PLAN_CN_API_KEY` | `xiaomi-token-plan-cn` |
| Xiaomi MiMo Token Plan (Amsterdam) | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` | `xiaomi-token-plan-ams` |
| Xiaomi MiMo Token Plan (Singapore) | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` | `xiaomi-token-plan-sgp` |

环境变量和 `auth.json` 键的参考：[`packages/ai/src/env-api-keys.ts`](https://github.com/earendil-works/pi/blob/main/packages/ai/src/env-api-keys.ts) 中的 [`const envMap`](https://github.com/earendil-works/pi/blob/main/packages/ai/src/env-api-keys.ts)。

#### Auth 文件

将凭据存储在 `~/.pi/agent/auth.json` 中：

```json
{
  "anthropic": { "type": "api_key", "key": "sk-ant-..." },
  "ant-ling": { "type": "api_key", "key": "..." },
  "openai": { "type": "api_key", "key": "sk-..." },
  "deepseek": { "type": "api_key", "key": "sk-..." },
  "nvidia": { "type": "api_key", "key": "nvapi-..." },
  "google": { "type": "api_key", "key": "..." },
  "opencode": { "type": "api_key", "key": "..." },
  "opencode-go": { "type": "api_key", "key": "..." },
  "together": { "type": "api_key", "key": "..." },
  "qwen-token-plan":  { "type": "api_key", "key": "sk-sp-..." },
  "qwen-token-plan-individual": { "type": "api_key", "key": "sk-sp-..." },
  "qwen-token-plan-cn": { "type": "api_key", "key": "sk-sp-..." },
  "xiaomi": { "type": "api_key", "key": "..." },
  "xiaomi-token-plan-cn":  { "type": "api_key", "key": "..." },
  "xiaomi-token-plan-ams": { "type": "api_key", "key": "..." },
  "xiaomi-token-plan-sgp": { "type": "api_key", "key": "..." }
}
```

`qwen-token-plan-individual` 使用与 `qwen-token-plan` 相同的国际 endpoint 和 `QWEN_TOKEN_PLAN_API_KEY`，但将选择器限制为 Individual subscriptions 所记录的 models。现有 provider 为向后兼容保留了更宽的 catalog。使用 `auth.json` 时，请将凭据存储在你所选的 provider 下；环境变量由两个国际 provider 共享。

该文件以 `0600` 权限创建（仅用户可读写）。Auth 文件凭据优先于环境变量。

API key 凭据还可以包含 provider 作用域的环境值。在解析凭据键、provider/model headers 以及 Cloudflare account IDs、Azure OpenAI 设置、Vertex project/location、Bedrock 设置、`PI_CACHE_RETENTION` 和 `HTTP_PROXY`/`HTTPS_PROXY` 等 provider 配置时，这些值会先于进程环境变量被使用。

```json
{
  "cloudflare-ai-gateway": {
    "type": "api_key",
    "key": "$CLOUDFLARE_API_KEY",
    "env": {
      "CLOUDFLARE_API_KEY": "...",
      "CLOUDFLARE_ACCOUNT_ID": "account-id",
      "CLOUDFLARE_GATEWAY_ID": "gateway-id"
    }
  }
}
```

当 pi 应使用与项目 shell 环境不同的 provider 设置时，请使用此方式。

### Key 解析

`key` 字段支持命令执行、环境插值和字面量：

- **Shell 命令：** 开头的 `"!command"` 将整个值作为命令执行，并使用 stdout（在进程生命周期内缓存）
  ```json
  { "type": "api_key", "key": "!security find-generic-password -ws 'anthropic'" }
  { "type": "api_key", "key": "!op read 'op://vault/item/credential'" }
  ```
- **环境插值：** `"$ENV_VAR"` 或 `"${ENV_VAR}"` 使用指定变量的值。插值在更大的字面量内部也可用。
  ```json
  { "type": "api_key", "key": "$MY_ANTHROPIC_KEY" }
  { "type": "api_key", "key": "${KEY_PREFIX}_${KEY_SUFFIX}" }
  ```
  `$FOO_BAR` 是变量 `FOO_BAR`；当 `BAR` 是字面文本时，请使用 `${FOO}_BAR`。缺失的环境变量会使该值无法解析。
- **转义：** `"$$"` 输出字面量 `"$"`；`"$!"` 输出字面量 `"!"` 而不触发命令执行。
  ```json
  { "type": "api_key", "key": "$$literal-dollar-prefix" }
  { "type": "api_key", "key": "$!literal-bang-prefix" }
  ```
- **字面量值：** 直接使用。诸如 `MY_API_KEY` 这样的纯大写字符串是字面量；环境变量请使用 `$MY_API_KEY`。
  ```json
  { "type": "api_key", "key": "sk-ant-..." }
  { "type": "api_key", "key": "public" }
  ```

OAuth 凭据在 `/login` 之后也存储在这里，并被自动管理。

## Cloud Providers

### Azure OpenAI

```bash
export AZURE_OPENAI_API_KEY=...
export AZURE_OPENAI_BASE_URL=https://your-resource.ai.azure.com
# also supported: https://your-resource.cognitiveservices.azure.com
# also supported: https://your-resource.openai.azure.com
# root endpoints are auto-normalized to /openai/v1
# or use resource name instead of base URL
export AZURE_OPENAI_RESOURCE_NAME=your-resource

# Optional
export AZURE_OPENAI_API_VERSION=2024-02-01
export AZURE_OPENAI_DEPLOYMENT_NAME_MAP=gpt-4=my-gpt4,gpt-4o=my-gpt4o
```

### Amazon Bedrock

使用 `/login amazon-bedrock` 存储 Bedrock API key，或配置以下环境中的 AWS 凭据来源之一：

```bash
# Option 1: AWS Profile
export AWS_PROFILE=your-profile

# Option 2: IAM Keys
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...

# Option 3: Bearer Token
export AWS_BEARER_TOKEN_BEDROCK=...

# Optional region (defaults to us-east-1)
export AWS_REGION=us-west-2
```

还支持 ECS task roles（`AWS_CONTAINER_CREDENTIALS_*`）和 IRSA（`AWS_WEB_IDENTITY_TOKEN_FILE`）。

```bash
pi --provider amazon-bedrock --model us.anthropic.claude-sonnet-4-20250514-v1:0
```

对于 ID 包含可识别 model 名称的 Claude models（基础 models 和系统定义的 inference profiles），prompt caching 会自动启用。对于 application inference profiles（其 ARN 不包含 model 名称），请设置 `AWS_BEDROCK_FORCE_CACHE=1` 以启用 cache points：

```bash
export AWS_BEDROCK_FORCE_CACHE=1
pi --provider amazon-bedrock --model arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123
```

如果你要连接到 Bedrock API proxy，可以使用以下环境变量：

```bash
# Set the URL for the Bedrock proxy (standard AWS SDK env var)
export AWS_ENDPOINT_URL_BEDROCK_RUNTIME=https://my.corp.proxy/bedrock

# Set if your proxy does not require authentication
export AWS_BEDROCK_SKIP_AUTH=1

# Set if your proxy only supports HTTP/1.1
export AWS_BEDROCK_FORCE_HTTP1=1
```

### Cloudflare AI Gateway

`CLOUDFLARE_API_KEY` 可以通过 `/login` 设置。account ID 和 gateway slug 可以设置为环境变量，或放在 `auth.json` 中 API key 凭据的 `env` 对象里。

```bash
export CLOUDFLARE_API_KEY=...           # or use /login
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_GATEWAY_ID=...        # create at dash.cloudflare.com → AI → AI Gateway
pi --provider cloudflare-ai-gateway --model "claude-sonnet-4-5"
```

通过 Cloudflare AI Gateway 路由到 OpenAI、Anthropic 和 Workers AI。Workers AI 使用 Unified API（`/compat`）和带前缀的 model IDs（`workers-ai/@cf/...`）。OpenAI 使用 OpenAI passthrough 路由（`/openai`）和原生 OpenAI model IDs，例如 `gpt-5.1`。Anthropic 使用 Anthropic passthrough 路由（`/anthropic`）和原生 Anthropic model IDs，例如 `claude-sonnet-4-5`。

AI Gateway 认证使用 `CLOUDFLARE_API_KEY` 作为 `cf-aig-authorization`。上游认证可以是以下之一：

| 模式 | 请求 auth | 上游 auth |
|------|--------------|---------------|
| Workers AI | 仅 Cloudflare token | Cloudflare 原生 |
| Unified billing | 仅 Cloudflare token | Cloudflare 处理上游 auth 并扣除额度 |
| Stored BYOK | 仅 Cloudflare token | Cloudflare 注入存储在 AI Gateway dashboard 中的 provider keys |
| Inline BYOK | Cloudflare token 加上游 `Authorization` header | 请求自行提供上游 provider key |

对于常规的 pi 用法，优先使用 unified billing 或 stored BYOK。Inline BYOK 需要为 Cloudflare AI Gateway provider 配置一个额外的上游 `Authorization` header，例如通过 `models.json` 的 provider/model 覆盖。

### Cloudflare Workers AI

`CLOUDFLARE_API_KEY` 可以通过 `/login` 设置。`CLOUDFLARE_ACCOUNT_ID` 可以设置为环境变量，或放在 `auth.json` 中 API key 凭据的 `env` 对象里。

```bash
export CLOUDFLARE_API_KEY=...           # or use /login
export CLOUDFLARE_ACCOUNT_ID=...
pi --provider cloudflare-workers-ai --model "@cf/moonshotai/kimi-k2.6"
```

Pi 会自动设置 `x-session-affinity` 以获得 [prefix caching](https://developers.cloudflare.com/workers-ai/features/prompt-caching/) 折扣。

### Google Vertex AI

使用 Application Default Credentials：

```bash
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT=your-project
export GOOGLE_CLOUD_LOCATION=us-central1
```

或将 `GOOGLE_APPLICATION_CREDENTIALS` 设置为一个 service account 密钥文件。

## llama.cpp

Pi 支持 llama.cpp router server。用 `/login llama.cpp` 配置它，用 `/llama` 管理已加载的 models，并用 `/model` 选择一个已加载的 model。

服务器设置、model 目录布局、环境变量和命令用法参见 [llama.cpp](llama-cpp.md)。

## 自定义 Providers

**通过 models.json：** 添加 Ollama、LM Studio、vLLM，或任何使用受支持 API（OpenAI Completions、OpenAI Responses、Anthropic Messages、Google Generative AI）的 provider。参见 [models.md](models.md)。

**通过 extensions：** 对于需要自定义 API 实现或 OAuth 流程的 providers，请创建一个 extension。参见 [custom-provider.md](custom-provider.md) 和 [examples/extensions/custom-provider-gitlab-duo](../examples/extensions/custom-provider-gitlab-duo/)。

## 解析顺序

在为某个 provider 解析凭据时：

1. CLI `--api-key` 标志
2. `auth.json` 条目（API key 或 OAuth token）
3. 环境变量
4. 来自 `models.json` 的自定义 provider keys
