# pi-mono 源码管理指南

本目录用于管理 `pi-mono` 仓库的源代码引用。

## 目录结构

```
pi-coding-agent-source-code/    # pi-mono 源码目录
└── pi-mono/                    # 克隆的仓库
```

## 初始化（首次设置）

```powershell
# 克隆 pi-mono 仓库
git clone https://github.com/badlogic/pi-mono.git pi-coding-agent-source-code/pi-mono
```

## 更新到最新版本

```powershell
# 进入源码目录并拉取最新代码
cd pi-coding-agent-source-code/pi-mono
git pull origin main
```

或者一行命令：

```powershell
cd pi-coding-agent-source-code/pi-mono; git pull origin main
```

## 切换到特定版本/标签

```powershell
# 查看所有标签
cd pi-coding-agent-source-code/pi-mono
git tag

# 切换到特定标签
git checkout v0.56.3

# 切换回 main 分支
git checkout main
```

## 查看当前版本

```powershell
cd pi-coding-agent-source-code/pi-mono
git log -1 --oneline
```

## 仓库信息

- **仓库地址**: https://github.com/badlogic/pi-mono
- **默认分支**: main
- **包含包**:
  - `@mariozechner/pi-ai` - 统一多提供商 LLM API
  - `@mariozechner/pi-agent-core` - Agent 运行时
  - `@mariozechner/pi-coding-agent` - 交互式编码代理 CLI
  - `@mariozechner/pi-mom` - Slack 机器人
  - `@mariozechner/pi-tui` - 终端 UI 库
  - `@mariozechner/pi-web-ui` - Web UI 组件
  - `@mariozechner/pi-pods` - vLLM 部署管理 CLI
