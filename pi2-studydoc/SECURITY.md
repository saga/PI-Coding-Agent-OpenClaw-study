# 安全策略

本文档应指导你理解 Pi 背后的安全概念，
以及边界在哪里。

一般来说，Pi 是一个 coding agent，它在运行它的用户的
安全边界内本地运行。 用户有责任监控其操作，或将其
限制在容器、虚拟机或其他 Sandbox
解决方案中。

Pi 把本地用户账号以及该账号可写入的文件视为与 Pi 进程
本身处于同一信任边界内。 如果攻击者能够修改用户 home
目录、workspace、shell 启动文件、环境或 Pi 配置下的文件，
他们通常就能影响 Pi 或其他本地开发者工具。依赖此类事先
本地写入权限的报告不是安全漏洞，除非它们展示了 Pi 如何
授予该写入权限，或如何跨越操作系统权限
边界。

Pi 依赖用户安装可信的 extension，并加载可信的 skill，
且只在可信的仓库中使用 pi。 这是因为像 `AGENTS.md` 这样
的文件或注释中的指令可以被轻易地用来对 coding agent 进行
prompt inject，而这无法被防护。

## 报告漏洞

如果你认为你在 pi 或本仓库中的其他包中发现了安全漏洞，
请通过以下任一方式私下报告：

- 发送电子邮件至 `security@earendil.com`，或
- 通过本仓库的 GitHub Security Advisories 开启一个私有报告

请包含：

- 对问题及其影响的描述
- 复现步骤、proof of concept 或相关日志
- 受影响的包、版本、commit 或配置
- 任何已知的缓解措施

不要为安全敏感的报告开公开 issue。 我们将审查
报告，并在适当时协调披露。

## 范围

分布式包、命令行工具、API 和仓库代码中的安全问题，以及
earendil 在 `pi.dev` 上运营的基础设施，
都在范围内。

## 范围之外

- 本地代码执行或 sandbox 行为（Pi coding agent 有意不设 sandbox）
- 用户安装的 pi extension 或 skill 的行为
- 在不可信仓库中工作带来的风险
- 安装不可信 extension、skill、包或工具带来的风险
- 由不可信的 MITM 代理引起的问题
- Pi 安装暴露于公共互联网
- Prompt injection 攻击
- 暴露的 secret 属于第三方/用户控制的凭据
- 需要能够在目标机器上创建、修改、删除或替换文件、
  目录、符号链接、环境变量、shell 配置或其他
  用户控制的本地状态的报告。这包括 `~/.pi`、
  `~/.pi/agent/models.json`、workspace 文件、`AGENTS.md`、skill、extension、
  extension 配置、dotfiles，以及通过 NFS、漫游
  配置文件或 dotfile 管理器同步的文件，除非该报告展示了 Pi 自身
  如何授予该访问权限。
- 由故意削弱的用户配置引起的问题。
- 针对 pi coding agent、需要可信本地输入/配置的资源/DOS 声明。
- 关于恶意 model 输出的报告。
- 被呈现为漏洞的用户批准或用户发起的本地操作。

## 给报告者的说明

最有用的报告会展示一个当前可复现的安全边界绕过，
并带有已证实的影响。 仅展示预期的本地 agent 行为、
prompt injection，或恶意的可信 extension/skill 的报告，
在此模型下不是安全漏洞。

例如，一份报告展示写入可信 Pi 配置文件的恶意内容导致
Pi 执行命令、加载攻击者控制的 tool、将凭据发送到
攻击者控制的 endpoint，或以其他方式改变行为，
这属于范围之外。

在可能的情况下，包含确切的受影响路径、包版本或 commit SHA、
配置，以及针对最新 release 或最新 `main` 的 proof of concept。
对于依赖报告，包含证据证明所发布的依赖受到影响，
且该问题可通过 Pi 触达。 对于暴露 secret 的报告，
包含证据证明该凭据归 Earendil 所有，或授予对
Earendil 运营的基础设施或服务的访问权限。
