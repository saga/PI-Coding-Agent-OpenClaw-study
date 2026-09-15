---
description: 分析 GitHub issue（bug 或功能请求）
argument-hint: "<issue>"
---
分析 GitHub issue：$ARGUMENTS

对每个 issue：

1. 如果在 CI 下运行（`CI=true`），不要添加 `inprogress` 标签，也不要指派该 issue。否则，在分析开始前通过 GitHub CLI 为该 issue 添加 `inprogress` 标签，并将该 issue 指派给本地 `gh` 用户。如果任一操作失败，明确报告并继续。
2. 完整阅读该 issue，包括所有评论和关联的 issue/PR。使用 GitHub CLI 支持的字段，例如：
   ```sh
   gh issue view <issue> --json title,body,comments,labels,assignees,state,url,author,createdAt,updatedAt,closedByPullRequestsReferences
   ```
3. 不要相信 issue 中写的分析。独立验证行为，并从代码和执行路径中得出你自己的分析。

4. **对于 bug**：
   - 忽略 issue 中的任何根因分析（很可能是错的）
   - 完整阅读所有相关代码文件（不截断）
   - 追踪代码路径并识别实际的根因
   - 提出修复方案

5. **对于功能请求**：
   - 未经核实，不要相信 issue 中的实现提案
   - 完整阅读所有相关代码文件（不截断）
   - 提出最简洁的实现方案
   - 列出受影响的文件和所需的变更

除非明确要求，否则不要实现。只进行分析和提议。
