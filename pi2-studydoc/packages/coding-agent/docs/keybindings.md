# Keybindings

所有键盘快捷键都可以通过 `~/.pi/agent/keybindings.json` 自定义。每个 action 可以绑定到一个或多个按键。

该配置文件使用与 pi 内部使用的、以及 extension 作者在 `keyHint()` 和注入的 `keybindings` 管理器中使用的相同的 namespaced keybinding ids。

使用 pre-namespaced ids（例如 `cursorUp` 或 `expandTools`）的较旧配置会在启动时自动迁移到 namespaced ids。

编辑 `keybindings.json` 后，在 pi 中运行 `/reload` 以在不重启 session 的情况下应用更改。

## 按键格式

`modifier+key`，其中 modifiers 为 `ctrl`、`shift`、`alt`、`super`（可组合），keys 为：

- **字母：** `a-z`
- **数字：** `0-9`
- **特殊键：** `escape`, `esc`, `enter`, `return`, `tab`, `space`, `backspace`, `delete`, `insert`, `clear`, `home`, `end`, `pageUp`, `pageDown`, `up`, `down`, `left`, `right`
- **功能键：** `f1`-`f12`
- **符号：** `` ` ``, `-`, `=`, `[`, `]`, `\`, `;`, `'`, `,`, `.`, `/`, `!`, `@`, `#`, `$`, `%`, `^`, `&`, `*`, `(`, `)`, `_`, `+`, `|`, `~`, `{`, `}`, `:`, `<`, `>`, `?`

Modifier 组合：`ctrl+shift+x`、`alt+ctrl+x`、`ctrl+shift+alt+x`、`super+k`、`ctrl+super+k`、`ctrl+1` 等。

`super` 绑定要求终端能够单独报告该 modifier，通常是通过 Kitty keyboard protocol。在不支持该功能的终端中，它们可能无法工作。

## 所有 Actions

### TUI Editor 光标移动

| Keybinding id | 默认 | 描述 |
|--------|---------|-------------|
| `tui.editor.cursorUp` | `up` | 向上移动光标，在顶部浏览更早的历史 |
| `tui.editor.cursorDown` | `down` | 向下移动光标，在底部浏览更新的历史 |
| `tui.editor.historyPrevious` | *(none)* | 选择上一条 prompt 历史条目 |
| `tui.editor.historyNext` | *(none)* | 选择下一条 prompt 历史条目 |
| `tui.editor.cursorLeft` | `left`, `ctrl+b` | 向左移动光标 |
| `tui.editor.cursorRight` | `right`, `ctrl+f` | 向右移动光标 |
| `tui.editor.cursorWordLeft` | `alt+left`, `ctrl+left`, `alt+b` | 向左按词移动光标 |
| `tui.editor.cursorWordRight` | `alt+right`, `ctrl+right`, `alt+f` | 向右按词移动光标 |
| `tui.editor.cursorLineStart` | `home`, `ctrl+home`, `ctrl+a` | 移动到行首 |
| `tui.editor.cursorLineEnd` | `end`, `ctrl+end`, `ctrl+e` | 移动到行尾 |
| `tui.editor.jumpForward` | `ctrl+]` | 向前跳转到字符 |
| `tui.editor.jumpBackward` | `ctrl+alt+]` | 向后跳转到字符 |
| `tui.editor.pageUp` | `pageUp`, `ctrl+pageUp` | 向上翻页 |
| `tui.editor.pageDown` | `pageDown`, `ctrl+pageDown` | 向下翻页 |

专用的 history actions 始终更改历史条目，无论光标在多行 prompt 中的位置如何。在主编辑器获得焦点时，显式的 history bindings 优先于 application actions，因此将 `tui.editor.historyPrevious` 绑定到 `ctrl+p` 会在该上下文中覆盖 model 循环切换，而不更改选择器中的 `Ctrl+P`。

### TUI Editor 删除

| Keybinding id | 默认 | 描述 |
|--------|---------|-------------|
| `tui.editor.deleteCharBackward` | `backspace` | 向后删除字符 |
| `tui.editor.deleteCharForward` | `delete`, `ctrl+d` | 向前删除字符 |
| `tui.editor.deleteWordBackward` | `ctrl+w`, `alt+backspace` | 向后删除词 |
| `tui.editor.deleteWordForward` | `alt+d`, `alt+delete` | 向前删除词 |
| `tui.editor.deleteToLineStart` | `ctrl+u` | 删除到行首 |
| `tui.editor.deleteToLineEnd` | `ctrl+k` | 删除到行尾 |

### TUI 输入

| Keybinding id | 默认 | 描述 |
|--------|---------|-------------|
| `tui.input.newLine` | `shift+enter`, `ctrl+j` | 插入新行 |
| `tui.input.submit` | `enter` | 提交输入 |
| `tui.input.tab` | `tab` | Tab / 自动补全 |

### TUI Kill Ring

| Keybinding id | 默认 | 描述 |
|--------|---------|-------------|
| `tui.editor.yank` | `ctrl+y` | 粘贴最近删除的文本 |
| `tui.editor.yankPop` | `alt+y` | 在 yank 后循环浏览已删除的文本 |
| `tui.editor.undo` | `ctrl+-` (`ctrl+z` on Windows; `alt+z` on WSL) | 撤销上一次编辑 |

### TUI 剪贴板与选区

| Keybinding id | 默认 | 描述 |
|--------|---------|-------------|
| `tui.input.copy` | `ctrl+c` | 复制选区 |
| `tui.select.up` | `up` | 向上移动选区 |
| `tui.select.down` | `down` | 向下移动选区 |
| `tui.select.pageUp` | `pageUp` | 在列表中向上翻页 |
| `tui.select.pageDown` | `pageDown` | 在列表中向下翻页 |
| `tui.select.confirm` | `enter` | 确认选区 |
| `tui.select.cancel` | `escape`, `ctrl+c` | 取消选区 |

### TUI Fullscreen 视口

这些 actions 在交互模式使用 `--tui-mode fullscreen` 时适用，并以主 transcript 滚动区域为目标。双指触控板和鼠标滚轮输入会滚动指针下方的区域，并回退到固定的 editor/status/footer 停靠区上方的 transcript。点击 OSC 8 超链接会在默认处理器中打开它。用主鼠标按键拖拽会选择文本并将其复制到剪贴板；在 transcript 的顶部或底部边缘按住会自动滚动到屏幕外的内容。当 transcript 向上滚动时，其底部行上可点击的 "Jump to latest message" 标签会显示 `tui.altScreen.bottom` 快捷键。有关终端特定的鼠标与触控板行为，请参阅 [终端设置](terminal-setup.md)。

Fullscreen transcript bindings 优先于 editor bindings。因此，在 fullscreen 模式下，默认的未修饰导航键控制 transcript，而它们的 `ctrl` 变体继续控制编辑器。在 fullscreen 模式之外，两种变体都控制编辑器。

transcript 搜索面板会显示已配置的 previous/next 快捷键以及可点击的箭头控件。再次按 `tui.altScreen.search`，或使用 `tui.altScreen.searchClose`，即可关闭它。

| 按键 | 默认模式 | Fullscreen 模式 |
|-----|--------------|-----------------|
| `home`, `end` | 编辑器 | Transcript |
| `ctrl+home`, `ctrl+end` | 编辑器 | 编辑器 |
| `pageUp`, `pageDown` | 编辑器 | Transcript |
| `ctrl+pageUp`, `ctrl+pageDown` | 编辑器 | 编辑器 |

这种路由仍可通过普通的 action bindings 进行配置。例如，`"tui.altScreen.pageUp": "ctrl+pageUp"` 会使得在 fullscreen 模式下 `pageUp` 控制编辑器，而 `ctrl+pageUp` 控制 transcript。绑定 `tui.altScreen.halfPageUp` 和 `tui.altScreen.halfPageDown` 以实现半页步进，或绑定 `tui.altScreen.lineUp` 和 `tui.altScreen.lineDown` 以实现单行步进。将 `"tui.altScreen.pageUp": []` 设置为禁用该 transcript 快捷键。用户 bindings 会替换该 action 的默认值。

| Keybinding id | 默认 | 描述 |
|--------|---------|-------------|
| `tui.altScreen.pageUp` | `pageUp` | 将 transcript 向上滚动一页 |
| `tui.altScreen.pageDown` | `pageDown` | 将 transcript 向下滚动一页 |
| `tui.altScreen.halfPageUp` | *(none)* | 将 transcript 向上滚动半页 |
| `tui.altScreen.halfPageDown` | *(none)* | 将 transcript 向下滚动半页 |
| `tui.altScreen.lineUp` | *(none)* | 将 transcript 向上滚动一行 |
| `tui.altScreen.lineDown` | *(none)* | 将 transcript 向下滚动一行 |
| `tui.altScreen.previousPrompt` | `ctrl+shift+up`, `ctrl+up` (`ctrl+up` only on Windows and WSL) | 跳转到上一条标记的消息 |
| `tui.altScreen.nextPrompt` | `ctrl+shift+down`, `ctrl+down` (`ctrl+down` only on Windows and WSL) | 跳转到下一条标记的消息 |
| `tui.altScreen.search` | `ctrl+shift+f` (`ctrl+f` on Windows and WSL) | 搜索已渲染的 transcript |
| `tui.altScreen.searchNext` | `enter`, `ctrl+g` | 在搜索时选择下一个搜索匹配项 |
| `tui.altScreen.searchPrevious` | `shift+enter`, `ctrl+shift+g` | 在搜索时选择上一个搜索匹配项 |
| `tui.altScreen.searchClose` | `escape` | 关闭 transcript 搜索 |
| `tui.altScreen.top` | `home` | 滚动到 transcript 的开头 |
| `tui.altScreen.bottom` | `end` | 滚动到 transcript 末尾并跟随新输出 |

### Application

| Keybinding id | 默认 | 描述 |
|--------|---------|-------------|
| `app.interrupt` | `escape` | 取消 / 中止 |
| `app.clear` | `ctrl+c` | 清空编辑器（第一次）/ 退出（第二次） |
| `app.exit` | `ctrl+d` | 退出（编辑器为空时） |
| `app.suspend` | `ctrl+z` (none on Windows) | 挂起到后台 |
| `app.editor.external` | `ctrl+g` | 在外部编辑器中打开（`externalEditor`、`$VISUAL`、`$EDITOR`，在 Windows 上为 Notepad，在其他平台为 `nano`） |
| `app.clipboard.pasteImage` | `ctrl+v` (`alt+v` on Windows and WSL) | 从剪贴板粘贴图片或文本 |

### Sessions

| Keybinding id | 默认 | 描述 |
|--------|---------|-------------|
| `app.session.new` | *(none)* | 开始一个新的 session（`/new`） |
| `app.session.tree` | *(none)* | 打开 session 树导航器（`/tree`） |
| `app.session.fork` | *(none)* | Fork 当前 session（`/fork`） |
| `app.session.resume` | *(none)* | 打开 session 恢复选择器（`/resume`） |
| `app.session.togglePath` | `ctrl+p` | 切换路径显示 |
| `app.session.toggleSort` | `ctrl+s` | 切换排序模式 |
| `app.session.toggleNamedFilter` | `ctrl+n` | 切换仅显示已命名项过滤器 |
| `app.session.rename` | `ctrl+r` | 重命名 session |
| `app.session.delete` | `ctrl+d` | 删除 session |
| `app.session.deleteNoninvasive` | `ctrl+backspace` | 当查询为空时删除 session |

### Models 与 Thinking

| Keybinding id | 默认 | 描述 |
|--------|---------|-------------|
| `app.model.select` | `ctrl+l` | 打开 model 选择器 |
| `app.model.cycleForward` | `ctrl+p` | 循环切换到下一个 model |
| `app.model.cycleBackward` | `shift+ctrl+p` (`alt+p` on Windows and WSL) | 循环切换到上一个 model |
| `app.models.save` | `ctrl+s` | 将选中的默认 model 或 scoped model 配置保存到 settings |
| `app.thinking.cycle` | `shift+tab` | 循环切换 thinking 等级 |
| `app.thinking.save` | `ctrl+s` | 将当前 thinking 等级保存到 settings |
| `app.thinking.toggle` | `ctrl+t` | 折叠或展开 thinking blocks |

### 显示与消息队列

| Keybinding id | 默认 | 描述 |
|--------|---------|-------------|
| `app.tools.expand` | `ctrl+o` | 折叠或展开 tool 输出 |
| `app.message.copy` | `ctrl+x` | 在 `/tree` 中复制选中的消息；否则复制最后一条 assistant 消息，或在 `fullscreenCopyOnSelect` 被禁用时复制当前 fullscreen 文本选区 |
| `app.message.followUp` | `alt+enter` (`ctrl+q` on Windows and WSL) | 将 follow-up 消息加入队列 |
| `app.message.dequeue` | `alt+up` (`alt+q` on Windows and WSL) | 将已排队的消息恢复到编辑器 |

### 树导航

| Keybinding id | 默认 | 描述 |
|--------|---------|-------------|
| `app.tree.foldOrUp` | `ctrl+left`, `alt+left` | 折叠当前 branch 段，或跳转到上一段的开头 |
| `app.tree.unfoldOrDown` | `ctrl+right`, `alt+right` | 展开当前 branch 段，或跳转到下一段的开头或 branch 末尾 |
| `app.tree.editLabel` | `shift+l` | 编辑选中树节点上的标签 |
| `app.tree.toggleLabelTimestamp` | `shift+t` | 切换树中标签的时间戳显示 |
| `app.tree.filter.default` | `ctrl+d` | 将树过滤器设置为默认视图 |
| `app.tree.filter.noTools` | `ctrl+t` | 切换隐藏 tool 结果的树过滤器 |
| `app.tree.filter.userOnly` | `ctrl+u` | 切换仅显示用户消息的树过滤器 |
| `app.tree.filter.labeledOnly` | `ctrl+l` | 切换仅显示已标记条目的树过滤器 |
| `app.tree.filter.all` | `ctrl+a` | 切换显示所有条目的树过滤器 |
| `app.tree.filter.cycleForward` | `ctrl+o` | 向前循环切换树过滤器 |
| `app.tree.filter.cycleBackward` | `shift+ctrl+o` | 向后循环切换树过滤器 |

### Scoped Models 选择器

在 scoped models 选择器内部使用（通过 `/scoped-models` 打开）。

| Keybinding id | 默认 | 描述 |
|--------|---------|-------------|
| `app.models.enableAll` | `ctrl+a` | 启用所有 models（或所有匹配当前搜索的 models） |
| `app.models.clearAll` | `ctrl+x` | 清除所有 models（或所有匹配当前搜索的 models） |
| `app.models.toggleProvider` | `ctrl+p` | 切换当前 provider 的所有 models |
| `app.models.reorderUp` | `alt+up` | 在循环顺序中将选中的 model 上移 |
| `app.models.reorderDown` | `alt+down` | 在循环顺序中将选中的 model 下移 |

## 自定义配置

创建 `~/.pi/agent/keybindings.json`：

```json
{
  "tui.editor.historyPrevious": "ctrl+p",
  "tui.editor.historyNext": "ctrl+n",
  "tui.editor.deleteWordBackward": ["ctrl+w", "alt+backspace"]
}
```

每个 action 可以有一个按键或一个按键数组。用户配置覆盖默认值。

在原生 Windows 上，`app.suspend` 没有默认 binding，因为 Windows 终端不支持 Unix job control。如果你手动绑定它，pi 会显示一条状态消息而不是挂起。在 WSL 中，正常的 Linux `ctrl+z`/`fg` 行为仍然适用。

### Emacs 示例

```json
{
  "tui.editor.historyPrevious": "ctrl+p",
  "tui.editor.historyNext": "ctrl+n",
  "tui.editor.cursorLeft": ["left", "ctrl+b"],
  "tui.editor.cursorRight": ["right", "ctrl+f"],
  "tui.editor.cursorWordLeft": ["alt+left", "alt+b"],
  "tui.editor.cursorWordRight": ["alt+right", "alt+f"],
  "tui.editor.deleteCharForward": ["delete", "ctrl+d"],
  "tui.editor.deleteCharBackward": ["backspace", "ctrl+h"],
  "tui.input.newLine": ["shift+enter", "ctrl+j"]
}
```

### Vim 示例

```json
{
  "tui.editor.cursorUp": ["up", "alt+k"],
  "tui.editor.cursorDown": ["down", "alt+j"],
  "tui.editor.cursorLeft": ["left", "alt+h"],
  "tui.editor.cursorRight": ["right", "alt+l"],
  "tui.editor.cursorWordLeft": ["alt+left", "alt+b"],
  "tui.editor.cursorWordRight": ["alt+right", "alt+w"]
}
```
