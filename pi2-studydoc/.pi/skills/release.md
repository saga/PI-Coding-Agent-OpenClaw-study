---
name: release
description: 准备、发布、验证和恢复 pi release。用于发布准备、本地 release smoke test、发布，以及失败的 release CI 或公告。
---

# 发布 pi

除非另有说明，否则从仓库根目录（位于此 skill 之上两级）运行仓库命令。

**Lockstep versioning**：所有包共享同一个版本；每次 release 都会一起更新所有包。`patch` = 修复 + 新增，`minor` = 破坏性变更。没有 major 发布。

1. **更新 CHANGELOG**：询问用户是否在 `main` 上的最新 commit 运行了 `/cl` prompt。如果没有，他们必须先运行 `/cl`，以便在发布前审计并更新每个包的 `[Unreleased]` 章节。

2. **本地 smoke test**：构建一个未发布的 release，并从仓库之外进行 smoke test（这样它无法解析 workspace 文件）：
   ```bash
   npm run release:local -- --out /tmp/pi-local-release --force
   cd /tmp

   # Node package install smoke tests
   /tmp/pi-local-release/node/pi --help
   /tmp/pi-local-release/node/pi --version
   /tmp/pi-local-release/node/pi --list-models
   /tmp/pi-local-release/node/pi -p "Say exactly: ok"
   /tmp/pi-local-release/node/pi

   # Bun binary smoke tests
   /tmp/pi-local-release/bun/pi --help
   /tmp/pi-local-release/bun/pi --version
   /tmp/pi-local-release/bun/pi --list-models
   /tmp/pi-local-release/bun/pi -p "Say exactly: ok"
   /tmp/pi-local-release/bun/pi
   ```
   验证 Node 和 Bun 的启动、model/account 列表、交互式启动，以及至少一个使用预期默认 provider 的真实 prompt。裸命令 `/tmp/pi-local-release/node/pi` 和 `/tmp/pi-local-release/bun/pi` 会启动交互模式；在 tmux 中分别运行它们，提交一个 prompt，并等待 model 回复，然后才可认为交互式 smoke test 通过。失败是发布阻碍，除非用户明确接受该风险。

   加载并遵循 [interactive-testing.md](interactive-testing.md) 以了解 tmux 工作流。从 `/tmp` 而非仓库根目录启动每个 release 二进制文件。

3. **运行 release 脚本**：
   ```bash
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:patch    # fixes + additions
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:minor    # breaking changes
   ```
   只对 release 命令使用 `npm_config_min_release_age=0`。当当前 workspace 包版本是最近发布的时候，仓库正常的 npm age gate 可能会阻碍 release lockfile 的刷新。在 push 之前审查 release 产生的任何 lockfile 或 shrinkwrap diff。

   release 脚本会提升所有包版本、更新变更日志、重新生成 release 产物、运行 `npm run check`、提交 `Release vX.Y.Z`、打上 `vX.Y.Z` tag、添加新的 `## [Unreleased]` 变更日志章节、提交 `Add [Unreleased] section for next cycle`，然后 push `main` 和该 tag。在 tag 被 push 之后，不要重新运行 release 脚本。

4. **CI 验证并公告 npm release**：push `vX.Y.Z` tag 会触发 `.github/workflows/build-binaries.yml`。`publish-npm` job 通过 GitHub Actions OIDC 使用 npm trusted publishing，环境为 `npm-publish`；不需要本地 `npm publish`、`npm whoami`、OTP 或 WebAuthn 流程。发布之后，`announce-pi-dev-release` 会验证每个公共 workspace 包都能以确切的 release 版本解析，且其 npm tarball 可用，然后将已验证的 release marker 写入 R2。`pi.dev/api/latest-version` 会读取该 marker；在此 job 成功之前，它绝不能从 npm 公告一个 release。

5. **如果 CI 发布或公告失败**：检查失败的 job。publish helper 是幂等的，会跳过 npm 上已存在的包版本；announcement job 会在更新 R2 marker 之前重新检查可用性。在修复 CI 或临时 npm 问题后，重新运行失败的 job 或 workflow。不要为同一版本重新运行 `npm run release:patch` 或 `npm run release:minor`。
