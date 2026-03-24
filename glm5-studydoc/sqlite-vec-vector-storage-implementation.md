# SQLite-vec 向量存储与查询实现详解

本文档详细说明 OpenClaw 如何使用 sqlite-vec 进行向量嵌入存储和相似度查询。

## 目录

1. [sqlite-vec 扩展加载](#1-sqlite-vec-扩展加载)
2. [向量表创建](#2-向量表创建)
3. [向量嵌入存储流程](#3-向量嵌入存储流程)
4. [向量相似度查询](#4-向量相似度查询)
5. [混合搜索（向量 + 全文）](#5-混合搜索向量全文)
6. [嵌入缓存优化](#6-嵌入缓存优化)
7. [完整数据流图](#7-完整数据流图)

---

## 1. sqlite-vec 扩展加载

### 1.1 扩展加载函数

**文件**: [`sqlite-vec.ts`](file:///d:/temp/PI-Coding-Agent-OpenClaw-study/open-claw-source-code/openclaw/src/memory/sqlite-vec.ts)

```typescript
import type { DatabaseSync } from "node:sqlite";

export async function loadSqliteVecExtension(params: {
  db: DatabaseSync;
  extensionPath?: string;
}): Promise<{ ok: boolean; extensionPath?: string; error?: string }> {
  try {
    // 1. 导入 sqlite-vec 模块
    const sqliteVec = await import("sqlite-vec");
    
    // 2. 解析扩展路径（用户指定或使用默认）
    const resolvedPath = params.extensionPath?.trim() 
      ? params.extensionPath.trim() 
      : undefined;
    const extensionPath = resolvedPath ?? sqliteVec.getLoadablePath();

    // 3. 启用扩展加载
    params.db.enableLoadExtension(true);
    
    // 4. 加载扩展
    if (resolvedPath) {
      // 用户指定路径
      params.db.loadExtension(extensionPath);
    } else {
      // 使用 sqlite-vec 自动加载
      sqliteVec.load(params.db);
    }

    return { ok: true, extensionPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
```

### 1.2 扩展初始化流程

**文件**: [`manager-sync-ops.ts`](file:///d:/temp/PI-Coding-Agent-OpenClaw-study/open-claw-source-code/openclaw/src/memory/manager-sync-ops.ts#L195-L220)

```typescript
private async loadVectorExtension(): Promise<boolean> {
  // 1. 检查是否已加载
  if (this.vector.available !== null) {
    return this.vector.available;
  }
  
  // 2. 检查向量搜索是否启用
  if (!this.vector.enabled) {
    this.vector.available = false;
    return false;
  }
  
  try {
    // 3. 解析扩展路径
    const resolvedPath = this.vector.extensionPath?.trim()
      ? resolveUserPath(this.vector.extensionPath)
      : undefined;
    
    // 4. 调用加载函数
    const loaded = await loadSqliteVecExtension({ 
      db: this.db, 
      extensionPath: resolvedPath 
    });
    
    if (!loaded.ok) {
      throw new Error(loaded.error ?? "unknown sqlite-vec load error");
    }
    
    this.vector.extensionPath = loaded.extensionPath;
    this.vector.available = true;
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    this.vector.available = false;
    this.vector.loadError = message;
    log.warn(`sqlite-vec unavailable: ${message}`);
    return false;
  }
}
```

### 1.3 超时保护

```typescript
protected async ensureVectorReady(dimensions?: number): Promise<boolean> {
  if (!this.vector.enabled) {
    return false;
  }
  
  // 使用超时保护加载
  if (!this.vectorReady) {
    this.vectorReady = this.withTimeout(
      this.loadVectorExtension(),
      VECTOR_LOAD_TIMEOUT_MS,  // 30 秒
      `sqlite-vec load timed out after ${Math.round(VECTOR_LOAD_TIMEOUT_MS / 1000)}s`,
    );
  }
  
  let ready = false;
  try {
    ready = (await this.vectorReady) || false;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    this.vector.available = false;
    this.vector.loadError = message;
    this.vectorReady = null;
    log.warn(`sqlite-vec unavailable: ${message}`);
    return false;
  }
  
  // 确保向量表存在
  if (ready && typeof dimensions === "number" && dimensions > 0) {
    this.ensureVectorTable(dimensions);
  }
  
  return ready;
}
```

---

## 2. 向量表创建

### 2.1 创建 vec0 虚拟表

**文件**: [`manager-sync-ops.ts`](file:///d:/temp/PI-Coding-Agent-OpenClaw-study/open-claw-source-code/openclaw/src/memory/manager-sync-ops.ts#L222-L237)

```typescript
private ensureVectorTable(dimensions: number): void {
  // 1. 检查维度是否匹配
  if (this.vector.dims === dimensions) {
    return;
  }
  
  // 2. 维度变化时删除旧表
  if (this.vector.dims && this.vector.dims !== dimensions) {
    this.dropVectorTable();
  }
  
  // 3. 创建 vec0 虚拟表
  this.db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE} USING vec0(\n` +
      `  id TEXT PRIMARY KEY,\n` +
      `  embedding FLOAT[${dimensions}]\n` +
      `)`,
  );
  
  this.vector.dims = dimensions;
}
```

### 2.2 vec0 表结构

```sql
-- vec0 是 sqlite-vec 提供的虚拟表类型
-- 专门用于向量相似度搜索

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
  id TEXT PRIMARY KEY,           -- 主键，关联 chunks 表的 id
  embedding FLOAT[768]           -- 向量列，维度由嵌入模型决定
);
```

**关键点**：
- `vec0` 是 sqlite-vec 扩展提供的特殊表类型
- `FLOAT[n]` 指定向量维度（如 768、1536 等）
- 自动创建向量索引，支持高效的 KNN 搜索
- `id` 作为主键与 `chunks` 表关联

### 2.3 删除旧表

```typescript
private dropVectorTable(): void {
  try {
    this.db.exec(`DROP TABLE IF EXISTS ${VECTOR_TABLE}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.debug(`Failed to drop ${VECTOR_TABLE}: ${message}`);
  }
}
```

---

## 3. 向量嵌入存储流程

### 3.1 完整存储流程

**文件**: [`manager-embedding-ops.ts`](file:///d:/temp/PI-Coding-Agent-OpenClaw-study/open-claw-source-code/openclaw/src/memory/manager-embedding-ops.ts#L865-L925)

```typescript
async indexFile(
  entry: MemoryFileEntry | SessionFileEntry,
  options: { source: MemorySource; content?: string }
): Promise<void> {
  // 1. 生成文本块（chunks）
  const chunks = this.chunkText(entry, options.content);
  
  // 2. 批量生成嵌入向量
  let embeddings: number[][];
  try {
    embeddings = this.batch.enabled
      ? await this.generateEmbeddingsBatch(chunks)  // 批量模式
      : await this.generateEmbeddings(chunks);     // 单次模式
  } catch (err) {
    // 错误处理...
    throw err;
  }
  
  // 3. 验证向量维度
  const sample = embeddings.find((embedding) => embedding.length > 0);
  const vectorReady = sample 
    ? await this.ensureVectorReady(sample.length) 
    : false;
  
  const now = Date.now();
  
  // 4. 清除旧的索引数据
  this.clearIndexedFileData(entry.path, options.source);
  
  // 5. 存储每个 chunk
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const embedding = embeddings[i] ?? [];
    
    // 5.1 生成唯一 ID
    const id = hashText(
      `${options.source}:${entry.path}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}:${this.provider.model}`,
    );
    
    // 5.2 插入 chunks 表（主表）
    this.db
      .prepare(
        `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           hash=excluded.hash,
           model=excluded.model,
           text=excluded.text,
           embedding=excluded.embedding,
           updated_at=excluded.updated_at`,
      )
      .run(
        id,
        entry.path,
        options.source,
        chunk.startLine,
        chunk.endLine,
        chunk.hash,
        this.provider.model,
        chunk.text,
        JSON.stringify(embedding),  // JSON 格式存储
        now,
      );
    
    // 5.3 插入 vec0 表（向量索引表）
    if (vectorReady && embedding.length > 0) {
      try {
        // 先删除旧记录
        this.db.prepare(`DELETE FROM ${VECTOR_TABLE} WHERE id = ?`).run(id);
      } catch {}
      
      // 插入新向量（使用 Blob 格式）
      this.db
        .prepare(`INSERT INTO ${VECTOR_TABLE} (id, embedding) VALUES (?, ?)`)
        .run(id, vectorToBlob(embedding));
    }
    
    // 5.4 插入 FTS 表（全文搜索表，可选）
    if (this.fts.enabled && this.fts.available) {
      this.db
        .prepare(
          `INSERT INTO ${FTS_TABLE} (text, id, path, source, model, start_line, end_line)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          chunk.text,
          id,
          entry.path,
          options.source,
          this.provider.model,
          chunk.startLine,
          chunk.endLine,
        );
    }
  }
  
  // 6. 更新文件记录
  this.upsertFileRecord(entry, options.source);
}
```

### 3.2 向量格式转换

```typescript
// 将 number[] 转换为 Float32Array 的 Buffer
const vectorToBlob = (embedding: number[]): Buffer =>
  Buffer.from(new Float32Array(embedding).buffer);
```

**为什么使用 Blob？**
- sqlite-vec 要求向量以二进制格式存储
- Float32Array 提供高效的二进制表示
- 减少存储空间（相比 JSON 文本）
- 加速向量运算（无需解析 JSON）

### 3.3 存储架构

```
┌─────────────────────────────────────────────────────────┐
│                     SQLite Database                      │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │ chunks (主表)                                     │   │
│  │ ------------------------------------------------- │   │
│  │ id (TEXT PK) | path | text | embedding (JSON) |… │   │
│  │ "abc123"      | …    | …   | "[0.1, 0.2, …]"  |… │   │
│  └──────────────────────────────────────────────────┘   │
│                       │                                  │
│                       │ JOIN ON id                       │
│                       ▼                                  │
│  ┌──────────────────────────────────────────────────┐   │
│  │ chunks_vec (vec0 虚拟表)                           │   │
│  │ ------------------------------------------------- │   │
│  │ id (TEXT PK) | embedding (FLOAT[768])            │   │
│  │ "abc123"      | <binary blob>                     │   │
│  └──────────────────────────────────────────────────┘   │
│                       │                                  │
│                       │ 自动索引                         │
│                       │ KNN 搜索                          │
│                       ▼                                  │
│  ┌──────────────────────────────────────────────────┐   │
│  │ chunks_fts (fts5 虚拟表)                           │   │
│  │ ------------------------------------------------- │   │
│  │ text | id | path | …                             │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

---

## 4. 向量相似度查询

### 4.1 余弦相似度搜索

**文件**: [`manager-search.ts`](file:///d:/temp/PI-Coding-Agent-OpenClaw-study/open-claw-source-code/openclaw/src/memory/manager-search.ts#L17-L70)

```typescript
export async function searchVector(params: {
  db: DatabaseSync;
  vectorTable: string;          // "chunks_vec"
  providerModel: string;        // 嵌入模型名称
  queryVec: number[];           // 查询向量
  limit: number;                // 返回数量
  snippetMaxChars: number;      // 片段最大字符数
  ensureVectorReady: (dimensions: number) => Promise<boolean>;
  sourceFilterVec: { sql: string; params: SearchSource[] };
  sourceFilterChunks: { sql: string; params: SearchSource[] };
}): Promise<SearchRowResult[]> {
  if (params.queryVec.length === 0 || params.limit <= 0) {
    return [];
  }
  
  // 1. 确保向量表就绪
  if (await params.ensureVectorReady(params.queryVec.length)) {
    // 2. 使用 vec0 表进行向量搜索
    const rows = params.db
      .prepare(
        `SELECT c.id, c.path, c.start_line, c.end_line, c.text,\n` +
          `       c.source,\n` +
          `       vec_distance_cosine(v.embedding, ?) AS dist\n` +
          `  FROM ${params.vectorTable} v\n` +
          `  JOIN chunks c ON c.id = v.id\n` +
          ` WHERE c.model = ?${params.sourceFilterVec.sql}\n` +
          ` ORDER BY dist ASC\n` +
          ` LIMIT ?`,
      )
      .all(
        vectorToBlob(params.queryVec),      // 查询向量（Blob 格式）
        params.providerModel,                // 模型过滤
        ...params.sourceFilterVec.params,   // 来源过滤
        params.limit,                        // 限制数量
      ) as Array<{
        id: string;
        path: string;
        start_line: number;
        end_line: number;
        text: string;
        source: SearchSource;
        dist: number;  // 余弦距离
      }>;
    
    // 3. 转换为搜索结果
    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      score: 1 - row.dist,  // 距离转相似度分数
      snippet: truncateUtf16Safe(row.text, params.snippetMaxChars),
      source: row.source,
    }));
  }

  // 4. Fallback: 如果 vec0 不可用，使用内存计算
  return searchVectorFallback(params);
}
```

### 4.2 vec_distance_cosine 函数

```sql
-- sqlite-vec 提供的内置函数
-- 计算两个向量的余弦距离

vec_distance_cosine(vector1, vector2) RETURNS FLOAT

-- 余弦距离 = 1 - 余弦相似度
-- 范围：[0, 2]，0 表示完全相同，2 表示完全相反
-- 对于归一化向量，范围：[0, 1]
```

**SQL 查询解析**：

```sql
SELECT 
  c.id, 
  c.path, 
  c.start_line, 
  c.end_line, 
  c.text,
  c.source,
  vec_distance_cosine(v.embedding, ?) AS dist  -- 计算余弦距离
FROM chunks_vec v
JOIN chunks c ON c.id = v.id          -- 关联主表获取文本
WHERE c.model = ?                     -- 过滤模型
  AND c.source IN (?, ?, ...)         -- 过滤来源
ORDER BY dist ASC                     -- 距离越小越相似
LIMIT ?                               -- 限制返回数量
```

### 4.3 查询执行流程

```
1. 用户查询
   │
   ▼
2. 生成查询向量（Embedding API）
   │
   ▼
3. 转换为 Float32Array Blob
   │
   ▼
4. 执行 SQL 查询
   │
   ├─► vec_distance_cosine(v.embedding, query_vec)
   │   │
   │   ├─► 从 vec0 表读取二进制向量
   │   ├─► 计算余弦距离
   │   └─► 按距离排序（KNN）
   │
   ▼
5. JOIN chunks 表获取文本元数据
   │
   ▼
6. 返回结果（距离转分数：score = 1 - dist）
```

### 4.4 内存计算 Fallback

```typescript
function searchVectorFallback(params: {
  db: DatabaseSync;
  providerModel: string;
  queryVec: number[];
  limit: number;
}): SearchRowResult[] {
  // 1. 从 chunks 表读取所有候选（JSON 格式）
  const candidates = listChunks({
    db: params.db,
    providerModel: params.providerModel,
  });
  
  // 2. 内存中计算余弦相似度
  const scored = candidates
    .map((chunk) => ({
      chunk,
      score: cosineSimilarity(params.queryVec, chunk.embedding),
    }))
    .filter((entry) => Number.isFinite(entry.score));
  
  // 3. 排序并返回
  return scored
    .toSorted((a, b) => b.score - a.score)
    .slice(0, params.limit)
    .map((entry) => ({
      id: entry.chunk.id,
      path: entry.chunk.path,
      startLine: entry.chunk.startLine,
      endLine: entry.chunk.endLine,
      score: entry.score,
      snippet: truncateUtf16Safe(entry.chunk.text, params.snippetMaxChars),
      source: entry.chunk.source,
    }));
}

// 余弦相似度计算
export function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    magnitudeA += a[i] * a[i];
    magnitudeB += b[i] * b[i];
  }
  
  magnitudeA = Math.sqrt(magnitudeA);
  magnitudeB = Math.sqrt(magnitudeB);
  
  if (magnitudeA === 0 || magnitudeB === 0) {
    return 0;
  }
  
  return dotProduct / (magnitudeA * magnitudeB);
}
```

---

## 5. 混合搜索（向量 + 全文）

### 5.1 关键词搜索（FTS5）

**文件**: [`manager-search.ts`](file:///d:/temp/PI-Coding-Agent-OpenClaw-study/open-claw-source-code/openclaw/src/memory/manager-search.ts#L133-L191)

```typescript
export async function searchKeyword(params: {
  db: DatabaseSync;
  ftsTable: string;           // "chunks_fts"
  providerModel: string | undefined;
  query: string;              // 关键词查询
  limit: number;
  snippetMaxChars: number;
  sourceFilter: { sql: string; params: SearchSource[] };
  buildFtsQuery: (raw: string) => string | null;
  bm25RankToScore: (rank: number) => number;
}): Promise<Array<SearchRowResult & { textScore: number }>> {
  if (params.limit <= 0) {
    return [];
  }
  
  // 1. 构建 FTS5 查询语法
  const ftsQuery = params.buildFtsQuery(params.query);
  if (!ftsQuery) {
    return [];
  }

  // 2. 执行 FTS5 搜索
  const modelClause = params.providerModel ? " AND model = ?" : "";
  const modelParams = params.providerModel ? [params.providerModel] : [];

  const rows = params.db
    .prepare(
      `SELECT id, path, source, start_line, end_line, text,\n` +
        `       bm25(${params.ftsTable}) AS rank\n` +
        `  FROM ${params.ftsTable}\n` +
        ` WHERE ${params.ftsTable} MATCH ?${modelClause}${params.sourceFilter.sql}\n` +
        ` ORDER BY rank ASC\n` +  -- rank 越小越相关
        ` LIMIT ?`,
    )
    .all(
      ftsQuery,
      ...modelParams,
      ...params.sourceFilter.params,
      params.limit
    ) as Array<{
      id: string;
      path: string;
      source: SearchSource;
      start_line: number;
      end_line: number;
      text: string;
      rank: number;  // BM25 排名
    }>;

  // 3. 转换排名为分数
  return rows.map((row) => {
    const textScore = params.bm25RankToScore(row.rank);
    return {
      id: row.id,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      score: textScore,
      textScore,
      snippet: truncateUtf16Safe(row.text, params.snippetMaxChars),
      source: row.source,
    };
  });
}
```

### 5.2 BM25 排名转分数

```typescript
// BM25 rank 是负数，越接近 0 越相关
// 转换为 0-1 的分数
function bm25RankToScore(rank: number): number {
  // rank 范围：(-∞, 0]
  // 使用 sigmoid 函数转换为 (0, 1]
  return 1 / (1 + Math.exp(rank));
}
```

### 5.3 混合搜索策略

```typescript
async function hybridSearch(params: {
  query: string;
  queryVec: number[];
  limit: number;
  vectorWeight: number;  // 0.5
  keywordWeight: number; // 0.5
}): Promise<SearchRowResult[]> {
  // 1. 并行执行向量搜索和关键词搜索
  const [vectorResults, keywordResults] = await Promise.all([
    searchVector({ ...params, queryVec: params.queryVec }),
    searchKeyword({ ...params, query: params.query }),
  ]);
  
  // 2. 合并结果
  const merged = new Map<string, SearchRowResult & { textScore?: number }>();
  
  for (const result of vectorResults) {
    merged.set(result.id, { ...result, textScore: 0 });
  }
  
  for (const result of keywordResults) {
    const existing = merged.get(result.id);
    if (existing) {
      // 3. 加权融合分数
      existing.score = 
        existing.score * params.vectorWeight + 
        result.textScore * params.keywordWeight;
      existing.textScore = result.textScore;
    } else {
      merged.set(result.id, { 
        ...result, 
        score: result.textScore * params.keywordWeight 
      });
    }
  }
  
  // 4. 重新排序
  return Array.from(merged.values())
    .toSorted((a, b) => b.score - a.score)
    .slice(0, params.limit);
}
```

---

## 6. 嵌入缓存优化

### 6.1 缓存表结构

**文件**: [`memory-schema.ts`](file:///d:/temp/PI-Coding-Agent-OpenClaw-study/open-claw-source-code/openclaw/src/memory/memory-schema.ts#L38-L52)

```typescript
// 创建嵌入缓存表
params.db.exec(`
  CREATE TABLE IF NOT EXISTS ${params.embeddingCacheTable} (
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    provider_key TEXT NOT NULL,
    hash TEXT NOT NULL,
    embedding TEXT NOT NULL,
    dims INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (provider, model, provider_key, hash)
  );
`);

// 创建时间索引
params.db.exec(
  `CREATE INDEX IF NOT EXISTS idx_embedding_cache_updated_at 
   ON ${params.embeddingCacheTable}(updated_at);`
);
```

### 6.2 缓存查询

**文件**: [`manager-embedding-ops.ts`](file:///d:/temp/PI-Coding-Agent-OpenClaw-study/open-claw-source-code/openclaw/src/memory/manager-embedding-ops.ts#L289-L320)

```typescript
protected collectCachedEmbeddings(
  chunks: Array<{ text: string; hash: string }>
): {
  embeddings: number[][];
  missing: Array<{ index: number; chunk: typeof chunks[0] }>;
} {
  const embeddings: number[][] = Array.from({ length: chunks.length }, () => []);
  const missing: Array<{ index: number; chunk: typeof chunks[0] }> = [];
  
  if (!this.cache.enabled) {
    chunks.forEach((chunk, index) => missing.push({ index, chunk }));
    return { embeddings, missing };
  }
  
  // 1. 批量查询缓存
  const placeholders = chunks.map(() => "?").join(", ");
  const rows = this.db
    .prepare(
      `SELECT hash, embedding FROM ${EMBEDDING_CACHE_TABLE}\n` +
        `WHERE provider = ? AND model = ? AND provider_key = ?\n` +
        `AND hash IN (${placeholders})`,
    )
    .all(
      this.provider.id,
      this.provider.model,
      this.providerKey ?? "",
      ...chunks.map((c) => c.hash),
    ) as Array<{ hash: string; embedding: string }>;
  
  // 2. 构建哈希映射
  const cacheMap = new Map<string, number[]>();
  for (const row of rows) {
    cacheMap.set(row.hash, parseEmbedding(row.embedding));
  }
  
  // 3. 填充结果
  chunks.forEach((chunk, index) => {
    const hit = cacheMap.get(chunk.hash);
    if (hit) {
      embeddings[index] = hit;
    } else {
      missing.push({ index, chunk });
    }
  });
  
  return { embeddings, missing };
}
```

### 6.3 缓存写入

```typescript
protected async cacheEmbeddings(
  toCache: Array<{ hash: string; embedding: number[] }>
): Promise<void> {
  if (!this.cache.enabled || toCache.length === 0) {
    return;
  }
  
  const now = Date.now();
  const insert = this.db.prepare(
    `INSERT INTO ${EMBEDDING_CACHE_TABLE} 
     (provider, model, provider_key, hash, embedding, dims, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, model, provider_key, hash) 
     DO UPDATE SET
       embedding=excluded.embedding,
       dims=excluded.dims,
       updated_at=excluded.updated_at`
  );
  
  this.db.exec("BEGIN");
  try {
    for (const item of toCache) {
      insert.run(
        this.provider.id,
        this.provider.model,
        this.providerKey ?? "",
        item.hash,
        JSON.stringify(item.embedding),
        item.embedding.length,
        now,
      );
    }
    this.db.exec("COMMIT");
  } catch (err) {
    this.db.exec("ROLLBACK");
    throw err;
  }
}
```

### 6.4 缓存淘汰策略

```typescript
protected pruneEmbeddingCacheIfNeeded(): void {
  if (!this.cache.enabled || !this.cache.maxEntries) {
    return;
  }
  
  const count = this.db
    .prepare(`SELECT COUNT(*) as count FROM ${EMBEDDING_CACHE_TABLE}`)
    .get() as { count: number };
  
  if (count.count <= this.cache.maxEntries) {
    return;
  }
  
  // 删除最旧的条目
  const toDelete = count.count - this.cache.maxEntries;
  this.db.exec(
    `DELETE FROM ${EMBEDDING_CACHE_TABLE}\n` +
      `WHERE (provider, model, provider_key, hash) IN (\n` +
      `  SELECT provider, model, provider_key, hash\n` +
      `  FROM ${EMBEDDING_CACHE_TABLE}\n` +
      `  ORDER BY updated_at ASC\n` +
      `  LIMIT ?\n` +
      `)`
  );
}
```

---

## 7. 完整数据流图

### 7.1 索引流程

```
┌─────────────────┐
│   文件/会话数据   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   文本分块       │
│ (chunking)      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 检查嵌入缓存     │◄───────┐
└────────┬────────┘        │
         │                 │
    ┌────┴────┐           │
    │  命中？  │           │
    └────┬────┘           │
         │                │
    ┌────┴────┐      ┌────┴────┐
    │   Yes   │      │   No    │
    └────┬────┘      └────┬────┘
         │                │
         │                ▼
         │         ┌─────────────┐
         │         │ 调用 API     │
         │         │ 生成嵌入      │
         │         └──────┬──────┘
         │                │
         │                ▼
         │         ┌─────────────┐
         │         │ 写入缓存表   │
         │         └──────┬──────┘
         │                │
         ▼                ▼
┌────────────────────────┘
│
▼
┌─────────────────────────────────────────┐
│  事务插入                                │
│  ┌──────────────────────────────────┐   │
│  │ chunks 表                         │   │
│  │ id, path, text, embedding(JSON) │   │
│  └──────────────────────────────────┘   │
│              │                          │
│              ├──────────────────┐       │
│              │                  │       │
│              ▼                  ▼       │
│  ┌──────────────────┐  ┌──────────────┐ │
│  │ chunks_vec       │  │ chunks_fts   │ │
│  │ (vec0 虚拟表)     │  │ (fts5 表)     │ │
│  │ id, embedding    │  │ text, id, …  │ │
│  │ (FLOAT[n] Blob)  │  │              │ │
│  └──────────────────┘  └──────────────┘ │
└─────────────────────────────────────────┘
```

### 7.2 查询流程

```
┌─────────────────┐
│   用户查询       │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 生成查询向量     │
│ (Embedding API) │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 向量相似度搜索   │
│ (vec0 表)       │
│ vec_distance_   │
│ cosine()        │
└────────┬────────┘
         │
         ├─────────────────┐
         │                 │
         ▼                 ▼
┌─────────────────┐ ┌──────────────┐
│ JOIN chunks 表   │ │ FTS5 搜索     │
│ 获取文本元数据   │ │ (可选)       │
└────────┬────────┘ └──────┬───────┘
         │                 │
         └────────┬────────┘
                  │
                  ▼
         ┌─────────────────┐
         │ 融合排序        │
         │ (加权分数)      │
         └────────┬────────┘
                  │
                  ▼
         ┌─────────────────┐
         │ 返回搜索结果    │
         └─────────────────┘
```

### 7.3 表关系图

```sql
-- 主表：存储完整数据
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  source TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  hash TEXT NOT NULL,
  model TEXT NOT NULL,
  text TEXT NOT NULL,
  embedding TEXT NOT NULL,        -- JSON 格式："[0.1, 0.2, ...]"
  updated_at INTEGER NOT NULL
);

-- 向量索引表：sqlite-vec 虚拟表
CREATE VIRTUAL TABLE chunks_vec USING vec0(
  id TEXT PRIMARY KEY,            -- 关联 chunks.id
  embedding FLOAT[768]            -- 二进制格式：Float32Array
);

-- 全文索引表：SQLite FTS5
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text,                           -- 可搜索文本
  id UNINDEXED,                   -- 关联 chunks.id
  path UNINDEXED,
  source UNINDEXED,
  model UNINDEXED,
  start_line UNINDEXED,
  end_line UNINDEXED
);

-- 嵌入缓存表：避免重复调用 API
CREATE TABLE embedding_cache (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  hash TEXT NOT NULL,             -- 文本哈希
  embedding TEXT NOT NULL,        -- JSON 格式
  dims INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, model, provider_key, hash)
);
```

---

## 8. 关键要点总结

### 8.1 存储优化

| 表 | 向量格式 | 用途 |
|----|---------|------|
| `chunks` | JSON 文本 | 完整数据存储，便于调试和 Fallback |
| `chunks_vec` | Float32 Blob | 高效向量索引，KNN 搜索 |
| `embedding_cache` | JSON 文本 | 缓存避免重复 API 调用 |

### 8.2 查询优化

1. **向量搜索**：使用 `vec_distance_cosine()` 函数
2. **全文搜索**：使用 FTS5 的 `MATCH` 操作符
3. **混合搜索**：加权融合两种结果
4. **来源过滤**：`source IN (?, ?, ...)`

### 8.3 性能考虑

- **批量嵌入**：减少 API 调用次数
- **缓存命中**：避免重复计算
- **二进制存储**：减少存储空间，加速查询
- **向量索引**：sqlite-vec 自动创建 KNN 索引
- **并发控制**：`PRAGMA busy_timeout = 5000`

### 8.4 错误处理

- **扩展加载失败**：Fallback 到内存计算
- **API 限流**：重试机制 + 指数退避
- **维度不匹配**：自动删除重建表
- **缓存满**：LRU 淘汰最旧条目

---

## 参考文件

- [`src/memory/sqlite-vec.ts`](file:///d:/temp/PI-Coding-Agent-OpenClaw-study/open-claw-source-code/openclaw/src/memory/sqlite-vec.ts) - sqlite-vec 扩展加载
- [`src/memory/manager-sync-ops.ts`](file:///d:/temp/PI-Coding-Agent-OpenClaw-study/open-claw-source-code/openclaw/src/memory/manager-sync-ops.ts) - 向量表创建和管理
- [`src/memory/manager-embedding-ops.ts`](file:///d:/temp/PI-Coding-Agent-OpenClaw-study/open-claw-source-code/openclaw/src/memory/manager-embedding-ops.ts) - 嵌入存储流程
- [`src/memory/manager-search.ts`](file:///d:/temp/PI-Coding-Agent-OpenClaw-study/open-claw-source-code/openclaw/src/memory/manager-search.ts) - 向量搜索和混合搜索
- [`src/memory/memory-schema.ts`](file:///d:/temp/PI-Coding-Agent-OpenClaw-study/open-claw-source-code/openclaw/src/memory/memory-schema.ts) - 数据库表结构
