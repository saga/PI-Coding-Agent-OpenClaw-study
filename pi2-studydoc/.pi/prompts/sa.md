---
description: 更新一个 GitHub security advisory 以供发布
argument-hint: "<advisory-url-or-draft-path>"
---
更新一个 GitHub security advisory 以供发布：$ARGUMENTS

所有 GitHub 操作都使用 `gh`。除非用户明确同意，或草稿 markdown 明确写着 `request_cve: true`，否则不要发布该 advisory、更改其状态或请求 CVE。

GitHub 不会通过文档化的 REST OpenAPI schema 或公开 GraphQL schema 暴露仓库 security advisory 的评论/讨论。从猜测的 API endpoint（例如 `api.github.com/repos/.../security-advisories/<GHSA>/comments`、`.../timeline` 或 `.../events`）返回 404 是预期行为，其本身并不代表认证失败。不要使用浏览器 session、浏览器 cookie 或 cookie 提取来获取 advisory 评论。相反，明确告诉用户 advisory 评论未被包含，如果他们希望这些评论被考虑，可以粘贴任何相关评论。

## 输入处理

- 如果 `$ARGUMENTS` 是一个 GitHub security advisory URL，则启动调查和起草工作流。
- 如果 `$ARGUMENTS` 是现有 markdown 草稿的路径，则读取它并将该草稿应用到该 advisory。
- 在此 prompt 之后的一条后续消息中，如果用户说 "update"、"apply"、"looks good" 或类似的话，将其视为批准应用先前写好的临时 markdown 草稿。在更新 GitHub 之前，从磁盘重新读取该文件。
- 如果应用草稿时不知道草稿路径，向用户询问该 markdown 文件路径。

## 初始 advisory 工作流

1. 将该 advisory URL 解析为 `owner`、`repo` 和 `GHSA` id。
2. 使用以下命令 fetch 该 advisory：
   ```sh
   gh api repos/<owner>/<repo>/security-advisories/<GHSA>
   ```
   在提出变更之前，按返回的原样记录该 advisory 的原始 severity、CVSS vector 和 CVSS score。
3. 除非用户将其粘贴到对话中，否则不要 fetch advisory 评论/讨论：
   - 检查 advisory JSON 中的 reference、credit、关联 issue/PR 以及任何 discussion 字段。
   - 不要依赖虚构的 API endpoint，例如 `/comments`、`/timeline` 或 `/events`；它们通常会返回 404，因为 GitHub 不会通过公共 API 暴露草稿 advisory 评论。
   - 不要使用浏览器 session、浏览器 cookie 或 cookie 提取来获取评论。
   - 明确告诉用户：`Advisory comments were not included because GitHub does not expose them through the public API. Paste any relevant comments if you want them considered.`
   - 如果用户粘贴了评论，阅读并考虑它们。
   - 绝不要假装评论已被阅读。
4. 独立调查：
   - 阅读 advisory 文本、metadata、受影响的包、版本范围、CVSS、CWE、reference，以及关联的 issue/PR/commit。
   - 检查相关的代码历史、release、变更日志、包 metadata 和 tag。
   - 判断该漏洞是否已被修复。
   - 如果已修复，识别已修补的版本和正确的受影响版本范围。
   - 未经核实，不要相信报告者的分析。
5. 在起草最终更新之前与用户讨论 CVSS：
   - 提议一个 CVSS vector、score 和 severity。
   - 简要解释有争议的指标。
   - 请用户确认或调整它。
6. 询问是否应为此 advisory 向 GitHub 请求 CVE。
7. 在 `/tmp` 下起草一个可供发布的 advisory markdown 文件，例如 `/tmp/sa-<GHSA>.md`。同时包含来自 advisory 的原始 CVSS 和提议/确认后的更新 CVSS。
8. 告诉用户：
   - 临时 markdown 文件的路径
   - 原始 advisory URL
   - 他们可以编辑该文件，然后说 "update" 或提供路径

## 草稿 markdown 格式

草稿文件必须包含 YAML frontmatter，后跟 advisory 正文。包含更新 GitHub 以及决定是否请求 CVE 所需的所有字段。

```markdown
---
advisory_url: https://github.com/<owner>/<repo>/security/advisories/<GHSA>
owner: <owner>
repo: <repo>
ghsa_id: <GHSA>
summary: <short advisory summary>
original_severity: <low|medium|high|critical|null>
original_cvss_vector: <original CVSS:3.1/... or null>
original_cvss_score: <original number or null>
severity: <proposed/confirmed low|medium|high|critical>
cvss_vector: <proposed/confirmed CVSS:3.1/...>
cvss_score: <proposed/confirmed number>
cwe_ids:
  - CWE-...
vulnerabilities:
  - package:
      ecosystem: npm
      name: <package-name>
    vulnerable_version_range: <range>
    patched_versions: <range-or-version>
request_cve: false
---

# <Advisory title>

<Concise description of the vulnerability and vulnerable behavior.>

## Info

<Technical explanation of the root cause and affected component. Focus on facts needed by defenders and maintainers. Do not include PoC steps, exploit payloads, or copy-pastable exploit strings.>

## Impact

<Who can exploit it, prerequisites, confidentiality/integrity/availability impact, and realistic deployment assumptions.>

## Affected versions

- Affected: `<range>`
- Patched: `<version or range>`

## The solution

<Describe the fix and the patched release.>

## Recommendations

<Upgrade guidance and operational mitigations.>

## Workarounds

<Workarounds if any; otherwise skip this section entirely>

## Timeline

- YYYY-MM-DD: Report received
- YYYY-MM-DD: Fix committed
- YYYY-MM-DD: Fixed version released
- YYYY-MM-DD: Advisory published

## Credits

<Reporter/researcher attribution if appropriate, otherwise skip section.>

## References

- <links to releases, commits, advisories, documentation>
```

使用 curl advisory 风格作为灵感：清晰的章节、直接的措辞、受影响/已修复版本的事实、建议、时间线和致谢。不要包含 PoC。

## 将草稿应用到 GitHub

当用户以 "update"/类似表述批准，或提供 markdown 路径时：

1. 从磁盘重新读取该 markdown 文件。绝不要依赖内存中先前生成的内容。
2. 解析 YAML frontmatter 和正文。
3. 在临时文件中构建 JSON payload。按如下方式映射字段：
   - `summary` 来自 frontmatter
   - `description` 来自 frontmatter 之后的 markdown 正文
   - `severity` 来自 frontmatter（如果存在）
   - `cvss_vector_string` 来自 `cvss_vector`
   - `cwe_ids` 来自 frontmatter
   - `vulnerabilities` 来自 frontmatter
   - 不要发送 `original_severity`、`original_cvss_vector` 或 `original_cvss_score`；这些字段仅为审计上下文而保留。
4. 使用以下命令更新该 advisory：
   ```sh
   gh api -X PATCH repos/<owner>/<repo>/security-advisories/<GHSA> --input /tmp/<payload>.json
   ```
5. 当且仅当 markdown frontmatter 中有 `request_cve: true` 时，使用以下命令请求 CVE：
   ```sh
   gh api -X POST repos/<owner>/<repo>/security-advisories/<GHSA>/cve
   ```
   将 "already requested" 或 "already assigned" 视为非致命情况并报告它。
6. 报告更新了什么：
   - advisory URL
   - summary
   - 受影响范围
   - 已修补版本
   - 原始 CVSS vector/score/severity
   - 更新后的 CVSS vector/score/severity
   - 是否请求了 CVE

## 安全规则

- 不要在最终 advisory 正文中包含 PoC 材料。
- 除非 markdown 文件中有 `request_cve: true`，否则不要请求 CVE。
- 除非用户明确要求，否则不要发布该 advisory 或更改其状态。
- 不要通过浏览器 session 或 cookie 获取 advisory 评论。说明评论未被包含，并邀请用户在希望评论被考虑时粘贴相关评论。
- 如果受影响范围、已修补版本、CVSS 或 CVE 请求状态存在不确定性，在应用之前询问用户。
