---
description: 通过结构化的 issue 和代码分析来审查来自 URL 的 PR
argument-hint: "<PR-URL>"
---
你会被给定一个或多个 GitHub PR URL：$@

对每个 PR URL，按顺序执行以下操作：
1. 在分析开始前通过 GitHub CLI 为该 PR 添加 `inprogress` 标签。如果添加标签失败，明确报告并继续。
2. 完整阅读该 PR 页面。包括描述、所有评论、所有 commit 和所有变更文件。
3. 识别 PR 正文、评论、commit message 或交叉链接中引用的任何关联 issue。完整阅读每个 issue，包括所有评论。
4. 在不 checkout 或切换到该 PR 分支的情况下分析 PR diff。使用 `gh pr diff`、`gh pr view`、`gh api` 以及本地 main 分支文件；如果需要 PR 文件内容，使用已 fetch 的 ref 配合 `git show <ref>:<path>` 或临时文件。完整阅读所有相关代码文件，不截断，并与 diff 进行对比。除非某个文件在 main 上缺失或 diff 上下文不足，否则不要 fetch PR 文件 blob。包含不在 diff 中但验证行为所必需的相关代码路径。
5. 不要检查变更日志条目。根据 CONTRIBUTING.md，贡献者 PR 不得编辑 `CHANGELOG.md` —— 维护者在合并时添加条目。
6. 检查 packages/coding-agent/README.md、packages/coding-agent/docs/*.md、packages/coding-agent/examples/**/*.md 是否需要修改。当现有功能被更改，或新功能被添加时，通常就是这种情况。
7. 提供一份结构化的审查，包含以下章节：
   - 它做什么：用一段简短文字描述该变更及其意图。
   - 好的方面：可靠的选择或改进。
   - 坏的方面：具体的问题、回归、缺失的测试或风险。
   - 丑陋的方面：微妙或影响重大的问题。
   - 测试：覆盖了什么、缺少什么，以及现有测试是否足够。
   - 给你的开放问题：只有阻碍合并决策、需要用户输入的事项。如果没有，则完全省略该章节。

每个 PR 的输出格式：
PR: <url>
它做什么：
- ...
好的方面：
- ...
坏的方面：
- ...
丑陋的方面：
- ...
测试：
- ...
给你的开放问题：
- ...

如果没有发现问题，请在坏的方面和丑陋的方面中说明。
