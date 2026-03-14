# 中文分词器与 AI Embedding 搜索研究

## 一、外部分词器

### 1.1 为什么需要外部分词器

FTS5 内置的 `trigram` 分词器对中文支持有限：

| 分词器 | 中文支持 | 问题 |
|--------|---------|------|
| trigram | ⚠️ | "人工智能" → "人工", "工智", "智能"，语义丢失 |
| unicode61 | ❌ | 按字符分割，无语义 |
| porter | ❌ | 只支持英文 |

**外部分词器**可以在存入 FTS5 前预处理，保留语义：

```
原始: "人工智能正在改变世界"
trigram: ["人工", "工智", "智能", "能正", "正在", "在改", "改变", "变世", "世界"]
jieba: ["人工智能", "正在", "改变", "世界"]  ✅ 保留语义
```

### 1.2 中文分词器选项

#### nodejieba (推荐)

```bash
npm install nodejieba
```

**优点**：
- C++ 实现，性能最高
- 支持自定义词典
- 支持多种分词模式

**缺点**：
- 需要编译，Windows 安装可能有问题
- 依赖 node-gyp

```javascript
import nodejieba from 'nodejieba';

// 精确模式 (推荐)
nodejieba.cut('人工智能正在改变世界');
// ['人工智能', '正在', '改变', '世界']

// 搜索引擎模式 (更适合搜索)
nodejieba.cutForSearch('人工智能正在改变世界');
// ['人工智能', '人工', '智能', '正在', '改变', '世界']

// 添加自定义词
nodejieba.insertWord('深度学习');
```

#### jieba-wasm

```bash
npm install jieba-wasm
```

**优点**：
- 纯 WASM，无需编译
- 跨平台兼容性好

**缺点**：
- 性能略低于 nodejieba
- 包体积较大 (~2MB)

```javascript
import { cut, cutForSearch } from 'jieba-wasm';

const tokens = cut('人工智能正在改变世界');
```

#### segment

```bash
npm install segment
```

**优点**：
- 纯 JavaScript，无依赖
- 安装简单

**缺点**：
- 性能最差
- 准确度较低

```javascript
import Segment from 'segment';

const segment = new Segment();
segment.useDefault();

const tokens = segment.doSegment('人工智能正在改变世界', { simple: true });
```

### 1.3 集成方案

```javascript
import nodejieba from 'nodejieba';
import { FTS5Search } from './fts5-search.js';

class ChineseFTS5Search extends FTS5Search {
  constructor(options = {}) {
    super({ ...options, tokenizer: 'unicode61' });
  }

  tokenize(text) {
    return nodejieba.cutForSearch(text);
  }

  buildIndex(entries) {
    const processed = entries.map(entry => ({
      ...entry,
      name: this.tokenize(entry.name).join(' '),
      description: this.tokenize(entry.description || '').join(' '),
      tags: entry.tags || []
    }));
    return super.buildIndex(processed);
  }
}
```

### 1.4 分词器对比

| 分词器 | 性能 | 安装难度 | 准确度 | 推荐场景 |
|--------|------|---------|--------|---------|
| nodejieba | ⭐⭐⭐⭐⭐ | ⚠️ 需编译 | ⭐⭐⭐⭐⭐ | 生产环境 |
| jieba-wasm | ⭐⭐⭐⭐ | ✅ 简单 | ⭐⭐⭐⭐⭐ | 跨平台 |
| segment | ⭐⭐ | ✅ 简单 | ⭐⭐⭐ | 快速原型 |

---

## 二、AI Embedding 搜索

### 2.1 什么是 Embedding 搜索

**Embedding** 将文本转换为向量，实现**语义搜索**：

```
传统搜索 (关键词匹配):
  查询: "如何付款"
  匹配: "付款方式", "支付流程"  ✅
  不匹配: "怎么给钱", "缴费方法" ❌ (关键词不同)

Embedding 搜索 (语义匹配):
  查询: "如何付款"
  匹配: "付款方式", "支付流程", "怎么给钱", "缴费方法" ✅ (语义相似)
```

### 2.2 Embedding 模型选项

#### OpenAI text-embedding-3-small

```javascript
import OpenAI from 'openai';

const openai = new OpenAI();

async function getEmbedding(text) {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text
  });
  return response.data[0].embedding; // 1536 维向量
}
```

**优点**：
- 质量高，支持多语言
- API 简单

**缺点**：
- 需要付费
- 网络延迟

#### 本地模型 (推荐)

```bash
npm install @xenova/transformers
```

```javascript
import { pipeline } from '@xenova/transformers';

const extractor = await pipeline(
  'feature-extraction',
  'Xenova/multilingual-e5-small'
);

const embedding = await extractor('如何付款', { pooling: 'mean' });
```

**优点**：
- 免费，无网络依赖
- 支持中文

**缺点**：
- 首次加载模型较慢
- 需要内存

### 2.3 向量数据库

存储和检索向量需要向量数据库：

| 数据库 | 特点 | 适用场景 |
|--------|------|---------|
| SQLite + vec0 | 轻量，FTS5 扩展 | 小规模，嵌入式 |
| Chroma | Python 原生，简单 | Python 项目 |
| Pinecone | 云服务，高性能 | 生产环境 |
| Milvus | 开源，高性能 | 大规模 |
| Qdrant | Rust 实现，快 | 高性能需求 |

### 2.4 SQLite 向量搜索扩展

```javascript
// 使用 sqlite-vec 扩展
import Database from 'better-sqlite3';
import { load } from 'sqlite-vec';

const db = new Database(':memory:');
load(db);

db.exec(`
  CREATE VIRTUAL TABLE vec_items USING vec0(
    id TEXT PRIMARY KEY,
    embedding FLOAT[384]
  )
`);

// 插入向量
const insert = db.prepare(`
  INSERT INTO vec_items (id, embedding) VALUES (?, ?)
`);
insert.run('doc1', embedding);

// 向量搜索
const results = db.prepare(`
  SELECT id, distance
  FROM vec_items
  WHERE embedding MATCH ?
  ORDER BY distance
  LIMIT 10
`).all(queryEmbedding);
```

### 2.5 混合搜索 (Hybrid Search)

**最佳实践：FTS5 + Embedding 混合**

```
┌─────────────────────────────────────────────────────────┐
│                      用户查询                            │
│                    "如何付款"                            │
└─────────────────────┬───────────────────────────────────┘
                      │
          ┌───────────┴───────────┐
          ▼                       ▼
┌─────────────────┐     ┌─────────────────┐
│   FTS5 搜索     │     │ Embedding 搜索  │
│  (关键词匹配)    │     │  (语义匹配)     │
│                 │     │                 │
│ 结果 A: 5 条    │     │ 结果 B: 5 条    │
└────────┬────────┘     └────────┬────────┘
         │                       │
         └───────────┬───────────┘
                     ▼
         ┌─────────────────────┐
         │    结果融合 (RRF)    │
         │  Reciprocal Rank    │
         │      Fusion         │
         └──────────┬──────────┘
                    ▼
         ┌─────────────────────┐
         │   最终排序结果       │
         │  1. 支付流程 (FTS5)  │
         │  2. 缴费方法 (Emb)   │
         │  3. 付款方式 (Both)  │
         └─────────────────────┘
```

### 2.6 混合搜索实现

```javascript
class HybridSearch {
  constructor() {
    this.fts = new FTS5Search();
    this.embeddings = new Map();
  }

  async buildIndex(entries) {
    this.fts.buildIndex(entries);
    
    for (const entry of entries) {
      const text = `${entry.name} ${entry.description}`;
      this.embeddings.set(entry.id, await getEmbedding(text));
    }
  }

  async search(query, options = {}) {
    const { ftsWeight = 0.5, embWeight = 0.5 } = options;
    
    // FTS5 搜索
    const ftsResults = this.fts.search(query, { limit: 20 });
    
    // Embedding 搜索
    const queryEmbedding = await getEmbedding(query);
    const embResults = this.vectorSearch(queryEmbedding, 20);
    
    // RRF 融合
    return this.rrfFusion(ftsResults, embResults, ftsWeight, embWeight);
  }

  vectorSearch(queryEmbedding, limit) {
    const results = [];
    for (const [id, embedding] of this.embeddings) {
      const similarity = this.cosineSimilarity(queryEmbedding, embedding);
      results.push({ id, score: similarity });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  rrfFusion(ftsResults, embResults, ftsWeight, embWeight, k = 60) {
    const scores = new Map();
    
    for (let i = 0; i < ftsResults.length; i++) {
      const id = ftsResults[i].id;
      scores.set(id, (scores.get(id) || 0) + ftsWeight / (k + i + 1));
    }
    
    for (let i = 0; i < embResults.length; i++) {
      const id = embResults[i].id;
      scores.set(id, (scores.get(id) || 0) + embWeight / (k + i + 1));
    }
    
    return Array.from(scores.entries())
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score);
  }
}
```

---

## 三、选择建议

### 3.1 场景决策树

```
你的内容是什么语言？
├── 纯英文
│   └── 使用 FTS5 + 'porter unicode61' (默认)
│
├── 中文
│   ├── 数据量 < 1万
│   │   └── FTS5 + nodejieba 外部分词
│   │
│   └── 数据量 > 1万 或 需要语义搜索
│       └── FTS5 + nodejieba + Embedding 混合搜索
│
└── 多语言混合
    └── FTS5 + 'unicode61' + Embedding 混合搜索
```

### 3.2 功能对比

| 功能 | FTS5 | FTS5 + 分词器 | FTS5 + Embedding |
|------|------|--------------|-----------------|
| 关键词搜索 | ✅ | ✅ | ✅ |
| 短语搜索 | ✅ | ✅ | ⚠️ |
| 中文支持 | ⚠️ trigram | ✅ | ✅ |
| 语义搜索 | ❌ | ❌ | ✅ |
| 同义词 | ❌ | ⚠️ 词典 | ✅ 自动 |
| 拼写纠错 | ❌ | ❌ | ✅ |
| 性能 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ |
| 复杂度 | 低 | 中 | 高 |

### 3.3 推荐方案

| 场景 | 推荐方案 |
|------|---------|
| Context Hub 原版 (英文 API 文档) | FTS5 + 'porter unicode61' |
| 企业内部中文文档 | FTS5 + nodejieba |
| 需要语义搜索 | FTS5 + Embedding 混合 |
| 代码搜索 | FTS5 + 'unicode61 tokenchars "_"' |

---

## 四、实现优先级

1. **Phase 1**: FTS5 基础搜索 (已完成)
2. **Phase 2**: 中文分词器集成 (nodejieba)
3. **Phase 3**: Embedding 搜索 (可选，按需)
4. **Phase 4**: 混合搜索 (可选，按需)
