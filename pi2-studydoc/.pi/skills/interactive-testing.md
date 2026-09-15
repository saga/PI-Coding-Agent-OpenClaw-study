---
name: interactive-testing
description: 在受控的 tmux 终端中测试和调试 pi 的交互模式。用于 TUI 行为检查和交互式 release smoke test。
---

# 使用 tmux 测试 pi 交互模式

在受控终端中运行 TUI（从仓库根目录运行，该目录位于此 skill 之上两级）：

```bash
tmux new-session -d -s pi-test -x 80 -y 24
tmux send-keys -t pi-test "./pi-test.sh" Enter
sleep 3 && tmux capture-pane -t pi-test -p     # capture after startup
tmux send-keys -t pi-test "your prompt here" Enter
tmux send-keys -t pi-test Escape               # special keys (also C-o for ctrl+o, etc.)
tmux kill-session -t pi-test
```

对于 release smoke test，使用 `-c /tmp` 启动 tmux session，并将 `./pi-test.sh` 替换为 release 二进制的绝对路径。分别测试 Node 和 Bun 二进制文件，提交一个 prompt，并等待 model 回复；仅启动成功不算通过 smoke test。
