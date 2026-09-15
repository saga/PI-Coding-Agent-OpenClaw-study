# Linux 剪贴板 helper

使用 `libxcb.so.1` 提供异步 X11 文本和图像读取。预构建在 glibc 和 musl 上支持 x64 和 arm64。读取具有有界等待；如果某个原生操作停滞，该 helper 会一直不可用，直到它完成。

当原生读取不可用时，Coding-agent 会回退到命令行工具。Wayland 读取使用 `wl-paste`；所有 Linux 写入都使用现有的命令行或终端剪贴板路径。

## 构建

安装 C 编译器和 XCB 开发头文件，然后在每个受支持的 Linux 架构上从 repository 根目录运行：

```sh
npm --prefix packages/tui run build:native:linux
```

## 测试

安装构建依赖以及 `pkg-config`、`Xvfb` 和 `xclip`，然后从 `packages/tui` 运行：

```sh
node --test test/native-clipboard-linux.test.ts
```

测试使用隔离的 X11 server，而非桌面剪贴板。当依赖缺失时它们会跳过。
