# tmux 安装配置

Pi 可以在 tmux 中运行，但 tmux 默认会剥离某些按键的修饰键信息。如果没有配置，`Shift+Enter` 和 `Ctrl+Enter` 通常与普通的 `Enter` 无法区分。

## 推荐配置

添加到 `~/.tmux.conf`：

```tmux
set -g extended-keys on
set -g extended-keys-format csi-u
```

然后完全重启 tmux：

```bash
tmux kill-server
tmux
```

当 Kitty 键盘协议不可用时，Pi 会自动请求扩展按键上报。使用 `extended-keys-format csi-u` 时，tmux 会以 CSI-u 格式转发带修饰键的按键，这是最可靠的配置。`extended-keys-format` 选项需要 tmux 3.5 或更高版本。

## 为什么推荐 `csi-u`

如果只使用：

```tmux
set -g extended-keys on
```

tmux 会默认使用 `extended-keys-format xterm`。当应用程序请求扩展按键上报时，带修饰键的按键会以 xterm `modifyOtherKeys` 格式转发，例如：

- `Ctrl+C` → `\x1b[27;5;99~`
- `Ctrl+D` → `\x1b[27;5;100~`
- `Ctrl+Enter` → `\x1b[27;5;13~`

使用 `extended-keys-format csi-u` 时，相同的按键会被转发为：

- `Ctrl+C` → `\x1b[99;5u`
- `Ctrl+D` → `\x1b[100;5u`
- `Ctrl+Enter` → `\x1b[13;5u`

Pi 支持这两种格式，但 `csi-u` 是推荐的 tmux 配置。

## 这修复了什么

如果没有 tmux 扩展按键，带修饰键的 Enter 会退化为旧式序列：

| 按键 | 无 extkeys | 使用 `csi-u` |
|-----|-----------------|--------------|
| Enter | `\r` | `\r` |
| Shift+Enter | `\r` | `\x1b[13;2u` |
| Ctrl+Enter | `\r` | `\x1b[13;5u` |
| Alt/Option+Enter | `\x1b\r` | `\x1b[13;3u` |

这会影响默认键位绑定（`Enter` 提交，`Shift+Enter` 换行）以及任何使用带修饰键 Enter 的自定义键位绑定。

## 要求

- tmux 3.5 或更高版本以使用 `extended-keys-format csi-u`（运行 `tmux -V` 检查）
- 支持扩展按键的终端模拟器（Ghostty、Kitty、iTerm2、WezTerm、Windows Terminal）

对于 tmux 3.2 到 3.4，请省略 `extended-keys-format csi-u`；Pi 仍然支持 tmux 默认的 xterm `modifyOtherKeys` 格式。
