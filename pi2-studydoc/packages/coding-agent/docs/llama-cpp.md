# llama.cpp

Pi 支持 [llama.cpp](https://github.com/ggml-org/llama.cpp) router server。该 router 会发现多个 GGUF 模型，并按需加载或卸载它们。

使用带有 router 支持的当前 llama.cpp 构建。遵循[构建说明](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md)，或为你的平台安装[预构建发行版](https://github.com/ggml-org/llama.cpp/releases)。

## 启动 router

启动 `llama-server` 时不要带 `--model` 或 `-m`。传入模型会启动单模型模式，而非 router 模式。

```bash
llama-server \
  --models-dir ~/models \
  --no-models-autoload \
  --jinja \
  --host 127.0.0.1 \
  --port 8080 \
  -ngl 999 \
  -c 32768
```

重要选项：

- `--models-dir ~/models` 发现本地 GGUF 文件。
- `--no-models-autoload` 使加载只能通过 `/llama` 显式进行。
- `--jinja` 启用兼容的 chat 模板与 tool calling。
- `-ngl 999` 将尽可能多的层卸载到 GPU。
- `-c 32768` 设置每个已加载模型的 context window。省略它则使用模型的原生 context，这可能需要多得多的内存。

单文件模型可以直接放在模型目录中。将多模态和多分片模型放在单独的子目录中：

```text
~/models/
├── llama-3.2-1b-Q4_K_M.gguf
├── gemma-3-4b-it-Q4_K_M/
│   ├── gemma-3-4b-it-Q4_K_M.gguf
│   └── mmproj-F16.gguf
└── large-model-Q4_K_M/
    ├── large-model-Q4_K_M-00001-of-00003.gguf
    ├── large-model-Q4_K_M-00002-of-00003.gguf
    └── large-model-Q4_K_M-00003-of-00003.gguf
```

手动添加文件后重启 router。要设置每个模型的 context 大小和其他选项，请使用 [llama.cpp model presets](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#model-presets)。

## 配置 Pi

启动 Pi 并配置 provider：

```text
/login llama.cpp
```

输入 router URL 和可选的 API key。默认 URL 是 `http://127.0.0.1:8080`。

如果你以 `--no-models-autoload` 启动 router，`/login llama.cpp` 只会存储连接。运行 `/llama` 加载一个模型，然后运行 `/model` 为当前 session 选择已加载的模型。

环境变量可以在不使用 `/login` 的情况下配置相同的值：

```bash
export LLAMA_BASE_URL=http://127.0.0.1:8080
export LLAMA_API_KEY=optional-secret
pi
```

如果 server 使用 API key，请以匹配的 `--api-key` 值启动 `llama-server`。保留 `--host 127.0.0.1` 以仅限本地访问。

## 管理模型

运行：

```text
/llama
```

- 选择一个未加载的模型以加载它。
- 选择一个已加载的模型以卸载它。
- 选择 **Download model…**，搜索 Hugging Face，然后选择一个 repository 和量化。精确的 `owner/repository[:quant]` 值也可以使用。
- 在加载或下载期间按 Escape 以确认取消。

Hugging Face 搜索在设置时使用 `HF_TOKEN`，然后检查 `$HF_TOKEN_PATH`、`$HF_HOME/token`、`$XDG_CACHE_HOME/huggingface/token` 和 `~/.cache/huggingface/token`。搜索在未经认证的情况下也能工作，但速率限制更低。Pi 在下载受限 repository 之前会发出警告，并链接到其访问页面。llama.cpp server 执行下载，因此当所选 repository 需要访问权限时，其进程也必须具有 `HF_TOKEN`。

如果其他模型已加载，Pi 会询问是先卸载它们还是保持加载。Pi 不会静默卸载模型，也从不删除模型文件。router 可能与其他客户端共享，因此 `/llama` 始终显示 router 的当前状态。

只有已加载的模型会出现在 `/model` 中。加载模型后，运行 `/model` 为当前 Pi session 选择它。

如果 router 断开连接，`/llama` 会显示 **Retry** 和 **Close**。Retry 会重新连接并刷新模型状态，而不会重放被中断的 operation。

## 故障排除

检查 router 是否可达：

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/models
```

- **`/llama` 中没有模型：** 检查 `--models-dir`、目录布局，并重启 router。
- **`/model` 中缺少模型：** 先用 `/llama` 加载它。
- **加载失败或使用过多内存：** 降低 `-c` 或卸载另一个模型。
- **Server 不处于 router 模式：** 启动它时不要带 `--model`、`-m` 或 `-hf`。
