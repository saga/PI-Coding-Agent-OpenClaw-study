> pi 可以创建 TUI component。让它为你的使用场景构建一个。

# TUI Component

Extension 和自定义 tool 可以为交互式用户界面渲染自定义 TUI component。本页介绍 component 系统以及可用的构建块。

**源码：** [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi/tree/main/packages/tui)

## Component 接口

所有 component 都实现：

```typescript
interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
  wantsKeyRelease?: boolean;
  invalidate(): void;
}
```

| 方法 | 描述 |
|--------|-------------|
| `render(width)` | 返回字符串数组（每行一个）。每一行**不得超过 `width`**。 |
| `handleInput?(data)` | 当 component 获得焦点时接收键盘输入。 |
| `handleMouse?(event)` | 在 fullscreen 模式下接收规范化后的指针输入。 |
| `wantsKeyRelease?` | 若为 true，component 会接收按键释放事件（Kitty protocol）。默认值：false。 |
| `invalidate()` | 清除缓存的渲染状态。在 theme 变更时调用。 |

TUI 会在每条已渲染行的末尾追加完整的 SGR reset 和 OSC 8 reset。样式不会跨行延续。如果你输出带样式的多行文本，请逐行重新应用样式，或使用 `wrapTextWithAnsi()`，以便为每个换行后的行保留样式。

## Focusable 接口（IME 支持）

需要显示文本光标并需要 IME（Input Method Editor）支持的 component 应实现 `Focusable` 接口：

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

当一个 `Focusable` component 获得焦点时，TUI：
1. 在该 component 上设置 `focused = true`
2. 扫描已渲染输出中的 `CURSOR_MARKER`（一个零宽 APC escape sequence）
3. 将硬件终端光标定位到该位置
4. 仅当 `showHardwareCursor` 启用时才显示硬件光标

光标默认保持隐藏。这样既保留了假光标的渲染，又能为那些以隐藏光标跟踪 IME 候选窗口的终端定位硬件光标。一些终端需要可见的硬件光标来进行 IME 定位；可通过 renderer 的 `showHardwareCursor` 构造函数参数或 `setShowHardwareCursor(true)` 来启用它。Pi 还会在创建其 renderer 之前把 `PI_HARDWARE_CURSOR=1` 映射到该设置。`Editor` 和 `Input` 内置 component 已经实现了此接口。

### 带内嵌 Input 的 Container Component

当一个 container component（dialog、selector 等）包含 `Input` 或 `Editor` 子级时，该 container 必须实现 `Focusable`，并把焦点状态传播给子级。否则，硬件光标将无法为 IME 输入正确定位。

```typescript
import { Container, type Focusable, Input } from "@earendil-works/pi-tui";

class SearchDialog extends Container implements Focusable {
  private searchInput: Input;

  // Focusable implementation - propagate to child input for IME cursor positioning
  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
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

没有这种传播，使用 IME（中文、日文、韩文等）输入时，候选窗口会显示在屏幕上错误的位置。

## 使用 Component

**在 extension 中**，通过 `ctx.ui.custom()`：

```typescript
pi.on("session_start", async (_event, ctx) => {
  const result = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) =>
    new MyComponent({
      theme,
      keybindings,
      onChange: () => tui.requestRender(),
      onSelect: (value) => done(value),
      onCancel: () => done(null),
    })
  );
});
```

**在自定义 tool 中**，通过 `ctx.ui.custom()`：

```typescript
async execute(toolCallId, params, signal, onUpdate, ctx) {
  const result = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) =>
    new MyComponent({
      theme,
      keybindings,
      onChange: () => tui.requestRender(),
      onSelect: (value) => done(value),
      onCancel: () => done(null),
    })
  );
  // Use result...
}
```

## Overlay

Overlay 会在现有内容之上渲染 component，而不清除屏幕。向 `ctx.ui.custom()` 传入 `{ overlay: true }`：

```typescript
const result = await ctx.ui.custom<string | null>(
  (tui, theme, keybindings, done) => new MyDialog({ onClose: done }),
  { overlay: true }
);
```

对于定位和尺寸，使用 `overlayOptions`：

```typescript
const result = await ctx.ui.custom<string | null>(
  (tui, theme, keybindings, done) => new SidePanel({ onClose: done }),
  {
    overlay: true,
    overlayOptions: {
      // Size: number or percentage string
      width: "50%",          // 50% of terminal width
      minWidth: 40,          // minimum 40 columns
      maxHeight: "80%",      // max 80% of terminal height

      // Position: anchor-based (default: "center")
      anchor: "right-center", // 9 positions: center, top-left, top-center, etc.
      offsetX: -2,            // offset from anchor
      offsetY: 0,

      // Or percentage/absolute positioning
      row: "25%",            // 25% from top
      col: 10,               // column 10

      // Margins
      margin: 2,             // all sides, or { top, right, bottom, left }

      // Responsive: hide on narrow terminals
      visible: (termWidth, termHeight) => termWidth >= 80,
    },
    // Get handle for programmatic focus and visibility control
    onHandle: (handle) => {
      // handle.focus() - focus this overlay and bring it to the visual front
      // handle.unfocus() - release input to normal fallback
      // handle.unfocus({ target }) - release input to a specific component or null
      // handle.setHidden(true/false) - toggle visibility
      // handle.hide() - permanently remove
    },
  }
);
```

### Overlay 焦点

一个获得焦点的可见 overlay 会在临时的非 overlay UI 期间保持输入所有权。如果一个 overlay 打开另一个未带 `{ overlay: true }` 的 `ctx.ui.custom()` component，该替换 UI 在激活期间会接收输入；当它关闭时，获得焦点的 overlay 可以重新取回输入。

当某个可见 overlay 应停止拥有输入、让 TUI 回退到另一个可见的捕获 overlay 或先前的焦点目标时，使用 `handle.unfocus()`。当 overlay 保持可见而某个特定 component 应接收输入时，使用 `handle.unfocus({ target })`。传入 `{ target: null }` 会有意不留下任何获得焦点的 component，直到再次设置焦点。

### Overlay 生命周期

Overlay component 在关闭时会被 dispose。不要复用引用——创建全新的实例：

```typescript
// Wrong - stale reference
let menu: MenuComponent;
await ctx.ui.custom((_, __, ___, done) => {
  menu = new MenuComponent(done);
  return menu;
}, { overlay: true });
setActiveComponent(menu);  // Disposed

// Correct - re-call to re-show
const showMenu = () => ctx.ui.custom((_, __, ___, done) => 
  new MenuComponent(done), { overlay: true });

await showMenu();  // First show
await showMenu();  // "Back" = just call again
```

有关涵盖 anchor、margin、堆叠、响应式可见性和动画的完整示例，见 [overlay-qa-tests.ts](../examples/extensions/overlay-qa-tests.ts)。

## 内置 Component

从 `@earendil-works/pi-tui` 导入：

```typescript
import { Text, Box, Container, Spacer, Markdown } from "@earendil-works/pi-tui";
```

### Text

带自动换行的多行文本。

```typescript
const text = new Text(
  "Hello World",    // content
  1,                // paddingX (default: 1)
  1,                // paddingY (default: 1)
  (s) => bgGray(s)  // optional background function
);
text.setText("Updated");
```

### Box

带 padding 和背景色的 Container。

```typescript
const box = new Box(
  1,                // paddingX
  1,                // paddingY
  (s) => bgGray(s)  // background function
);
box.addChild(new Text("Content", 0, 0));
box.setBgFn((s) => bgBlue(s));
```

### Container

垂直分组子 component。

```typescript
const container = new Container();
container.addChild(component1);
container.addChild(component2);
container.removeChild(component1);
```

### Spacer

空的垂直空间。

```typescript
const spacer = new Spacer(2);  // 2 empty lines
```

### Markdown

渲染带语法高亮的 markdown。

```typescript
const md = new Markdown(
  "# Title\n\nSome **bold** text",
  1,        // paddingX
  1,        // paddingY
  theme     // MarkdownTheme (see below)
);
md.setText("Updated markdown");
```

### Image

在受支持的终端（Kitty、iTerm2、Ghostty、WezTerm、Warp）中渲染图像。

```typescript
const image = new Image(
  base64Data,   // base64-encoded image
  "image/png",  // MIME type
  theme,        // ImageTheme
  { maxWidthCells: 80, maxHeightCells: 24 }
);
```

## 键盘输入

使用 `matchesKey()` 进行按键检测：

```typescript
import { matchesKey, Key } from "@earendil-works/pi-tui";

handleInput(data: string) {
  if (matchesKey(data, Key.up)) {
    this.selectedIndex--;
  } else if (matchesKey(data, Key.enter)) {
    this.onSelect?.(this.selectedIndex);
  } else if (matchesKey(data, Key.escape)) {
    this.onCancel?.();
  } else if (matchesKey(data, Key.ctrl("c"))) {
    // Ctrl+C
  }
}
```

**按键标识符**（使用 `Key.*` 以获得自动补全，或使用字符串字面量）：
- 基本按键：`Key.enter`、`Key.escape`、`Key.tab`、`Key.space`、`Key.backspace`、`Key.delete`、`Key.home`、`Key.end`
- 方向键：`Key.up`、`Key.down`、`Key.left`、`Key.right`
- 带修饰键：`Key.ctrl("c")`、`Key.shift("tab")`、`Key.alt("left")`、`Key.ctrlShift("p")`
- 字符串格式同样可用：`"enter"`、`"ctrl+c"`、`"shift+tab"`、`"ctrl+shift+p"`

## 鼠标输入

Fullscreen 模式会把规范化后的 press、release、click、move、drag 和 wheel 事件路由到 component 和 overlay。返回 `{ handled: true }` 以抑制默认行为，返回 `capture: true` 以保留 drag/release 所有权，返回 `focus: true` 以请求键盘焦点，当 hover 或 release 明显改变 component 时返回 `render: true`。press、click、drag 和 wheel 默认会渲染；无操作的 move/release 事件不会。

```typescript
import { MouseRegion } from "@earendil-works/pi-tui";

const clickable = new MouseRegion(content, (event) => {
  if (event.type !== "click" || event.button !== "left") return undefined;
  expanded = !expanded;
  return { handled: true };
});
```

未处理的 wheel 输入会滚动最近的 `ScrollView`；未处理的主键拖拽会保留 transcript 选择。OSC 8 链接优先于父级 click region。`Input`、`Editor`、`SelectList` 和 `SettingsList` 包含 fullscreen 鼠标行为。常规模式不会捕获鼠标输入，因为终端拥有其 scrollback。

## 行宽

**关键：** `render()` 返回的每一行都不得超过 `width` 参数。

```typescript
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";

render(width: number): string[] {
  // Truncate long lines
  return [truncateToWidth(this.text, width)];
}
```

工具函数：
- `visibleWidth(str)` - 获取显示宽度（忽略 ANSI code）
- `truncateToWidth(str, width, ellipsis?)` - 截断并可选地添加省略号
- `wrapTextWithAnsi(str, width)` - 保留 ANSI code 的自动换行

## 创建自定义 Component

示例：交互式 selector

```typescript
import {
  matchesKey, Key,
  truncateToWidth, visibleWidth
} from "@earendil-works/pi-tui";

class MySelector {
  private items: string[];
  private selected = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];
  
  public onSelect?: (item: string) => void;
  public onCancel?: () => void;

  constructor(items: string[]) {
    this.items = items;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up) && this.selected > 0) {
      this.selected--;
      this.invalidate();
    } else if (matchesKey(data, Key.down) && this.selected < this.items.length - 1) {
      this.selected++;
      this.invalidate();
    } else if (matchesKey(data, Key.enter)) {
      this.onSelect?.(this.items[this.selected]);
    } else if (matchesKey(data, Key.escape)) {
      this.onCancel?.();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    this.cachedLines = this.items.map((item, i) => {
      const prefix = i === this.selected ? "> " : "  ";
      return truncateToWidth(prefix + item, width);
    });
    this.cachedWidth = width;
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
```

在 extension 中的用法：

```typescript
pi.registerCommand("pick", {
  description: "Pick an item",
  handler: async (_args, ctx) => {
    const items = ["Option A", "Option B", "Option C"];
    const selected = await ctx.ui.custom<string | null>((tui, _theme, _keybindings, done) => {
      const selector = new MySelector(items);
      selector.onSelect = done;
      selector.onCancel = () => done(null);

      return {
        render: (width) => selector.render(width),
        handleInput: (data) => {
          selector.handleInput(data);
          tui.requestRender();
        },
        invalidate: () => selector.invalidate(),
      };
    });

    if (selected !== null) {
      ctx.ui.notify(`Selected: ${selected}`, "info");
    }
  }
});
```

## 主题化

Component 接受 theme 对象用于样式设置。

**在 `renderCall`/`renderResult` 中**，使用 `theme` 参数：

```typescript
renderResult(result, options, theme, context) {
  // Use theme.fg() for foreground colors
  return new Text(theme.fg("success", "Done!"), 0, 0);
  
  // Use theme.bg() for background colors
  const styled = theme.bg("toolPendingBg", theme.fg("accent", "text"));
}
```

**前景色**（`theme.fg(color, text)`）：

| 类别 | 颜色 |
|----------|--------|
| General | `text`, `accent`, `muted`, `dim`, `searchMatchText` |
| Status | `success`, `error`, `warning` |
| Borders | `border`, `borderAccent`, `borderMuted` |
| Messages | `userMessageText`, `customMessageText`, `customMessageLabel` |
| Tools | `toolTitle`, `toolOutput` |
| Diffs | `toolDiffAdded`, `toolDiffRemoved`, `toolDiffContext` |
| Markdown | `mdHeading`, `mdLink`, `mdLinkUrl`, `mdCode`, `mdCodeBlock`, `mdCodeBlockBorder`, `mdQuote`, `mdQuoteBorder`, `mdHr`, `mdListBullet` |
| Syntax | `syntaxComment`, `syntaxKeyword`, `syntaxFunction`, `syntaxVariable`, `syntaxString`, `syntaxNumber`, `syntaxType`, `syntaxOperator`, `syntaxPunctuation` |
| Thinking | `thinkingOff`, `thinkingMinimal`, `thinkingLow`, `thinkingMedium`, `thinkingHigh`, `thinkingXhigh`, `thinkingMax` |
| Modes | `bashMode` |

**背景色**（`theme.bg(color, text)`）：

`selectedBg`, `searchMatchBg`, `userMessageBg`, `customMessageBg`, `toolPendingBg`, `toolSuccessBg`, `toolErrorBg`

**对于 Markdown**，使用 `getMarkdownTheme()`：

```typescript
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";

renderResult(result, options, theme, context) {
  const mdTheme = getMarkdownTheme();
  return new Markdown(result.details.markdown, 0, 0, mdTheme);
}
```

**对于自定义 component**，定义你自己的 theme 接口：

```typescript
interface MyTheme {
  selected: (s: string) => string;
  normal: (s: string) => string;
}
```

## Debug 日志

设置 `PI_TUI_WRITE_LOG` 以捕获写入 stdout 的原始 ANSI 流。

```bash
PI_TUI_WRITE_LOG=/tmp/tui-ansi.log npx tsx packages/tui/test/chat-simple.ts
```

## 性能

尽可能缓存已渲染的输出：

```typescript
class CachedComponent {
  private cachedWidth?: number;
  private cachedLines?: string[];

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }
    // ... compute lines ...
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

当状态变化时调用 `invalidate()`，然后使用注入的 `tui.requestRender()` 触发重新渲染。

## Invalidation 与 Theme 变更

当 theme 变更时，TUI 会在所有 component 上调用 `invalidate()` 以清除它们的缓存。Component 必须正确实现 `invalidate()`，以确保 theme 变更生效。

### 问题

如果一个 component 把 theme 颜色预先烘焙进字符串（通过 `theme.fg()`、`theme.bg()` 等）并缓存它们，这些缓存字符串会包含来自旧 theme 的 ANSI escape code。如果 component 单独存储了带 theme 的内容，仅仅清除渲染缓存是不够的。

**错误的做法**（theme 颜色不会更新）：

```typescript
class BadComponent extends Container {
  private content: Text;

  constructor(message: string, theme: Theme) {
    super();
    // Pre-baked theme colors stored in Text component
    this.content = new Text(theme.fg("accent", message), 1, 0);
    this.addChild(this.content);
  }
  // No invalidate override - parent's invalidate only clears
  // child render caches, not the pre-baked content
}
```

### 解决方案

使用 theme 颜色构建内容的 component 必须在 `invalidate()` 被调用时重建该内容：

```typescript
class GoodComponent extends Container {
  private message: string;
  private content: Text;

  constructor(message: string) {
    super();
    this.message = message;
    this.content = new Text("", 1, 0);
    this.addChild(this.content);
    this.updateDisplay();
  }

  private updateDisplay(): void {
    // Rebuild content with current theme
    this.content.setText(theme.fg("accent", this.message));
  }

  override invalidate(): void {
    super.invalidate();  // Clear child caches
    this.updateDisplay(); // Rebuild with new theme
  }
}
```

### 模式：在 Invalidate 时重建

对于内容复杂的 component：

```typescript
class ComplexComponent extends Container {
  private data: SomeData;

  constructor(data: SomeData) {
    super();
    this.data = data;
    this.rebuild();
  }

  private rebuild(): void {
    this.clear();  // Remove all children

    // Build UI with current theme
    this.addChild(new Text(theme.fg("accent", theme.bold("Title")), 1, 0));
    this.addChild(new Spacer(1));

    for (const item of this.data.items) {
      const color = item.active ? "success" : "muted";
      this.addChild(new Text(theme.fg(color, item.label), 1, 0));
    }
  }

  override invalidate(): void {
    super.invalidate();
    this.rebuild();
  }
}
```

### 何时需要这样做

以下情况需要此模式：

1. **预先烘焙 theme 颜色** - 使用 `theme.fg()` 或 `theme.bg()` 创建存储在子 component 中的带样式字符串
2. **语法高亮** - 使用 `highlightCode()`，它会应用基于 theme 的语法颜色
3. **复杂布局** - 构建内嵌 theme 颜色的子 component 树

以下情况不需要此模式：

1. **使用 theme 回调** - 传入诸如 `(text) => theme.fg("accent", text)` 这样在渲染期间被调用的函数
2. **简单 container** - 只是对其他 component 分组，而不添加带 theme 的内容
3. **无状态渲染** - 在每次 `render()` 调用中全新计算带 theme 的输出（无缓存）

## 常见模式

这些模式涵盖了 extension 中最常见的 UI 需求。**复制这些模式，而不是从零开始构建。**

### 模式 1：选择对话框（SelectList）

用于让用户从选项列表中挑选。使用来自 `@earendil-works/pi-tui` 的 `SelectList`，并用 `DynamicBorder` 作为边框。

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

pi.registerCommand("pick", {
  handler: async (_args, ctx) => {
    const items: SelectItem[] = [
      { value: "opt1", label: "Option 1", description: "First option" },
      { value: "opt2", label: "Option 2", description: "Second option" },
      { value: "opt3", label: "Option 3" },  // description is optional
    ];

    const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
      const container = new Container();

      // Top border
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

      // Title
      container.addChild(new Text(theme.fg("accent", theme.bold("Pick an Option")), 1, 0));

      // SelectList with theme
      const selectList = new SelectList(items, Math.min(items.length, 10), {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      });
      selectList.onSelect = (item) => done(item.value);
      selectList.onCancel = () => done(null);
      container.addChild(selectList);

      // Help text
      container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));

      // Bottom border
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

      return {
        render: (w) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data) => { selectList.handleInput(data); tui.requestRender(); },
      };
    });

    if (result) {
      ctx.ui.notify(`Selected: ${result}`, "info");
    }
  },
});
```

**示例：** [preset.ts](../examples/extensions/preset.ts)、[tools.ts](../examples/extensions/tools.ts)

### 模式 2：可取消的异步 Operation（BorderedLoader）

用于耗时且应当可取消的 operation。`BorderedLoader` 会显示 spinner，并处理 escape 以取消。

```typescript
import { BorderedLoader } from "@earendil-works/pi-coding-agent";

pi.registerCommand("fetch", {
  handler: async (_args, ctx) => {
    const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
      const loader = new BorderedLoader(tui, theme, "Fetching data...");
      loader.onAbort = () => done(null);

      // Do async work
      fetchData(loader.signal)
        .then((data) => done(data))
        .catch(() => done(null));

      return loader;
    });

    if (result === null) {
      ctx.ui.notify("Cancelled", "info");
    } else {
      ctx.ui.setEditorText(result);
    }
  },
});
```

**示例：** [qna.ts](../examples/extensions/qna.ts)、[handoff.ts](../examples/extensions/handoff.ts)

### 模式 3：设置/开关（SettingsList）

用于切换多个设置。使用来自 `@earendil-works/pi-tui` 的 `SettingsList` 配合 `getSettingsListTheme()`。

```typescript
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";

pi.registerCommand("settings", {
  handler: async (_args, ctx) => {
    const items: SettingItem[] = [
      { id: "verbose", label: "Verbose mode", currentValue: "off", values: ["on", "off"] },
      { id: "color", label: "Color output", currentValue: "on", values: ["on", "off"] },
    ];

    await ctx.ui.custom((_tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(new Text(theme.fg("accent", theme.bold("Settings")), 1, 1));

      const settingsList = new SettingsList(
        items,
        Math.min(items.length + 2, 15),
        getSettingsListTheme(),
        (id, newValue) => {
          // Handle value change
          ctx.ui.notify(`${id} = ${newValue}`, "info");
        },
        () => done(undefined),  // On close
        { enableSearch: true }, // Optional: enable fuzzy search by label
      );
      container.addChild(settingsList);

      return {
        render: (w) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data) => settingsList.handleInput?.(data),
      };
    });
  },
});
```

**示例：** [tools.ts](../examples/extensions/tools.ts)

### 模式 4：持久状态指示器

在 footer 中显示跨渲染持久存在的状态。适合模式指示器。

```typescript
// Set status (shown in footer)
ctx.ui.setStatus("my-ext", ctx.ui.theme.fg("accent", "● active"));

// Clear status
ctx.ui.setStatus("my-ext", undefined);
```

**示例：** [status-line.ts](../examples/extensions/status-line.ts)、[plan-mode/index.ts](../examples/extensions/plan-mode/index.ts)、[preset.ts](../examples/extensions/preset.ts)

### 模式 4b：Working 指示器定制

定制 pi 在流式输出响应时显示的内联 working 指示器。

```typescript
// Static indicator
ctx.ui.setWorkingIndicator({ frames: [ctx.ui.theme.fg("accent", "●")] });

// Custom animated indicator
ctx.ui.setWorkingIndicator({
  frames: [
    ctx.ui.theme.fg("dim", "·"),
    ctx.ui.theme.fg("muted", "•"),
    ctx.ui.theme.fg("accent", "●"),
    ctx.ui.theme.fg("muted", "•"),
  ],
  intervalMs: 120,
});

// Hide the indicator entirely
ctx.ui.setWorkingIndicator({ frames: [] });

// Restore pi's default spinner
ctx.ui.setWorkingIndicator();
```

这只会影响常规的流式 working 指示器。Compaction 和 retry loader 保持它们内置的样式。自定义 frame 会被原样渲染，因此 extension 在需要时必须自行添加颜色。

**示例：** [working-indicator.ts](../examples/extensions/working-indicator.ts)

### 模式 5：Editor 上方/下方的 Widget

在输入 editor 的上方或下方显示持久内容。适合 todo 列表、进度。

```typescript
// Simple string array (above editor by default)
ctx.ui.setWidget("my-widget", ["Line 1", "Line 2"]);

// Render below the editor
ctx.ui.setWidget("my-widget", ["Line 1", "Line 2"], { placement: "belowEditor" });

// Or with theme
ctx.ui.setWidget("my-widget", (_tui, theme) => {
  const lines = items.map((item, i) =>
    item.done
      ? theme.fg("success", "✓ ") + theme.fg("muted", item.text)
      : theme.fg("dim", "○ ") + item.text
  );
  return {
    render: () => lines,
    invalidate: () => {},
  };
});

// Clear
ctx.ui.setWidget("my-widget", undefined);
```

**示例：** [plan-mode/index.ts](../examples/extensions/plan-mode/index.ts)

### 模式 6：自定义 Footer

替换 footer。`footerData` 暴露了 extension 无法通过其他方式访问的数据。

```typescript
ctx.ui.setFooter((tui, theme, footerData) => ({
  invalidate() {},
  render(width: number): string[] {
    // footerData.getGitBranch(): string | null
    // footerData.getExtensionStatuses(): ReadonlyMap<string, string>
    return [`${ctx.model?.id} (${footerData.getGitBranch() || "no git"})`];
  },
  dispose: footerData.onBranchChange(() => tui.requestRender()), // reactive
}));

ctx.ui.setFooter(undefined); // restore default
```

Token 统计可通过 `ctx.sessionManager.getBranch()` 和 `ctx.model` 获得。

**示例：** [custom-footer.ts](../examples/extensions/custom-footer.ts)

### 模式 7：自定义 Editor（vim 模式等）

用一个自定义实现替换主输入 editor。适用于模态编辑（vim）、不同的按键绑定（emacs）或专门的输入处理。

```typescript
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

type Mode = "normal" | "insert";

class VimEditor extends CustomEditor {
  private mode: Mode = "insert";

  handleInput(data: string): void {
    // Escape: switch to normal mode, or pass through for app handling
    if (matchesKey(data, "escape")) {
      if (this.mode === "insert") {
        this.mode = "normal";
        return;
      }
      // In normal mode, escape aborts agent (handled by CustomEditor)
      super.handleInput(data);
      return;
    }

    // Insert mode: pass everything to CustomEditor
    if (this.mode === "insert") {
      super.handleInput(data);
      return;
    }

    // Normal mode: vim-style navigation
    switch (data) {
      case "i": this.mode = "insert"; return;
      case "h": super.handleInput("\x1b[D"); return; // Left
      case "j": super.handleInput("\x1b[B"); return; // Down
      case "k": super.handleInput("\x1b[A"); return; // Up
      case "l": super.handleInput("\x1b[C"); return; // Right
    }
    // Pass unhandled keys to super (ctrl+c, etc.), but filter printable chars
    if (data.length === 1 && data.charCodeAt(0) >= 32) return;
    super.handleInput(data);
  }

  render(width: number): string[] {
    const lines = super.render(width);
    // Add mode indicator to bottom border (use truncateToWidth for ANSI-safe truncation)
    if (lines.length > 0) {
      const label = this.mode === "normal" ? " NORMAL " : " INSERT ";
      const lastLine = lines[lines.length - 1]!;
      // Pass "" as ellipsis to avoid adding "..." when truncating
      lines[lines.length - 1] = truncateToWidth(lastLine, width - label.length, "") + label;
    }
    return lines;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    // Factory receives the TUI, theme, and keybindings from the app
    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      new VimEditor(tui, theme, keybindings)
    );
  });
}
```

**要点：**

- **继承 `CustomEditor`**（而不是基础 `Editor`）以获得应用级的按键绑定（escape 中止、ctrl+d 退出、模型切换等）
- **对你不处理的按键调用 `super.handleInput(data)`**
- **状态 spinner**：自定义 editor 默认保留独立的状态行。将 `{ embedWorkingStatus: true }` 作为 `CustomEditor` 构造函数的第四个参数传入，改为把 working、compaction、branch summarization 和 retry spinner 内嵌到 editor 边框中。
- **工厂模式**：`setEditorComponent` 接收一个工厂函数，该函数会获得 `tui`、`theme` 和 `keybindings`
- **传入 `undefined`** 以恢复默认 editor：`ctx.ui.setEditorComponent(undefined)`

**示例：** [modal-editor.ts](../examples/extensions/modal-editor.ts)

## 关键规则

1. **始终使用回调中的 theme** - 不要直接 import theme。使用 `ctx.ui.custom((tui, theme, keybindings, done) => ...)` 回调中的 `theme`。

2. **始终为 DynamicBorder 的 color 参数标注类型** - 写成 `(s: string) => theme.fg("accent", s)`，而不是 `(s) => theme.fg("accent", s)`。

3. **状态变更后调用 tui.requestRender()** - 在 `handleInput` 中，更新状态后调用 `tui.requestRender()`。

4. **返回三方法对象** - 自定义 component 需要 `{ render, invalidate, handleInput }`。

5. **使用现有的 component** - `SelectList`、`SettingsList`、`BorderedLoader` 覆盖了 90% 的场景。不要重新构建它们。

## 示例

- **选择 UI**：[examples/extensions/preset.ts](../examples/extensions/preset.ts) - 带 DynamicBorder 边框的 SelectList
- **可取消的异步**：[examples/extensions/qna.ts](../examples/extensions/qna.ts) - 用于 LLM 调用的 BorderedLoader
- **设置开关**：[examples/extensions/tools.ts](../examples/extensions/tools.ts) - 用于启用/禁用 tool 的 SettingsList
- **状态指示器**：[examples/extensions/plan-mode/index.ts](../examples/extensions/plan-mode/index.ts) - setStatus 与 setWidget
- **Working 指示器**：[examples/extensions/working-indicator.ts](../examples/extensions/working-indicator.ts) - setWorkingIndicator
- **自定义 footer**：[examples/extensions/custom-footer.ts](../examples/extensions/custom-footer.ts) - 带统计信息的 setFooter
- **自定义 editor**：[examples/extensions/modal-editor.ts](../examples/extensions/modal-editor.ts) - 类似 Vim 的模态编辑
- **贪吃蛇游戏**：[examples/extensions/snake.ts](../examples/extensions/snake.ts) - 带键盘输入和游戏循环的完整游戏
- **自定义 tool 渲染**：[examples/extensions/todo.ts](../examples/extensions/todo.ts) - renderCall 与 renderResult
