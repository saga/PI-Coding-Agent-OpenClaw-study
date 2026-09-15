# Windows 原生预构建

提供控制台输入设置、修饰键状态以及异步文本/图像剪贴板访问。链接到 `kernel32` 和 `user32`；不需要 Node 头文件。

## 构建

在 Windows 上，安装 Visual Studio 的“使用 C++ 的桌面开发”工作负载，然后从 repository 根目录运行以构建 x64 和 arm64：

```sh
npm --prefix packages/tui run build:native:win32
```

对于交叉构建或自定义工具链，请提供 MinGW 兼容的编译器：

```sh
PI_TUI_WIN32_TOOLCHAIN=mingw \
CC_X64=/path/to/x86_64-w64-mingw32-gcc \
CC_ARM64=/path/to/aarch64-w64-mingw32-gcc \
npm --prefix packages/tui run build:native:win32
```

## 测试剪贴板写入

在 Windows 测试桌面上，从 `packages/tui` 在 PowerShell 中运行：

```powershell
$env:PI_TEST_NATIVE_CLIPBOARD = "1"
node --test test/native-platform.test.ts
```

这个选择性启用的测试会检查原生文本写入和读取。**它会替换系统剪贴板内容。**
