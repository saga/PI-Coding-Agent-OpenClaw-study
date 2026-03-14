/**
 * Context Hub 搜索增强 - 统一导出
 * 
 * 使用 SQLite FTS5 实现全文搜索
 */

export { 
  FTS5Search, 
  createFTS5Search, 
  buildFTS5Index,
  Database 
} from './fts5-search.js';
