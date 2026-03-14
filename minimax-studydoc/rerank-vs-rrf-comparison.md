# Rerank vs RRF：搜索结果融合方案对比

## 一、两种方案概述

### RRF (Reciprocal Rank Fusion)

**算法融合**：基于排名的数学公式，无需模型

```
RRF(d) = Σ 1 / (k + rank(d))
```

### Rerank 模型

**AI 重排序**：用深度学习模型对结果重新打分

```
Query + Document → Rerank Model → Relevance Score
```

---

## 二、详细对比

### 2.1 原理对比

| 方面 | RRF | Rerank |
|------|-----|--------|
| 类型 | 数学算法 | 深度学习模型 |
| 输入 | 排名列表 | Query + Document 文本 |
| 输出 | 融合分数 | 相关性分数 |
| 计算量 | O(n) | O(n) × 模型推理 |
| 延迟 | < 1ms | 50-500ms |

### 2.2 工作流程对比

**RRF 流程**：

```
┌─────────────┐     ┌─────────────┐
│  FTS5 结果   │     │ Embedding   │
│  [A,B,C,D]  │     │ 结果 [B,A,D,E]│
└──────┬──────┘     └──────┬──────┘
       │                   │
       └─────────┬─────────┘
                 ▼
         ┌──────────────┐
         │ RRF 公式计算  │  (< 1ms)
         │ score = 1/(k+rank) │
         └──────┬───────┘
                ▼
         最终排序结果
```

**Rerank 流程**：

```
┌─────────────┐     ┌─────────────┐
│  FTS5 结果   │     │ Embedding   │
│  [A,B,C,D]  │     │ 结果 [B,A,D,E]│
└──────┬──────┘     └──────┬──────┘
       │                   │
       └─────────┬─────────┘
                 ▼
         ┌──────────────┐
         │  合并去重     │
         │  [A,B,C,D,E]  │
         └──────┬───────┘
                ▼
         ┌──────────────────────────┐
         │     Rerank 模型           │
         │  对每个 (query, doc) 打分  │  (50-500ms)
         │                          │
         │  query: "如何付款"        │
         │  doc: "支付流程文档"       │
         │  → score: 0.95           │
         └──────────┬───────────────┘
                    ▼
              最终排序结果
```

### 2.3 性能对比

| 指标 | RRF | Rerank |
|------|-----|--------|
| 延迟 | < 1ms | 50-500ms |
| CPU | 极低 | 高 |
| GPU | 不需要 | 建议有 |
| 内存 | < 1MB | 500MB-2GB |
| 成本 | 0 | API 费用或 GPU |

### 2.4 准确度对比

| 场景 | RRF | Rerank |
|------|-----|--------|
| 简单查询 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| 复杂语义 | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| 多语言 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| 长文档 | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |

---

## 三、Rerank 模型选项

### 3.1 云 API

| 服务 | 模型 | 延迟 | 成本 |
|------|------|------|------|
| Cohere | rerank-v3.5 | ~100ms | $2/1000次 |
| Jina | jina-reranker-v2 | ~50ms | 免费额度 |
| OpenAI | 不提供 | - | - |

```javascript
// Cohere Rerank API
import Cohere from 'cohere-ai';

const cohere = new Cohere(process.env.COHERE_API_KEY);

const results = await cohere.rerank({
  model: 'rerank-v3.5',
  query: '如何付款',
  documents: ['支付流程', '缴费方法', '退款政策'],
  topN: 5
});
```

### 3.2 本地模型

| 模型 | 大小 | 语言 | 推荐场景 |
|------|------|------|---------|
| bge-reranker-base | 278M | 中英文 | 通用 |
| bge-reranker-large | 1.3G | 中英文 | 高准确度 |
| jina-reranker-v1-turbo | 38M | 英文 | 快速 |
| ms-marco-MiniLM | 80M | 英文 | 轻量 |

```javascript
// 本地 Rerank 模型
import { pipeline } from '@xenova/transformers';

const reranker = await pipeline(
  'text-classification',
  'BAAI/bge-reranker-base'
);

const scores = await reranker(
  ['如何付款', '如何付款', '如何付款'],
  ['支付流程文档', '退款政策文档', '登录帮助文档'],
  { top_k: 1 }
);
// [0.95, 0.12, 0.03]
```

---

## 四、为什么用 RRF 而不是 Rerank？

### 4.1 用 RRF 的理由

| 理由 | 说明 |
|------|------|
| **零成本** | 不需要 API 费用，不需要 GPU |
| **零延迟** | < 1ms，适合实时搜索 |
| **简单** | 几行代码，无依赖 |
| **可控** | 结果可预测，可调试 |
| **无风险** | 不依赖外部服务 |

### 4.2 用 Rerank 的理由

| 理由 | 说明 |
|------|------|
| **更准确** | 深度理解语义 |
| **处理复杂查询** | 长查询、多意图 |
| **跨语言** | 多语言混合效果好 |
| **长文档** | 能理解文档内容 |

### 4.3 选择决策树

```
你的需求是什么？
│
├── 需要最高准确度？
│   ├── 有预算/GPU？
│   │   └── ✅ 用 Rerank
│   └── 没预算？
│       └── ⚠️ RRF 也可以接受
│
├── 需要低延迟 (< 100ms)？
│   └── ✅ 用 RRF
│
├── 数据量大 (> 1000次/天)？
│   ├── 有 GPU？
│   │   └── ✅ 本地 Rerank
│   └── 无 GPU？
│       └── ✅ RRF (API 成本高)
│
└── 快速原型 / MVP？
    └── ✅ 用 RRF
```

---

## 五、实际场景推荐

### 5.1 Context Hub 场景

```
特点：
- API 文档搜索
- 英文为主
- 需要快速响应
- 用户量不确定

推荐：RRF 或 纯 FTS5
理由：
- API 文档关键词匹配效果好
- 不需要深度语义理解
- 延迟敏感
```

### 5.2 企业知识库场景

```
特点：
- 中文内容
- 需要语义搜索
- 用户查询多样
- 有预算

推荐：Rerank (本地 bge-reranker)
理由：
- 中文语义理解重要
- 查询复杂度高
- 可以部署本地模型
```

### 5.3 电商搜索场景

```
特点：
- 超高并发
- 毫秒级响应
- 商品描述短

推荐：RRF
理由：
- 延迟要求极高
- 商品描述短，Rerank 优势不明显
- 成本敏感
```

---

## 六、代码实现

### 6.1 RRF 实现 (推荐入门)

```javascript
function rrf(resultsList, k = 60) {
  const scores = new Map();
  
  for (const results of resultsList) {
    for (let i = 0; i < results.length; i++) {
      const id = results[i].id;
      scores.set(id, (scores.get(id) || 0) + 1 / (k + i + 1));
    }
  }
  
  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

// 使用
const ftsResults = fts5.search('query');
const embResults = embedding.search('query');
const final = rrf([ftsResults, embResults]);
```

### 6.2 Rerank 实现 (推荐生产)

```javascript
import { pipeline } from '@xenova/transformers';

class Reranker {
  constructor() {
    this.model = null;
  }
  
  async init() {
    this.model = await pipeline(
      'text-classification',
      'BAAI/bge-reranker-base'
    );
  }
  
  async rerank(query, documents, topK = 10) {
    const pairs = documents.map(doc => [query, doc.content]);
    const scores = await this.model(pairs);
    
    return documents
      .map((doc, i) => ({ ...doc, score: scores[i].score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

// 使用
const reranker = new Reranker();
await reranker.init();

const candidates = [...ftsResults, ...embResults];
const final = await reranker.rerank('query', candidates);
```

---

## 七、总结

| 方案 | 适用场景 | 不适用场景 |
|------|---------|-----------|
| **RRF** | 快速响应、零成本、MVP | 需要最高准确度 |
| **Rerank** | 高准确度、复杂查询、有预算 | 超高并发、零延迟要求 |

**一句话总结**：

> RRF 是**性价比**之选，Rerank 是**效果**之选。

对于 Context Hub 这种 API 文档搜索场景，**RRF 或纯 FTS5 已经足够**，因为：
1. API 文档关键词匹配效果好
2. 不需要深度语义理解
3. 延迟敏感
4. 无额外成本
