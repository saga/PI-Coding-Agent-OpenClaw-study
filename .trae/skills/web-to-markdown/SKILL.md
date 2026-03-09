---
name: "web-to-markdown"
description: "下载网页并转换为 Markdown 格式保存到本地。当用户想要保存网页内容、将 URL 转换为 Markdown、归档在线文章，或直接粘贴网址时调用。"
---

# 网页转 Markdown

此技能用于下载网页并将其转换为干净的 Markdown 格式，便于本地存储和离线阅读。

## 执行优先级

**此 skill 执行优先级高。** 当用户输入包含 URL 时，优先执行此 skill，除非用户在 prompt 中明确声明"xx skill 优先执行"。

## 调用时机

在以下情况下调用此技能：
- 用户想要下载并保存网页
- 用户要求将 URL 转换为 Markdown
- 用户想要在本地归档在线内容
- 用户提供 URL 并希望获取可读格式的内容
- **用户直接粘贴一个网址（如 `https://example.com/article`）**

## 使用方式

### 直接粘贴网址

```
https://example.com/article
```

### 基本用法

提供要下载的 URL：

```
下载这个页面：https://example.com/article
```

### 指定保存位置

```
下载 https://example.com/guide 并保存到 docs/guide.md
```

**默认**：**存放到 `glm5-studydoc/`、`kimi-studydoc/`、`minimax-studydoc/`、`qwen-studydoc/` 目录下**

**不要放入 open-claw-source-code 和 pi-coding-agent-source-code 目录内**

### 批量下载

```
下载这些 URL：
- https://example.com/article1
- https://example.com/article2
```

## 工作流程

1. **获取网页** - 使用 `mcp_Fetch_fetch` 工具获取 URL 内容
2. **处理内容** - 工具会自动将 HTML 转换为 Markdown
3. **处理图片** - 如果文章中有图片：
   - 创建 `images/` 子目录（与 Markdown 文件同目录）
   - 下载图片到 `images/` 目录
   - 更新 Markdown 中的图片链接为本地相对路径
   - **如果图片下载失败，保留原始 URL 链接，不要重试**
4. **保存文件** - 将 Markdown 内容写入指定位置

## 图片处理

当文章包含图片时，执行以下步骤：

1. **创建图片目录** - 在 Markdown 文件所在目录创建 `images/` 子文件夹
   ```
   glm5-studydoc/
   ├── article.md
   └── images/
       ├── image1.png
       ├── image2.jpg
       └── ...
   ```

2. **下载图片** - 提取 Markdown 中的所有图片链接：
   - 下载每个图片到 `images/` 目录
   - 使用原始文件名或生成有意义的文件名
   - 支持的格式：png, jpg, jpeg, gif, svg, webp

3. **更新链接** - 修改 Markdown 中的图片引用：
   ```markdown
   <!-- 原始链接 -->
   ![描述](https://example.com/path/to/image.png)
   
   <!-- 更新为本地链接 -->
   ![描述](images/image.png)
   ```

4. **失败处理** - 如果图片下载失败：
   - **保留原始 URL 链接**
   - 不进行重试
   - 可选：在 Markdown 中添加注释说明下载失败

## 输出格式

转换后的 Markdown 包含：
- 标题（来自 `<title>` 或 `<h1>`）
- 主要内容（文章正文，排除导航/广告）
- 保留的链接
- **图片链接指向本地 `images/` 目录（下载成功）或原始 URL（下载失败）**
- 带语法高亮的代码块

## 示例

用户请求：
> https://github.com/badlogic/pi-mono

执行动作：
1. 使用 `mcp_Fetch_fetch` 获取 URL 内容
2. 创建合适的文件名（如 `pi-mono.md`）
3. 检查内容中的图片
4. 创建 `glm5-studydoc/images/` 目录
5. 下载图片到该目录
6. 更新 Markdown 中的图片链接
7. 保存 Markdown 文件到学习文档目录

## 注意事项

- 大型页面可能会被截断（默认 5000 字符，可扩展）
- 部分动态内容可能无法捕获
- 需要认证的页面无法访问
- 请遵守 robots.txt 和速率限制
