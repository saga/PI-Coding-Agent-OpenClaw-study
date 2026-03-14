# Context Hub 为何选择 BM25 而非 SQLite FTS5

## 背景

在实现文档搜索功能时，有两种主要方案：
1. **BM25** - Context Hub 使用的算法
2. **SQLite FTS5** - SQLite 内置的全文搜索

本文分析 Context Hub 为何选择 BM25，以及两者的对比。

---

## 一、为什么不用 FTS5

### 1.1 架构分离

**FTS5 的问题：必须绑定 SQLite**

```javascript
// FTS5 需要这样使用
CREATE VIRTUAL TABLE documents USING fts5(title, content);
```

Context Hub 的设计目标是：
- **CLI 工具**：轻量级，可在不同环境运行
- **多源架构**：支持本地文件、远程 CDN、npm bundle
- **可移植索引**：搜索索引是独立的 JSON 文件

如果使用 FTS5：
- 需要为每个数据源创建 SQLite 数据库
- 索引文件无法跨平台共享
- 增加了运行时依赖

**BM25 的优势：纯 JSON 索引**

```javascript
// 索引就是普通的 JSON 文件
{
  "version": "1.0.0",
  "algorithm": "bm25",
  "documents": [...],
  "idf": {...},
  "avgFieldLengths": {...}
}
```

- ✅ 可以隨手复制分发
- ✅ 不需要 SQLite 运行时
- ✅ 索引可以内嵌到 npm 包中

---

### 1.2 多源合并

Context Hub 支持配置多个文档源：

```yaml
# ~/.chub/config.yaml
sources:
  - name: community
    url: https://cdn.aichub.org/v1
  - name: internal
    path: /path/to/local/docs
```

**FTS5 的问题：难以合并多个源**

- 每个源的索引独立存储
- 合并需要额外的数据库操作
- 无法动态合并

**BM25 的优势：可自由合并**

```javascript
// registry.js - 多源索引合并
const allDocuments = searchIndexes.flatMap(idx => idx.documents);
// 重新计算全局 IDF
const idf = computeGlobalIDF(allDocuments);
```

索引可以：
- 独立构建
- 动态合并
- 按需重算

---

### 1.3 字段加权

FTS5 的字段权重配置有限：

```sql
-- FTS5 只能这样设置
CREATE VIRTUAL TABLE docs USING fts5(
  title,
  content,
  tokenize='porter unicode61'
);
-- 查询时无法轻易对不同字段设置不同权重
```

**BM25 的优势：灵活的多字段加权**

```javascript
// bm25.js
const FIELD_WEIGHTS = {
  name: 3.0,        // 文档名称权重最高
  tags: 2.0,       // 标签权重次之
  description: 1.0 // 描述权重最低
};
```

这对于 Context Hub 很重要：
- 搜索 "stripe payments" 
- 匹配名称 "Stripe Payments API" 应该排在最前面
- 匹配描述 "Process payments with Stripe" 应该排在后面

---

### 1.4 索引构建时机

**FTS5**：需要运行时创建索引
- 每次启动 CLI 时加载数据
- 创建虚拟表
- 构建索引（耗时）

**BM25**：构建时索引
- `chub build` 时预先构建索引
- 搜索时直接加载 JSON
- 启动更快

---

## 二、FTS5 vs BM25 详细对比

### 2.1 核心原理

| 特性 | FTS5 | BM25 |
|------|------|------|
| 算法基础 | 倒排索引 + BM25 变体 | TF-IDF 改进版 |
| 索引结构 | B-tree (SQLite) | JSON 数组 + Map |
| 词态学 | 内置 (porter stemmer) | 需自行实现 |
| 停用词 | 内置 | 需自行定义 |

### 2.2 功能对比

| 特性 | FTS5 | BM25 | 说明 |
|------|------|------|------|
| 短语搜索 | ✅ | ❌ | FTS5 支持 `"phrase search"` |
| 布尔搜索 | ✅ | ❌ | FTS5 支持 `AND OR NOT` |
| 通配符 | ✅ | ⚠️ | FTS5 支持 `prefix*`，BM25 需自行实现 |
| 字段加权 | ⚠️ | ✅ | FTS5 需复杂配置，BM25 简单 |
| 中文支持 | ⚠️ | ⚠️ | 两者都需分词器 |
| 排序算法 | BM25 变体 | 标准 BM25 | 本质相同 |

### 2.3 性能对比

| 指标 | FTS5 | BM25 |
|------|------|------|
| 索引大小 | 较大 (B-tree) | 较小 (JSON) |
| 搜索速度 | O(log n) | O(n) |
| 内存占用 | 中等 | 取决于数据量 |
| 增量更新 | ✅ 支持 | ❌ 需重算 |

### 2.4 部署对比

| 方面 | FTS5 | BM25 |
|------|------|------|
| 依赖 | 需要 SQLite | 无额外依赖 |
| 分发 | 索引文件 + SQLite | 纯 JSON |
| 跨平台 | 受限于 SQLite | 任意平台 |
| npm bundle | 困难 | 简单 |

---

## 三、在 Context Hub 场景下的选择

### 3.1 Context Hub 的搜索特点

1. **搜索目标是元数据**，不是全文内容
   - 搜索 `stripe payments`
   - 匹配的是文档名称、标签、描述
   - 不是在文档内容中搜索

2. **数据量适中**
   - 几千到几万个文档
   - 不需要分布式搜索

3. **索引预构建**
   - `chub build` 时构建索引
   - 搜索时直接加载

### 3.2 为什么 BM25 更适合

```
需求: 搜索文档名称/标签/描述，而非文档内容

FTS5 适用场景:
  - 大规模全文搜索
  - 需要短语匹配
  - 需要布尔查询
  - 已使用 SQLite 存储数据

BM25 适用场景:
  - 元数据搜索
  - 需要灵活加权
  - 轻量级部署
  - 多源动态合并
```

---

## 四、如果要用 FTS5 实现

```javascript
import Database from 'better-sqlite3';

function buildFTS5Index(entries) {
  const db = new Database(':memory:');
  
  // 创建 FTS5 虚拟表
  db.exec(`
    CREATE VIRTUAL TABLE docs_fts USING fts5(
      id,
      name,
      tags,
      description,
      tokenize='porter unicode61'
    )
  `);
  
  // 插入数据
  const stmt = db.prepare(`
    INSERT INTO docs_fts (id, name, tags, description) 
    VALUES (?, ?, ?, ?)
  `);
  
  for (const entry of entries) {
    stmt.run(entry.id, entry.name, entry.tags?.join(' '), entry.description);
  }
  
  return db;
}

function searchFTS5(db, query) {
  const results = db.prepare(`
    SELECT id, bm25(docs_fts) as score
    FROM docs_fts
    WHERE docs_fts MATCH ?
    ORDER BY score
    LIMIT 10
  `).all(query);
  
  return results;
}
```

**问题**：
- ❌ 需要引入 `better-sqlite3` 依赖
- ❌ 索引无法直接序列化为 JSON
- ❌ 多源合并需要额外的数据库操作
- ❌ 字段加权不如 BM25 灵活

---

## 五、总结

| 方面 | FTS5 | BM25 | Context Hub 选择 |
|------|------|------|-----------------|
| 部署复杂度 | 高 | 低 | ✅ BM25 |
| 多源支持 | 差 | 好 | ✅ BM25 |
| 字段加权 | 差 | 好 | ✅ BM25 |
| 全文搜索 | 好 | 中 | 不需要 |
| 依赖 | 需要 SQLite | 无 | ✅ BM25 |

**结论**：Context Hub 选择 BM25 是正确的，因为：

1. 它的搜索目标是**文档元数据**，不是全文
2. 它需要**多源动态合并**
3. 它追求**轻量级部署**，不希望引入额外依赖
4. 它的索引**需要可移植**，可以内嵌到 npm 包中

如果 Context Hub 需要在文档内容中进行全文搜索，则 FTS5 会是更好的选择。
