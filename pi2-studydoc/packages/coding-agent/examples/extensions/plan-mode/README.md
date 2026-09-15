# Plan 模式 Extension

用于安全代码分析的只读探索模式。

## 特性

- **禁用内置写入 tool**：禁用 edit/write，同时保留其他活跃 tool
- **Bash 允许列表**：仅允许只读 bash 命令
- **Plan 提取**：从 `Plan:` 小节中提取编号步骤
- **进度跟踪**：执行期间 widget 显示完成状态
- **[DONE:n] 标记**：显式的步骤完成跟踪
- **Session 持久化**：状态在 Session 恢复后依然保留

## 命令

- `/plan` - 切换 plan 模式
- `/todos` - 显示当前 plan 进度
- `Ctrl+Alt+P` - 切换 plan 模式（快捷键）

## 用法

1. 使用 `/plan` 或 `--plan` 标志启用 plan 模式
2. 让 agent 分析代码并创建 plan
3. agent 应在 `Plan:` 标题下输出带编号的 plan：

```
Plan:
1. First step description
2. Second step description
3. Third step description
```

4. 在提示时选择 "Execute the plan"
5. 执行期间，agent 使用 `[DONE:n]` 标签将步骤标记为完成
6. 进度 widget 显示完成状态

## 工作原理

### Plan 模式（只读）
- 禁用内置 edit/write tool
- 其他活跃 tool 仍然可用
- Bash 命令通过允许列表过滤
- agent 创建 plan 而不进行任何更改

### 执行模式
- 恢复完整 tool 访问权限
- agent 按顺序执行步骤
- `[DONE:n]` 标记跟踪完成情况
- widget 显示进度

### 命令允许列表

安全命令（允许）：
- 文件查看：`cat`、`head`、`tail`、`less`、`more`
- 搜索：`grep`、`find`、`rg`、`fd`
- 目录：`ls`、`pwd`、`tree`
- Git 读取：`git status`、`git log`、`git diff`、`git branch`
- 包信息：`npm list`、`npm outdated`、`yarn info`
- 系统信息：`uname`、`whoami`、`date`、`uptime`

被阻止的命令：
- 文件修改：`rm`、`mv`、`cp`、`mkdir`、`touch`
- Git 写入：`git add`、`git commit`、`git push`
- 包安装：`npm install`、`yarn add`、`pip install`
- 系统：`sudo`、`kill`、`reboot`
- 编辑器：`vim`、`nano`、`code`
