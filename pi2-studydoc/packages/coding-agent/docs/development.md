# 开发

更多指南请参见 [AGENTS.md](https://github.com/earendil-works/pi/blob/main/AGENTS.md)。

## 环境搭建

```bash
git clone https://github.com/earendil-works/pi
cd pi
npm install
npm run build
```

从源码运行：

```bash
/path/to/pi/pi-test.sh
```

该脚本可以从任意目录运行。Pi 会保留调用者的当前工作目录。

### 实验性远程 harness

远程 harness 的 server/client 集成仅供开发使用。请在仓库中这样运行：

```bash
PI_EXPERIMENTAL=1 ./pi-test.sh server
PI_EXPERIMENTAL=1 ./pi-test.sh client
```

`PI_SERVER_DIR` 会覆盖 server profile 与 socket 目录（默认：`~/.pi/server`）。当省略 `--server-id` 时，`PI_SERVER_ID` 用于选择逻辑 server ID。

在 checkout 中，`client` 与 `experimental/plugin` 这两个 package 子路径仅在 `source` 条件下才能解析。它们的实现以及 server/client 命令都不会包含在 npm package 和独立二进制文件中。`pi-client`、`pi-protocol` 和 `pi-server` 是 coding-agent 的开发依赖，而非运行时依赖。本地 SDK 与 stdio RPC API 保持不变。

## Fork 与品牌定制

通过 `package.json` 配置：

```json
{
  "piConfig": {
    "name": "pi",
    "configDir": ".pi"
  }
}
```

在你的 fork 中修改 `name`、`configDir` 和 `bin` 字段。这会影响 CLI banner、配置路径和环境变量名。

## 路径解析

三种执行模式：npm install、独立二进制文件、从源码使用 tsx。

处理 package 资源时**始终使用 `src/config.ts`**：

```typescript
import { getPackageDir, getThemeDir } from "./config.js";
```

切勿直接使用 `__dirname` 访问 package 资源。

## 调试命令

`/debug`（隐藏命令）会写入 `~/.pi/agent/pi-debug.log`：
- 带 ANSI 码的渲染后 TUI 行
- 最近发送给 LLM 的消息

## 测试

```bash
./test.sh                         # Run non-LLM tests (no API keys needed)
npm test                          # Run all tests
npm test -- test/specific.test.ts # Run specific test
```

### 已发布 package 的冒烟测试

构建完成后，运行 `npm run check:package-install`。它会打包公开的 package，并仅在仓库之外的临时目录中以直接依赖的方式安装 coding-agent。本地 tarball 覆盖会选定已声明的传递依赖，而不会安装仅用于开发的 package。该检查会在没有凭据或模型请求的情况下验证 SDK 导入与 CLI 启动。

`npm run check` 还会检查运行时依赖声明，并拒绝那些通过 import 被拉入 package 构建的、已被排除的开发源码。

## 项目结构

```
packages/
  ai/           # LLM provider abstraction
  agent/        # Agent loop and message types  
  tui/          # Terminal UI components
  coding-agent/ # CLI and interactive mode
```
