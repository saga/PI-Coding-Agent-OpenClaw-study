---
description: scout 收集 Context，planner 创建实现计划（不实现）
---
使用带 chain 参数的 subagent tool 来执行此工作流：

1. 首先，使用 "scout" agent 查找与以下内容相关的所有代码：$@
2. 然后，使用 "planner" agent 使用上一步的 Context 为 "$@" 创建实现计划（使用 {previous} 占位符）

将此作为 chain 执行，通过 {previous} 在步骤之间传递输出。不要实现 - 只需返回 plan。
