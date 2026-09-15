> pi 可以帮助你创建 pi package。让它打包你的 extension、skill、prompt template 或 theme。

# Pi Packages

Pi package 打包 extension、skill、prompt template 和 theme，以便你可以通过 npm 或 git 分享它们。一个 package 可以在 `package.json` 中的 `pi` 键下声明资源，或使用约定目录。

## 目录

- [安装和管理](#install-and-manage)
- [Package 来源](#package-sources)
- [创建 Pi Package](#creating-a-pi-package)
- [Package 结构](#package-structure)
- [依赖](#dependencies)
- [Package 过滤](#package-filtering)
- [启用和禁用资源](#enable-and-disable-resources)
- [作用域和去重](#scope-and-deduplication)

## 安装和管理

> **安全性：** Pi package 以完整的系统访问权限运行。Extension 会执行任意代码，skill 可以指示模型执行任何操作，包括运行可执行文件。安装第三方 package 前请审查源代码。

```bash
pi install npm:@foo/bar@1.0.0
pi install git:github.com/user/repo@v1
pi install https://github.com/user/repo  # raw URLs work too
pi install /absolute/path/to/package
pi install ./relative/path/to/package

pi remove npm:@foo/bar
pi list                     # show installed packages from settings
pi update                   # update pi only
pi update --all             # update pi, update packages, and reconcile pinned git refs
pi update --extensions      # update packages and reconcile pinned git refs only
pi update --models          # refresh model catalogs only
pi update --self            # update pi only
pi update --self --force    # reinstall pi even if current
pi update npm:@foo/bar      # update one package
pi update --extension npm:@foo/bar
```

这些命令管理 pi package，并且 `pi update` 可以更新 pi CLI 安装。对于实验性的安装程序管理的安装，`pi update` 会将确切检出的版本安装到一个分阶段的、由 lockfile 支持的 release 中，并仅在验证后激活它；如果更新失败，则保持当前 release 不变。受管理的安装不支持 `--force`；请重新运行安装程序来修复。要卸载 pi 本身，请参见 [Quickstart](quickstart.md#uninstall)。

默认情况下，`install` 和 `remove` 会写入用户 settings（`~/.pi/agent/settings.json`）。使用 `-l` 改为写入项目 settings（`.pi/settings.json`）。项目 settings 可以与你的团队共享，并且在项目被信任后，pi 会在启动时自动安装任何缺失的 package。

要在不安装的情况下试用一个 package，请使用 `--extension` 或 `-e`。这只会为当前运行安装到一个临时目录：

```bash
pi -e npm:@foo/bar
pi -e git:github.com/user/repo
```

## Package 来源

Pi 在 settings 和 `pi install` 中接受三种来源类型。

### npm

```
npm:@scope/pkg@1.2.3
npm:pkg
```

- 带版本的 spec 会被固定，并且会被 package 更新跳过（`pi update --extensions`、`pi update --all`）。
- 用户安装位于 `~/.pi/agent/npm/` 下。
- 项目安装位于 `.pi/npm/` 下。
- 在 `settings.json` 中设置 `npmCommand`，将 npm package 查找和安装操作固定到特定的包装命令，例如 `mise` 或 `asdf`。

示例：

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

### git

```
git:github.com/user/repo@v1
git:git@github.com:user/repo@v1
https://github.com/user/repo@v1
ssh://git@github.com/user/repo@v1
```

- 没有 `git:` 前缀时，只接受协议 URL（`https://`、`http://`、`ssh://`、`git://`）。
- 有 `git:` 前缀时，接受简写格式，包括 `github.com/user/repo` 和 `git@github.com:user/repo`。
- HTTPS 和 SSH URL 都受支持。
- SSH URL 会自动使用你配置的 SSH 密钥（遵循 `~/.ssh/config`）。
- 对于非交互式运行（例如 CI），你可以设置 `GIT_TERMINAL_PROMPT=0` 来禁用凭据提示，并设置 `GIT_SSH_COMMAND`（例如 `ssh -o BatchMode=yes -o ConnectTimeout=5`）来快速失败。
- Ref 是固定的 tag 或 commit。`pi update --extensions` 和 `pi update --all` 不会将它们移动到更新的 ref，但它们会将现有 clone 与配置的 ref 进行协调。
- 使用 `pi install git:host/user/repo@new-ref` 更新 settings，并将现有 package 移动到一个新的固定 ref。
- 克隆到 `~/.pi/agent/git/<host>/<path>`（全局）或 `.pi/git/<host>/<path>`（项目）。
- 当协调改变了检出内容时，pi 会重置并清理 clone，然后如果 `package.json` 存在则运行 `npm install`。

**SSH 示例：**
```bash
# git@host:path shorthand (requires git: prefix)
pi install git:git@github.com:user/repo

# ssh:// protocol format
pi install ssh://git@github.com/user/repo

# With version ref
pi install git:git@github.com:user/repo@v1.0.0
```

### 本地路径

```
/absolute/path/to/package
./relative/path/to/package
```

本地路径指向磁盘上的文件或目录，并会被添加到 settings 中而不进行复制。相对路径会相对于它们所在的 settings 文件进行解析。如果路径是一个文件，它会作为单个 extension 加载。如果是一个目录，pi 会使用 package 规则加载资源。

## 创建 Pi Package

向 `package.json` 添加一个 `pi` manifest，或使用约定目录。包含 `pi-package` 关键字以便于发现。

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

路径相对于 package 根目录。数组支持 glob 模式和 `!exclusions`。正向 manifest glob 会按字典序发现可见路径。直接列出以点开头的路径。如果一个 glob 需要继续穿过符号链接，请直接列出符号链接的资源根目录。

### Gallery 元数据

[package gallery](https://pi.dev/packages) 会显示标记了 `pi-package` 的 package。添加 `video` 或 `image` 字段以显示预览：

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "video": "https://example.com/demo.mp4",
    "image": "https://example.com/screenshot.png"
  }
}
```

- **video**：仅限 MP4。在桌面端，悬停时自动播放。点击会打开全屏播放器。
- **image**：PNG、JPEG、GIF 或 WebP。显示为静态预览。

如果两者都设置了，video 优先。

## Package 结构

### 约定目录

如果没有 `pi` manifest，pi 会从这些目录自动发现资源：

- `extensions/` 加载 `.ts` 和 `.js` 文件
- `skills/` 递归查找 `SKILL.md` 文件夹，并将顶层 `.md` 文件作为 skill 加载
- `prompts/` 加载 `.md` 文件
- `themes/` 加载 `.json` 文件

## 依赖

第三方运行时依赖属于 `package.json` 中的 `dependencies`。不注册 extension、skill、prompt template 或 theme 的依赖也属于 `dependencies`。当 pi 从 npm 或 git 安装 package 时，它会运行 `npm install`，因此这些依赖会被自动安装。

Pi 为 extension 和 skill 捆绑了核心 package。如果你导入了其中任何一个，请将它们列在 `peerDependencies` 中并使用 `"*"` 范围，且不要捆绑它们：`@earendil-works/pi-ai`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`、`typebox`。

其他 pi package 必须捆绑在你的 tarball 中。将它们添加到 `dependencies` 和 `bundledDependencies`，然后通过 `node_modules/` 路径引用它们的资源。Pi 使用单独的模块根目录加载 package，因此单独的安装不会冲突或共享模块。

示例：

```json
{
  "dependencies": {
    "shitty-extensions": "^1.0.1"
  },
  "bundledDependencies": ["shitty-extensions"],
  "pi": {
    "extensions": ["extensions", "node_modules/shitty-extensions/extensions"],
    "skills": ["skills", "node_modules/shitty-extensions/skills"]
  }
}
```

## Package 过滤

使用 settings 中的对象形式过滤 package 加载的内容：

```json
{
  "packages": [
    "npm:simple-pkg",
    {
      "source": "npm:my-package",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"],
      "themes": ["+themes/legacy.json"]
    }
  ]
}
```

`+path` 和 `-path` 是相对于 package 根目录的确切路径。

- 省略某个键表示加载该类型的所有内容。
- 使用 `[]` 表示不加载该类型的任何内容。
- `!pattern` 排除匹配项。
- `+path` 强制包含一个确切的路径。
- `-path` 强制排除一个确切的路径。
- 过滤器叠加在 manifest 之上。它们会缩小已经被允许的范围。

## 启用和禁用资源

使用 `pi config` 启用或禁用来自已安装 package 和本地目录的 extension、skill、prompt template 和 theme。`pi config` 从全局 settings（`~/.pi/agent/settings.json`）开始；按 Tab 在全局和项目本地模式之间切换。使用 `pi config -l` 从项目覆盖（`.pi/settings.json`）开始，继承的全局资源会变暗显示。

## 作用域和去重

Package 可以同时出现在全局和项目 settings 中。如果同一个 package 同时出现在两者中，项目条目优先，除非项目条目具有 `autoload: false`，在这种情况下，它会作为全局条目之上的增量应用。身份由以下内容确定：

- npm：package 名称
- git：不带 ref 的仓库 URL
- local：解析后的绝对路径
