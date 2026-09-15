# OpenClaw sqlite-vec 详细实现说明

## 一、嵌入向量存储过程

在 OpenClaw 的内存系统中，当使用 sqlite-vec 扩展时，嵌入向量不是存储在普通的 SQL 列中，而是存储在 sqlite-vec 提供的虚拟表中。这个过程发生在文件索引期间。

### 存储位置和表结构

- **虚拟表名称**: `chunks_vec` (在代码中定义为常量 `VECTOR_TABLE`)
- **表创建语句** (在 `manager-sync-ops.ts` 的 `ensureVectorTable` 方法中):
  ```sql
  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
    id TEXT PRIMARY KEY,
    embedding FLOAT[${dimensions}]
  )
  ```
  其中 `${dimensions}` 是嵌入向量的维度数量（如 768、1536 或 3072）。

### 存储流程详解

当一个文件块被索引时，存储过程如下（在 `manager-embedding-ops.ts` 的 `indexFile` 方法中，约第 898-904 行）：

1. **生成唯一ID**: 为每个文件块生成一个基于其来源、路径、位置和内容哈希的唯一标识符:
   ```typescript
   const id = hashText(
     `${options.source}:${entry.path}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}:${this.provider.model}`,
   );
   ```

2. **准备向量数据**: 将数值型嵌入向量转换为 SQLite 可接受的二进制格式:
   ```typescript
   const vectorToBlob = (embedding: number[]): Buffer =>
     Buffer.from(new Float32Array(embedding).buffer);
   ```

3. **存储到 vec0 表**:
   ```typescript
   if (vectorReady && embedding.length > 0) {
     try {
       // 如果存在旧记录，先删除（防止重复）
       this.db.prepare(`DELETE FROM ${VECTOR_TABLE} WHERE id = ?`).run(id);
     } catch {}
     // 插入新向量记录
     this.db
       .prepare(`INSERT INTO ${VECTOR_TABLE} (id, embedding) VALUES (?, ?)`)
       .run(id, vectorToBlob(embedding));
   }
   ```

### 存储特点

- **主键设计**: 使用文件块的唯一标识符作为主键，确保每个向量有唯一对应的记录
- **向量存储**: 向量被存储为 `FLOAT[dimensions]` 类型，这是 sqlite-vec 扩展特有的数据类型
- **自动去重**: 通过先删除再插入的方式实现向量数据的更新
- **条件存储**: 只有当向量可用（sqlite-vec 加载成功）且嵌入向量不为空时才存储到 vec0 表

## 二、向量相似度查询过程

当执行 `memory_search` 操作时，如果 sqlite-vec 可用，系统会使用 vec0 表执行高效的向量相似度搜索。

### 查询入口

查询过程始于 `manager.ts` 中的 `search` 方法（约第 331-440 行），特别是当以下条件满足时：
- 有可用的嵌入提供者 (`this.provider` 不为 null)
- 查询向量不全为零 (`hasVector` 为 true)

此时会调用 `searchVector` 方法（约第 442-462 行）。

### 详细查询流程

在 `manager-search.ts` 中的 `searchVector` 函数（第 20-94 行）实现了向量搜索的核心逻辑：

1. **向量就绪检查**:
   ```typescript
   if (await params.ensureVectorReady(params.queryVec.length)) {
   ```
   这确保了 sqlite-vec 扩展已经成功加载并且 vec0 表已准备就绪。

2. **构建SQL查询**:
   ```sql
   SELECT c.id, c.path, c.start_line, c.end_line, c.text,
          c.source,
          vec_distance_cosine(v.embedding, ?) AS dist
     FROM ${params.vectorTable} v
     JOIN chunks c ON c.id = v.id
    WHERE c.model = ?${params.sourceFilterVec.sql}
    ORDER BY dist ASC
    LIMIT ?
   ```

3. **查询参数**:
   - 第一个参数: 查询向量的二进制表示 (`vectorToBlob(params.queryVec)`)
   - 第二个参数: 嵌入模型名称 (`params.providerModel`)
   - 后续参数: 来源过滤条件（用于限制搜索范围）
   - 最后参数: 返回结果数量限制 (`params.limit`)

4. **结果处理**:
   ```typescript
   return rows.map((row) => ({
     id: row.id,
     path: row.path,
     startLine: row.start_line,
     endLine: row.end_line,
     score: 1 - row.dist,  // 将距离转换为相似度分数
     snippet: truncateUtf16Safe(row.text, params.snippetMaxChars),
     source: row.source,
   }));
   ```

### 关键技术点

1. **vec_distance_cosine 函数**:
   - 这是由 sqlite-vec 扩展提供的 SQL 函数
   - 计算两个向量之间的余弦距离（范围 0-2，0 表示完全相同）
   - 在 SQLite 本地执行，避免了将所有向量加载到应用内存中的需要

2. **距离到相似度的转换**:
   - 余弦相似度 = 1 - 余弦距离
   - 余弦相似度范围为 -1 到 1，但由于嵌入向量通常是标准化的，实际范围是 0 到 1
   - 分数越高表示越相似

3. **高效连接查询**:
   - 通过 `JOIN chunks c ON c.id = v.id` 将 vec0 表与 chunks 表连接
   - 这样既能获得向量数据，又能获取对应的文本内容和元数据
   - 只返回需要的列，减少数据传输量

4. **排序和限制**:
   - `ORDER BY dist ASC` 确保最近的向量（最高相似度）排在前面
   - `LIMIT ?` 只返回所需数量的结果，提高效率

## 三、混合搜索中的角色

在启用混合搜索（向量搜索 + 关键词搜索）时，sqlite-vec 扮演向量搜索部分的核心角色。

### 混合搜索流程

在 `manager.ts` 的 `search` 方法中（约第 394-420 行）：

1. **向量搜索部分**:
   ```typescript
   const queryVec = await this.embedQueryWithTimeout(cleaned);
   const hasVector = queryVec.some((v) => v !== 0);
   const vectorResults = hasVector
     ? await this.searchVector(queryVec, candidates).catch(() => [])
     : [];
   ```
   这里的 `searchVector` 调用正是使用了上面描述的 sqlite-vec 功能。

2. **关键词搜索部分**:
   同时执行全文搜索（如果 FTS 可用）：
   ```typescript
   const keywordResults =
     hybrid.enabled && this.fts.enabled && this.fts.available
     ? await this.searchKeyword(cleaned, candidates).catch(() => [])
     : [];
   ```

3. **结果合并**:
   使用 `mergeHybridResults` 函数根据配置的权重合并两种搜索结果：
   ```typescript
   const merged = await this.mergeHybridResults({
     vector: vectorResults,
     keyword: keywordResults,
     vectorWeight: hybrid.vectorWeight,
     textWeight: hybrid.textWeight,
     mmr: hybrid.mmr,
     temporalDecay: hybrid.temporalDecay,
   });
   ```

## 四、性能优势

### 相比JavaScript实现的优势

1. **计算效率**：
   - 余弦距离计算在 SQLite 的本地代码中执行，使用了优化的数学库
   - 避免了在 JavaScript 中遍历和计算所有向量的开销

2. **内存效率**：
   - 不需要将所有嵌入向量加载到 Node.js 内存中
   - 只返回匹配结果的向量，大幅减少内存使用
   - 特别适合大规模向量集合（10K+ 向量）

3. **磁盘I/O优化**：
   - SQLite 使用了高效的查询计划和索引（虽然 vec0 表本身是暴力搜索，但可以结合其他过滤条件）
   - 利用了 SQLite 的页面缓存机制

4. **并发能力**：
   - SQLite 的数据库锁机制允许一定程度的并发读取
   - 比起在单线程 JavaScript 中计算所有向量更有优势

### 基准测试考量

虽然代码中没有显式的基准测试，但从实现可以看出：
- 向量维度越高，sqlite-vec 的优势越明显
- 向量数量越多，sqlite-vec 的优势越明显
- 在嵌入维度固定的情况下，搜索时间主要取决于向量比较的数量

## 五、错误处理和回退机制

OpenClaw 的实现考虑了 sqlite-vec 不可用的情况：

### 加载失败处理

在 `manager-sync-ops.ts` 的 `loadVectorExtension` 方法中：
```typescript
try {
  // ... 加载逻辑 ...
  if (!loaded.ok) {
    throw new Error(loaded.error ?? "unknown sqlite-vec load error");
  }
  // ... 成功处理 ...
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  this.vector.available = false;
  this.vector.loadError = message;
  log.warn(`sqlite-vec unavailable: ${message}`);
  return false;
}
```

### 查询时的回退

在 `manager-search.ts` 的 `searchVector` 函数中：
1. 首先检查向量是否就绪：`if (await params.ensureVectorReady(params.queryVec.length))`
2. 如果不就绪（加载失败或不可用），则跳过向量搜索部分
3. 回退到纯 JavaScript 的余弦相似度计算（函数末尾的 `listChunks` + `cosineSimilarity` 实现）

这种设计确保了即使 sqlite-vec 完全不可用，内存搜索功能仍然可以工作，只不过性能会降低。

## 六、配置和使用

### 配置选项

在 `agents.defaults.memorySearch.store.vector` 下：
- `enabled`: 布尔值，控制是否使用 sqlite-vec（默认 true）
- `extensionPath`: 字符串，可选的自定义 sqlite-vec 库路径

### 使用场景

sqlite-vec 在以下情况下自动启用和使用：
1. 内存系统初始化时
2. 第一次需要向量操作时（搜索或索引）
3. 当 `memorySearch.store.vector.enabled` 为 true 时
4. 当系统能够成功加载 sqlite-vec 扩展时

### 监控和诊断

可以通过 `memory status` 命令查看 sqlite-vec 的状态：
- `vector.enabled`: 配置是否启用
- `vector.available`: 扩展是否成功加载并可用
- `vector.loadError`: 如果不可用时的错误信息
- `vector.extensionPath`: 实际使用的扩展路径
- `vector.dims`: 当前使用的向量维度

## 七、总结

OpenClaw 对 sqlite-vec 的实现是一个典型的性能优化与可靠性平衡的例子：

1. **透明集成**: 对终端用户完全透明，无需特殊配置即可获得性能提升
2. **优雅降级**: 当 sqlite-vec 不可用时，自动回退到 JavaScript 实现，保证功能可用性
3. **高效存储**: 使用 sqlite-vec 的 vec0 虚拟表存储向量，利用 SQLite 的本地计算能力
4. **标准SQL接口**: 通过标准的 SQL 查询接口使用向量搜索，保持代码的可维护性
5. **混合搜索支持**: 在混合搜索模式下，向量部分由 sqlite-vec 加速，关键词部分由 FTS5 提供

这个实现使得 OpenClaw 能够在保持良好兼容性和可靠性的同时，在向量搜索场景下获得显著的性能提升，特别是在处理大规模嵌入向量集合时。