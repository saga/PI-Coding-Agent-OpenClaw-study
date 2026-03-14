/**
 * Context Hub FTS5 搜索引擎
 * 
 * 使用 SQLite FTS5 实现全文搜索
 * 提供比纯 BM25 更强大的搜索功能：
 * 1. 短语搜索 (Phrase Search)
 * 2. 布尔搜索 (AND/OR/NOT)
 * 3. 通配符搜索 (Prefix/Suffix)
 * 4. 邻近搜索 (Proximity)
 * 5. 内置分词器 (Porter Stemmer)
 */

import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * FTS5 分词器选项
 * 
 * FTS5 支持以下分词器：
 * 
 * 1. unicode61 (推荐)
 *    - 示例: 'unicode61'
 *    - 特点: Unicode 6.1 标准，支持多语言，性能好
 *    - 适用: 多语言混合内容，国际化项目
 *    - 限制: 不支持词干提取
 * 
 * 2. porter (英文词干提取)
 *    - 示例: 'porter unicode61' 或 'porter'
 *    - 特点: Porter 词干提取算法，running/runs/runner → run
 *    - 适用: 英文内容，需要词形归一化
 *    - 注意: 只支持英文，中文无效
 * 
 * 3. ascii (ASCII 字符)
 *    - 示例: 'ascii'
 *    - 特点: 只处理 ASCII 字符，最快
 *    - 适用: 纯英文内容，性能优先
 *    - 限制: 非ASCII字符会被忽略
 * 
 * 4. trigram (中文/日文/韩文)
 *    - 示例: 'trigram'
 *    - 特点: 三元组分词，支持中日韩文字
 *    - 适用: 中文、日文、韩文内容
 *    - 注意: 索引较大，精确匹配不如分词器
 * 
 * 组合使用:
 *    - 'porter unicode61': 英文词干 + Unicode 支持 (推荐英文项目)
 *    - 'unicode61': 纯 Unicode 支持 (推荐多语言项目)
 *    - 'trigram': 中文/日文/韩文项目
 *    - 'ascii': 纯英文性能优先
 * 
 * unicode61 参数:
 *    - 'unicode61 remove_diacritics 1': 移除变音符号 (café → cafe)
 *    - 'unicode61 categories "L* N*"': 指定 Unicode 类别
 *    - 'unicode61 tokenchars "_"': 将下划线视为词的一部分
 * 
 * 选择建议:
 *    ┌─────────────────────────────────────────────────────────────┐
 *    │ 内容类型              │ 推荐分词器                        │
 *    ├─────────────────────────────────────────────────────────────┤
 *    │ 纯英文 API 文档       │ 'porter unicode61' (默认)         │
 *    │ 多语言混合            │ 'unicode61'                       │
 *    │ 中文内容              │ 'trigram' 或使用外部分词器        │
 *    │ 性能优先              │ 'ascii'                           │
 *    │ 需要词形归一化        │ 'porter unicode61'                │
 *    │ 代码搜索 (含下划线)   │ 'unicode61 tokenchars "_"'        │
 *    └─────────────────────────────────────────────────────────────┘
 * 
 * 注意: 中文分词建议使用外部分词器 (如 nodejieba)，预处理后再存入 FTS5
 */
const DEFAULT_TOKENIZER = 'porter unicode61';

export class FTS5Search {
  constructor(options = {}) {
    this.db = options.db || new Database(':memory:');
    this.tokenizer = options.tokenizer || DEFAULT_TOKENIZER;
    this.tableName = options.tableName || 'docs_fts';
    this.persistent = options.persistent || false;
    
    if (!options.db) {
      this.initTable();
    }
  }

  initTable() {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${this.tableName} USING fts5(
        id,
        name,
        tags,
        description,
        content,
        tokenize='${this.tokenizer}'
      )
    `);
    
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tableName}_metadata (
        id TEXT PRIMARY KEY,
        name TEXT,
        tags TEXT,
        description TEXT,
        content TEXT,
        fts_id INTEGER
      )
    `);
  }

  buildIndex(entries) {
    const insert = this.db.prepare(`
      INSERT INTO ${this.tableName} (id, name, tags, description, content)
      VALUES (?, ?, ?, ?, ?)
    `);
    
    const insertMeta = this.db.prepare(`
      INSERT INTO ${this.tableName}_metadata (id, name, tags, description, content, fts_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    const transaction = this.db.transaction((entries) => {
      for (const entry of entries) {
        const tags = (entry.tags || []).join(' ');
        const content = [
          entry.name,
          entry.description || '',
          tags
        ].join(' ');
        
        const info = insert.run(entry.id, entry.name, tags, entry.description || '', content);
        insertMeta.run(entry.id, entry.name, tags, entry.description || '', content, info.lastInsertRowid);
      }
    });
    
    transaction(entries);
    
    return this;
  }

  search(query, options = {}) {
    const { limit = 10, fields = ['name', 'tags', 'description'] } = options;
    
    if (!query || query.trim() === '') {
      return this.db.prepare(`
        SELECT id, name, tags, description,
               0 as score
        FROM ${this.tableName}_metadata
        LIMIT ?
      `).all(limit);
    }
    
    const scoreField = fields.map(f => `bm25(${this.tableName})`).join(' + ');
    
    const results = this.db.prepare(`
      SELECT m.id, m.name, m.tags, m.description,
             bm25(${this.tableName}) as score
      FROM ${this.tableName}
      JOIN ${this.tableName}_metadata m ON ${this.tableName}.rowid = m.fts_id
      WHERE ${this.tableName} MATCH ?
      ORDER BY score
      LIMIT ?
    `).all(query, limit);
    
    return results;
  }

  phraseSearch(phrase) {
    const query = `"${phrase}"`;
    return this.search(query);
  }

  booleanSearch(expression) {
    return this.search(expression);
  }

  prefixSearch(prefix) {
    return this.search(`${prefix}*`);
  }

  suggest(prefix, limit = 10) {
    return this.db.prepare(`
      SELECT name FROM ${this.tableName}_metadata
      WHERE name LIKE ?
      LIMIT ?
    `).all(`${prefix}%`, limit);
  }

  getDocumentCount() {
    const result = this.db.prepare(`SELECT COUNT(*) as count FROM ${this.tableName}`).get();
    return result.count;
  }

  optimize() {
    this.db.exec(`INSERT INTO ${this.tableName}(${this.tableName}) VALUES('optimize')`);
  }

  checkpoint() {
    this.db.exec(`INSERT INTO ${this.tableName}(${this.tableName}) VALUES('checkpoint')`);
  }

  exportIndex(filePath) {
    const data = {
      entries: this.db.prepare(`SELECT * FROM ${this.tableName}_metadata`).all(),
      version: '1.0.0',
      tokenizer: this.tokenizer
    };
    
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(data, null, 2));
    
    return filePath;
  }

  importIndex(filePath) {
    if (!existsSync(filePath)) {
      throw new Error(`Index file not found: ${filePath}`);
    }
    
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    
    this.db.exec(`DELETE FROM ${this.tableName}`);
    this.db.exec(`DELETE FROM ${this.tableName}_metadata`);
    
    this.buildIndex(data.entries);
    
    return this;
  }

  close() {
    if (!this.persistent) {
      this.db.close();
    }
  }
}

export function createFTS5Search(options) {
  return new FTS5Search(options);
}

export function buildFTS5Index(entries, options = {}) {
  const search = new FTS5Search(options);
  search.buildIndex(entries);
  return search;
}

export { Database };
