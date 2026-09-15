> pi 可以创建 themes。让它为你的环境构建一个。

# Themes

Themes 是定义 TUI 颜色的 JSON 文件。

## 目录

- [位置](#locations)
- [选择 Theme](#selecting-a-theme)
- [创建自定义 Theme](#creating-a-custom-theme)
- [Theme 格式](#theme-format)
- [Color Tokens](#color-tokens)
- [Color 值](#color-values)
- [提示](#tips)

## 位置

Pi 从以下位置加载 themes：

- 内置：`dark`、`light`
- 全局：`~/.pi/agent/themes/*.json`
- 项目：`.pi/themes/*.json`（仅在项目被 trust 之后）
- Packages：`themes/` 目录或 `package.json` 中的 `pi.themes` 条目
- Settings：包含文件或目录的 `themes` 数组
- CLI：`--theme <path>`（可重复）

使用 `--no-themes` 禁用发现。

## 选择 Theme

通过 `/settings` 或在 `settings.json` 中选择一个 theme：

```json
{
  "theme": "my-theme"
}
```

在首次运行时，pi 会检测你的终端背景，并默认使用 `dark` 或 `light`。

### 初始 Theme

以某个 theme 启动一次交互式运行，而不更改已保存的 setting：

```bash
pi --use-theme light
```

要跟随终端外观，请使用 `lightTheme/darkTheme` 语法：

```bash
pi --use-theme light/dark
```

CLI 的值是那次运行的初始 theme。稍后在 `/settings` 中选择另一个 theme 会立即应用它
并正常保存。

## 创建自定义 Theme

1. 创建一个 theme 文件：

```bash
mkdir -p ~/.pi/agent/themes
vim ~/.pi/agent/themes/my-theme.json
```

2. 使用所有必需的颜色定义该 theme（请参阅 [Color Tokens](#color-tokens)）：

```json
{
  "$schema": "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
  "name": "my-theme",
  "vars": {
    "primary": "#00aaff",
    "secondary": 242
  },
  "colors": {
    "accent": "primary",
    "border": "primary",
    "borderAccent": "#00ffff",
    "borderMuted": "secondary",
    "success": "#00ff00",
    "error": "#ff0000",
    "warning": "#ffff00",
    "muted": "secondary",
    "dim": 240,
    "text": "",
    "thinkingText": "secondary",
    "selectedBg": "#2d2d30",
    "scrollbarTrack": "secondary",
    "scrollbarThumb": "",
    "searchMatchBg": "#2d2d30",
    "searchMatchText": "",
    "userMessageBg": "#2d2d30",
    "userMessageText": "",
    "customMessageBg": "#2d2d30",
    "customMessageText": "",
    "customMessageLabel": "primary",
    "toolPendingBg": "#1e1e2e",
    "toolSuccessBg": "#1e2e1e",
    "toolErrorBg": "#2e1e1e",
    "toolTitle": "primary",
    "toolOutput": "",
    "mdHeading": "#ffaa00",
    "mdLink": "primary",
    "mdLinkUrl": "secondary",
    "mdCode": "#00ffff",
    "mdCodeBlock": "",
    "mdCodeBlockBorder": "secondary",
    "mdQuote": "secondary",
    "mdQuoteBorder": "secondary",
    "mdHr": "secondary",
    "mdListBullet": "#00ffff",
    "toolDiffAdded": "#00ff00",
    "toolDiffRemoved": "#ff0000",
    "toolDiffContext": "secondary",
    "syntaxComment": "secondary",
    "syntaxKeyword": "primary",
    "syntaxFunction": "#00aaff",
    "syntaxVariable": "#ffaa00",
    "syntaxString": "#00ff00",
    "syntaxNumber": "#ff00ff",
    "syntaxType": "#00aaff",
    "syntaxOperator": "primary",
    "syntaxPunctuation": "secondary",
    "thinkingOff": "secondary",
    "thinkingMinimal": "primary",
    "thinkingLow": "#00aaff",
    "thinkingMedium": "#00ffff",
    "thinkingHigh": "#ff00ff",
    "thinkingXhigh": "#ff0000",
    "thinkingMax": "#ff0088",
    "bashMode": "#ffaa00"
  }
}
```

3. 通过 `/settings` 选择该 theme。

**热重载：** 当你编辑当前活动的自定义 theme 文件时，pi 会自动重新加载它以获得即时视觉反馈。

## Theme 格式

```json
{
  "$schema": "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
  "name": "my-theme",
  "vars": {
    "blue": "#0066cc",
    "gray": 242
  },
  "colors": {
    "accent": "blue",
    "muted": "gray",
    "text": "",
    ...
  }
}
```

- `name` 是必需的，必须唯一，且不得包含 `/`。
- `vars` 是可选的。在此定义可复用的颜色，然后在 `colors` 中引用它们。
- `colors` 必须定义全部 53 个必需的 tokens。`thinkingMax` 和两个搜索高亮 tokens 是可选的，并使用下面列出的回退值。

`$schema` 字段启用编辑器自动补全与校验。

## Color Tokens

每个 theme 必须定义全部 53 个必需的 color tokens。可选的 tokens 保持与现有 themes 的兼容性：`thinkingMax` 回退到 `thinkingXhigh`，`searchMatchBg` 回退到 `selectedBg`，`searchMatchText` 回退到 `text`。其他搜索匹配项在 `searchMatchBg` 上使用带下划线的 `searchMatchText`；当前匹配项反转该前景/背景对并使用粗体文本。

### Core UI（13 种颜色）

| Token | 用途 |
|-------|---------|
| `accent` | 主强调色（logo、选中项、光标） |
| `border` | 普通边框 |
| `borderAccent` | 高亮边框 |
| `borderMuted` | 细微边框（编辑器） |
| `success` | 成功状态 |
| `error` | 错误状态 |
| `warning` | 警告状态 |
| `muted` | 次要文本 |
| `dim` | 三级文本 |
| `text` | 默认文本（通常为 `""`） |
| `thinkingText` | Thinking block 文本 |
| `scrollbarTrack` | Fullscreen 滚动条轨道前景色 |
| `scrollbarThumb` | Fullscreen 滚动条滑块前景色，由普通与展开状态共享 |

### 背景与内容（11 个必需，2 个可选）

| Token | 用途 |
|-------|---------|
| `selectedBg` | 选中行背景 |
| `searchMatchBg` | Transcript 搜索匹配项背景和当前匹配项文本；可选，回退到 `selectedBg` |
| `searchMatchText` | Transcript 搜索匹配项文本和当前匹配项背景；可选，回退到 `text` |
| `userMessageBg` | 用户消息背景 |
| `userMessageText` | 用户消息文本 |
| `customMessageBg` | Extension 消息背景 |
| `customMessageText` | Extension 消息文本 |
| `customMessageLabel` | Extension 消息标签 |
| `toolPendingBg` | Tool 框（pending） |
| `toolSuccessBg` | Tool 框（success） |
| `toolErrorBg` | Tool 框（error） |
| `toolTitle` | Tool 标题 |
| `toolOutput` | Tool 输出文本 |

### Markdown（10 种颜色）

| Token | 用途 |
|-------|---------|
| `mdHeading` | 标题 |
| `mdLink` | 链接文本 |
| `mdLinkUrl` | 链接 URL |
| `mdCode` | Inline code |
| `mdCodeBlock` | 代码块内容 |
| `mdCodeBlockBorder` | 代码块围栏 |
| `mdQuote` | 引用块文本 |
| `mdQuoteBorder` | 引用块边框 |
| `mdHr` | 水平分隔线 |
| `mdListBullet` | 列表项目符号 |

### Tool Diffs（3 种颜色）

| Token | 用途 |
|-------|---------|
| `toolDiffAdded` | 新增行 |
| `toolDiffRemoved` | 删除行 |
| `toolDiffContext` | Context 行 |

### 语法高亮（9 种颜色）

| Token | 用途 |
|-------|---------|
| `syntaxComment` | 注释 |
| `syntaxKeyword` | 关键字 |
| `syntaxFunction` | 函数名 |
| `syntaxVariable` | 变量 |
| `syntaxString` | 字符串 |
| `syntaxNumber` | 数字 |
| `syntaxType` | 类型 |
| `syntaxOperator` | 运算符 |
| `syntaxPunctuation` | 标点 |

### Thinking 等级边框（6 个必需，1 个可选）

表示 thinking 等级的编辑器边框颜色（从细微到突出的视觉层次）：

| Token | 用途 |
|-------|---------|
| `thinkingOff` | Thinking 关闭 |
| `thinkingMinimal` | 最小 thinking |
| `thinkingLow` | 低 thinking |
| `thinkingMedium` | 中 thinking |
| `thinkingHigh` | 高 thinking |
| `thinkingXhigh` | 超高 thinking |
| `thinkingMax` | 最大 thinking；可选，回退到 `thinkingXhigh` |

### Bash 模式（1 种颜色）

| Token | 用途 |
|-------|---------|
| `bashMode` | Bash 模式（`!` 前缀）下的编辑器边框 |

### HTML 导出（可选）

`export` 部分控制 `/export` HTML 输出的颜色。如果省略，颜色将从 `userMessageBg` 派生。

```json
{
  "export": {
    "pageBg": "#18181e",
    "cardBg": "#1e1e24",
    "infoBg": "#3c3728"
  }
}
```

## Color 值

支持四种格式：

| Format | 示例 | 描述 |
|--------|---------|-------------|
| Hex | `"#ff0000"` | 6 位十六进制 RGB |
| 256-color | `39` | xterm 256 色调色板索引（0-255） |
| Variable | `"primary"` | 对 `vars` 条目的引用 |
| Default | `""` | 终端的默认颜色 |

### 256 色调色板

- `0-15`：基础 ANSI 颜色（取决于终端）
- `16-231`：6×6×6 RGB 立方体（`16 + 36×R + 6×G + B`，其中 R,G,B 为 0-5）
- `232-255`：灰度渐变

### 终端兼容性

Pi 使用 24 位 RGB 颜色。大多数现代终端都支持这一点（iTerm2、Kitty、WezTerm、Windows Terminal、VS Code）。对于仅支持 256 色的较旧终端，pi 会回退到最接近的近似值。

检查 truecolor 支持：

```bash
echo $COLORTERM  # Should output "truecolor" or "24bit"
```

## 提示

**深色终端：** 使用明亮、饱和、对比度更高的颜色。

**浅色终端：** 使用更深、更柔和、对比度更低的颜色。

**色彩和谐：** 从基础调色板（Nord、Gruvbox、Tokyo Night）开始，在 `vars` 中定义它，并一致地引用。

**测试：** 用不同的消息类型、tool 状态、markdown 内容和长换行文本检查你的 theme。

**VS Code：** 将 `terminal.integrated.minimumContrastRatio` 设置为 `1` 以获得准确的颜色。

## 示例

查看内置 themes：
- [dark.json](../src/modes/interactive/theme/dark.json)
- [light.json](../src/modes/interactive/theme/light.json)
