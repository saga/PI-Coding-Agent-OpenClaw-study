import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import fg from "fast-glob";

export interface FileEntry {
  path: string;
  relativePath: string;
  name: string;
  extension: string;
  sizeBytes: number;
  lastModified: Date;
  lineCount: number;
  contentHash: string;
  contentPreview: string;
}

export interface DirectoryEntry {
  path: string;
  relativePath: string;
  childDirs: string[];
  fileCount: number;
}

export interface IndexResult {
  repoId: string;
  repoPath: string;
  scannedAt: Date;
  totalFiles: number;
  totalDirs: number;
  totalSizeBytes: number;
  directories: DirectoryEntry[];
  files: FileEntry[];
}

export interface IndexerOptions {
  maxDepth?: number;
  maxFileSize?: number;
  excludePatterns?: string[];
  includeExtensions?: string[];
  extractContentPreview?: boolean;
  computeContentHash?: boolean;
}

const DEFAULT_EXCLUDE_PATTERNS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "vendor",
  ".idea",
  ".vscode",
  ".next",
  ".nuxt",
  "coverage",
  ".cache",
  "__pycache__",
  ".pytest_cache",
  "target",
  "bin",
  "obj",
];

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".py": "Python",
  ".java": "Java",
  ".kt": "Kotlin",
  ".scala": "Scala",
  ".go": "Go",
  ".rs": "Rust",
  ".rb": "Ruby",
  ".php": "PHP",
  ".cs": "C#",
  ".cpp": "C++",
  ".c": "C",
  ".h": "C",
  ".hpp": "C++",
  ".swift": "Swift",
  ".m": "Objective-C",
  ".mm": "Objective-C++",
  ".r": "R",
  ".lua": "Lua",
  ".pl": "Perl",
  ".sh": "Shell",
  ".bash": "Shell",
  ".zsh": "Shell",
  ".ps1": "PowerShell",
  ".sql": "SQL",
  ".json": "JSON",
  ".yaml": "YAML",
  ".yml": "YAML",
  ".xml": "XML",
  ".toml": "TOML",
  ".ini": "INI",
  ".md": "Markdown",
  ".txt": "Text",
  ".html": "HTML",
  ".css": "CSS",
  ".scss": "SCSS",
  ".sass": "Sass",
  ".less": "Less",
  ".vue": "Vue",
  ".svelte": "Svelte",
  ".graphql": "GraphQL",
  ".proto": "Protocol Buffers",
};

const SPECIAL_FILENAME_PATTERNS: Record<string, string> = {
  "pom.xml": "Maven",
  "build.gradle": "Gradle",
  "build.gradle.kts": "Gradle",
  "settings.gradle": "Gradle",
  "settings.gradle.kts": "Gradle",
  "package.json": "NPM",
  "Cargo.toml": "Cargo",
  "go.mod": "Go",
  "composer.json": "Composer",
  "Gemfile": "Bundler",
  "requirements.txt": "Pip",
  "Pipfile": "Pipenv",
  "pyproject.toml": "Python",
  "setup.py": "Python",
  "setup.cfg": "Python",
  "Dockerfile": "Docker",
  "docker-compose.yml": "Docker Compose",
  "docker-compose.yaml": "Docker Compose",
  "Makefile": "Make",
  "CMakeLists.txt": "CMake",
  "go.sum": "Go",
  "yarn.lock": "Yarn",
  "pnpm-lock.yaml": "PNPM",
  "package-lock.json": "NPM",
  "tsconfig.json": "TypeScript",
  "jsconfig.json": "JavaScript",
  ".eslintrc": "ESLint",
  ".eslintrc.js": "ESLint",
  ".eslintrc.json": "ESLint",
  ".prettierrc": "Prettier",
  ".prettierrc.json": "Prettier",
  "jest.config.js": "Jest",
  "vitest.config.ts": "Vitest",
  "pytest.ini": "Pytest",
  "tox.ini": "Tox",
  "kubernetes.yaml": "Kubernetes",
  "kustomization.yaml": "Kustomize",
  "Chart.yaml": "Helm",
  "values.yaml": "Helm",
  "Jenkinsfile": "Jenkins",
  ".gitlab-ci.yml": "GitLab CI",
  "azure-pipelines.yml": "Azure DevOps",
  "circle.yml": "CircleCI",
  "bitbucket-pipelines.yml": "Bitbucket Pipelines",
};

export class FileIndexer {
  private options: Required<IndexerOptions>;

  constructor(options: IndexerOptions = {}) {
    this.options = {
      maxDepth: options.maxDepth ?? 20,
      maxFileSize: options.maxFileSize ?? 10 * 1024 * 1024,
      excludePatterns: options.excludePatterns ?? DEFAULT_EXCLUDE_PATTERNS,
      includeExtensions: options.includeExtensions ?? [],
      extractContentPreview: options.extractContentPreview ?? true,
      computeContentHash: options.computeContentHash ?? true,
    };
  }

  async index(repoPath: string, repoId?: string): Promise<IndexResult> {
    const resolvedRepoId = repoId ?? this.generateRepoId(repoPath);
    const result: IndexResult = {
      repoId: resolvedRepoId,
      repoPath,
      scannedAt: new Date(),
      totalFiles: 0,
      totalDirs: 0,
      totalSizeBytes: 0,
      directories: [],
      files: [],
    };

    const rootDir: DirectoryEntry = {
      path: "./",
      relativePath: ".",
      childDirs: [],
      fileCount: 0,
    };
    result.directories.push(rootDir);

    const dirMap = new Map<string, DirectoryEntry>();
    dirMap.set(".", rootDir);

    const entries = await fg(["**/*"], {
      cwd: repoPath,
      onlyDirectories: false,
      onlyFiles: true,
      deep: this.options.maxDepth,
      ignore: this.options.excludePatterns,
      absolute: false,
      followSymlinks: false,
      suppressErrors: true,
    });

    const dirSet = new Set<string>();
    for (const entry of entries) {
      const parts = entry.replace(/\\/g, "/").split("/");
      for (let i = 1; i < parts.length; i++) {
        const dirPath = parts.slice(0, i).join("/");
        dirSet.add(dirPath);
      }
    }

    result.totalDirs = dirSet.size;
    for (const dirPath of dirSet) {
      const parentPath = dirPath.includes("/") ? dirPath.substring(0, dirPath.lastIndexOf("/")) : ".";
      const parentDir = dirMap.get(parentPath) ?? rootDir;
      
      const dirEntry: DirectoryEntry = {
        path: dirPath + "/",
        relativePath: dirPath,
        childDirs: [],
        fileCount: 0,
      };
      dirMap.set(dirPath, dirEntry);
      result.directories.push(dirEntry);
    }

    const fileEntries: FileEntry[] = [];
    const batchSize = 100;
    
    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize);
      const promises = batch.map((entry) => this.processFile(repoPath, entry));
      const processed = await Promise.all(promises);
      
      for (const fileEntry of processed) {
        if (fileEntry) {
          fileEntries.push(fileEntry);
        }
      }

      if (i + batchSize < entries.length) {
        const progress = Math.min(i + batchSize, entries.length);
        console.log(`Indexing: ${progress}/${entries.length} files`);
      }
    }

    for (const fileEntry of fileEntries) {
      const dirPath = fileEntry.relativePath.includes("/") 
        ? fileEntry.relativePath.substring(0, fileEntry.relativePath.lastIndexOf("/"))
        : ".";
      const dirEntry = dirMap.get(dirPath);
      if (dirEntry) {
        dirEntry.fileCount++;
      }
    }

    result.files = fileEntries;
    result.totalFiles = fileEntries.length;
    result.totalSizeBytes = fileEntries.reduce((sum, f) => sum + f.sizeBytes, 0);

    return result;
  }

  private generateRepoId(repoPath: string): string {
    const normalized = path.resolve(repoPath).replace(/[\\\/]/g, "-");
    const hash = crypto.createHash("md5").update(normalized).digest("hex").substring(0, 8);
    return `${path.basename(repoPath)}-${hash}`;
  }

  private detectLanguage(filename: string, extension: string): string {
    if (SPECIAL_FILENAME_PATTERNS[filename]) {
      return SPECIAL_FILENAME_PATTERNS[filename];
    }
    return EXTENSION_TO_LANGUAGE[extension] ?? "Unknown";
  }

  private async processFile(
    rootPath: string,
    relativePath: string
  ): Promise<FileEntry | null> {
    const fullPath = path.join(rootPath, relativePath);
    const normalizedPath = relativePath.replace(/\\/g, "/");

    if (
      this.options.includeExtensions.length > 0
    ) {
      const ext = path.extname(relativePath).toLowerCase();
      const filename = path.basename(relativePath);
      if (
        !this.options.includeExtensions.includes(ext) &&
        !this.options.includeExtensions.includes(filename)
      ) {
        return null;
      }
    }

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(fullPath);
    } catch (error) {
      return null;
    }

    if (stat.size > this.options.maxFileSize) {
      return null;
    }

    const extension = path.extname(relativePath).toLowerCase();
    const filename = path.basename(relativePath);

    let contentHash = "";
    let contentPreview = "";
    let lineCount = 0;

    if (stat.size > 0 && stat.size < 1024 * 1024) {
      try {
        const content = await fs.promises.readFile(fullPath, "utf-8");
        lineCount = content.split("\n").length;

        if (this.options.computeContentHash) {
          contentHash = crypto
            .createHash("sha256")
            .update(content)
            .digest("hex")
            .substring(0, 16);
        }

        if (this.options.extractContentPreview) {
          const lines = content.split("\n").slice(0, 10);
          contentPreview = lines.join("\n");
        }
      } catch (error) {
      }
    }

    return {
      path: fullPath,
      relativePath: normalizedPath,
      name: filename,
      extension,
      sizeBytes: stat.size,
      lastModified: stat.mtime,
      lineCount,
      contentHash,
      contentPreview,
    };
  }

  async indexIncremental(
    repoPath: string,
    previousIndex?: { lastScan: Date; fileHashes: Record<string, string> }
  ): Promise<{ indexResult: IndexResult; changedFiles: string[] }> {
    const indexResult = await this.index(repoPath);
    const changedFiles: string[] = [];

    if (!previousIndex) {
      return { indexResult, changedFiles: indexResult.files.map(f => f.relativePath) };
    }

    const currentHashes = new Map<string, string>();
    for (const file of indexResult.files) {
      if (file.contentHash) {
        currentHashes.set(file.relativePath, file.contentHash);
      }
    }

    for (const [path, hash] of Object.entries(previousIndex.fileHashes)) {
      if (!currentHashes.has(path)) {
        changedFiles.push(path);
      } else if (currentHashes.get(path) !== hash) {
        changedFiles.push(path);
      }
    }

    for (const path of currentHashes.keys()) {
      if (!previousIndex.fileHashes[path]) {
        changedFiles.push(path);
      }
    }

    return { indexResult, changedFiles };
  }

  generateRepoId(repoPath: string): string {
    const normalized = path.resolve(repoPath).replace(/[\\\/]/g, "-");
    const hash = crypto.createHash("md5").update(normalized).digest("hex").substring(0, 8);
    return `${path.basename(repoPath)}-${hash}`;
  }
}

export async function indexRepo(
  repoPath: string,
  options?: IndexerOptions
): Promise<IndexResult> {
  const indexer = new FileIndexer(options);
  return indexer.index(repoPath);
}
