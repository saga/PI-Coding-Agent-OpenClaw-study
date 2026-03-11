import sqlite3 from "sqlite3";
import path from "node:path";
import fs from "node:fs";
import {
  FileIndexer,
  type IndexResult,
  type FileEntry,
} from "./indexer.js";
import {
  type FingerprintRule,
  type DetectedComponent,
  type RepoFingerprint,
  type RepoType,
  type LanguageStats,
  type FingerprintSummary,
  type FingerprintOptions,
  DEFAULT_RULES,
} from "./rules.js";

export { type FingerprintRule, DEFAULT_RULES } from "./rules.js";

export interface StorageOptions {
  dbPath?: string;
}

export interface ScanResult {
  repoId: string;
  repoPath: string;
  fingerprint: RepoFingerprint;
  indexedAt: Date;
  durationMs: number;
  changedFiles?: string[];
}

export interface IncrementalIndex {
  repoId: string;
  lastScan: Date;
  fileHashes: Record<string, string>;
}

export interface ScanProgress {
  phase: "indexing" | "analyzing" | "saving" | "complete";
  progress: number;
  total?: number;
  current?: string;
}

export type ScanEventType = "progress" | "file" | "component" | "complete";
export interface ScanEvent {
  type: ScanEventType;
  data: ScanProgress | FileEntry | DetectedComponent | ScanResult;
}

export interface PaginationOptions {
  pageSize?: number;
  page?: number;
}

export class FingerprintEngine {
  private db: sqlite3.Database | null = null;
  private dbPath: string;
  private rules: FingerprintRule[];
  private indexer: FileIndexer;
  private incrementalCache: Map<string, IncrementalIndex> = new Map();

  constructor(options: {
    dbPath?: string;
    rules?: FingerprintRule[];
    indexerOptions?: ConstructorParameters<typeof FileIndexer>[0];
  } = {}) {
    this.dbPath = options.dbPath ?? "./fingerprint.db";
    this.rules = options.rules ?? DEFAULT_RULES;
    this.indexer = new FileIndexer(options.indexerOptions);
  }

  async scan(repoPath: string, options: { incremental?: boolean } = {}): Promise<ScanResult> {
    const startTime = Date.now();

    let indexResult: IndexResult;
    let changedFiles: string[] | undefined;

    if (options.incremental) {
      const incrementalResult = await this.indexer.indexIncremental(repoPath, this.getIncrementalIndex(repoPath));
      indexResult = incrementalResult.indexResult;
      changedFiles = incrementalResult.changedFiles;
    } else {
      indexResult = await this.indexer.index(repoPath);
    }

    const fingerprint = this.analyze(indexResult, {
      enableContentMatch: true,
      enableVersionDetection: true,
    });

    if (options.incremental && changedFiles && changedFiles.length > 0) {
      this.updateIncrementalCache(repoPath, indexResult);
    }

    const fingerprintData: ScanResult = {
      repoId: indexResult.repoId,
      repoPath,
      fingerprint,
      indexedAt: new Date(),
      durationMs: Date.now() - startTime,
      changedFiles,
    };

    return fingerprintData;
  }

  async *scanStream(repoPath: string): AsyncGenerator<ScanEvent> {
    const startTime = Date.now();
    const repoId = this.indexer.generateRepoId(repoPath);

    yield { type: "progress", data: { phase: "indexing", progress: 0 } as ScanProgress };

    const indexResult = await this.indexer.index(repoPath);

    yield { type: "progress", data: { phase: "indexing", progress: 100, total: indexResult.totalFiles } as ScanProgress };

    yield { type: "progress", data: { phase: "analyzing", progress: 0 } as ScanProgress };

    const components = await this.detectComponentsStream(indexResult, (comp) => {
      yield { type: "component", data: comp };
    });

    yield { type: "progress", data: { phase: "analyzing", progress: 100 } as ScanProgress };

    const languages = this.calculateLanguageStats(indexResult);
    const summary = this.generateSummary(components, languages, indexResult);

    const fingerprint: RepoFingerprint = {
      repoId,
      repoPath,
      scannedAt: indexResult.scannedAt,
      detectedLanguage: summary.primaryLanguage,
      detectedFramework: summary.primaryFramework,
      detectedRuntime: summary.containerized ? "containerized" : null,
      repoType: this.classifyRepoType(components, summary),
      components,
      languages,
      summary,
    };

    const result: ScanResult = {
      repoId,
      repoPath,
      fingerprint,
      indexedAt: new Date(),
      durationMs: Date.now() - startTime,
    };

    yield { type: "complete", data: result };
  }

  private async detectComponentsStream(
    indexResult: IndexResult,
    onComponent: (comp: DetectedComponent) => void
  ): Promise<DetectedComponent[]> {
    const chunkSize = 20;
    const chunks: FingerprintRule[][] = [];
    
    for (let i = 0; i < this.rules.length; i += chunkSize) {
      chunks.push(this.rules.slice(i, i + chunkSize));
    }

    const allComponents: DetectedComponent[] = [];
    const componentsByName = new Map<string, DetectedComponent>();

    const chunkResults = await Promise.all(
      chunks.map(chunk => this.matchRulesChunk(chunk, indexResult, true))
    );

    for (const chunkResult of chunkResults) {
      for (const { rule, matches } of chunkResult) {
        if (matches.length > 0) {
          const confidence = this.calculateConfidence(rule, matches);
          
          if (confidence >= 0.5) {
            const existing = componentsByName.get(rule.component);
            if (!existing || confidence > existing.confidence) {
              const component: DetectedComponent = {
                ruleId: rule.id,
                name: rule.component,
                category: rule.category,
                confidence,
                evidence: matches,
                metadata: rule.metadata,
              };
              componentsByName.set(rule.component, component);
              onComponent(component);
            }
          }
        }
      }
    }

    return Array.from(componentsByName.values()).sort(
      (a, b) => b.confidence - a.confidence
    );
  }

  analyze(indexResult: IndexResult, options: FingerprintOptions = {}): RepoFingerprint {
    const { enableContentMatch = true, minConfidenceThreshold = 0.5 } = options;

    const components = this.detectComponents(indexResult, {
      enableContentMatch,
      minConfidenceThreshold,
    });

    const languages = this.calculateLanguageStats(indexResult);

    const summary = this.generateSummary(components, languages, indexResult);

    return {
      repoId: indexResult.repoId,
      repoPath: indexResult.repoPath,
      scannedAt: indexResult.scannedAt,
      detectedLanguage: summary.primaryLanguage,
      detectedFramework: summary.primaryFramework,
      detectedRuntime: summary.containerized ? "containerized" : null,
      repoType: this.classifyRepoType(components, summary),
      components,
      languages,
      summary,
    };
  }

  private detectComponents(
    indexResult: IndexResult,
    options: { enableContentMatch: boolean; minConfidenceThreshold: number }
  ): DetectedComponent[] {
    const componentsByName = new Map<string, DetectedComponent>();

    const chunkSize = 20;
    const chunks: FingerprintRule[][] = [];
    for (let i = 0; i < this.rules.length; i += chunkSize) {
      chunks.push(this.rules.slice(i, i + chunkSize));
    }

    const runSync = (fn: () => void) => fn();

    this.db?.serialize(runSync);

    return this.detectComponentsWithChunks(chunks, indexResult, options, componentsByName);
  }

  private detectComponentsWithChunks(
    chunks: FingerprintRule[][],
    indexResult: IndexResult,
    options: { enableContentMatch: boolean; minConfidenceThreshold: number },
    componentsByName: Map<string, DetectedComponent>
  ): DetectedComponent[] {
    if (chunks.length === 0) {
      return Array.from(componentsByName.values()).sort(
        (a, b) => b.confidence - a.confidence
      );
    }

    const [currentChunk, ...remainingChunks] = chunks;

    const currentResults = currentChunk.map(rule => ({
      rule,
      matches: this.matchRule(rule, indexResult, options.enableContentMatch)
    }));

    for (const { rule, matches } of currentResults) {
      if (matches.length > 0) {
        const confidence = this.calculateConfidence(rule, matches);

        if (confidence >= options.minConfidenceThreshold) {
          const existing = componentsByName.get(rule.component);
          if (!existing || confidence > existing.confidence) {
            const component: DetectedComponent = {
              ruleId: rule.id,
              name: rule.component,
              category: rule.category,
              confidence,
              evidence: matches,
              metadata: rule.metadata,
            };
            componentsByName.set(rule.component, component);
          }
        }
      }
    }

    return this.detectComponentsWithChunks(remainingChunks, indexResult, options, componentsByName);
  }

  private async matchRulesChunk(
    rules: FingerprintRule[],
    indexResult: IndexResult,
    enableContentMatch: boolean
  ): Promise<{ rule: FingerprintRule; matches: ReturnType<typeof this.matchRule> }[]> {
    return rules.map(rule => ({
      rule,
      matches: this.matchRule(rule, indexResult, enableContentMatch)
    }));
  }

  private matchRule(
    rule: FingerprintRule,
    indexResult: IndexResult,
    enableContentMatch: boolean
  ): { type: "file" | "content" | "directory"; path: string; matchedPattern: string; lineNumber?: number }[] {
    const matches: { type: "file" | "content" | "directory"; path: string; matchedPattern: string; lineNumber?: number }[] = [];

    switch (rule.type) {
      case "file_present":
        for (const file of indexResult.files) {
          if (this.matchPattern(rule.pattern, file.name, rule.matchType)) {
            matches.push({ type: "file", path: file.relativePath, matchedPattern: rule.pattern });
          }
        }
        break;

      case "file_extension":
        for (const file of indexResult.files) {
          if (this.matchPattern(rule.pattern, file.extension, rule.matchType)) {
            matches.push({ type: "file", path: file.relativePath, matchedPattern: rule.pattern });
          }
        }
        break;

      case "filename_pattern":
        for (const file of indexResult.files) {
          if (this.matchPattern(rule.pattern, file.name, rule.matchType)) {
            matches.push({ type: "file", path: file.relativePath, matchedPattern: rule.pattern });
          }
        }
        break;

      case "directory_pattern":
        for (const dir of indexResult.directories) {
          if (this.matchPattern(rule.pattern, dir.path, rule.matchType)) {
            matches.push({ type: "directory", path: dir.path, matchedPattern: rule.pattern });
          }
        }
        break;

      case "content_match":
        if (!enableContentMatch) break;
        for (const file of indexResult.files) {
          if (!file.contentPreview) continue;
          const lines = file.contentPreview.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (this.matchPattern(rule.pattern, lines[i], rule.matchType)) {
              matches.push({ type: "content", path: file.relativePath, matchedPattern: rule.pattern, lineNumber: i + 1 });
              break;
            }
          }
        }
        break;
    }

    return matches;
  }

  private matchPattern(pattern: string, value: string, matchType: string): boolean {
    const normalizedValue = value.toLowerCase();
    const normalizedPattern = pattern.toLowerCase();

    switch (matchType) {
      case "exact": return normalizedValue === normalizedPattern;
      case "contains": return normalizedValue.includes(normalizedPattern);
      case "startsWith": return normalizedValue.startsWith(normalizedPattern);
      case "endsWith": return normalizedValue.endsWith(normalizedPattern);
      case "glob":
        const regexPattern = pattern.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".");
        return new RegExp(`^${regexPattern}$`, "i").test(normalizedValue);
      case "regex":
        try { return new RegExp(pattern, "i").test(value); } catch { return false; }
      default: return false;
    }
  }

  private calculateConfidence(rule: FingerprintRule, matches: { type: string }[]): number {
    if (matches.length === 0) return 0;
    let confidence = 0.5;
    if (matches.some(m => m.type === "file")) confidence += 0.2;
    if (matches.some(m => m.type === "content")) confidence += 0.15;
    if (matches.some(m => m.type === "directory")) confidence += 0.1;
    confidence += Math.min(0.1, matches.length * 0.02);
    confidence = Math.min(1, confidence);
    confidence *= rule.weight / 10;
    return Math.min(1, confidence);
  }

  private calculateLanguageStats(indexResult: IndexResult): LanguageStats[] {
    const languageMap = new Map<string, { files: number; lines: number }>();
    for (const file of indexResult.files) {
      const ext = file.extension.toLowerCase();
      const language = this.getLanguageFromExtension(ext);
      if (!languageMap.has(language)) languageMap.set(language, { files: 0, lines: 0 });
      const stats = languageMap.get(language)!;
      stats.files++;
      stats.lines += file.lineCount;
    }
    const totalFiles = indexResult.totalFiles;
    const languages: LanguageStats[] = [];
    for (const [language, stats] of languageMap) {
      languages.push({
        language,
        fileCount: stats.files,
        lineCount: stats.lines,
        percentage: totalFiles > 0 ? (stats.files / totalFiles) * 100 : 0,
      });
    }
    return languages.sort((a, b) => b.lineCount - a.lineCount);
  }

  private getLanguageFromExtension(ext: string): string {
    const map: Record<string, string> = {
      ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
      ".py": "Python", ".java": "Java", ".kt": "Kotlin", ".scala": "Scala", ".go": "Go",
      ".rs": "Rust", ".rb": "Ruby", ".php": "PHP", ".cs": "C#", ".cpp": "C++", ".c": "C",
      ".h": "C", ".swift": "Swift", ".m": "Objective-C", ".vue": "Vue", ".svelte": "Svelte",
      ".html": "HTML", ".css": "CSS", ".scss": "SCSS", ".less": "Less", ".sql": "SQL",
      ".json": "JSON", ".yaml": "YAML", ".yml": "YAML", ".xml": "XML", ".md": "Markdown",
      ".sh": "Shell", ".ps1": "PowerShell", ".proto": "Protocol Buffers",
    };
    return map[ext] ?? "Other";
  }

  private generateSummary(components: DetectedComponent[], languages: LanguageStats[], indexResult: IndexResult): FingerprintSummary {
    const languageComponents = components.filter(c => c.category === "language");
    const frameworkComponents = components.filter(c => c.category === "framework");
    const cloudComponents = components.filter(c => c.category === "cloud");
    const databaseComponents = components.filter(c => c.category === "database");
    const cicdComponents = components.filter(c => c.category === "cicd");

    const hasDocker = components.some(c => c.name === "Docker" || c.name === "Docker Compose");
    const hasTests = components.some(c => c.name === "Jest" || c.name === "Pytest" || c.name === "JUnit");
    const hasDocs = components.some(c => c.name === "MkDocs" || c.name === "Sphinx");
    const complexityScore = this.calculateComplexityScore(indexResult, components);

    return {
      primaryLanguage: languageComponents[0]?.name ?? null,
      primaryFramework: frameworkComponents[0]?.name ?? null,
      cloudServices: cloudComponents.map(c => c.name),
      databases: databaseComponents.map(c => c.name),
      cicdSystems: cicdComponents.map(c => c.name),
      containerized: hasDocker,
      hasTests,
      hasDocumentation: hasDocs,
      complexityScore,
    };
  }

  private classifyRepoType(components: DetectedComponent[], summary: FingerprintSummary): RepoType {
    const hasInfra = components.some(c => c.category === "infrastructure");
    const hasDataPipeline = components.some(c => c.name === "Airflow" || c.name === "Spark");
    const hasML = components.some(c => c.name === "Jupyter");
    const hasBatch = summary.primaryLanguage === "Python" && components.some(c => c.name === "Cron");
    const hasFrontend = components.some(c => ["React", "Vue", "Angular", "NextJS"].includes(c.name));
    const hasBackend = components.some(c => ["SpringBoot", "Express", "NestJS", "Flask", "Django", "FastAPI"].includes(c.name));
    const hasLibrary = !hasFrontend && !hasBackend && !hasInfra && !hasDataPipeline && summary.primaryLanguage !== null;

    if (hasInfra && components.some(c => c.name === "Terraform" || c.name === "Helm")) return "infrastructure";
    if (hasDataPipeline || hasML) return hasML ? "ml-project" : "data-pipeline";
    if (hasFrontend && !hasBackend) return "frontend";
    if (hasBackend || summary.primaryFramework) return summary.containerized ? "microservice" : "backend";
    if (hasBatch) return "batch";
    if (hasDocs || summary.hasDocumentation) return "documentation";
    if (hasLibrary) return "library";
    return "unknown";
  }

  private calculateComplexityScore(indexResult: IndexResult, components: DetectedComponent[]): number {
    let score = 0;
    score += Math.min(10, Math.floor(indexResult.totalFiles / 10));
    score += Math.min(10, Math.floor(indexResult.totalDirs / 5));
    score += components.length * 2;
    if (components.some(c => c.category === "cloud")) score += 5;
    if (components.some(c => c.category === "database")) score += 3;
    if (components.some(c => c.category === "cicd")) score += 2;
    return Math.min(100, score);
  }

  private getIncrementalIndex(repoPath: string): IncrementalIndex | undefined {
    return this.incrementalCache.get(path.resolve(repoPath));
  }

  private updateIncrementalCache(repoPath: string, indexResult: IndexResult): void {
    const fileHashes: Record<string, string> = {};
    for (const file of indexResult.files) {
      if (file.contentHash) {
        fileHashes[file.relativePath] = file.contentHash;
      }
    }
    this.incrementalCache.set(path.resolve(repoPath), {
      repoId: indexResult.repoId,
      lastScan: new Date(),
      fileHashes,
    });
  }

  initDatabase(): void {
    this.db = new sqlite3.Database(this.dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS repos (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, default_branch TEXT,
        detected_language TEXT, detected_framework TEXT, repo_type TEXT,
        scanned_at TEXT, indexed_at TEXT, duration_ms INTEGER, complexity_score INTEGER
      );
      CREATE TABLE IF NOT EXISTS components (
        id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id TEXT NOT NULL, rule_id TEXT NOT NULL,
        component_name TEXT NOT NULL, category TEXT NOT NULL, confidence REAL NOT NULL, metadata TEXT,
        FOREIGN KEY (repo_id) REFERENCES repos(id)
      );
      CREATE TABLE IF NOT EXISTS languages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id TEXT NOT NULL, language TEXT NOT NULL,
        file_count INTEGER NOT NULL, line_count INTEGER NOT NULL, percentage REAL NOT NULL,
        FOREIGN KEY (repo_id) REFERENCES repos(id)
      );
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id TEXT NOT NULL, path TEXT NOT NULL,
        filename TEXT NOT NULL, extension TEXT, size_bytes INTEGER, line_count INTEGER, content_hash TEXT,
        FOREIGN KEY (repo_id) REFERENCES repos(id)
      );
      CREATE INDEX IF NOT EXISTS idx_components_repo ON components(repo_id);
      CREATE INDEX IF NOT EXISTS idx_languages_repo ON languages(repo_id);
      CREATE INDEX IF NOT EXISTS idx_files_repo ON files(repo_id);
    `);
  }

  private runSql(sql: string, params: unknown[] = []): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db!.run(sql, params, (err) => (err ? reject(err) : resolve()));
    });
  }

  private runSqlAll<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
      this.db!.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows as T[])));
    });
  }

  async saveResult(result: ScanResult): Promise<void> {
    if (!this.db) this.initDatabase();

    const { repoId, repoPath, fingerprint, indexedAt, durationMs } = result;
    const repoName = path.basename(repoPath);

    return new Promise((resolve, reject) => {
      this.db!.serialize(() => {
        this.db!.run("BEGIN TRANSACTION", (err) => {
          if (err) { reject(err); return; }

          this.db!.run(
            `INSERT OR REPLACE INTO repos (id, name, path, default_branch, detected_language, detected_framework, repo_type, scanned_at, indexed_at, duration_ms, complexity_score)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [repoId, repoName, repoPath, "main", fingerprint.detectedLanguage, fingerprint.detectedFramework,
             fingerprint.repoType, fingerprint.scannedAt.toISOString(), indexedAt.toISOString(), durationMs, fingerprint.summary.complexityScore],
            (err) => { if (err) { reject(err); return; } }
          );

          const compStmt = this.db!.prepare(`INSERT INTO components (repo_id, rule_id, component_name, category, confidence, metadata) VALUES (?, ?, ?, ?, ?, ?)`);
          for (const comp of fingerprint.components) {
            compStmt.run([repoId, comp.ruleId, comp.name, comp.category, comp.confidence, comp.metadata ? JSON.stringify(comp.metadata) : null]);
          }
          compStmt.free();

          const langStmt = this.db!.prepare(`INSERT INTO languages (repo_id, language, file_count, line_count, percentage) VALUES (?, ?, ?, ?, ?)`);
          for (const lang of fingerprint.languages) {
            langStmt.run([repoId, lang.language, lang.fileCount, lang.lineCount, lang.percentage]);
          }
          langStmt.free();

          this.db!.run("COMMIT", (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      });
    });
  }

  async getFiles(repoId: string, options: PaginationOptions = {}): Promise<{ files: FileEntry[]; total: number; page: number; pageSize: number }> {
    if (!this.db) this.initDatabase();
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 100;
    const offset = (page - 1) * pageSize;

    const totalResult = await this.runSqlAll<{ count: number }>(`SELECT COUNT(*) as count FROM files WHERE repo_id = ?`, [repoId]);
    const total = totalResult[0]?.count ?? 0;

    const files = await this.runSqlAll<FileEntry & { contentPreview: string }>(
      `SELECT path as "path", relativePath as "relativePath", filename as "name", extension, size_bytes as "sizeBytes", 
              lastModified as "lastModified", line_count as "lineCount", content_hash as "contentHash", '' as "contentPreview"
       FROM files WHERE repo_id = ? LIMIT ? OFFSET ?`,
      [repoId, pageSize, offset]
    );

    return { files, total, page, pageSize };
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

export async function scanAndStore(
  repoPath: string,
  options: { dbPath?: string; saveToDb?: boolean; incremental?: boolean } = {}
): Promise<ScanResult> {
  const engine = new FingerprintEngine({ dbPath: options.dbPath });
  const result = await engine.scan(repoPath, { incremental: options.incremental ?? false });
  if (options.saveToDb !== false) await engine.saveResult(result);
  return result;
}
