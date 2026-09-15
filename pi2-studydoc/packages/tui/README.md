# @earendil-works/pi-tui

极简终端 UI 框架，具备 differential rendering 与同步输出，用于无闪烁的交互式 CLI 应用。

## 特性

- **可互换的 Renderer**：共享的 `TUI` 接口，提供主屏与备用屏两套实现
- **Differential Rendering**：仅更新发生变化的行或 viewport 行
- **应用自行掌控的滚动**：备用屏 viewport 支持鼠标、触控板与键盘导航
- **同步输出**：使用 CSI 2026 实现原子屏幕更新（无闪烁）
- **Bracketed Paste 模式**：正确处理大段粘贴，对超过 10 行的粘贴使用标记
- **基于 Component**：简单的 Component 接口，带有 render() 方法
- **Theme 支持**：Component 接受 theme 接口以实现可定制的样式
- **内置 Component**：Text、TruncatedText、Input、Editor、Markdown、Loader、SelectList、SettingsList、MouseRegion、Spacer、Image、Box、Container、VStack、HStack、ScrollView
- **内联图片**：在支持 Kitty 或 iTerm2 图形协议的终端中渲染图片
- **Autocomplete 支持**：文件路径与斜杠命令

## 快速开始

```typescript
import { type TUI, Text, Editor, ProcessTerminal, TuiMainScreen, matchesKey } from "@earendil-works/pi-tui";

// Create terminal
const terminal = new ProcessTerminal();

// Create the default main-screen renderer through the shared TUI interface
const tui: TUI = new TuiMainScreen(terminal);

// Add components
tui.addChild(new Text("Welcome to my app!"));

import { defaultEditorTheme as editorTheme } from './test/test-themes.ts';
const editor = new Editor(tui, editorTheme);
editor.onSubmit = (text) => {
  console.log("Submitted:", text);
  tui.addChild(new Text(`You said: ${text}`));
};
tui.addChild(editor);

// Focus the editor so it receives keyboard input
tui.setFocus(editor);

// In raw mode Ctrl+C doesn't send SIGINT — intercept it here to allow exit
tui.addInputListener((data) => {
  if (matchesKey(data, 'ctrl+c')) {
    tui.stop();
    process.exit(0);
  }
});

// Start
tui.start();
```

## 核心 API

### TUI 接口与 renderer

`TUI` 是用于 component 管理、焦点、overlay、输入、生命周期、终端查询与渲染的共享接口。仅在构造应用时才选择具体的 renderer：

- `TuiMainScreen` 渲染进主终端缓冲区，并保留终端 scrollback。
- `TuiAltScreen` 在备用终端缓冲区中渲染固定高度的 viewport，由应用自行掌控滚动。停止时，它会恢复主缓冲区并打印完整的最终文档。

```typescript
import { type TUI, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";

const tui: TUI = new TuiMainScreen(terminal);
// To use an application-owned viewport in the alternate terminal buffer instead:
// const tui: TUI = new TuiAltScreen(terminal);

tui.addChild(component);
tui.removeChild(component);
tui.start();
tui.stop();
tui.requestRender(); // Request a re-render

// Global debug key handler (Shift+Ctrl+D)
tui.onDebug = () => console.log("Debug triggered");
```

### 备用屏 viewport 布局

`TuiAltScreen` 可以渲染一个显式的终端高度布局。`VStack` 与 `HStack` 分配受约束的区域，而 `ScrollView` 掌控某一个区域的滚动。这些语义有意在 `TuiMainScreen` 上不可用，因为在那里终端掌控着 scrollback。

```typescript
import {
  Container,
  isViewportTUI,
  ScrollView,
  Text,
  VStack,
} from "@earendil-works/pi-tui";

const transcript = new Container();
transcript.addChild(new Text("History"));

const editorAndFooter = new VStack([
  editor,
  new Text("status"),
]);

if (isViewportTUI(tui)) {
  tui.setLayoutRoot(new VStack([
    {
      component: new ScrollView(transcript, {
        follow: "end",
        primary: true,
        overscroll: "chain",
      }),
      basis: 0,
      grow: 1,
      minSize: 1,
    },
    {
      component: editorAndFooter,
      basis: "auto",
      shrink: 1,
      minSize: 1,
    },
  ]));
}
```

Stack 条目支持 `basis`、`grow`、`shrink`、`minSize`、`maxSize` 以及响应式的 `visible` 回调。鼠标滚轮输入默认以指针下方的 scroll view 为目标，未使用的 delta 会链式传递给外层 scroll view。主 scroll view 接收备用屏键盘导航操作，以及在不可滚动区域上方的滚轮输入。它还可以在 OSC 133 语义 prompt 标记之间跳转，与常见终端 prompt 导航快捷键保持一致。按 `Ctrl+Shift+F` 可打开或关闭其带边框的搜索面板。该面板显示已配置的 previous/next 快捷键，并提供可点击的箭头控件；默认情况下，`Enter`/`Ctrl+G` 与 `Shift+Enter`/`Ctrl+Shift+G` 在匹配项之间移动，`Escape` 也会关闭搜索。`TuiAltScreenOptions.searchMatchStyle` 与 `searchCurrentMatchStyle` 定制匹配项高亮，而 `searchNavigationButtonStyle` 为每个箭头按钮设置样式并接收其 hover 状态。`TuiAltScreenOptions.scrollToEndIndicator` 会在 `follow: "end"` 的主 scroll view 滚动离开末尾时，在其最后一行居中渲染一个可点击标签；点击它会恢复跟随末尾。

布局几何会针对每一个被请求的帧重新构建。有状态的 component 会被保留，且它们现有的已渲染行缓存仍然有效。直接对这些布局 component 调用 `render(width)` 会生成一个无界文档，备用屏模式恢复主屏时也会用到它。

### Overlay

Overlay 会在现有内容之上渲染 component，而不替换现有内容。适用于对话框、菜单与模态 UI。

```typescript
// Show overlay with default options (centered, max 80 cols)
const handle = tui.showOverlay(component);

// Show overlay with custom positioning and sizing
// Values can be numbers (absolute) or percentage strings (e.g., "50%")
const handle = tui.showOverlay(component, {
  // Sizing
  width: 60,              // Fixed width in columns
  width: "80%",           // Width as percentage of terminal
  minWidth: 40,           // Minimum width floor
  maxHeight: 20,          // Maximum height in rows
  maxHeight: "50%",       // Maximum height as percentage of terminal

  // Anchor-based positioning (default: 'center')
  anchor: 'bottom-right', // Position relative to anchor point
  offsetX: 2,             // Horizontal offset from anchor
  offsetY: -1,            // Vertical offset from anchor

  // Percentage-based positioning (alternative to anchor)
  row: "25%",             // Vertical position (0%=top, 100%=bottom)
  col: "50%",             // Horizontal position (0%=left, 100%=right)

  // Absolute positioning (overrides anchor/percent)
  row: 5,                 // Exact row position
  col: 10,                // Exact column position

  // Margin from terminal edges
  margin: 2,              // All sides
  margin: { top: 1, right: 2, bottom: 1, left: 2 },

  // Responsive visibility
  visible: (termWidth, termHeight) => termWidth >= 100  // Hide on narrow terminals

  // Focus behavior
  nonCapturing: true       // Don't auto-focus when shown
});

// OverlayHandle methods
handle.hide();              // Permanently remove the overlay
handle.setHidden(true);     // Temporarily hide (can show again)
handle.setHidden(false);    // Show again after hiding
handle.isHidden();          // Check if temporarily hidden
handle.focus();             // Focus and bring to visual front
handle.unfocus();           // Release focus to normal fallback
handle.unfocus({ target: baseComponent }); // Release this overlay to a specific component
handle.unfocus({ target: null });   // Release this overlay and leave focus empty
handle.isFocused();         // Check if overlay has focus
handle.getBounds();         // Get last rendered terminal-relative bounds

handle.unfocus();
// Overlay loses focus; TUI falls back to another visible capturing overlay or the previous focus target.

handle.unfocus({ target: null });
// Overlay loses focus; no component receives input until focus is set again.

// A focused visible overlay reclaims keyboard input after temporary replacement UI
// releases focus. If you want a specific component to receive input while overlays remain
// visible, call handle.unfocus({ target: component }).

// Hide topmost overlay
tui.hideOverlay();

// Check if any visible overlay is active
tui.hasOverlay();
```

**Anchor 取值**：`'center'`、`'top-left'`、`'top-right'`、`'bottom-left'`、`'bottom-right'`、`'top-center'`、`'bottom-center'`、`'left-center'`、`'right-center'`

**解析顺序**：
1. `minWidth` 在宽度计算之后作为下限应用
2. 对于位置：绝对 `row`/`col` > 百分比 `row`/`col` > `anchor`
3. `margin` 会将最终位置钳制在终端边界之内
4. `visible` 回调控制 overlay 是否渲染（每帧都会调用）

### Component 接口

所有 component 都实现：

```typescript
interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
  invalidate?(): void;
}
```

| 方法 | 说明 |
|--------|-------------|
| `render(width)` | 返回一个字符串数组，每行一个元素。每一行**不得超过 `width`**，否则 TUI 会报错。请使用 `truncateToWidth()` 或手动换行来确保这一点。 |
| `handleInput?(data)` | 当 component 拥有焦点并接收到键盘输入时调用。`data` 字符串包含原始终端输入（可能包含 ANSI 转义序列）。 |
| `handleMouse?(event)` | 由 `TuiAltScreen` 针对目标为该 component 的归一化指针输入调用。 |
| `invalidate?()` | 调用以清除任何缓存的渲染状态。Component 应在下一次 `render()` 调用时从头重新渲染。 |

TUI 会在每一行已渲染内容的末尾追加一次完整的 SGR reset 与 OSC 8 reset。样式不会跨行延续。如果你输出带样式的多行文本，请逐行重新应用样式，或使用 `wrapTextWithAnsi()`，以便每一行被换行后的内容都保留样式。

### 鼠标输入

`TuiAltScreen` 会归一化 SGR 鼠标输入，并对 component 与 overlay 进行命中测试。事件包含 component 局部的 `x`/`y`、绝对的 `screenX`/`screenY`、bounds、button、modifiers、点击次数以及滚轮 delta。`TuiMainScreen` 不捕获鼠标输入，因为终端掌控着它的 scrollback。

```typescript
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
  if (event.type === "click" && event.button === "left") {
    this.expanded = !this.expanded;
    return { handled: true };
  }
  if (event.type === "press" && event.button === "left") {
    return { handled: true, capture: true, focus: true };
  }
  if (event.type === "drag") {
    this.updateFromPointer(event.x, event.y);
    return { handled: true, render: true };
  }
  return undefined;
}
```

返回 `handled` 会抑制 renderer 级别的回退行为。`capture` 会让后续的 drag 与 release 事件继续路由到同一个 component。`focus` 请求键盘焦点。可选的 `render` 标志控制重绘：press、click、drag 与 wheel 默认会渲染；move 与 release 不会。对于发生了可见变化的 hover 状态设置 `render: true`，对于已处理但无实际效果的 no-op 设置 `render: false`。渲染请求会被合并，终端输出仍保持差分。

未处理的手势会保留备用屏默认行为：滚轮输入滚动最近的 `ScrollView` 并链式传递未使用的 delta，主键拖动会选择文本，OSC 8 链接在父级 click 处理器之前打开，未处理的右键会保留已配置的粘贴行为。只有当 press/release 完成且未发生拖动时，才会发出 click。

使用 `MouseRegion` 可以在不改变 component 渲染的前提下添加鼠标行为：

```typescript
const collapsible = new MouseRegion(content, (event) => {
  if (event.type !== "click" || event.button !== "left") return undefined;
  expanded = !expanded;
  return { handled: true };
});
```

`Container` 与 `Box` 会使用最后一帧渲染所记录的几何信息将事件路由到嵌套子级，因此指针移动不会仅仅为了命中测试而重新渲染子级。显式的 `VStack`、`HStack` 与 `ScrollView` 布局则直接使用备用屏布局帧。

### Focusable 接口（IME 支持）

显示文本光标并需要 IME（Input Method Editor）支持的 component 应实现 `Focusable` 接口：

```typescript
import { CURSOR_MARKER, type Component, type Focusable } from "@earendil-works/pi-tui";

class MyInput implements Component, Focusable {
  focused: boolean = false;  // Set by TUI when focus changes
  
  render(width: number): string[] {
    const marker = this.focused ? CURSOR_MARKER : "";
    // Emit marker right before the fake cursor
    return [`> ${beforeCursor}${marker}\x1b[7m${atCursor}\x1b[27m${afterCursor}`];
  }
}
```

当 `Focusable` component 拥有焦点时，TUI 会：
1. 在该 component 上设置 `focused = true`
2. 扫描已渲染输出中的 `CURSOR_MARKER`（一个零宽 APC 转义序列）
3. 将硬件终端光标定位到该位置
4. 仅在启用 `showHardwareCursor` 时显示硬件光标

光标默认保持隐藏。这样既保留了假光标渲染，又能为那些通过隐藏光标跟踪 IME 候选窗口的终端定位硬件光标。部分终端需要可见的硬件光标才能进行 IME 定位；可通过 renderer 构造函数的 `showHardwareCursor` 参数或 `setShowHardwareCursor(true)` 启用。内置的 `Editor` 与 `Input` component 已实现该接口。

**内嵌输入框的容器 component：** 当某个容器 component（对话框、选择器等）包含 `Input` 或 `Editor` 子级时，该容器必须实现 `Focusable` 并将焦点状态传播给子级：

```typescript
import { Container, type Focusable, Input } from "@earendil-works/pi-tui";

class SearchDialog extends Container implements Focusable {
  private searchInput: Input;

  // Propagate focus to child input for IME cursor positioning
  private _focused = false;
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor() {
    super();
    this.searchInput = new Input();
    this.addChild(this.searchInput);
  }
}
```

如果没有这种传播，使用 IME（中文、日文、韩文等）输入时，候选窗口会显示在错误的位置。

## 内置 Component

### Container

将子 component 分组。

```typescript
const container = new Container();
container.addChild(component);
container.removeChild(component);
```

### Box

对所有子级应用 padding 与背景色的容器。

```typescript
const box = new Box(
  1,                              // paddingX (default: 1)
  1,                              // paddingY (default: 1)
  (text) => chalk.bgGray(text)   // optional background function
);
box.addChild(new Text("Content"));
box.setBgFn((text) => chalk.bgBlue(text));  // Change background dynamically
```

### Text

显示带有自动换行与 padding 的多行文本。

```typescript
const text = new Text(
  "Hello World",                  // text content
  1,                              // paddingX (default: 1)
  1,                              // paddingY (default: 1)
  (text) => chalk.bgGray(text)   // optional background function
);
text.setText("Updated text");
text.setCustomBgFn((text) => chalk.bgBlue(text));
```

### TruncatedText

单行文本，会截断以适配 viewport 宽度。适用于状态行与标题。

```typescript
const truncated = new TruncatedText(
  "This is a very long line that will be truncated...",
  0,  // paddingX (default: 0)
  0   // paddingY (default: 0)
);
```

### Input

带水平滚动的单行文本输入框。

```typescript
const input = new Input();
input.onSubmit = (value) => console.log(value);
input.setValue("initial");
input.getValue();
```

在备用屏模式下，点击会定位光标并让输入框获得键盘焦点。

**Key Bindings：**
- `Enter` - 提交
- `Ctrl+A` / `Ctrl+E` - 行首/行尾
- `Ctrl+W` 或 `Alt+Backspace` - 向后删除一个单词
- `Ctrl+U` - 删除至行首
- `Ctrl+K` - 删除至行尾
- `Ctrl+Left` / `Ctrl+Right` - 按单词导航
- `Alt+Left` / `Alt+Right` - 按单词导航
- 方向键、Backspace、Delete 按预期工作

### Editor

多行文本编辑器，支持 autocomplete、文件补全、粘贴处理，以及内容超出终端高度时的垂直滚动。

```typescript
interface EditorTheme {
  borderColor: (str: string) => string;
  selectList: SelectListTheme;
}

interface EditorOptions {
  paddingX?: number;  // Horizontal padding (default: 0)
}

const editor = new Editor(tui, theme, options?);  // tui is required for height-aware scrolling
editor.onSubmit = (text) => console.log(text);
editor.onChange = (text) => console.log("Changed:", text);
editor.disableSubmit = true; // Disable submit temporarily
editor.setAutocompleteProvider(provider);
editor.borderColor = (s) => chalk.blue(s); // Change border dynamically
editor.setPaddingX(1); // Update horizontal padding dynamically
editor.getPaddingX();  // Get current padding
```

**特性：**
- 备用屏模式下支持点击定位光标，以及可点击的 autocomplete 行
- 带自动换行的多行编辑
- 斜杠命令 autocomplete（输入 `/`）
- 文件路径 autocomplete（按 `Tab`）
- 大段粘贴处理（超过 10 行会创建 `[paste #1 +50 lines]` 标记）
- editor 上方/下方的水平线
- 假光标渲染（隐藏真实光标）

**Key Bindings：**
- `Enter` - 提交
- `Shift+Enter`、`Ctrl+Enter` 或 `Alt+Enter` - 换行（取决于终端，Alt+Enter 最可靠）
- `Tab` - Autocomplete
- `Ctrl+K` - 删除至行尾
- `Ctrl+U` - 删除至行首
- `Ctrl+W` 或 `Alt+Backspace` - 向后删除一个单词
- `Alt+D` 或 `Alt+Delete` - 向前删除一个单词
- `Ctrl+A` / `Ctrl+E` - 行首/行尾
- `Ctrl+]` - 向前跳转到字符（等待下一次按键，然后将光标移动到首次出现的位置）
- `Ctrl+Alt+]` - 向后跳转到字符
- 方向键、Backspace、Delete 按预期工作

### Markdown

渲染 markdown，支持语法高亮与主题化。

```typescript
interface MarkdownTheme {
  heading: (text: string) => string;
  link: (text: string) => string;
  linkUrl: (text: string) => string;
  code: (text: string) => string;
  codeBlock: (text: string) => string;
  codeBlockBorder: (text: string) => string;
  quote: (text: string) => string;
  quoteBorder: (text: string) => string;
  hr: (text: string) => string;
  listBullet: (text: string) => string;
  bold: (text: string) => string;
  italic: (text: string) => string;
  strikethrough: (text: string) => string;
  underline: (text: string) => string;
  highlightCode?: (code: string, lang?: string) => string[];
}

interface DefaultTextStyle {
  color?: (text: string) => string;
  bgColor?: (text: string) => string;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
}

const md = new Markdown(
  "# Hello\n\nSome **bold** text",
  1,              // paddingX
  1,              // paddingY
  theme,          // MarkdownTheme
  defaultStyle    // optional DefaultTextStyle
);
md.setText("Updated markdown");
```

**特性：**
- 标题、粗体、斜体、代码块、列表、链接、引用块
- HTML 标签按纯文本渲染
- 通过 `highlightCode` 实现可选的语法高亮
- Padding 支持
- 为提升性能而进行渲染缓存

### Loader

动画加载 spinner。

```typescript
const loader = new Loader(
  tui,                              // TUI instance for render updates
  (s) => chalk.cyan(s),            // spinner color function
  (s) => chalk.gray(s),            // message color function
  "Loading..."                      // message (default: "Loading...")
);
loader.start();
loader.setMessage("Still loading...");
loader.stop();
```

### CancellableLoader

扩展 Loader，增加 Escape 键处理以及用于取消异步操作的 AbortSignal。

```typescript
const loader = new CancellableLoader(
  tui,                              // TUI instance for render updates
  (s) => chalk.cyan(s),            // spinner color function
  (s) => chalk.gray(s),            // message color function
  "Working..."                      // message
);
loader.onAbort = () => done(null); // Called when user presses Escape
doAsyncWork(loader.signal).then(done);
```

**属性：**
- `signal: AbortSignal` - 用户按下 Escape 时被中止
- `aborted: boolean` - loader 是否已被中止
- `onAbort?: () => void` - 用户按下 Escape 时的回调

### SelectList

带键盘导航的交互式选择列表。

```typescript
interface SelectItem {
  value: string;
  label: string;
  description?: string;
}

interface SelectListTheme {
  selectedPrefix: (text: string) => string;
  selectedText: (text: string) => string;
  description: (text: string) => string;
  scrollInfo: (text: string) => string;
  noMatch: (text: string) => string;
}

const list = new SelectList(
  [
    { value: "opt1", label: "Option 1", description: "First option" },
    { value: "opt2", label: "Option 2", description: "Second option" },
  ],
  5,      // maxVisible
  theme   // SelectListTheme
);

list.onSelect = (item) => console.log("Selected:", item);
list.onCancel = () => console.log("Cancelled");
list.onSelectionChange = (item) => console.log("Highlighted:", item);
list.setFilter("opt"); // Filter items
```

**控件：**
- 鼠标移动/滚轮：在备用屏模式下高亮行
- 点击：选择一行
- 方向键：导航
- Enter：选择
- Escape：取消

### SettingsList

带值循环与子菜单的设置面板。

```typescript
interface SettingItem {
  id: string;
  label: string;
  description?: string;
  currentValue: string;
  values?: string[];  // If provided, Enter/Space cycles through these
  submenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
}

interface SettingsListTheme {
  label: (text: string, selected: boolean) => string;
  value: (text: string, selected: boolean) => string;
  description: (text: string) => string;
  cursor: string;
  hint: (text: string) => string;
}

const settings = new SettingsList(
  [
    { id: "theme", label: "Theme", currentValue: "dark", values: ["dark", "light"] },
    { id: "model", label: "Model", currentValue: "gpt-4", submenu: (val, done) => modelSelector },
  ],
  10,      // maxVisible
  theme,   // SettingsListTheme
  (id, newValue) => console.log(`${id} changed to ${newValue}`),
  () => console.log("Cancelled")
);
settings.updateValue("theme", "light");
```

**控件：**
- 鼠标移动/滚轮：在备用屏模式下高亮行
- 点击：激活一行
- 方向键：导航
- Enter/Space：激活（循环值或打开子菜单）
- Escape：取消

### Spacer

用于垂直间距的空行。

```typescript
const spacer = new Spacer(2); // 2 empty lines (default: 1)
```

### Image

为支持 Kitty 图形协议（Kitty、Ghostty、WezTerm）或 iTerm2 内联图片的终端内联渲染图片。在不支持的终端上回退为文本占位符。

```typescript
interface ImageTheme {
  fallbackColor: (str: string) => string;
}

interface ImageOptions {
  maxWidthCells?: number;
  maxHeightCells?: number;
  filename?: string;
}

const image = new Image(
  base64Data,       // base64-encoded image data
  "image/png",      // MIME type
  theme,            // ImageTheme
  options           // optional ImageOptions
);
tui.addChild(image);
```

支持的格式：PNG、JPEG、GIF、WebP。尺寸会自动从图片头部解析。

#### 备用屏图片兼容性

`TuiAltScreen` 在实现 Kitty 图形协议的终端（包括 Kitty 与 Ghostty）中支持内联图片与部分 viewport 裁剪。iTerm2 的内联图片协议不提供删除已有 placement 或在滚动时裁剪其源的操作。为防止陈旧图片残留在重绘内容之上，`TuiAltScreen` 在 iTerm2 中会将图片 component 渲染为文本占位符。`TuiMainScreen` 仍照常渲染 iTerm2 内联图片。

## Autocomplete

### CombinedAutocompleteProvider

同时支持斜杠命令与文件路径。

```typescript
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";

const provider = new CombinedAutocompleteProvider(
  [
    { name: "help", description: "Show help" },
    { name: "clear", description: "Clear screen" },
    { name: "delete", description: "Delete last message" },
  ],
  process.cwd() // base path for file completion
);

editor.setAutocompleteProvider(provider);
```

**特性：**
- 输入 `/` 查看斜杠命令
- 按 `Tab` 进行文件路径补全
- 适用于 `~/`、`./`、`../` 与 `@` 前缀
- 对于 `@` 前缀，会筛选出可附加的文件

## Key Detection

将 `matchesKey()` 与 `Key` 辅助对象配合使用来检测键盘输入（支持 Kitty 键盘协议）：

```typescript
import { matchesKey, Key } from "@earendil-works/pi-tui";

if (matchesKey(data, Key.ctrl("c"))) {
  process.exit(0);
}

if (matchesKey(data, Key.enter)) {
  submit();
} else if (matchesKey(data, Key.escape)) {
  cancel();
} else if (matchesKey(data, Key.up)) {
  moveUp();
}
```

**Key 标识符**（autocomplete 使用 `Key.*`，或使用字符串字面量）：
- 基础按键：`Key.enter`、`Key.escape`、`Key.tab`、`Key.space`、`Key.backspace`、`Key.delete`、`Key.home`、`Key.end`
- 方向键：`Key.up`、`Key.down`、`Key.left`、`Key.right`
- 带修饰键：`Key.ctrl("c")`、`Key.shift("tab")`、`Key.alt("left")`、`Key.ctrlShift("p")`
- 字符串格式同样可用：`"enter"`、`"ctrl+c"`、`"shift+tab"`、`"ctrl+shift+p"`

## 渲染模式

`TuiMainScreen` 使用三种渲染策略：

1. **首次渲染**：输出所有行，不清除 scrollback
2. **宽度变化或 viewport 之上发生变化**：清屏并完整重新渲染
3. **常规更新**：将光标移动到第一个发生变化的行，清除到末尾，并渲染发生变化的行

`TuiAltScreen` 掌控一个终端高度的 viewport。在没有显式 layout root 时，它保留旧有的单文档滚动行为。使用 `setLayoutRoot()` 时，`VStack`、`HStack` 与嵌套的 `ScrollView` component 可以预留固定区域，并独立滚动受约束的区域。它会就地更新发生变化的 viewport 行，在位于底部时跟随流式输出，并在内容增长时保留手动选择的滚动位置。鼠标滚轮与可配置的键盘导航滚动时不会修改终端 scrollback，包括在 OSC 133 语义 prompt 标记之间跳转。Scrollbar 支持 hover 展开、拖动 thumb 与点击 track 跳转。点击 OSC 8 超链接会用已配置的 URL handler 打开它。用主鼠标键拖动会选择文本，除非 `TuiAltScreenOptions.copyOnSelect` 为 `false`，否则会通过 OSC 52 将其复制到剪贴板；将拖动保持在某个 scroll view 的顶部或底部边缘会自动滚动，并将选区扩展到屏幕之外的内容。Kitty 图片支持垂直 viewport 裁剪；iTerm2 内联图片会回退为文本，因为 iTerm2 协议无法在 viewport 重绘期间删除或裁剪 placement。

两种 renderer 都会将更新包裹在**同步输出**（`\x1b[?2026h` ... `\x1b[?2026l`）中，以实现原子、无闪烁的渲染。

## Terminal 接口

TUI 可与任何实现 `Terminal` 接口的对象配合使用：

```typescript
interface Terminal {
  start(onInput: (data: string) => void, onResize: () => void): void;
  stop(): void;
  write(data: string): void;
  get columns(): number;
  get rows(): number;
  moveBy(lines: number): void;
  hideCursor(): void;
  showCursor(): void;
  clearLine(): void;
  clearFromCursor(): void;
  clearScreen(): void;
}
```

**内置实现：**
- `ProcessTerminal` - 使用 `process.stdin/stdout`
- `VirtualTerminal` - 用于测试（使用 `@xterm/headless`）

## 工具函数

```typescript
import { visibleWidth, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// Get visible width of string (ignoring ANSI codes)
const width = visibleWidth("\x1b[31mHello\x1b[0m"); // 5

// Truncate string to width (preserving ANSI codes, adds ellipsis)
const truncated = truncateToWidth("Hello World", 8); // "Hello..."

// Truncate without ellipsis
const truncatedNoEllipsis = truncateToWidth("Hello World", 8, ""); // "Hello Wo"

// Wrap text to width (preserving ANSI codes across line breaks)
const lines = wrapTextWithAnsi("This is a long line that needs wrapping", 20);
// ["This is a long line", "that needs wrapping"]
```

## 创建自定义 Component

创建自定义 component 时，**`render()` 返回的每一行都不得超过 `width` 参数**。如果有任何一行宽于终端，TUI 会报错。

### 处理输入

将 `matchesKey()` 与 `Key` 辅助对象配合用于键盘输入：

```typescript
import { matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

class MyInteractiveComponent implements Component {
  private selectedIndex = 0;
  private items = ["Option 1", "Option 2", "Option 3"];
  
  public onSelect?: (index: number) => void;
  public onCancel?: () => void;

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    } else if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
    } else if (matchesKey(data, Key.enter)) {
      this.onSelect?.(this.selectedIndex);
    } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.onCancel?.();
    }
  }

  render(width: number): string[] {
    return this.items.map((item, i) => {
      const prefix = i === this.selectedIndex ? "> " : "  ";
      return truncateToWidth(prefix + item, width);
    });
  }
}
```

### 处理行宽

使用所提供的工具函数来确保各行适配：

```typescript
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

class MyComponent implements Component {
  private text: string;

  constructor(text: string) {
    this.text = text;
  }

  render(width: number): string[] {
    // Option 1: Truncate long lines
    return [truncateToWidth(this.text, width)];

    // Option 2: Check and pad to exact width
    const line = this.text;
    const visible = visibleWidth(line);
    if (visible > width) {
      return [truncateToWidth(line, width)];
    }
    // Pad to exact width (optional, for backgrounds)
    return [line + " ".repeat(width - visible)];
  }
}
```

### ANSI 码注意事项

`visibleWidth()` 与 `truncateToWidth()` 都能正确处理 ANSI 转义序列：

- `visibleWidth()` 在计算宽度时忽略 ANSI 码
- `truncateToWidth()` 保留 ANSI 码，并在截断时正确地将其闭合

```typescript
import chalk from "chalk";

const styled = chalk.red("Hello") + " " + chalk.blue("World");
const width = visibleWidth(styled); // 11 (not counting ANSI codes)
const truncated = truncateToWidth(styled, 8); // Red "Hello" + " W..." with proper reset
```

### 缓存

为提升性能，component 应缓存其已渲染输出，仅在必要时重新渲染：

```typescript
class CachedComponent implements Component {
  private text: string;
  private cachedWidth?: number;
  private cachedLines?: string[];

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines = [truncateToWidth(this.text, width)];

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
```

## 示例

参见 `test/chat-simple.ts` 获取一个完整的聊天界面示例，其中包含：
- 带自定义背景色的 Markdown 消息
- 响应期间的加载 spinner
- 带 autocomplete 与斜杠命令的 editor
- 消息之间的 Spacer

运行它：
```bash
npx tsx test/chat-simple.ts
```

## 开发

```bash
# Install dependencies (from monorepo root)
npm install

# Run type checking
npm run check

# Run the demo
npx tsx test/chat-simple.ts
```

### 调试日志

设置 `PI_TUI_WRITE_LOG` 以捕获写入 stdout 的原始 ANSI 流。

```bash
PI_TUI_WRITE_LOG=/tmp/tui-ansi.log npx tsx test/chat-simple.ts
```
