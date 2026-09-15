# 终端设置

Pi 使用 [Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) 来可靠地检测修饰键。大多数现代终端都支持该协议，但有些需要配置。

## 能力覆盖（Capability Overrides）

Pi 会自动检测 OSC 8 超链接、inline image 协议和 truecolor。如果在终端代理或多路复用器之后检测失败，请使用这些高级覆盖项：

| 能力 | 环境变量 | JSON 设置 |
|------------|----------------------|--------------|
| OSC 8 超链接 | `PI_HYPERLINKS=1\|0\|auto` | `terminal.hyperlinks: true\|false\|"auto"` |
| Inline images | `PI_IMAGE_PROTOCOL=kitty\|iterm2\|none\|auto` | `terminal.images: "kitty"\|"iterm2"\|false\|"auto"` |
| Truecolor | `PI_TRUE_COLOR=1\|0\|auto` | `terminal.trueColor: true\|false\|"auto"` |

Settings 的优先级高于环境变量；未设置或设为 `auto` 会保留自动检测。请只强制启用整条终端路径都支持的能力，因为不受支持的转义序列可能会破坏渲染。

## Kitty

开箱即用。

## iTerm2

### 常规 TUI 模式

开箱即用。

### 全屏 TUI 模式

Pi 拥有 viewport，因此 iTerm2 发送的是鼠标滚轮上报，而不是滚动其原生 scrollback。在 iTerm2 默认的快速触控板行为下，这些上报可能丢失大部分被加速的滚轮增量，使全屏滚动比常规滚动慢得多。

如果全屏模式下快速鼠标滚轮手势一次只移动大约一行：

1. 打开 **iTerm2 → Settings → Advanced**。
2. 搜索 **Trackpad scrolls fast?**，将其设为 **No**。

这是 iTerm2 全局的变通办法，也可能改变原生触控板滚动。底层行为跟踪于 [iTerm2 issue 9619](https://gitlab.com/gnachman/iterm2/-/work_items/9619)。

## Apple Terminal

Pi 在可用时会启用增强按键上报。如果 Terminal.app 对 `Shift+Enter` 仍发送普通 Return，pi 会使用一个本地 macOS 修饰键回退，把该 Return 当作 `Shift+Enter`。

该回退仅在 pi 与 Terminal.app 运行在同一台 Mac 上时有效。它无法通过远程 SSH 检测本地键盘。

## Ghostty

添加到你的 Ghostty 配置（macOS 上是 `~/Library/Application Support/com.mitchellh.ghostty/config`，Linux 上是 `~/.config/ghostty/config`）：

```
keybind = alt+backspace=text:\x1b\x7f
```

较旧的 Claude Code 版本可能添加过这个 Ghostty 映射：

```
keybind = shift+enter=text:\n
```

该映射发送一个原始换行字节。在 pi 内部，这与 `Ctrl+J` 无法区分，因此 tmux 和 pi 都不再看到真正的 `shift+enter` 按键事件。

如果 Claude Code 2.x 或更新版本是你添加该映射的唯一原因，你可以移除它，除非你想在 tmux 中使用 Claude Code——在那里它仍然需要该 Ghostty 映射。

Pi 默认把 `Ctrl+J` 绑定为换行别名，因此 `Shift+Enter` 通过该重映射在 tmux 中继续可用，无需额外 pi 配置。

### 全屏 TUI 模式

在全屏模式下，链接仍可点击，但当 pi 捕获鼠标输入时，Ghostty 不会显示其悬停下划线或左下角 URL 预览。在 macOS 上按住 `Shift+Command`，在 Linux 上按住 `Shift+Ctrl`，即可使用 Ghostty 原生的链接处理。

## WezTerm

WezTerm 通常通过 xterm modifyOtherKeys 开箱即用地支持 `Shift+Enter`。要显式使用 Kitty keyboard protocol，请创建 `~/.wezterm.lua`：

```lua
local wezterm = require 'wezterm'
local config = wezterm.config_builder()
config.enable_kitty_keyboard = true
return config
```

在 macOS 上，WezTerm 默认把 `Option+Enter` 绑定为全屏。要让 `Option+Enter` 用于 pi 的 follow-up 排队，请添加该按键覆盖：

```lua
local wezterm = require 'wezterm'
local config = wezterm.config_builder()
config.keys = {
  {
    key = 'Enter',
    mods = 'ALT',
    action = wezterm.action.SendString('\x1b[13;3u'),
  },
}
return config
```

如果你已经有 `config.keys` 表，请把该条目加进去。

在 WSL 上，WezTerm 可能需要可见的硬件光标来定位 IME 候选窗口。如果 CJK IME 候选词不跟随文本光标，请在运行 pi 前设置 `PI_HARDWARE_CURSOR=1`，或在 settings 中把 `showHardwareCursor` 设为 `true`。

## Alacritty

Alacritty 通常开箱即用地支持 `Shift+Enter`。在 macOS 上，`Option+Enter` 可能以普通 `Enter` 到达。要让 `Option+Enter` 用于 pi 的 follow-up 排队，请添加到 `~/.config/alacritty/alacritty.toml`：

```toml
[[keyboard.bindings]]
key = "Enter"
mods = "Alt"
chars = "\u001b[13;3u"
```

更改配置后重启 Alacritty。

## VS Code（集成终端）

VS Code 1.109.5 及更新版本在集成终端中默认启用 Kitty keyboard protocol，因此 `Shift+Enter` 应当开箱即用。

早于 1.109.5 的 VS Code 版本需要为 `Shift+Enter` 显式配置终端 keybinding。

`keybindings.json` 位置：
- macOS：`~/Library/Application Support/Code/User/keybindings.json`
- Linux：`~/.config/Code/User/keybindings.json`
- Windows：`%APPDATA%\\Code\\User\\keybindings.json`

添加到 `keybindings.json`：

```json
{
  "key": "shift+enter",
  "command": "workbench.action.terminal.sendSequence",
  "args": { "text": "\u001b[13;2u" },
  "when": "terminalFocus"
}
```

## Zed（集成终端）

将这些按键绑定添加到你的 Zed `keymap.json`：

```json
{
  "context": "Terminal",
  "bindings": {
    "shift-enter": ["terminal::SendText", "\u001b[13;2u"],
    "ctrl--": ["terminal::SendText", "\u001b[45;5u"],
    "ctrl-alt-]": ["terminal::SendText", "\u001b[93;7u"]
  }
}
```

## Windows Terminal

Pi 在 Windows 上原生运行或在 WSL 中运行时使用 Windows 风格的 keybindings：

- `Alt+V` 粘贴图片或剪贴板文本。
- `Ctrl+F` 在全屏模式下搜索 transcript，`Ctrl+Up`/`Ctrl+Down` 在标记的消息之间跳转。
- `Alt+P` 切换到上一个 model。
- `Ctrl+Z` 在原生 Windows 上撤销编辑；WSL 使用 `Alt+Z`，以便 `Ctrl+Z` 可以挂起 pi。
- `Ctrl+Q` 排队一条 follow-up 消息，`Alt+Q` 恢复已排队的消息。

添加到 `settings.json`（Ctrl+Shift+, 或 Settings → Open JSON file）以转发 `Shift+Enter` 用于插入换行：

```json
{
  "actions": [
    {
      "command": { "action": "sendInput", "input": "\u001b[13;2u" },
      "keys": "shift+enter"
    }
  ]
}
```

Windows Terminal 默认把 `Alt+Enter` 绑定为全屏。要改用它而不是 pi 的 `Ctrl+Q` 默认值来进行 follow-up 排队，请配置 Windows Terminal 发送该按键，并在 pi 中把 `app.message.followUp` 绑定到 `alt+enter`。

如果你已经有 `actions` 数组，请把该对象加进去。更改设置后请完全关闭并重新打开 Windows Terminal。

## xfce4-terminal、terminator

这些终端的转义序列支持有限。像 `Ctrl+Enter` 和 `Shift+Enter` 这样的修饰 Enter 键无法与普通 `Enter` 区分，导致诸如 `submit: ["ctrl+enter"]` 的自定义 keybinding 无法工作。

为获得最佳体验，请使用支持 Kitty keyboard protocol 的终端：
- [Kitty](https://sw.kovidgoyal.net/kitty/)
- [Ghostty](https://ghostty.org/)
- [WezTerm](https://wezfurlong.org/wezterm/)
- [iTerm2](https://iterm2.com/)
- [Alacritty](https://github.com/alacritty/alacritty)（需要使用支持 Kitty protocol 的编译选项）

## IntelliJ IDEA（集成终端）

内置终端的转义序列支持有限。在 IntelliJ 的终端中，Shift+Enter 无法与 Enter 区分。

如果你希望硬件光标可见，请在运行 pi 前设置 `PI_HARDWARE_CURSOR=1`（出于兼容性考虑默认禁用）。

为获得最佳体验，建议使用专门的终端模拟器。
