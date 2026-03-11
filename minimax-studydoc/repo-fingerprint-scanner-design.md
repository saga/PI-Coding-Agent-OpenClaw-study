# 企业级 Repo Fingerprint Scanner 设计方案

## 1. 需求分析

**目标场景：**
- 企业内部 GitHub Org，约 1000+ 个仓库
- 需要在 LLM 使用前预扫描仓库结构
- 生成可快速检索的指纹数据
- 提高后续 LLM 和 PI 的上下文准确性

**核心需求：**
1. 扫描仓库目录结构
2. 提取文件元数据（类型、大小、修改时间）
3. 生成可搜索的索引
4. 支持增量更新
5. 低性能开销

---

## 2. 方案对比

### 方案 A：SQLite 数据库存储（推荐）

**架构：**
```
Repo Fingerprint Scanner
    ↓
[Directory Scanner] → [File Metadata Extractor] → [SQLite Database]
    ↓
[Search API] ← [Index Builder]
```

**数据库 Schema：**
```sql
-- 仓库元信息
CREATE TABLE repos (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    full_name TEXT NOT NULL,
    default_branch TEXT,
    last_scanned TIMESTAMP,
    file_count INTEGER,
    total_size_bytes INTEGER,
    UNIQUE(full_name)
);

-- 目录结构
CREATE TABLE directories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id TEXT,
    path TEXT NOT NULL,
    parent_id INTEGER,
    FOREIGN KEY (repo_id) REFERENCES repos(id),
    FOREIGN KEY (parent_id) REFERENCES directories(id),
    UNIQUE(repo_id, path)
);

-- 文件元数据
CREATE TABLE files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id TEXT,
    directory_id INTEGER,
    name TEXT NOT NULL,
    extension TEXT,
    size_bytes INTEGER,
    last_modified TIMESTAMP,
    line_count INTEGER,
    language TEXT,
    content_hash TEXT,
    FOREIGN KEY (repo_id) REFERENCES repos(id),
    FOREIGN KEY (directory_id) REFERENCES directories(id),
    UNIQUE(repo_id, directory_id, name)
);

-- 语言统计
CREATE TABLE languages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id TEXT,
    name TEXT NOT NULL,
    file_count INTEGER,
    line_count INTEGER,
    FOREIGN KEY (repo_id) REFERENCES repos(id),
    UNIQUE(repo_id, name)
);

-- 索引表（用于快速搜索）
CREATE TABLE file_index (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER,
    content TEXT,
    FOREIGN KEY (file_id) REFERENCES files(id)
);

CREATE VIRTUAL TABLE file_index_fts USING fts5(
    content='file_index',
    content_rowid='id',
    content
);
```

**优点：**
- ✅ 查询性能高（支持 SQL 索引）
- ✅ 事务支持（保证数据一致性）
- ✅ 支持全文搜索（FTS5）
- ✅ 单文件存储，易于备份和迁移
- ✅ 支持增量更新
- ✅ 无外部依赖（Node.js 内置 sqlite3）

**缺点：**
- ❌ 单文件可能较大（1000 个 repo 约 1-5GB）
- ❌ 并发写入性能有限

**适用场景：** 企业内网环境，需要快速查询和低延迟

---

### 方案 B：向量数据库存储（适合语义搜索）

**架构：**
```
Repo Fingerprint Scanner
    ↓
[Directory Scanner] → [File Content Extractor] → [Embedding Generator]
    ↓
[Vector Database] ← [Index Builder]
```

**技术栈：**
- **存储层：** Pinecone / Weaviate / Qdrant / Chroma
- **向量生成：** sentence-transformers / OpenAI Embeddings
- **元数据存储：** 关联关系存储在元数据字段

**数据库 Schema（以 Qdrant 为例）：**
```json
{
  "collections": {
    "repositories": {
      "vectors": {
        "size": 384,
        "distance": "Cosine"
      },
      "payload_indices": [
        "repo_name",
        "file_extension",
        "language",
        "directory_path"
      ]
    }
  }
}
```

**优点：**
- ✅ 支持语义搜索（相似代码查找）
- ✅ 支持复杂过滤（多条件组合查询）
- ✅ 分布式架构，可扩展
- ✅ 实时更新

**缺点：**
- ❌ 需要外部服务（增加运维成本）
- ❌ 向量生成需要额外计算
- ❌ 存储成本较高
- ❌ 网络延迟

**适用场景：** 需要语义搜索能力，多租户 SaaS 环境

---

### 方案 C：混合存储（平衡方案）

**架构：**
```
Repo Fingerprint Scanner
    ↓
[Directory Scanner] → [SQLite for Metadata] + [Vector DB for Content]
    ↓
[Search API] ← [Hybrid Query Engine]
```

**数据分布：**
- **SQLite：** 目录结构、文件元数据、统计信息
- **Vector DB：** 文件内容向量（可选采样）

**优点：**
- ✅ 元数据查询快（SQLite）
- ✅ 语义搜索支持（Vector DB）
- ✅ 成本平衡
- ✅ 灵活扩展

**缺点：**
- ❌ 架构复杂
- ❌ 需要维护两个系统
- ❌ 数据同步挑战

**适用场景：** 中大型企业，需要平衡性能和成本

---

### 方案 D：文件系统快照（轻量级）

**架构：**
```
Repo Fingerprint Scanner
    ↓
[Directory Scanner] → [JSON Snapshot] → [Compressed Archive]
    ↓
[Search CLI] ← [Index Builder]
```

**数据格式：**
```json
{
  "repo_id": "org/repo-name",
  "scanned_at": "2024-01-01T00:00:00Z",
  "stats": {
    "file_count": 1234,
    "total_size_bytes": 567890,
    "languages": ["TypeScript", "Python", "Go"]
  },
  "directories": [
    {
      "path": "src/",
      "children": ["components/", "utils/", "index.ts"]
    }
  ],
  "files": [
    {
      "path": "src/index.ts",
      "size": 1234,
      "extension": ".ts",
      "language": "TypeScript",
      "line_count": 50
    }
  ]
}
```

**存储方式：**
- 每个仓库一个 JSON 文件
- 压缩存储（gzip/brotli）
- 对象存储（S3/MinIO）

**优点：**
- ✅ 简单易实现
- ✅ 人类可读
- ✅ 适合冷存储
- ✅ 无需数据库

**缺点：**
- ❌ 查询性能差（需要遍历文件）
- ❌ 不支持复杂查询
- ❌ 需要额外索引层

**适用场景：** 归档存储，低频查询场景

---

## 3. 推荐方案：SQLite + 扩展机制

### 3.1 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                    Repo Fingerprint Scanner                  │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   Scanner    │  │  Extractor   │  │  Indexer   │      │
│  │  (Dir Tree)  │→ │(Meta/Content)│→│(SQLite)    │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│                        ↓                                     │
│              ┌──────────────────┐                           │
│              │  SQLite DB       │                           │
│              │  - repos         │                           │
│              │  - directories   │                           │
│              │  - files         │                           │
│              │  - languages     │                           │
│              │  - file_index    │                           │
│              └──────────────────┘                           │
│                        ↓                                     │
│              ┌──────────────────┐                           │
│              │  Search API      │                           │
│              │  - SQL queries   │                           │
│              │  - FTS5 search   │                           │
│              └──────────────────┘                           │
└─────────────────────────────────────────────────────────────┘
                              ↓
              ┌──────────────────────────────┐
              │  pi-coding-agent Extension   │
              │  - on "context" hook         │
              │  - inject fingerprint data   │
              └──────────────────────────────┘
```

### 3.2 核心功能

#### 3.2.1 扫描器（Scanner）

```typescript
interface ScanResult {
  repoId: string;
  repoName: string;
  defaultBranch: string;
  scannedAt: Date;
  stats: {
    fileCount: number;
    totalSizeBytes: number;
    directoryCount: number;
    languages: Record<string, { count: number; lines: number }>;
  };
  directories: DirectoryNode[];
  files: FileMetadata[];
}

interface DirectoryNode {
  path: string;
  parentPath: string | null;
  children: string[];
}

interface FileMetadata {
  path: string;
  name: string;
  extension: string;
  sizeBytes: number;
  lastModified: Date;
  lineCount: number;
  language: string;
  contentHash: string;
  contentPreview?: string; // 可选：前 N 行
}
```

#### 3.2.2 扩展集成（pi-coding-agent）

```typescript
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export default function repoFingerprintExtension(api: ExtensionAPI): void {
  let fingerprintDB: SQLiteDB | null = null;

  api.on("context", async (event, ctx) => {
    if (!fingerprintDB) {
      return;
    }

    const cwd = ctx.cwd || process.cwd();
    const fingerprint = await fingerprintDB.findRepoByPath(cwd);

    if (fingerprint) {
      // 注入仓库指纹到上下文
      event.prependContext = `
## Repository Context
- Repository: ${fingerprint.repoName}
- Default Branch: ${fingerprint.defaultBranch}
- Total Files: ${fingerprint.stats.fileCount}
- Languages: ${Object.keys(fingerprint.stats.languages).join(", ")}
- Last Scanned: ${fingerprint.scannedAt.toISOString()}

### Directory Structure
${fingerprint.directories.map(d => `  ${d.path}`).join("\n")}

### Key Files
${fingerprint.files.slice(0, 10).map(f => `  ${f.path}`).join("\n")}
`.trim();
    }
  });

  api.on("agent_start", async (event, ctx) => {
    // 初始化数据库连接
    fingerprintDB = await connectFingerprintDB("/path/to/fingerprint.db");
  });
}
```

### 3.3 实现细节

#### 3.3.1 扫描优化

```typescript
async function scanDirectory(
  rootPath: string,
  options: {
    maxDepth?: number;
    excludePatterns?: string[];
    includePatterns?: string[];
    maxFileSize?: number;
  } = {}
): Promise<ScanResult> {
  const { maxDepth = 10, excludePatterns = [], maxFileSize = 10 * 1024 * 1024 } = options;

  const results: ScanResult = {
    repoId: generateRepoId(rootPath),
    repoName: path.basename(rootPath),
    defaultBranch: "main",
    scannedAt: new Date(),
    stats: {
      fileCount: 0,
      totalSizeBytes: 0,
      directoryCount: 0,
      languages: {},
    },
    directories: [],
    files: [],
  };

  const excludeRegex = excludePatterns.map(p => new RegExp(p)).concat([
    /node_modules/,
    /\.git/,
    /dist/,
    /build/,
    /vendor/,
    /\.idea/,
    /\.vscode/,
  ]);

  async function walk(currentPath: string, depth: number, currentDir: DirectoryNode) {
    if (depth > maxDepth) return;

    try {
      const entries = await fs.readdir(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);
        const relativePath = path.relative(rootPath, fullPath);
        const relativeDir = path.dirname(relativePath);

        // 检查排除规则
        if (excludeRegex.some(regex => regex.test(relativePath))) {
          continue;
        }

        if (entry.isDirectory()) {
          const dirNode: DirectoryNode = {
            path: relativePath + "/",
            parentPath: currentDir?.path || null,
            children: [],
          };
          results.directories.push(dirNode);
          results.stats.directoryCount++;

          // 递归扫描子目录
          await walk(fullPath, depth + 1, dirNode);
        } else if (entry.isFile()) {
          try {
            const stat = await fs.stat(fullPath);
            if (stat.size > maxFileSize) continue;

            const extension = path.extname(entry.name).toLowerCase();
            const content = await fs.readFile(fullPath, "utf-8").catch(() => null);
            
            // 语言检测
            const language = detectLanguage(entry.name, content);

            // 行数统计
            const lineCount = content ? content.split("\n").length : 0;

            // 内容哈希
            const contentHash = content 
              ? crypto.createHash("sha256").update(content).digest("hex").substring(0, 16)
              : "";

            const fileMeta: FileMetadata = {
              path: relativePath,
              name: entry.name,
              extension,
              sizeBytes: stat.size,
              lastModified: stat.mtime,
              lineCount,
              language,
              contentHash,
              contentPreview: content?.split("\n").slice(0, 5).join("\n"),
            };

            results.files.push(fileMeta);
            results.stats.fileCount++;
            results.stats.totalSizeBytes += stat.size;

            // 语言统计
            if (!results.stats.languages[language]) {
              results.stats.languages[language] = { count: 0, lines: 0 };
            }
            results.stats.languages[language].count++;
            results.stats.languages[language].lines += lineCount;

          } catch (error) {
            console.warn(`Failed to process file ${fullPath}:`, error);
          }
        }
      }
    } catch (error) {
      console.warn(`Failed to read directory ${currentPath}:`, error);
    }
  }

  const rootDir: DirectoryNode = {
    path: "./",
    parentPath: null,
    children: [],
  };
  results.directories.push(rootDir);

  await walk(rootPath, 0, rootDir);

  return results;
}
```

#### 3.3.2 SQLite 操作

```typescript
import Database from "better-sqlite3";

interface FingerprintDB {
  init(): void;
  upsertRepo(repo: RepoMetadata): void;
  bulkInsertDirectories(repoId: string, directories: DirectoryNode[]): void;
  bulkInsertFiles(repoId: string, files: FileMetadata[]): void;
  findRepoByPath(path: string): RepoMetadata | null;
  searchFiles(repoId: string, query: string): FileMetadata[];
  getRepoStats(repoId: string): RepoStats | null;
}

class SQLiteFingerprintDB implements FingerprintDB {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.init();
  }

  init(): void {
    // 创建表（见上面的 schema）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS repos (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        full_name TEXT NOT NULL,
        default_branch TEXT,
        last_scanned TIMESTAMP,
        file_count INTEGER,
        total_size_bytes INTEGER,
        UNIQUE(full_name)
      );

      CREATE TABLE IF NOT EXISTS directories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id TEXT,
        path TEXT NOT NULL,
        parent_id INTEGER,
        FOREIGN KEY (repo_id) REFERENCES repos(id),
        FOREIGN KEY (parent_id) REFERENCES directories(id),
        UNIQUE(repo_id, path)
      );

      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id TEXT,
        directory_id INTEGER,
        name TEXT NOT NULL,
        extension TEXT,
        size_bytes INTEGER,
        last_modified TIMESTAMP,
        line_count INTEGER,
        language TEXT,
        content_hash TEXT,
        FOREIGN KEY (repo_id) REFERENCES repos(id),
        FOREIGN KEY (directory_id) REFERENCES directories(id),
        UNIQUE(repo_id, directory_id, name)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS file_index_fts USING fts5(
        content='file_index',
        content_rowid='id',
        content
      );
    `);
  }

  upsertRepo(repo: RepoMetadata): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO repos 
      (id, name, full_name, default_branch, last_scanned, file_count, total_size_bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      repo.repoId,
      repo.repoName,
      repo.repoName,
      repo.defaultBranch,
      repo.scannedAt.toISOString(),
      repo.stats.fileCount,
      repo.stats.totalSizeBytes
    );
  }

  bulkInsertDirectories(repoId: string, directories: DirectoryNode[]): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO directories (repo_id, path, parent_id)
      VALUES (?, ?, (
        SELECT id FROM directories WHERE repo_id = ? AND path = ?
      ))
    `);

    const tx = this.db.transaction(() => {
      for (const dir of directories) {
        const parentId = dir.parentPath 
          ? this.db.prepare("SELECT id FROM directories WHERE repo_id = ? AND path = ?")
              .pluck()
              .get(repoId, dir.parentPath)
          : null;
        
        stmt.run(repoId, dir.path, parentId);
      }
    });
    tx();
  }

  bulkInsertFiles(repoId: string, files: FileMetadata[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO files 
      (repo_id, directory_id, name, extension, size_bytes, last_modified, line_count, language, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertContentStmt = this.db.prepare(`
      INSERT OR REPLACE INTO file_index (file_id, content)
      VALUES (?, ?)
    `);

    const tx = this.db.transaction(() => {
      for (const file of files) {
        const dirId = this.db.prepare("SELECT id FROM directories WHERE repo_id = ? AND path = ?")
          .pluck()
          .get(repoId, path.dirname(file.path));

        stmt.run(
          repoId,
          dirId,
          file.name,
          file.extension,
          file.sizeBytes,
          file.lastModified.toISOString(),
          file.lineCount,
          file.language,
          file.contentHash
        );

        const fileId = this.db.lastInsertRowid;
        if (file.contentPreview) {
          insertContentStmt.run(fileId, file.contentPreview);
        }
      }
    });
    tx();
  }

  findRepoByPath(cwd: string): RepoMetadata | null {
    const repoId = generateRepoId(cwd);
    const repo = this.db.prepare("SELECT * FROM repos WHERE id = ?").get(repoId);
    
    if (!repo) return null;

    return {
      repoId: repo.id,
      repoName: repo.name,
      defaultBranch: repo.default_branch,
      scannedAt: new Date(repo.last_scanned),
      stats: {
        fileCount: repo.file_count,
        totalSizeBytes: repo.total_size_bytes,
        directoryCount: 0, // 需要单独查询
        languages: {}, // 需要单独查询
      },
      directories: [],
      files: [],
    };
  }

  searchFiles(repoId: string, query: string): FileMetadata[] {
    const stmt = this.db.prepare(`
      SELECT f.* FROM files f
      JOIN file_index_fts ON file_index_fts.rowid = f.id
      WHERE f.repo_id = ? AND file_index_fts.content MATCH ?
      LIMIT 50
    `);
    
    return stmt.all(repoId, query).map(row => ({
      path: row.path,
      name: row.name,
      extension: row.extension,
      sizeBytes: row.size_bytes,
      lastModified: new Date(row.last_modified),
      lineCount: row.line_count,
      language: row.language,
      contentHash: row.content_hash,
    }));
  }

  getRepoStats(repoId: string): RepoStats | null {
    const stats = this.db.prepare(`
      SELECT 
        COUNT(DISTINCT d.path) as directory_count,
        COUNT(f.id) as file_count,
        SUM(f.size_bytes) as total_size,
        f.language,
        COUNT(*) as language_count,
        SUM(f.line_count) as language_lines
      FROM files f
      LEFT JOIN directories d ON f.repo_id = d.repo_id AND f.directory_id = d.id
      WHERE f.repo_id = ?
      GROUP BY f.language
    `).all(repoId);

    if (!stats || stats.length === 0) return null;

    const languages: Record<string, { count: number; lines: number }> = {};
    let totalFiles = 0;
    let totalSize = 0;

    for (const row of stats) {
      languages[row.language] = {
        count: row.language_count,
        lines: row.language_lines || 0,
      };
      totalFiles += row.language_count;
      totalSize += row.total_size || 0;
    }

    return {
      directoryCount: stats[0]?.directory_count || 0,
      fileCount: totalFiles,
      totalSizeBytes: totalSize,
      languages,
    };
  }

  close(): void {
    this.db.close();
  }
}
```

#### 3.3.3 增量更新策略

```typescript
interface ScanOptions {
  force?: boolean; // 强制重新扫描
  incremental?: boolean; // 增量更新
  changedSince?: Date; // 仅扫描变更的文件
}

async function scanWithIncremental(
  repoPath: string,
  db: SQLiteFingerprintDB,
  options: ScanOptions = {}
): Promise<void> {
  const { force = false, incremental = true } = options;

  const repoId = generateRepoId(repoPath);
  const existingRepo = db.findRepoByPath(repoPath);

  if (!force && existingRepo && incremental) {
    // 增量更新：仅扫描变更的文件
    const lastScanned = existingRepo.scannedAt;
    
    const changedFiles = await findChangedFiles(repoPath, lastScanned);
    
    if (changedFiles.length > 0) {
      console.log(`Incremental scan: ${changedFiles.length} files changed`);
      
      const newFiles: FileMetadata[] = [];
      for (const filePath of changedFiles) {
        const fullPath = path.join(repoPath, filePath);
        try {
          const stat = await fs.stat(fullPath);
          const content = await fs.readFile(fullPath, "utf-8").catch(() => null);
          
          const fileMeta: FileMetadata = {
            path: filePath,
            name: path.basename(filePath),
            extension: path.extname(filePath).toLowerCase(),
            sizeBytes: stat.size,
            lastModified: stat.mtime,
            lineCount: content ? content.split("\n").length : 0,
            language: detectLanguage(filePath, content),
            contentHash: content 
              ? crypto.createHash("sha256").update(content).digest("hex").substring(0, 16)
              : "",
          };
          
          newFiles.push(fileMeta);
        } catch (error) {
          console.warn(`Failed to process ${fullPath}:`, error);
        }
      }

      db.bulkInsertFiles(repoId, newFiles);
      
      // 更新仓库元信息
      const stats = db.getRepoStats(repoId);
      db.upsertRepo({
        repoId,
        repoName: existingRepo.repoName,
        defaultBranch: existingRepo.defaultBranch,
        scannedAt: new Date(),
        stats: {
          fileCount: stats?.fileCount || 0,
          totalSizeBytes: stats?.totalSizeBytes || 0,
          directoryCount: stats?.directoryCount || 0,
          languages: stats?.languages || {},
        },
      });
    }
  } else {
    // 全量扫描
    const result = await scanDirectory(repoPath);
    db.upsertRepo(result);
    db.bulkInsertDirectories(repoId, result.directories);
    db.bulkInsertFiles(repoId, result.files);
  }
}

async function findChangedFiles(
  repoPath: string,
  since: Date
): Promise<string[]> {
  // 使用 git log 获取变更文件
  const { exec } = require("child_process");
  const util = require("util");
  const execPromise = util.promisify(exec);

  try {
    const { stdout } = await execPromise(
      `git log --since="${since.toISOString()}" --name-only --pretty=format:`,
      { cwd: repoPath }
    );

    const changedFiles = stdout
      .split("\n")
      .filter(line => line.trim() && !line.includes("node_modules") && !line.includes(".git"))
      .map(line => line.trim());

    return [...new Set(changedFiles)];
  } catch (error) {
    console.warn("Failed to get git log, falling back to full scan");
    return [];
  }
}
```

---

## 4. 实施建议

### 4.1 优先级

1. **第一阶段：** SQLite 基础实现（1-2 周）
   - 实现扫描器
   - 实现数据库操作
   - 基础搜索 API

2. **第二阶段：** pi-coding-agent 集成（1 周）
   - 开发 Extension
   - Hook 集成
   - 性能优化

3. **第三阶段：** 扩展功能（2-3 周）
   - 增量更新
   - Web UI
   - 批量扫描工具

### 4.2 性能优化

- **并行扫描：** 使用 `p-limit` 限制并发数
- **缓存策略：** 缓存文件内容哈希
- **增量更新：** 仅扫描变更文件
- **数据库索引：** 为常用查询添加索引
- **压缩存储：** 对大文件内容进行压缩

### 4.3 安全考虑

- **权限控制：** 限制扫描范围
- **敏感信息过滤：** 排除 `.env`、密钥文件
- **内容哈希：** 不存储原始内容，仅存储哈希
- **访问审计：** 记录扫描和查询日志

### 4.4 监控指标

- 扫描耗时（P50/P95/P99）
- 数据库大小
- 查询延迟
- 错误率

---

## 5. 参考实现

### 5.1 类似项目

- **Sourcegraph：** 代码搜索和索引
- **GitHub Code Search：** GitHub 内部代码搜索
- **OpenSearch：** 开源搜索平台
- **Bleve：** Go 语言全文搜索

### 5.2 相关技术

- **SQLite FTS5：** https://www.sqlite.org/fts5.html
- **better-sqlite3：** https://github.com/WiseLibs/better-sqlite3
- **pi-coding-agent Extensions：** https://github.com/mariozechner/pi-coding-agent

---

## 6. 结论

**推荐方案：SQLite 基础存储 + pi-coding-agent Extension**

**理由：**
1. 简单易维护
2. 查询性能高
3. 无外部依赖
4. 支持增量更新
5. 易于集成到现有流程

**下一步：**
1. 实现 MVP 扫描器
2. 集成到 pi-coding-agent
3. 在小规模测试（10-50 个 repo）
4. 逐步扩展到全量扫描
