import { FingerprintEngine, scanAndStore, DEFAULT_RULES } from "./engine.js";
import { FileIndexer, indexRepo } from "./indexer.js";

export { FingerprintEngine, scanAndStore, DEFAULT_RULES } from "./engine.js";
export { FileIndexer, indexRepo } from "./indexer.js";
export type {
  FileEntry,
  DirectoryEntry,
  IndexResult,
  IndexerOptions,
} from "./indexer.js";
export type {
  FingerprintRule,
  DetectedComponent,
  RepoFingerprint,
  RepoType,
  LanguageStats,
  FingerprintSummary,
  FingerprintOptions,
  ScanResult,
  StorageOptions,
} from "./engine.js";

export async function main() {
  const args = process.argv.slice(2);
  const repoPath = args[0];

  if (!repoPath) {
    console.error("Usage: ts-node src/index.ts <repo-path> [--save-db]");
    process.exit(1);
  }

  const saveDb = args.includes("--save-db");

  console.log(`Scanning repository: ${repoPath}`);
  console.log("=".repeat(50));

  const result = await scanAndStore(repoPath, {
    saveToDb: saveDb,
  });

  console.log("\n=== Fingerprint Results ===\n");
  console.log(`Repository: ${result.repoPath}`);
  console.log(`Language: ${result.fingerprint.detectedLanguage || "Unknown"}`);
  console.log(`Framework: ${result.fingerprint.detectedFramework || "None"}`);
  console.log(`Type: ${result.fingerprint.repoType}`);
  console.log(`Complexity: ${result.fingerprint.summary.complexityScore}/100`);

  console.log("\n=== Components Detected ===\n");
  for (const comp of result.fingerprint.components) {
    console.log(
      `  [${comp.category}] ${comp.name} (${(comp.confidence * 100).toFixed(0)}%)`
    );
  }

  console.log("\n=== Languages ===\n");
  for (const lang of result.fingerprint.languages.slice(0, 5)) {
    console.log(
      `  ${lang.language}: ${lang.fileCount} files, ${lang.lineCount} lines (${lang.percentage.toFixed(1)}%)`
    );
  }

  console.log("\n=== Summary ===\n");
  const summary = result.fingerprint.summary;
  console.log(`  Cloud Services: ${summary.cloudServices.join(", ") || "None"}`);
  console.log(`  Databases: ${summary.databases.join(", ") || "None"}`);
  console.log(`  CI/CD: ${summary.cicdSystems.join(", ") || "None"}`);
  console.log(`  Containerized: ${summary.containerized ? "Yes" : "No"}`);
  console.log(`  Has Tests: ${summary.hasTests ? "Yes" : "No"}`);

  console.log(`\nScanned in ${result.durationMs}ms`);
  console.log(`Total files: ${result.fingerprint.components.length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
