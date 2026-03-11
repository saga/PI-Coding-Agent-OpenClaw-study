export interface FingerprintRule {
  id: string;
  name: string;
  category: RuleCategory;
  type: RuleType;
  pattern: string;
  matchType: MatchType;
  weight: number;
  component: string;
  version?: string;
  metadata?: Record<string, unknown>;
}

export type RuleCategory =
  | "language"
  | "framework"
  | "runtime"
  | "infrastructure"
  | "cicd"
  | "database"
  | "cloud"
  | "messaging"
  | "build"
  | "security"
  | "documentation"
  | "ownership";

export type RuleType =
  | "file_present"
  | "file_extension"
  | "content_match"
  | "directory_pattern"
  | "filename_pattern";

export type MatchType =
  | "exact"
  | "contains"
  | "regex"
  | "startsWith"
  | "endsWith"
  | "glob";

export interface DetectedComponent {
  ruleId: string;
  name: string;
  category: RuleCategory;
  confidence: number;
  evidence: MatchEvidence[];
  metadata?: Record<string, unknown>;
}

export interface MatchEvidence {
  type: "file" | "content" | "directory";
  path: string;
  matchedPattern: string;
  lineNumber?: number;
}

export interface RepoFingerprint {
  repoId: string;
  repoPath: string;
  scannedAt: Date;
  detectedLanguage: string | null;
  detectedFramework: string | null;
  detectedRuntime: string | null;
  repoType: RepoType;
  components: DetectedComponent[];
  languages: LanguageStats[];
  summary: FingerprintSummary;
}

export interface LanguageStats {
  language: string;
  fileCount: number;
  lineCount: number;
  percentage: number;
}

export type RepoType =
  | "frontend"
  | "backend"
  | "microservice"
  | "library"
  | "infrastructure"
  | "data-pipeline"
  | "ml-project"
  | "batch"
  | "documentation"
  | "unknown";

export interface FingerprintSummary {
  primaryLanguage: string | null;
  primaryFramework: string | null;
  cloudServices: string[];
  databases: string[];
  cicdSystems: string[];
  containerized: boolean;
  hasTests: boolean;
  hasDocumentation: boolean;
  complexityScore: number;
}

export interface FingerprintOptions {
  enableContentMatch?: boolean;
  enableVersionDetection?: boolean;
  minConfidenceThreshold?: number;
  customRules?: FingerprintRule[];
}

export const DEFAULT_RULES: FingerprintRule[] = [
  // Language Rules
  {
    id: "lang-java-maven",
    name: "Maven Java Project",
    category: "language",
    type: "file_present",
    pattern: "pom.xml",
    matchType: "exact",
    weight: 10,
    component: "Java",
    metadata: { buildTool: "Maven" },
  },
  {
    id: "lang-java-gradle",
    name: "Gradle Java Project",
    category: "language",
    type: "file_present",
    pattern: "build.gradle",
    matchType: "exact",
    weight: 10,
    component: "Java",
    metadata: { buildTool: "Gradle" },
  },
  {
    id: "lang-java-gradle-kts",
    name: "Gradle Kotlin DSL Project",
    category: "language",
    type: "file_present",
    pattern: "build.gradle.kts",
    matchType: "exact",
    weight: 10,
    component: "Java",
    metadata: { buildTool: "Gradle", kotlin: true },
  },
  {
    id: "lang-java-kotlin",
    name: "Kotlin File",
    category: "language",
    type: "file_extension",
    pattern: "*.kt",
    matchType: "glob",
    weight: 5,
    component: "Kotlin",
  },
  {
    id: "lang-js-npm",
    name: "NPM JavaScript Project",
    category: "language",
    type: "file_present",
    pattern: "package.json",
    matchType: "exact",
    weight: 8,
    component: "JavaScript",
    metadata: { packageManager: "npm" },
  },
  {
    id: "lang-ts",
    name: "TypeScript File",
    category: "language",
    type: "file_extension",
    pattern: "*.ts",
    matchType: "glob",
    weight: 5,
    component: "TypeScript",
  },
  {
    id: "lang-tsx",
    name: "TypeScript React File",
    category: "language",
    type: "file_extension",
    pattern: "*.tsx",
    matchType: "glob",
    weight: 5,
    component: "TypeScript",
  },
  {
    id: "lang-python-pip",
    name: "Python Pip Project",
    category: "language",
    type: "file_present",
    pattern: "requirements.txt",
    matchType: "exact",
    weight: 8,
    component: "Python",
    metadata: { packageManager: "pip" },
  },
  {
    id: "lang-python-poetry",
    name: "Python Poetry Project",
    category: "language",
    type: "file_present",
    pattern: "pyproject.toml",
    matchType: "exact",
    weight: 10,
    component: "Python",
    metadata: { packageManager: "poetry" },
  },
  {
    id: "lang-go",
    name: "Go Module",
    category: "language",
    type: "file_present",
    pattern: "go.mod",
    matchType: "exact",
    weight: 10,
    component: "Go",
  },
  {
    id: "lang-rust",
    name: "Rust Cargo Project",
    category: "language",
    type: "file_present",
    pattern: "Cargo.toml",
    matchType: "exact",
    weight: 10,
    component: "Rust",
  },
  {
    id: "lang-csharp",
    name: "C# Project",
    category: "language",
    type: "file_extension",
    pattern: "*.csproj",
    matchType: "glob",
    weight: 8,
    component: "C#",
  },
  {
    id: "lang-ruby",
    name: "Ruby Gem",
    category: "language",
    type: "file_present",
    pattern: "Gemfile",
    matchType: "exact",
    weight: 8,
    component: "Ruby",
  },
  {
    id: "lang-php",
    name: "PHP Composer",
    category: "language",
    type: "file_present",
    pattern: "composer.json",
    matchType: "exact",
    weight: 8,
    component: "PHP",
  },

  // Framework Rules
  {
    id: "fw-spring-boot",
    name: "Spring Boot Application",
    category: "framework",
    type: "file_present",
    pattern: "pom.xml",
    matchType: "exact",
    weight: 15,
    component: "SpringBoot",
  },
  {
    id: "fw-spring-boot-starter",
    name: "Spring Boot Starter",
    category: "framework",
    type: "content_match",
    pattern: "@SpringBootApplication",
    matchType: "contains",
    weight: 20,
    component: "SpringBoot",
  },
  {
    id: "fw-express",
    name: "Express.js",
    category: "framework",
    type: "content_match",
    pattern: '"express"',
    matchType: "contains",
    weight: 10,
    component: "Express",
  },
  {
    id: "fw-react",
    name: "React",
    category: "framework",
    type: "content_match",
    pattern: '"react"',
    matchType: "contains",
    weight: 10,
    component: "React",
  },
  {
    id: "fw-nextjs",
    name: "Next.js",
    category: "framework",
    type: "file_present",
    pattern: "next.config.js",
    matchType: "exact",
    weight: 15,
    component: "NextJS",
  },
  {
    id: "fw-angular",
    name: "Angular",
    category: "framework",
    type: "file_present",
    pattern: "angular.json",
    matchType: "exact",
    weight: 15,
    component: "Angular",
  },
  {
    id: "fw-vue",
    name: "Vue.js",
    category: "framework",
    type: "file_present",
    pattern: "vue.config.js",
    matchType: "exact",
    weight: 15,
    component: "Vue",
  },
  {
    id: "fw-nestjs",
    name: "NestJS",
    category: "framework",
    type: "content_match",
    pattern: '"@nestjs"',
    matchType: "contains",
    weight: 15,
    component: "NestJS",
  },
  {
    id: "fw-flask",
    name: "Flask",
    category: "framework",
    type: "content_match",
    pattern: "from flask import",
    matchType: "contains",
    weight: 15,
    component: "Flask",
  },
  {
    id: "fw-django",
    name: "Django",
    category: "framework",
    type: "content_match",
    pattern: "from django",
    matchType: "contains",
    weight: 15,
    component: "Django",
  },
  {
    id: "fw-fastapi",
    name: "FastAPI",
    category: "framework",
    type: "content_match",
    pattern: "from fastapi import",
    matchType: "contains",
    weight: 15,
    component: "FastAPI",
  },
  {
    id: "fw-fastapi-decorator",
    name: "FastAPI Decorator",
    category: "framework",
    type: "content_match",
    pattern: "@app.get",
    matchType: "contains",
    weight: 10,
    component: "FastAPI",
  },
  {
    id: "fw-nestjs-controller",
    name: "NestJS Controller",
    category: "framework",
    type: "filename_pattern",
    pattern: "*.controller.ts",
    matchType: "glob",
    weight: 8,
    component: "NestJS",
  },
  {
    id: "fw-spring-service",
    name: "Spring Service",
    category: "framework",
    type: "filename_pattern",
    pattern: "*.service.ts",
    matchType: "glob",
    weight: 8,
    component: "SpringBoot",
  },

  // Infrastructure Rules
  {
    id: "inf-terraform",
    name: "Terraform",
    category: "infrastructure",
    type: "file_extension",
    pattern: "*.tf",
    matchType: "glob",
    weight: 10,
    component: "Terraform",
  },
  {
    id: "inf-terraform-provider",
    name: "Terraform AWS Provider",
    category: "infrastructure",
    type: "content_match",
    pattern: 'provider "aws"',
    matchType: "contains",
    weight: 15,
    component: "Terraform",
    metadata: { provider: "aws" },
  },
  {
    id: "inf-helm",
    name: "Helm Chart",
    category: "infrastructure",
    type: "file_present",
    pattern: "Chart.yaml",
    matchType: "exact",
    weight: 12,
    component: "Helm",
  },
  {
    id: "inf-kustomize",
    name: "Kustomize",
    category: "infrastructure",
    type: "file_present",
    pattern: "kustomization.yaml",
    matchType: "exact",
    weight: 12,
    component: "Kustomize",
  },
  {
    id: "inf-k8s-deployment",
    name: "Kubernetes Deployment",
    category: "infrastructure",
    type: "filename_pattern",
    pattern: "*deployment*.yaml",
    matchType: "glob",
    weight: 8,
    component: "Kubernetes",
  },
  {
    id: "inf-k8s-service",
    name: "Kubernetes Service",
    category: "infrastructure",
    type: "filename_pattern",
    pattern: "*service*.yaml",
    matchType: "glob",
    weight: 8,
    component: "Kubernetes",
  },

  // CI/CD Rules
  {
    id: "cicd-github-actions",
    name: "GitHub Actions",
    category: "cicd",
    type: "directory_pattern",
    pattern: ".github/workflows",
    matchType: "exact",
    weight: 12,
    component: "GitHub Actions",
  },
  {
    id: "cicd-jenkins",
    name: "Jenkins",
    category: "cicd",
    type: "file_present",
    pattern: "Jenkinsfile",
    matchType: "exact",
    weight: 12,
    component: "Jenkins",
  },
  {
    id: "cicd-gitlab-ci",
    name: "GitLab CI",
    category: "cicd",
    type: "file_present",
    pattern: ".gitlab-ci.yml",
    matchType: "exact",
    weight: 12,
    component: "GitLab CI",
  },
  {
    id: "cicd-azure",
    name: "Azure DevOps",
    category: "cicd",
    type: "file_present",
    pattern: "azure-pipelines.yml",
    matchType: "exact",
    weight: 12,
    component: "Azure DevOps",
  },
  {
    id: "cicd-circleci",
    name: "CircleCI",
    category: "cicd",
    type: "file_present",
    pattern: "circle.yml",
    matchType: "exact",
    weight: 10,
    component: "CircleCI",
  },

  // Container Rules
  {
    id: "rt-docker",
    name: "Docker",
    category: "runtime",
    type: "file_present",
    pattern: "Dockerfile",
    matchType: "exact",
    weight: 10,
    component: "Docker",
  },
  {
    id: "rt-docker-compose",
    name: "Docker Compose",
    category: "runtime",
    type: "file_present",
    pattern: "docker-compose.yml",
    matchType: "exact",
    weight: 10,
    component: "Docker Compose",
  },
  {
    id: "rt-containerfile",
    name: "Containerfile",
    category: "runtime",
    type: "file_present",
    pattern: "Containerfile",
    matchType: "exact",
    weight: 10,
    component: "Docker",
  },

  // Database Rules
  {
    id: "db-postgres",
    name: "PostgreSQL",
    category: "database",
    type: "content_match",
    pattern: "postgres",
    matchType: "contains",
    weight: 5,
    component: "PostgreSQL",
  },
  {
    id: "db-mysql",
    name: "MySQL",
    category: "database",
    type: "content_match",
    pattern: "mysql",
    matchType: "contains",
    weight: 5,
    component: "MySQL",
  },
  {
    id: "db-mongodb",
    name: "MongoDB",
    category: "database",
    type: "content_match",
    pattern: "mongodb",
    matchType: "contains",
    weight: 5,
    component: "MongoDB",
  },
  {
    id: "db-redis",
    name: "Redis",
    category: "database",
    type: "content_match",
    pattern: "redis",
    matchType: "contains",
    weight: 5,
    component: "Redis",
  },
  {
    id: "db-elasticsearch",
    name: "Elasticsearch",
    category: "database",
    type: "content_match",
    pattern: "elasticsearch",
    matchType: "contains",
    weight: 5,
    component: "Elasticsearch",
  },
  {
    id: "db-dynamodb",
    name: "DynamoDB",
    category: "database",
    type: "content_match",
    pattern: "dynamodb",
    matchType: "contains",
    weight: 5,
    component: "DynamoDB",
  },

  // AWS Services
  {
    id: "cloud-aws-s3",
    name: "AWS S3",
    category: "cloud",
    type: "content_match",
    pattern: "aws_s3_bucket",
    matchType: "contains",
    weight: 8,
    component: "AWS S3",
  },
  {
    id: "cloud-aws-lambda",
    name: "AWS Lambda",
    category: "cloud",
    type: "content_match",
    pattern: "aws_lambda_function",
    matchType: "contains",
    weight: 8,
    component: "AWS Lambda",
  },
  {
    id: "cloud-aws-ecs",
    name: "AWS ECS",
    category: "cloud",
    type: "content_match",
    pattern: "aws_ecs_service",
    matchType: "contains",
    weight: 8,
    component: "AWS ECS",
  },
  {
    id: "cloud-aws-eks",
    name: "AWS EKS",
    category: "cloud",
    type: "content_match",
    pattern: "aws_eks_cluster",
    matchType: "contains",
    weight: 8,
    component: "AWS EKS",
  },
  {
    id: "cloud-aws-rds",
    name: "AWS RDS",
    category: "cloud",
    type: "content_match",
    pattern: "aws_rds",
    matchType: "contains",
    weight: 8,
    component: "AWS RDS",
  },

  // GCP Services
  {
    id: "cloud-gcp-gcs",
    name: "Google Cloud Storage",
    category: "cloud",
    type: "content_match",
    pattern: "google_storage_bucket",
    matchType: "contains",
    weight: 8,
    component: "GCS",
  },
  {
    id: "cloud-gcp-run",
    name: "Google Cloud Run",
    category: "cloud",
    type: "content_match",
    pattern: "google_cloud_run_service",
    matchType: "contains",
    weight: 8,
    component: "Cloud Run",
  },
  {
    id: "cloud-gcp-gke",
    name: "Google GKE",
    category: "cloud",
    type: "content_match",
    pattern: "google_container_cluster",
    matchType: "contains",
    weight: 8,
    component: "GKE",
  },

  // Azure Services
  {
    id: "cloud-azure-storage",
    name: "Azure Storage",
    category: "cloud",
    type: "content_match",
    pattern: "azurerm_storage_account",
    matchType: "contains",
    weight: 8,
    component: "Azure Storage",
  },
  {
    id: "cloud-azure-func",
    name: "Azure Functions",
    category: "cloud",
    type: "content_match",
    pattern: "azurerm_function_app",
    matchType: "contains",
    weight: 8,
    component: "Azure Functions",
  },
  {
    id: "cloud-azure-aks",
    name: "Azure AKS",
    category: "cloud",
    type: "content_match",
    pattern: "azurerm_kubernetes_cluster",
    matchType: "contains",
    weight: 8,
    component: "AKS",
  },

  // Data Pipeline
  {
    id: "data-airflow",
    name: "Apache Airflow",
    category: "messaging",
    type: "content_match",
    pattern: "airflow",
    matchType: "contains",
    weight: 15,
    component: "Airflow",
  },
  {
    id: "data-dag",
    name: "Airflow DAG",
    category: "messaging",
    type: "filename_pattern",
    pattern: "*dag.py",
    matchType: "glob",
    weight: 12,
    component: "Airflow",
  },
  {
    id: "data-spark",
    name: "Apache Spark",
    category: "messaging",
    type: "content_match",
    pattern: "from pyspark",
    matchType: "contains",
    weight: 12,
    component: "Spark",
  },
  {
    id: "data-kafka",
    name: "Apache Kafka",
    category: "messaging",
    type: "content_match",
    pattern: "kafka",
    matchType: "contains",
    weight: 10,
    component: "Kafka",
  },

  // Build Tools
  {
    id: "build-maven",
    name: "Maven",
    category: "build",
    type: "file_present",
    pattern: "pom.xml",
    matchType: "exact",
    weight: 8,
    component: "Maven",
  },
  {
    id: "build-gradle",
    name: "Gradle",
    category: "build",
    type: "file_present",
    pattern: "build.gradle",
    matchType: "exact",
    weight: 8,
    component: "Gradle",
  },
  {
    id: "build-npm",
    name: "NPM",
    category: "build",
    type: "file_present",
    pattern: "package-lock.json",
    matchType: "exact",
    weight: 5,
    component: "NPM",
  },
  {
    id: "build-yarn",
    name: "Yarn",
    category: "build",
    type: "file_present",
    pattern: "yarn.lock",
    matchType: "exact",
    weight: 5,
    component: "Yarn",
  },

  // Security
  {
    id: "sec-sonarqube",
    name: "SonarQube",
    category: "security",
    type: "file_present",
    pattern: "sonar-project.properties",
    matchType: "exact",
    weight: 10,
    component: "SonarQube",
  },
  {
    id: "sec-dependabot",
    name: "Dependabot",
    category: "security",
    type: "file_present",
    pattern: "dependabot.yml",
    matchType: "exact",
    weight: 10,
    component: "Dependabot",
  },
  {
    id: "sec-renovate",
    name: "Renovate",
    category: "security",
    type: "file_present",
    pattern: "renovate.json",
    matchType: "exact",
    weight: 10,
    component: "Renovate",
  },

  // Documentation
  {
    id: "docs-mkdocs",
    name: "MkDocs",
    category: "documentation",
    type: "file_present",
    pattern: "mkdocs.yml",
    matchType: "exact",
    weight: 10,
    component: "MkDocs",
  },
  {
    id: "docs-sphinx",
    name: "Sphinx",
    category: "documentation",
    type: "file_present",
    pattern: "conf.py",
    matchType: "exact",
    weight: 10,
    component: "Sphinx",
  },

  // Ownership
  {
    id: "owner-codeowners",
    name: "CODEOWNERS",
    category: "ownership",
    type: "file_present",
    pattern: "CODEOWNERS",
    matchType: "exact",
    weight: 5,
    component: "CODEOWNERS",
  },

  // Testing
  {
    id: "test-jest",
    name: "Jest",
    category: "build",
    type: "file_present",
    pattern: "jest.config.js",
    matchType: "exact",
    weight: 8,
    component: "Jest",
  },
  {
    id: "test-vitest",
    name: "Vitest",
    category: "build",
    type: "file_present",
    pattern: "vitest.config.ts",
    matchType: "exact",
    weight: 8,
    component: "Vitest",
  },
  {
    id: "test-pytest",
    name: "Pytest",
    category: "build",
    type: "file_present",
    pattern: "pytest.ini",
    matchType: "exact",
    weight: 8,
    component: "Pytest",
  },
  {
    id: "test-junit",
    name: "JUnit",
    category: "build",
    type: "filename_pattern",
    pattern: "*test*.java",
    matchType: "glob",
    weight: 5,
    component: "JUnit",
  },

  // ML/Notebook
  {
    id: "ml-notebook",
    name: "Jupyter Notebook",
    category: "language",
    type: "file_extension",
    pattern: "*.ipynb",
    matchType: "glob",
    weight: 10,
    component: "Jupyter",
  },
];
