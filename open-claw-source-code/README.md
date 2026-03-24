# OpenClaw 源码管理指南

本目录用于管理 `OpenClaw` 仓库的源代码引用。

## 目录结构

```
open-claw-source-code/          # OpenClaw 源码目录
└── openclaw/                   # 克隆的仓库
```

## 初始化（首次设置）

```powershell
# 克隆 OpenClaw 仓库
git clone https://github.com/openclaw/openclaw.git open-claw-source-code/openclaw
```

## 更新到最新版本

从项目根目录执行：

```powershell
cd open-claw-source-code/openclaw; git pull origin main
```

## 切换到特定版本/标签

```powershell
# 查看所有标签
cd open-claw-source-code/openclaw
git tag

# 切换到特定标签
git checkout v2025.3.9

# 切换回 main 分支
git checkout main
```

## 查看当前版本

```powershell
cd open-claw-source-code/openclaw
git log -1 --oneline
```

## 从源码构建

```powershell
cd open-claw-source-code/openclaw

# 安装依赖
pnpm install

# 构建 UI
pnpm ui:build

# 构建项目
pnpm build

# 运行
pnpm openclaw onboard --install-daemon
```

## 开发模式（自动重载）

```powershell
cd open-claw-source-code/openclaw
pnpm gateway:watch
```

## 仓库信息

- **仓库地址**: https://github.com/openclaw/openclaw
- **默认分支**: main
- **运行时要求**: Node ≥22
- **包管理器**: 推荐 pnpm（也支持 npm、bun）

## 主要特性

- **本地优先 Gateway** - 单一控制平面管理会话、频道、工具和事件
- **多频道收件箱** - WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, iMessage, IRC, Microsoft Teams, Matrix 等
- **多代理路由** - 将入站频道/账户路由到隔离的代理
- **语音唤醒 + 对话模式** - macOS/iOS 唤醒词，Android 持续语音
- **实时 Canvas** - 代理驱动的可视化工作区
- **配套应用** - macOS 菜单栏应用 + iOS/Android 节点

## 开发频道

- **stable**: 标签发布版本 (vYYYY.M.D)，npm dist-tag latest
- **beta**: 预发布版本 (vYYYY.M.D-beta.N)，npm dist-tag beta
- **dev**: main 分支最新代码，npm dist-tag dev

切换频道: `openclaw update --channel stable|beta|dev`
