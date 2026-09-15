# 示例

pi-coding-agent SDK 与 extension 的示例代码。

## 目录

### [sdk/](sdk/)
通过 `createAgentSession()` 的编程式用法。展示如何自定义模型、提示词、tool、extension 以及 Session 管理。

### [extensions/](extensions/)
示例 extension 演示：
- 生命周期事件处理器（tool 拦截、安全门、Context 修改）
- 自定义 tool（todo 列表、问题、subagent、输出截断）
- 命令与键盘快捷键
- 自定义 UI（页脚、页眉、编辑器、覆盖层）
- Git 集成（检查点、自动提交）
- 系统提示词修改与自定义 Compaction
- 外部集成（SSH、文件监听、系统 theme 同步）
- 自定义 provider（带自定义流式传输的 Anthropic、GitLab Duo）

### [plugins/pi-example-plugin/](plugins/pi-example-plugin/)
一个实验性 plugin 包，Pi 会自动将其构建为独立的 Session-worker 与 TUI Chord facet。

## 文档

- [SDK 参考](sdk/README.md)
- [Extensions 文档](../docs/extensions.md)
- [Skills 文档](../docs/skills.md)
