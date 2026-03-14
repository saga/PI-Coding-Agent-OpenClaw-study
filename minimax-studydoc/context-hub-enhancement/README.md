# Context Hub FTS5 搜索增强

基于 SQLite FTS5 实现全文搜索，提供比纯 BM25 更强大的搜索功能。

## 为什么用 FTS5 而不是纯 BM25

| 功能 | 纯 BM25 | FTS5 |
|------|---------|------|
| 关键词搜索 | ✅ | ✅ |
| 字段加权 | ✅ | ✅ |
| 短语搜索 | ❌ 需自己实现 | ✅ 原生支持 |
| 布尔搜索 | ❌ 需自己实现 | ✅ 原生支持 |
| 通配符搜索 | ❌ 需自己实现 | ✅ 原生支持 |
| 邻近搜索 | ❌ | ✅ |
| 词干提取 | ❌ | ✅ Porter |
| 性能 | O(n) | O(log n) |

## 安装

```bash
cd context-hub-enhancement
npm install better-sqlite3
```

## 使用

```javascript
import { FTS5Search } from './src/lib/fts5-search.js';

const entries = [
  { id: 'stripe/payments', name: 'Stripe Payments API', description: 'Process payments', tags: ['payment', 'api'] },
  { id: 'stripe/webhooks', name: 'Stripe Webhooks', description: 'Payment events', tags: ['webhook', 'stripe'] },
  { id: 'openai/chat', name: 'OpenAI Chat API', description: 'GPT completions', tags: ['ai', 'gpt'] },
];

const fts = new FTS5Search();
fts.buildIndex(entries);

// 基础搜索
fts.search('stripe payment');

// 短语搜索
fts.phraseSearch('payment api');

// 前缀搜索
fts.prefixSearch('strip');

// 建议补全
fts.suggest('str', 10);
```

## FTS5 搜索语法

```sql
stripe payment           -- 关键词
"stripe payment"         -- 短语 (精确匹配)
stripe AND payment       -- AND
stripe OR paypal         -- OR
stripe NOT webhook       -- NOT
strip*                   -- 前缀
payment NEAR/10 api      -- 邻近 (10词以内)
```

## API

| 方法 | 说明 |
|------|------|
| `buildIndex(entries)` | 构建索引 |
| `search(query, opts)` | 搜索 |
| `phraseSearch(phrase)` | 短语搜索 |
| `prefixSearch(prefix)` | 前缀搜索 |
| `suggest(prefix, limit)` | 建议补全 |
| `optimize()` | 优化索引 |
| `exportIndex(path)` | 导出索引 |
| `importIndex(path)` | 导入索引 |

## 文件结构

```
context-hub-enhancement/
├── package.json
├── README.md
└── src/
    └── lib/
        ├── index.js        # 统一导出
        └── fts5-search.js  # FTS5 实现
```
