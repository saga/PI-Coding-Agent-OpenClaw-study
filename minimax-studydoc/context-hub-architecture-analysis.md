# Context Hub 源码分析：如何为 Agent 提供文档内容

## 概述

Context Hub 是一个为 AI Coding Agent 提供版本化、结构化文档的工具。它的核心解决的问题是：**Coding Agent 容易 hallucinate API，且会在会话间遗忘之前学到的知识**。

---

## 一、整体架构

### 1.1 核心组件

```
┌─────────────────────────────────────────────────────────────────┐
│                        Context Hub CLI                          │
│                         (chub 命令行)                            │
├─────────────────────────────────────────────────────────────────┤
│  search        │  get         │  annotate  │  feedback          │
│  (搜索文档)    │  (获取文档)   │  (添加注解) │  (反馈评分)        │
└────────┬───────┴──────┬───────┴─────┬──────┴────────┬──────────┘
         │              │             │               │
         ▼              ▼             ▼               ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Registry System                            │
│              (注册表系统 - registry.js)                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐│
│  │ docs[]      │  │ skills[]    │  │ BM25 Search Index      ││
│  │ (文档列表)   │  │ (技能列表)   │  │ (搜索索引)              ││
│  └─────────────┘  └─────────────┘  └─────────────────────────┘│
└────────┬───────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Cache System                               │
│              (缓存系统 - cache.js)                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐│
│  │ Local       │  │ Remote CDN  │  │ Bundled (npm包内置)      ││
│  │ (本地源码)   │  │ (远程CDN)   │  │                         ││
│  └─────────────┘  └─────────────┘  └─────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 数据流

```
用户/Agent
    │
    ▼
┌──────────────────────────────────────────┐
│  chub search "stripe payments"             │
└──────────────────┬───────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────┐
│  registry.js: searchEntries()             │
│  - 加载 registry.json                     │
│  - 使用 BM25 搜索                         │
└──────────────────┬───────────────────────┘
                   │
         ┌─────────┴─────────┐
         ▼                   ▼
    BM25 搜索            关键词匹配
    (有索引时)           (无索引时)
         │                   │
         └─────────┬─────────┘
                   ▼
┌──────────────────────────────────────────┐
│  返回匹配结果 [{id, score, ...}]          │
└──────────────────┬───────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────┐
│  chub get stripe/api --lang py            │
└──────────────────┬───────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────┐
│  cache.js: fetchDoc()                    │
│  1. 检查本地缓存                          │
│  2. 检查 npm 内置 bundle                  │
│  3. 从 CDN 获取                           │
└──────────────────┬───────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────┐
│  返回文档内容 + 注解 (annotations.js)      │
└──────────────────────────────────────────┘
```

---

## 二、如何给 Agent 提供文档内容

### 2.1 三层内容获取机制

Context Hub 提供了**三层内容获取优先级**：

```javascript
// cache.js - fetchDoc() 函数
async function fetchDoc(source, docPath) {
  // 第1层: 本地源码 (最快)
  if (source.path) {
    return readFileSync(join(source.path, docPath), 'utf8');
  }

  // 第2层: 本地缓存
  const cachedPath = join(getSourceDataDir(source.name), docPath);
  if (existsSync(cachedPath)) {
    return readFileSync(cachedPath, 'utf8');
  }

  // 第3层: npm 内置 bundle
  const bundledPath = join(getBundledDir(), docPath);
  if (existsSync(bundledPath)) {
    return readFileSync(bundledPath, 'utf8');
  }

  // 第4层: 远程 CDN (最慢)
  const url = `${source.url}/${docPath}`;
  const content = await fetch(url);
  // 缓存下来供下次使用
  writeFileSync(cachedPath, content);
  return content;
}
```

### 2.2 多语言支持

文档按语言版本组织，Agent 可以指定需要的语言：

```bash
chub get openai/chat --lang py     # Python
chub get openai/chat --lang js     # JavaScript
chub get openai/chat --lang ts     # TypeScript
```

注册表中的结构：

```json
{
  "id": "openai/chat",
  "languages": [
    {
      "language": "py",
      "recommendedVersion": "v1.0.0",
      "versions": [
        {
          "version": "v1.0.0",
          "path": "openai/chat/py/v1.0.0",
          "provides": ["doc"]
        }
      ]
    }
  ]
}
```

### 2.3 增量获取 (减少 token 消耗)

Agent 不需要获取整个文档目录，可以只获取需要的文件：

```bash
# 获取单个文件
chub get openai/chat --file api-reference.md

# 获取所有文件
chub get openai/chat --full
```

实现原理 (`get.js`):

```javascript
if (opts.file) {
  // 只获取指定的文件
  const content = await fetchDoc(resolved.source, join(resolved.path, opts.file));
} else if (opts.full) {
  // 获取所有文件
  const allFiles = await fetchDocFull(resolved.source, resolved.path, resolved.files);
} else {
  // 默认只获取入口文件 (DOC.md 或 SKILL.md)
  const content = await fetchDoc(resolved.source, entryFile.filePath);
}
```

### 2.4 注解机制 (让 Agent 记住学习成果)

这是 Context Hub 最核心的创新：**Agent 可以添加本地笔记，跨会话持久化**。

```bash
# Agent 使用文档后，添加注解
chub annotate stripe/api "Webhook 需要 raw body 验证"

# 下次获取同一文档时，注解会自动附加
chub get stripe/api
# 输出: DOC.md 内容 + [Agent note] Webhook 需要 raw body 验证
```

实现 (`annotations.js`):

```javascript
// 注解存储在 ~/.chub/annotations/ 目录
function annotationPath(entryId) {
  const safe = entryId.replace(/\//g, '--');  // stripe/api → stripe--api.json
  return join(getAnnotationsDir(), `${safe}.json`);
}

export function writeAnnotation(entryId, note) {
  const data = {
    id: entryId,
    note,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(annotationPath(entryId), JSON.stringify(data));
}
```

在获取文档时自动注入 (`get.js`):

```javascript
const annotation = readAnnotation(r.id);
if (annotation) {
  process.stdout.write(`\n\n---\n[Agent note — ${annotation.updatedAt}]\n${annotation.note}\n`);
}
```

---

## 三、BM25 算法的作用

### 3.1 什么是 BM25

BM25 (Best Matching 25) 是一种**信息检索排名函数**，用于评估文档与查询词之间的相关性。它是 TF-IDF 的改进版本，解决了以下问题：

- **词频饱和**: 词出现次数越多，权重不会无限增加
- **文档长度标准化**: 考虑文档长度的影响

### 3.2 BM25 在 Context Hub 中的角色

Context Hub 使用 BM25 实现**文档搜索**功能：

```
┌─────────────────────────────────────────────────────┐
│                    BM25 搜索流程                     │
├─────────────────────────────────────────────────────┤
│                                                     │
│  1. Build Time (chub build)                        │
│     ┌─────────────────────────────────────────┐    │
│     │ 输入: registry entries (docs + skills)   │    │
│     │                                           │    │
│     │ 对每个文档进行分词 (tokenize)             │    │
│     │ - 去除停用词 (stop words)                │    │
│     │ - 小写化                                 │    │
│     │ - 去除特殊字符                           │    │
│     │                                           │    │
│     │ 计算:                                     │    │
│     │ - TF (词频)                              │    │
│     │ - DF (文档频率)                          │    │
│     │ - IDF (逆文档频率)                       │    │
│     │ - 平均字段长度                           │    │
│     │                                           │    │
│     │ 输出: search-index.json                  │    │
│     │ {                                         │    │
│     │   documents: [{id, tokens: {name,        │    │
│     │     description, tags}}],                │    │
│     │   idf: {...},                           │    │
│     │   avgFieldLengths: {...}                 │    │
│     │   params: {k1: 1.5, b: 0.75}            │    │
│     │ }                                        │    │
│     └─────────────────────────────────────────┘    │
│                                                     │
│  2. Search Time (chub search)                      │
│     ┌─────────────────────────────────────────┐    │
│     │ 输入: query string                       │    │
│     │                                           │    │
│     │ 1. 分词查询词                             │    │
│     │ 2. 对每个文档计算 BM25 分数:              │    │
│     │                                           │    │
│     │   score = Σ IDF(qi) ×                    │    │
│     │          (f(qi,D) × (k1+1)) /            │    │
│     │          (f(qi,D) + k1×(1-b+b×|D|/avgD)) │    │
│     │                                           │    │
│     │ 3. 多字段加权:                            │    │
│     │   - name: 3.0x 权重                      │    │
│     │   - tags: 2.0x 权重                      │    │
│     │   - description: 1.0x 权重              │    │
│     │                                           │    │
│     │ 4. 按分数排序，返回 Top N                 │    │
│     └─────────────────────────────────────────┘    │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### 3.3 具体实现 (`bm25.js`)

#### 分词器 (Tokenize)

```javascript
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', ...
]);

export function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')   // 只保留字母数字空格连字符
    .split(/[\s-]+/)                 // 按空格或连字符分割
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));  // 过滤停用词
}
```

#### 索引构建 (Build Index)

```javascript
export function buildIndex(entries) {
  // 1. 对每个 entry 分词
  const documents = [];
  const dfMap = {};  // 文档频率

  for (const entry of entries) {
    const nameTokens = tokenize(entry.name);
    const descTokens = tokenize(entry.description || '');
    const tagTokens = tokenize(entry.tags?.join(' ') || '');

    documents.push({
      id: entry.id,
      tokens: { name: nameTokens, description: descTokens, tags: tagTokens },
    });

    // 2. 统计每个词的文档频率
    const allTerms = new Set([...nameTokens, ...descTokens, ...tagTokens]);
    for (const term of allTerms) {
      dfMap[term] = (dfMap[term] || 0) + 1;
    }
  }

  // 3. 计算 IDF
  const N = documents.length;
  const idf = {};
  for (const [term, df] of Object.entries(dfMap)) {
    idf[term] = Math.log((N - df + 0.5) / (df + 0.5) + 1);
  }

  return { documents, idf, avgFieldLengths, params: { k1: 1.5, b: 0.75 } };
}
```

#### 搜索 (Search)

```javascript
export function search(query, index, opts = {}) {
  const queryTerms = tokenize(query);
  const results = [];

  for (const doc of index.documents) {
    let totalScore = 0;

    // 对每个字段计算 BM25 分数并加权
    for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
      const fieldScore = scoreField(
        queryTerms,
        doc.tokens[field],
        index.idf,
        index.avgFieldLengths[field],
        index.params.k1,
        index.params.b
      );
      totalScore += fieldScore * weight;
    }

    if (totalScore > 0) {
      results.push({ id: doc.id, score: totalScore });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, opts.limit);
}
```

### 3.4 BM25 vs 简单关键词匹配

Context Hub 优先使用 BM25 搜索，如果索引不可用则回退到简单关键词匹配：

```javascript
// registry.js - searchEntries()
if (_searchIndex) {
  // BM25 搜索
  const bm25Results = bm25Search(query, _searchIndex);
  results = bm25Results.map(r => ({ entry: entryById.get(r.id), score: r.score }));
} else {
  // 回退: 关键词匹配
  results = deduped.map((entry) => {
    let score = 0;
    if (entry.id === q) score += 100;
    if (entry.name.toLowerCase().includes(q)) score += 40;
    // ... 更多规则
    return { entry, score };
  });
}
```

### 3.5 为什么选择 BM25

| 特性 | BM25 | 简单关键词匹配 |
|------|------|---------------|
| 相关性排序 | ✅ 基于词频和文档频率的数学公式 | ❌ 简单计数 |
| 词频饱和 | ✅ 词频增加，权重有限增长 | ❌ 词频越高权重越高 |
| 文档长度标准化 | ✅ 考虑文档长度差异 | ❌ 不考虑 |
| 多字段加权 | ✅ name/tags/description 不同权重 | ❌ 统一对待 |
| 性能 | ⚠️ 需要预建索引 | ✅ 无需预处理 |

---

## 四、Multi-Source 支持

Context Hub 支持配置多个文档源：

```yaml
# ~/.chub/config.yaml
sources:
  - name: community
    url: https://cdn.aichub.org/v1
  - name: internal
    path: /path/to/local/docs
```

搜索时会合并多个源的索引：

```javascript
// registry.js - 多源索引合并
if (searchIndexes.length > 1) {
  // 合并文档，重算全局 IDF
  const allDocuments = searchIndexes.flatMap(idx => idx.documents);
  // 重新计算 idf...
  _searchIndex = { documents: allDocuments, idf, ... };
}
```

---

## 五、与 pi-coding-agent 的对比

| 特性 | Context Hub | pi-coding-agent |
|------|-------------|-----------------|
| 文档格式 | Markdown (版本化) | 多样 |
| 搜索 | BM25 + 关键词 | 依赖外部 |
| 增量获取 | ✅ 支持 | 需自行实现 |
| 注解/记忆 | ✅ 本地持久化 | Memory 功能 |
| 多语言 | ✅ 内置支持 | 需自行处理 |
| Agent 集成 | 提示 Agent 使用 CLI | 内置 |

---

## 六、总结

Context Hub 的核心创新点：

1. **版本化文档**: 每个 API 文档有多个语言版本，Agent 可指定
2. **增量获取**: 只获取需要的文件，减少 token 消耗
3. **注解机制**: Agent 可以"学习"，在会话间保留知识
4. **BM25 搜索**: 更准确的搜索结果排序
5. **多源支持**: 支持本地和远程文档源

这套设计非常适合企业场景：维护私有的文档源，Agent 可以快速检索并获取准确的文档内容。
