---
description: 在发布前审计变更日志条目
---
审计自上次发布以来所有 commit 的变更日志条目。

## 流程

1. **找到上一个 release tag：**
   ```bash
   git tag --sort=-version:refname | head -1
   ```

2. **列出该 tag 以来的所有 commit：**
   ```bash
   git log <tag>..HEAD --oneline
   ```

3. **阅读每个包的 [Unreleased] 章节：**
   - packages/ai/CHANGELOG.md
   - packages/tui/CHANGELOG.md
   - packages/coding-agent/CHANGELOG.md

4. **对每个 commit 检查：**
   - 跳过：变更日志更新、仅文档变更、发布杂务
   - 跳过：对生成的 model catalog 的变更（例如 `packages/ai/src/models.generated.ts`），除非伴随非生成源码/文档中一项有意的、面向产品的变更。
   - 确定该 commit 影响哪个（些）包（使用 `git show <hash> --stat`）
   - 验证受影响的包中存在变更日志条目
   - 对于外部贡献（PR），验证格式：`Description ([#N](url) by [@user](url))`

5. **跨包重复规则：**
   `ai`、`agent` 或 `tui` 中影响最终用户的变更应重复到 `coding-agent` 的变更日志，因为 coding-agent 是依赖它们的面向用户的包。

6. **在变更日志修复之后添加 New Features 章节：**
   - 在 `packages/coding-agent/CHANGELOG.md` 的 `## [Unreleased]` 开头插入一个 `### New Features` 章节。
   - 在写入之前，向用户提议最重要的新功能以获取确认。
   - 尽可能链接到相关文档和章节。

7. **报告：**
   - 列出缺少条目的 commit
   - 列出需要跨包重复的条目
   - 直接添加任何缺失的条目

## 变更日志格式参考

章节（按顺序）：
- `### Breaking Changes` - 需要迁移的 API 变更
- `### Added` - 新功能
- `### Changed` - 对现有功能的变更
- `### Fixed` - Bug 修复
- `### Removed` - 移除的功能

署名：
- 内部：`Fixed foo ([#123](https://github.com/earendil-works/pi/issues/123))`
- 外部：`Added bar ([#456](https://github.com/earendil-works/pi/pull/456) by [@user](https://github.com/user))`
