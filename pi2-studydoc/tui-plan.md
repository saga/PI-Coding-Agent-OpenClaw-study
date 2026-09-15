# 备用屏布局系统计划

## 目的

为 `TuiAltScreen` 实现一套受约束的布局系统，并用它让 coding-agent transcript 保持可滚动，同时让 pending/status/widget/editor/footer 区域固定在底部。

本文档是一份实现交接说明。它记录了设计讨论期间做出的决策，除非实现过程中的发现要求重新审视某项决策，否则应将其视为既定范围。

## 核心决策

1. 受约束的布局系统是一项备用屏特性。
2. `TuiMainScreen` 保留其现有的终端 scrollback 渲染模型。
3. 交互模式使用两种不同的组合，但共享相同的 component 实例与行为。
4. 公开的布局原语最初为：
   - `VStack`
   - `HStack`
   - `ScrollView`
   - 现有的 overlay
5. 与帧相关的布局树是内部的。API 使用者构建 component 树，绝不操作布局 box、矩形、命中测试节点或滚动祖先。
6. 在每次被请求的渲染时重建内部布局树。不要重建 component 状态。
7. 依赖现有的叶子渲染缓存，尤其是 `Markdown`、`Text`、`Image` 与 `Box`。初期不要引入第二层框架级渲染缓存。
8. `Editor` 目前不缓存其已渲染的行，但它很小且活跃；预计它不会成为主要开销。
9. 让 `interactive-mode.ts` 的改动保持声明式且最小。布局、裁剪、滚动、命中测试与事件路由都属于 `packages/tui`。
10. 鼠标滚轮支持是一项增强。可配置的键盘滚动必须始终可用。

## 为什么主屏与备用屏布局不同

在主屏模式下，终端掌控滚动。应用无法可靠地提供：

- sticky 行
- 可独立滚动的嵌套区域
- 全高度的并排 pane
- 对移入终端 scrollback 的内容进行可靠的鼠标命中测试
- 在不重放或清除 scrollback 的情况下任意重绘屏幕之外的区域

因此，不要假装 `TuiMainScreen` 中存在相同的受约束 viewport 语义。

主屏交互模式仍然是一份垂直渲染的文档：

```text
header
已加载的资源
chat
待处理消息
status
上方的 widgets
editor / 替换 UI
下方的 widgets
footer
```

备用屏交互模式则变为：

```text
┌─────────────────────────────────────────────┐
│ 可滚动的 transcript                         │
│                                             │
│ header                                      │
│ 已加载的资源                                │
│ chat/messages/tool 输出                     │
│                                             │
├─────────────────────────────────────────────┤
│ 待处理消息                                  │
│ working/retry/compaction 状态               │
│ editor 上方的 widgets                       │
│ editor 或临时替换 UI                        │
│ editor 下方的 widgets                       │
│ footer                                      │
└─────────────────────────────────────────────┘
```

待处理消息与 status 属于固定区域。当用户阅读较早的输出时隐藏活动的队列/工作状态会令人意外。

## 目标

### 首次实现所必需的

- `TuiAltScreen` 中的受约束根布局。
- 垂直与水平的 stack 布局。
- 带 follow-end 行为的垂直滚动。
- sticky 的 coding-agent dock。
- 现有的鼠标滚轮与键盘 transcript 滚动。
- 基于指针下方区域的滚轮路由。
- 嵌套 scroll view 的滚动链式传递。
- 现有的 overlay 渲染必须继续可用。
- 现有的光标定位与 IME 支持必须继续可用。
- 现有的超链接点击与鼠标文本选择必须继续可用。
- 对于 transcript 用例，现有的 Kitty 图片行为不得退化。
- `TuiMainScreen` 的行为与输出顺序必须保持不变。
- 离开备用屏模式时仍必须打印完整的逻辑最终文档。

### 该设计所开启的未来用途

- 宽终端的侧边栏。
- 可独立滚动的 transcript 与侧边栏。
- sticky 的顶部区域。
- 布局感知的 overlay。
- Scrollbar 与未读行指示器。
- Transcript 虚拟化。

## 首次实现的非目标

- 与 CSS 兼容的 flexbox。
- Grid 布局。
- 换行的 flex 行。
- 任意的绝对定位；overlay 已覆盖此需求。
- 百分比尺寸，除非它能自然地从现有尺寸工具中得出。
- 虚拟化的 transcript 渲染。
- 增量式布局树变更。
- 供自定义 component 创建或变更内部布局节点的公开 API。
- 改造每一个现有 component 以理解高度约束。
- 给主屏模式赋予假的 sticky 或嵌套滚动语义。

## 公开 API

### Stack 条目

为垂直与水平 stack 使用同一个与轴无关的条目类型。

```ts
export interface StackEntryOptions {
	/** Initial size on the stack's main axis. Defaults to "auto". */
	basis?: number | "auto";
	/** Share of positive remaining space. Defaults to 0. */
	grow?: number;
	/** Relative willingness to shrink when content overflows. Defaults to 1. */
	shrink?: number;
	/** Minimum allocated size on the main axis. Defaults to 0. */
	minSize?: number;
	/** Maximum allocated size on the main axis. */
	maxSize?: number;
	/** Conditionally omit this entry for a viewport size. */
	visible?: (viewport: { width: number; height: number }) => boolean;
}

export interface StackEntry extends StackEntryOptions {
	component: Component;
}

export type StackChild = Component | StackEntry;

export interface StackOptions {
	gap?: number;
	align?: "stretch" | "start" | "center" | "end";
}
```

在实现中使用显式字段。不要使用 TypeScript 参数属性，因为根目录配置的源码必须保持可在 Node strip-only 模式下擦除。

### `VStack`

```ts
export class VStack implements Component {
	constructor(children?: StackChild[], options?: StackOptions);

	addChild(component: Component, options?: StackEntryOptions): void;
	removeChild(component: Component): void;
	clear(): void;
	invalidate(): void;
	render(width: number): string[];
}
```

行为：

- 公开的 `render(width)` 提供无界高度的渲染，用于兼容性与调试。
- 受约束行为由 `TuiAltScreen` 通过内部布局引擎在内部调用。
- 子级从上到下排列。
- `gap` 行仅出现在可见子级之间。
- 交叉轴默认为 `stretch`。

### `HStack`

```ts
export class HStack implements Component {
	constructor(children?: StackChild[], options?: StackOptions);

	addChild(component: Component, options?: StackEntryOptions): void;
	removeChild(component: Component): void;
	clear(): void;
	invalidate(): void;
	render(width: number): string[];
}
```

行为：

- 子级从左到右排列。
- 子级宽度根据 `basis`、`grow`、`shrink`、`minSize` 与 `maxSize` 分配。
- 较短的子级根据 `align` 填充。
- 使用现有的 ANSI 感知切片/合成工具来合成 ANSI 行。切勿用普通字符串长度或原始 substring 处理终端列。
- 初期的图片支持只需保留当前的垂直 transcript 行为。水平方向的限制见图片章节。

### `ScrollView`

```ts
export interface ScrollViewOptions {
	axis?: "vertical";
	/** Follow content growth while positioned at the end. */
	follow?: "none" | "end";
	/** Designate this view as the fallback target for global scroll actions. */
	primary?: boolean;
	/** Bubble unused wheel delta to an outer scroll view. */
	overscroll?: "chain" | "contain";
	/** Reserved for a later visible scrollbar implementation. */
	scrollbar?: "hidden" | "auto" | "always";
}

export class ScrollView implements Component {
	constructor(component: Component, options?: ScrollViewOptions);

	get scrollTop(): number;
	get isFollowingEnd(): boolean;

	scrollBy(lines: number): number;
	scrollToStart(): void;
	scrollToEnd(): void;
	invalidate(): void;
	render(width: number): string[];
}
```

`scrollBy()` 返回未使用的 delta，以便嵌套滚动可以链式传递：

```ts
const remaining = scrollView.scrollBy(delta);
```

示例：

- 请求 `+3`，移动了 `+3`：返回 `0`。
- 请求 `+3`，仅剩一行：移动一行并返回 `+2`。
- 请求 `-3`，已在顶部：返回 `-3`。

行为：

- 在受约束布局中，子级以无界高度进行测量/渲染，并裁剪到已分配的 viewport。
- 在公开的无界 `render(width)` 中，渲染完整的子级。这是最终文档输出与调试所需要的，并非为了在主屏模式下模拟 viewport 行为。
- `follow: "end"` 的行为与当前的 `TuiAltScreen.stickToBottom` 类似：
  - 以 follow 模式开始
  - 内容增长时视图保持在末尾
  - 滚动离开末尾会禁用 follow 模式
  - 到达末尾或显式滚动到末尾会启用 follow 模式
- 滚动必须请求渲染。
- 当 viewport 高度变化时保留 `scrollTop`，除非正在跟随末尾。

### Viewport 能力

不要给每一个 `TUI` 实现都添加受约束布局方法，仿佛主屏模式也支持它们一样。

添加一个显式能力：

```ts
export interface ViewportTUI extends TUI {
	setLayoutRoot(component: Component | undefined): void;
}

export function isViewportTUI(tui: TUI): tui is ViewportTUI;
```

`TuiAltScreen` 实现 `ViewportTUI`。`TuiMainScreen` 不实现。

类型守卫应测试一项稳定的能力，而不是依赖应用层的 `instanceof`。具体实现可以使用 symbol 或方法存在性检查。

当未设置显式 layout root 时，`TuiAltScreen` 的行为必须与当前 `addChild()` 的使用者保持兼容。将其现有的子级视为隐式主 `ScrollView` 中一份隐式垂直堆叠的文档。

## 内部布局 API

不要从 `packages/tui/src/index.ts` 导出这些类型。

建议模块：`packages/tui/src/layout.ts`。

```ts
interface LayoutConstraints {
	width: number;
	/** Undefined means unbounded height. */
	height: number | undefined;
}

interface LayoutRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface LayoutBox {
	component: Component;
	rect: LayoutRect;
	clip: LayoutRect;
	children: LayoutBox[];
	parent?: LayoutBox;
	/** Leaf-rendered lines. Keep the returned array by reference. */
	lines?: readonly string[];
	/** Present when this box represents a ScrollView viewport. */
	scrollView?: ScrollView;
	/** Z/layer ordering for hit testing when needed. */
	layer: number;
}

interface LayoutFrame {
	root: LayoutBox;
	width: number;
	height: number;
	lines: string[];
	primaryScrollView?: ScrollView;
}
```

确切结构可能在实现期间发生变化，但它必须支持：

- 绘制可见的终端行
- 裁剪嵌套子级
- 从终端坐标进行命中测试
- 转换为 component 局部坐标
- 遍历祖先
- 识别滚动祖先
- 定位光标标记
- 保留足够的映射以支持选区与超链接

### Component 树与布局树

公开的 component 树是长期存在且有状态的：

```text
VStack
├─ ScrollView
│  └─ chat 容器
└─ dock VStack
   ├─ editor 容器
   └─ footer 容器
```

内部布局树是临时的帧快照：

```text
根 box         rect 0,0,120,40
├─ 滚动 box    rect 0,0,120,31 clip 0,0,120,31
│  └─ 内容     rect 0,-85,120,116
└─ dock box    rect 0,31,120,9
```

针对每一个被请求的帧重建布局树。在成功绘制之后原子地替换已提交的帧，以便输入始终针对最后显示的几何信息进行路由。

不要仅仅为了生成布局几何而变更 component 状态，有意为之的 `ScrollView` 钳制/follow 状态除外。

## 渲染与缓存策略

### 重建几何，复用叶子行

一个新帧执行：

```ts
const nextLayout = layout(root, terminalBounds);
const nextScreen = paint(nextLayout);
writeScreenDiff(previousScreen, nextScreen);
currentLayout = nextLayout;
```

对于一个叶子 component：

```ts
const lines = component.render(width);
```

在布局 box 中按引用保留 `lines`。大多数开销较大的叶子已经按内容与宽度进行缓存：

- `Markdown` 缓存文本、宽度与已渲染的行。
- `Text` 缓存文本、宽度与已渲染的行。
- `Image` 缓存宽度与已渲染的行。
- `Box` 基于宽度/背景/子级输出进行缓存。
- 若干 coding-agent 动画与 tool component 拥有自己的缓存。

`Editor`、`Input`、selector、footer 以及一些较小的叶子会重新计算。初期这是可以接受的。

在 profiling 表明有需要之前，不要在布局引擎中添加单独的 `WeakMap<Component, RenderCache>`。第二层缓存有变陈旧的风险，因为现有的 component 各自拥有自己的失效语义。

### 在可行的情况下避免不必要的扁平化

第一个正确的实现可能会调用现有的 `Container.render(width)`，这会扁平化子级数组。Markdown 解析/高亮仍会被缓存，因此对于初期实现来说这是可以接受的。

如果容易且安全，将恰好是基类 `Container` 的实例优化为结构化的垂直 stack，以便布局能够保留子级的行数组与高度，而无需扁平化整个 transcript。不要绕过 `Container` 子类（例如 message/tool component）中被覆写的渲染。除非子类显式选择加入内部结构化布局，否则将其视为叶子。

不要让这项优化成为正确性的前提条件。

### 没有渲染就没有布局

仅在 `requestRender()` 调度了一次渲染之后才重建布局帧。不存在独立的布局循环。

## Stack 布局算法

实现应使用一个按轴参数化的共享 stack 分配器。

### 可见性

1. 依据终端 viewport 尺寸评估 `visible`。
2. 在计算 gap 或尺寸分配之前移除不可见的条目。

### 固有尺寸

- `basis: "auto"` 使用子级在主轴上的固有尺寸。
- 数值型 `basis` 使用给定的单元格数量。
- 将 basis 钳制到 `minSize`/`maxSize`。
- 对于会换行的叶子，宽度分配必须在固有高度已知之前完成。
- 因此 `HStack` 在测量子级高度之前先分配宽度。
- `VStack` 在分配剩余高度之前，以已分配的宽度渲染/测量自动高度的子级。

### 正的剩余空间

将正的剩余空间按 `grow` 成比例分配给 `grow > 0` 的条目，并遵守 `maxSize`。

使用确定性的整数舍入。按子级顺序分配剩余单元格，使布局不会逐帧抖动。

### 溢出

当总 basis 超出可用尺寸时：

1. 计算可收缩的条目（`shrink > 0` 且当前尺寸高于 `minSize`）。
2. 按 `shrink` 与当前 basis 成比例分配所需的收缩量，或采用另一项有文档记录的确定性策略。
3. 如果某个条目在溢出被解决之前就达到了 `minSize`，则重复。
4. 如果约束仍无法满足，则在父级边界处裁剪。

聚焦的光标绝不能仅仅因为叶子被裁剪而消失。当垂直裁剪一个叶子且其行包含 `CURSOR_MARKER` 时，尽可能选择一个包含该标记的可见行窗口。

### 初始交互布局尺寸

transcript 应具有弹性，而 dock 应优先采用固有高度：

```ts
new VStack([
	{
		component: transcriptScrollView,
		basis: 0,
		grow: 1,
		shrink: 1,
		minSize: 1,
	},
	{
		component: dock,
		basis: "auto",
		grow: 0,
		shrink: 1,
		minSize: 1,
	},
]);
```

实现必须为极小的终端与过大的自定义 widget 定义合理的行为。优先顺序为：

1. 在终端高度允许时，至少保留一行 transcript。
2. 保留聚焦的 editor/selector 光标。
3. 尽可能至少保留一行 footer。
4. 在隐藏聚焦的 editor 之前，先裁剪/截断 widget 与 pending/status 内容。

这可能需要 coding-agent 特定的 stack 条目 `minSize`/`shrink` 设置，而不是向通用 TUI 布局添加领域特定的优先级规则。

## 绘制

### 帧表面

布局引擎可以继续为每个终端行使用 ANSI 字符串，而不是引入完整的单元格对象模型。

绘制必须：

- 在受约束的备用屏模式下精确创建 `terminal.rows` 个基础行
- 遵守每个 box 的矩形与累积的 clip
- 使用 ANSI 感知的列切片
- 在独立绘制的区域之间重置样式
- 在光标提取之前保留 `CURSOR_MARKER`
- 合成水平子级而不发生样式泄漏
- 生成不超过终端宽度的行

复用：

- `sliceByColumn()`
- `compositeTuiLine()`
- `visibleWidth()`
- 现有的行重置归一化

### 垂直 stack

在各自被分配的 `y` 处绘制每个子级。跳过与累积 clip 不相交的子级与行范围。

### 水平 stack

在各自被分配的 `x` 处绘制每个子级。在合成相邻子级之前，将较短的行填充到已分配的宽度。应用重置边界，使一个子级的样式或 OSC 8 超链接不会泄漏到另一个子级。

### Scroll view

- 子级内容以其完整的自然高度进行布局。
- 子级的绘制原点按 `-scrollTop` 平移。
- 将 scroll view 的矩形累积到 clip 中。
- 仅绘制与 viewport 相交的子级行。
- 在布局树中记录 scroll box，用于命中测试与祖先遍历。

## 输入与事件路由

### 归一化鼠标事件

将终端鼠标解析保留在 `TuiAltScreen` 中，但在路由之前将解析出的序列转换为归一化事件：

```ts
interface TuiMouseEvent {
	type: "press" | "release" | "move" | "wheel";
	x: number;
	y: number;
	button: number;
	deltaX: number;
	deltaY: number;
}
```

该类型确切的公开可见性是可选的。初期的滚轮路由器可以保持内部。

### 命中测试

对已提交的布局帧进行命中测试，而不是对当前正在构建的帧。

1. 拒绝位于其 clip 之外的 box。
2. 先遍历更高层/最前面的子级。
3. 返回包含该终端坐标的最深的可见 box。
4. 保留祖先链以支持事件冒泡。

### 滚轮路由

对于一个滚轮事件：

1. 在指针处进行命中测试。
2. 从最深的 box 开始向根遍历。
3. 将 delta 提供给遇到的每一个 `ScrollView`。
4. 如果 `overscroll` 为 `"chain"`，将未使用的 delta 传递给下一个滚动祖先。
5. 如果 `overscroll` 为 `"contain"`，即使仍有 delta 也停止。
6. 如果没有命中的祖先消费该 delta，则将其提供给该帧的主 scroll view。
7. 消费已识别的鼠标序列，使原始鼠标字节永远不会到达 editor。

预期行为：

- 在 transcript 上滚动滚轮：滚动 transcript。
- 在未来的侧边栏上滚动滚轮：滚动侧边栏。
- 在嵌套 scroll view 上滚动滚轮：滚动内层视图，然后在其边界处链式传递。
- 在不可滚动的 dock/footer 上滚动滚轮：滚动主 transcript。
- 滚轮交互不得从 editor 那里抢走键盘焦点。

### 触控板

对于仅垂直的 scroll view，保留当前忽略水平滚轮事件的行为。如果一个事件同时包含两个轴，仅消费受支持的垂直部分，并记录该策略。

### 禁用鼠标时的回退

不要依赖检测鼠标支持。终端并不提供足够可靠的通用能力信号。

键盘导航始终可通过现有的可配置操作使用：

- `tui.altScreen.pageUp`
- `tui.altScreen.pageDown`
- `tui.altScreen.top`
- `tui.altScreen.bottom`

将这些操作路由到：

1. 一个显式激活的滚动区域，如果未来的多 pane 导航设置了这样一个区域
2. 否则路由到主 scroll view

对于第一个 coding-agent 布局，只有一个 scroll view，因此 transcript 始终是键盘目标。

如果未来的布局引入了多个可通过键盘选择的滚动区域，请向 `TUI_KEYBINDINGS` 添加可配置操作；绝不要硬编码按键检查。

## 焦点与光标行为

- 现有的 `TUI.setFocus(component)` 仍然是公开的键盘焦点 API。
- 键盘焦点与滚轮滚动目标是分离的。除非显式要求，滚动侧边栏不得将焦点从 editor 移开。
- 在绘制期间，在最终合成的帧中查找 `CURSOR_MARKER`。
- 光标行/列必须包含 stack 偏移、滚动平移、overlay 偏移与水平 pane 偏移。
- 仅根据现有的 `showHardwareCursor` 行为显示硬件光标。
- overlay 焦点恢复所使用的布局包含性检查必须理解 layout root 与嵌套的布局 component。

## 选区与超链接

当前的备用屏 renderer 将选区的行直接映射到一份全局逻辑文档中。一旦存在固定区域与水平区域，该假设便不再成立。

对于首次实现，保留可见屏幕的选区语义：

- anchor 与 focus 从终端屏幕坐标开始。
- 针对当前已提交的可见帧应用高亮。
- 使用 ANSI 感知的切片与 `stripTerminalSequences()` 从被选中的可见行/列复制文本。
- 空白/填充区域除了必要的行分隔之外不贡献任何文本。
- 继续将选区列吸附到字素边界。

如果需要在帧变化之间维持选区，请在已绘制的行中存储足够的源映射，以便将屏幕行转换为叶子行引用。不要将固定的 dock 行映射到不相关的 transcript 行。

超链接点击可以继续从已提交的屏幕行中、在所点击的列处读取 OSC 8 元数据。确保使用的是最终合成后的行，而不是未经偏移的子级行。

维持当前行为：

- 未拖动的点击可以调用 `openUrl`
- 拖动不会激活 URL
- 拖动后的释放会通过 OSC 52 复制

## 图片

初期所需的图片用例是现有的垂直滚动 transcript。

保留：

- Kitty 图片元数据与预留行
- 当 Kitty 图片的顶部位于滚动 viewport 之上时进行裁剪
- 当包含图片的行发生变化时进行删除/重绘
- 在备用屏模式下回退为文本的 iTerm2 行为

在首次实现中，图片协议行的水平合成不要求变得完全通用。终端图片 placement 的行为并不像普通的 ANSI 文本。记录该限制并进行防御性处理：

- `HStack` 中带图片的 component 可能被要求占据整行/整宽
- 不要静默损坏相邻 pane 的输出
- 为所选择的任何回退策略添加一个聚焦测试

不要使现有的垂直图片测试退化。

## Overlay

保留当前的 overlay 栈与定位 API。

初期集成：

1. 将基础受约束布局绘制为终端高度的行。
2. 使用当前的 overlay 逻辑在这些行之上合成现有的 overlay。
3. 从最终结果中提取光标。
4. 应用差分渲染。

在首次实现中，不要求现有的 overlay 成为嵌套的 `ScrollView` layout root。然而，基础布局的命中测试不得破坏 overlay 的焦点或输入归属。

后续阶段可以为每个 overlay 赋予其自己的受约束布局树，并将 overlay box 作为更高的命中测试层纳入。

## `TuiAltScreen` 重构

改动后建议的状态：

```ts
private layoutRoot?: Component;
private currentLayout?: LayoutFrame;
private implicitScrollView?: ScrollView;
```

在适用的情况下，将这些职责从 `TuiAltScreen` 的全局字段移入 `ScrollView`：

- `scrollTop`
- `contentLineCount`
- `stickToBottom`

诸如 `viewportTop`、`isFollowingOutput`、`scrollBy()`、`scrollToTop()` 与 `scrollToBottom()` 之类的兼容 getter/方法可以委托给主/隐式 scroll view，以便现有测试与消费者继续工作。如果向后兼容会实质性增加实现的复杂度，则不要保留它，除非测试/公开 API 表明这些方法被依赖；在移除之前检查导出与用法。

`doRender()` 在概念上变为：

```ts
const root = this.layoutRoot ?? this.getImplicitLegacyRoot();
const nextLayout = layoutConstrained(root, width, height);
let screen = paint(nextLayout);
screen = this.compositeOverlays(screen, width, height);
screen = this.applySelection(screen);
const cursor = this.extractCursorPosition(screen, height);
// Normalize, crop defensive overflow, diff, write.
this.currentLayout = nextLayout;
```

### 旧有的隐式根

当调用者仅使用 `tui.addChild()` 时：

```text
implicit ScrollView(primary, follow=end)
└─ implicit vertical document of TuiAltScreen.children
```

这保留了当前独立的 `TuiAltScreen` API 与测试。

隐式根必须观察到后续的 `addChild()`、`removeChild()` 与 `clear()` 变更。

### 停止时的最终文档

当离开备用屏模式时，以无界高度渲染显式或隐式的根：

- `ScrollView` 输出其完整的子级，而不是被裁剪的 viewport。
- coding-agent transcript 先出现，dock 在其后出现一次。
- 不要打印终端高度的填充行。
- 剥离光标标记。
- 保留现有的行重置与图片清理。

不要仅使用最后一个可见帧作为退出文档。

## 交互模式改动

文件：`packages/coding-agent/src/modes/interactive/interactive-mode.ts`

改动应保持较小。

### 添加稳定的分组容器

```ts
private documentContainer: Container;
private footerContainer: Container;
```

现有的 component 容器保持不变：

- `headerContainer`
- `loadedResourcesContainer`
- `chatContainer`
- `pendingMessagesContainer`
- `statusContainer`
- `widgetContainerAbove`
- `editorContainer`
- `widgetContainerBelow`

一次性构建 transcript 组：

```ts
this.documentContainer.addChild(this.headerContainer);
this.documentContainer.addChild(this.loadedResourcesContainer);
this.documentContainer.addChild(this.chatContainer);
```

一次性构建 footer 槽位：

```ts
this.footerContainer.addChild(this.footer);
```

### 主屏组合

保留当前确切的顺序：

```ts
this.ui.addChild(this.documentContainer);
this.ui.addChild(this.pendingMessagesContainer);
this.ui.addChild(this.statusContainer);
this.ui.addChild(this.widgetContainerAbove);
this.ui.addChild(this.editorContainer);
this.ui.addChild(this.widgetContainerBelow);
this.ui.addChild(this.footerContainer);
```

由于 `documentContainer` 在视觉上是透明的，它的三个子级渲染的位置与今天完全相同。

### 备用屏组合

```ts
const transcript = new ScrollView(this.documentContainer, {
	follow: "end",
	primary: true,
	overscroll: "chain",
});

const dock = new VStack([
	{ component: this.pendingMessagesContainer, shrink: 1, minSize: 0 },
	{ component: this.statusContainer, shrink: 1, minSize: 0 },
	{ component: this.widgetContainerAbove, shrink: 1, minSize: 0 },
	{ component: this.editorContainer, shrink: 1, minSize: 3 },
	{ component: this.widgetContainerBelow, shrink: 1, minSize: 0 },
	{ component: this.footerContainer, shrink: 1, minSize: 1 },
]);

const root = new VStack([
	{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
	{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
]);

viewportTui.setLayoutRoot(root);
```

使用 `isViewportTUI(this.ui)` 进行类型收窄。由于 `options.alt` 已经选择了 renderer，无法获得该能力属于内部编程错误，而不是静默回退。

### 自定义 footer 替换

重构 `setExtensionFooter()`，使其永不移除/添加根 TUI 子级：

```ts
this.footerContainer.clear();
this.footerContainer.addChild(this.customFooter ?? this.footer);
this.ui.requestRender();
```

继续释放被替换掉的自定义 footer。

### 不应需要逻辑改动的特性

- message 渲染
- 流式更新
- tool 更新
- widget API
- editor 替换
- extension selector/input/editor
- 内置 selector
- 队列渲染
- status 指示器
- 焦点变化
- overlay
- theme 失效

这些特性会变更现有的稳定容器，并且应自动出现在正确的布局中。

### 现有的备用屏特定 status 变通方案

重新审视这段代码：

```ts
if (hadActiveStatusIndicator && !this.options.alt && this.ui.getClearOnShrink()) {
	this.statusContainer.addChild(this.idleStatus);
}
```

主屏的变通方案应保持仅用于主屏。受约束的备用屏布局应自然地清除已释放的行。

## 建议的文件

可能的新文件：

- `packages/tui/src/layout.ts` — 内部约束、box、布局、绘制、命中测试
- `packages/tui/src/components/v-stack.ts`
- `packages/tui/src/components/h-stack.ts`
- `packages/tui/src/components/scroll-view.ts`

可能被修改的文件：

- `packages/tui/src/tui.ts`
- `packages/tui/src/tui-alt-screen.ts`
- `packages/tui/src/index.ts`
- `packages/tui/src/keybindings.ts` 仅在需要新的可配置操作时
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `packages/tui/test/tui-alt-screen.test.ts`
- `packages/tui/test/` 下新的聚焦布局测试
- `packages/coding-agent/test/interactive-tui.test.ts`
- `packages/tui/README.md`
- `packages/coding-agent/docs/usage.md`
- `packages/coding-agent/docs/keybindings.md` 如果键盘行为发生变化
- `packages/tui/CHANGELOG.md`
- `packages/coding-agent/CHANGELOG.md`

不要修改已发布的 changelog 章节。在现有的 `## [Unreleased]` 子章节下添加条目。

## 测试计划

### Stack 分配测试

为两个轴添加聚焦的单元测试：

- 自动尺寸的子级
- 数值型 basis
- 正的 grow 分配
- shrink 分配
- min/max 钳制
- 确定性的奇数单元格舍入
- gap 仅出现在可见子级之间
- 条件可见性
- 交叉轴对齐
- 宽于分配尺寸的子级输出会被安全裁剪
- ANSI 样式/超链接不会在水平子级之间泄漏
- 水平裁剪中的 CJK、emoji 与组合字符边界

### ScrollView 测试

- 初始的 `follow: "end"` 位置
- 跟随时内容增长
- 手动向上滚动会禁用 follow
- 到达底部会重新启用 follow
- 显式的 `scrollToEnd()` 会重新启用 follow
- 跟随时 viewport 的增长/收缩
- 手动定位时 viewport 的增长/收缩
- `scrollBy()` 返回未使用的正/负 delta
- 嵌套滚动链式传递
- `overscroll: "contain"`
- 子级短于 viewport
- 空的子级
- 子级宽度变化
- 当聚焦内容被裁剪时光标标记仍然可见

### 布局帧测试

- 为嵌套 V/H stack 生成的矩形
- 累积裁剪
- 命中测试返回最深的可见 box
- 被裁剪的 box 不可被命中测试
- 局部坐标转换
- 层顺序
- 从 scroll view 中仅绘制可见行
- 在 resize/内容变化后每一帧都使用新的几何信息
- 缓存的叶子行数组按引用被接受且不会被变更

### 备用屏 renderer 测试

扩展 `packages/tui/test/tui-alt-screen.test.ts`：

- 旧有的 `addChild()` 路径仍表现为当前的隐式滚动
- 显式 layout root 渲染终端高度的帧
- transcript 滚动时固定 dock 保持不变
- transcript viewport 高度将 dock 高度计算在内
- 跟随时 dock 的增长/收缩
- 手动滚动时 dock 的增长/收缩
- Shift+PageUp/Down 以主 ScrollView 为目标
- Ctrl+Home/End 以主 ScrollView 为目标
- 在 transcript 上滚动滚轮会滚动 transcript
- 在不可滚动的 dock 上滚动滚轮会回退到主 transcript
- 嵌套滚动先消费，然后冒泡未使用的 delta
- 禁用鼠标的模式仍支持键盘滚动
- dock 内的光标行正确
- 滚动内容内的光标行正确
- overlay 合成仍相对于屏幕
- overlay 焦点行为保持正确
- 在水平/垂直偏移之后 OSC 8 点击仍正确
- 选区/复制在 transcript 中可用
- 选区/复制在 dock 中可用且不会映射到 transcript 行
- 终端 resize 会重新计算布局
- 过大的 dock 不会丢失聚焦的光标
- 停止时会精确打印一次完整的 transcript 加 dock
- 最终输出中没有终端填充行

保留并通过所有现有的图片测试：

- 在 viewport 顶部进行的 Kitty 裁剪
- 图片删除/重绘
- iTerm2 回退
- 没有陈旧的图片 placement

### 主屏回归测试

- 现有的主屏测试原样通过
- 交互式主屏的子级顺序/渲染输出保持不变
- 自定义 footer 在流式布局中仍位于底部
- 在主屏模式下不安装 layout root 或应用滚动

### Coding-agent 集成测试

在 `packages/coding-agent/test/interactive-tui.test.ts` 或一个新的聚焦测试中：

- renderer 能力仅在备用屏模式下暴露
- 主模式挂载流式组合
- 备用屏模式挂载 transcript ScrollView 加 dock
- pending/status/widgets/editor/footer 位于 dock 中
- 自定义 footer 替换会更新 `footerContainer`
- editor 替换不会重建根布局
- widget 更新不会重建公开的 component 组合

优先检查 component 组合或使用 `VirtualTerminal`；不要使用真实的 provider API。

## 验证命令

在实现改动之后：

1. 使用仓库规定的 Vitest 调用方式，从相关的包根目录运行每个被修改/新增的聚焦测试。
2. 从仓库根目录运行 `npm run check`，并修复所有 error、warning 与 info。
3. 不要运行 `npm test` 或完整的 Vitest 套件。
4. 如果需要更广泛的验证，可选地使用仓库的 `./test.sh` 运行所有非 e2e 测试。
5. 使用 `AGENTS.md` 中的流程在 tmux 中手动演练备用屏模式：
   - 长 transcript
   - 滚轮/触控板滚动
   - Shift+PageUp/Down
   - 手动滚动时的流式输出
   - 返回底部/follow
   - 多行 editor
   - autocomplete 打开
   - settings/model/tree selector 替换 editor
   - editor 上方与下方的 extension widget
   - 自定义 footer
   - 终端 resize
   - 超链接点击
   - 鼠标选区/复制
   - 在可用的情况下测试 Kitty 图片
6. 手动对主屏模式进行冒烟测试，以确保终端 scrollback 行为不变。

## 建议的实现顺序

1. 添加 stack 分配单元测试与共享的轴分配器。
2. 实现 `VStack` 的无界渲染与受约束内部布局。
3. 实现带 ANSI 安全合成的 `HStack`。
4. 实现 `ScrollView` 状态以及独立于终端 ANSI 输出的单元测试。
5. 实现内部布局帧的生成与绘制。
6. 添加命中测试与滚动祖先遍历。
7. 将显式与隐式 layout root 集成到 `TuiAltScreen`。
8. 将当前的全局备用屏滚动行为移到隐式主 `ScrollView` 的兼容路径之后。
9. 逐个子系统地保留选区、超链接、光标、overlay 与图片处理，每一步之后运行现有测试。
10. 添加 coding-agent 分组容器与两个小的组合分支。
11. 重构自定义 footer 替换以使用 `footerContainer`。
12. 添加集成测试、文档与 changelog 条目。
13. 运行聚焦测试与 `npm run check`。
14. 在两种模式下执行 tmux/手动冒烟测试。

## 验收标准

当满足以下条件时，实现即告完成：

- 主屏模式的行为与之前一致，并保留终端 scrollback。
- 备用屏模式拥有可滚动的 transcript 与固定的底部 dock。
- 仅在 follow 模式激活时，流式输出才跟随 transcript 末尾。
- 新输出到达时手动滚动保持稳定。
- 鼠标滚轮路由到相应的 scroll view，并在边界处链式传递。
- 禁用鼠标时键盘导航可用。
- Editor/selector 焦点与 IME 光标定位保持正确。
- Widget 与自定义 footer 在备用屏模式下保持 extension 兼容且固定。
- 超链接、选区、overlay 与 Kitty transcript 图片不会退化。
- 离开备用屏模式时会打印一次完整的逻辑文档。
- 布局 box 是内部的，并针对每一个被请求的帧重建。
- 开销较大的叶子渲染继续使用现有的 component 缓存。
- 所有聚焦测试与 `npm run check` 通过。
