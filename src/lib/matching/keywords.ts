// Shared tech/skill keyword dictionary + word-boundary matching. Used by BOTH
// the fast pre-filter (job search ranking) and the ATS keyword checker's
// deterministic fallback, so skill detection is consistent across the app.

// Canonical, lowercase tech keywords. Multi-word / punctuated forms are preferred
// where a single token would be ambiguous (e.g. "apache spark", "power bi",
// "machine learning", "spring boot") so we don't false-match everyday words.
export const TECH_KEYWORDS: string[] = [
  // Languages
  "javascript", "typescript", "python", "java", "kotlin", "scala", "swift",
  "ruby", "php", "go", "golang", "rust", "c++", "c#", "objective-c", "dart",
  "elixir", "perl", "shell", "bash", "powershell",
  // Frontend
  "react", "next.js", "nextjs", "vue", "angular", "svelte", "remix", "redux",
  "tailwind", "sass", "webpack", "vite", "html", "css",
  // Backend / frameworks
  "node", "nodejs", "express", "django", "flask", "fastapi", "spring",
  "spring boot", "rails", ".net", "dotnet", "laravel", "nestjs",
  // Data / DB
  "sql", "postgresql", "mysql", "mongodb", "redis", "dynamodb", "cassandra",
  "sqlite", "oracle", "elasticsearch", "snowflake", "databricks",
  "apache spark", "hadoop", "kafka", "rabbitmq", "airflow", "dbt",
  // Cloud / infra
  "aws", "gcp", "azure", "docker", "kubernetes", "terraform", "ansible",
  "helm", "lambda", "ec2", "s3", "serverless", "microservices",
  "jenkins", "github actions", "gitlab", "circleci", "prometheus", "grafana",
  "datadog", "nginx",
  // ML / data science
  "machine learning", "deep learning", "tensorflow", "pytorch", "keras",
  "scikit-learn", "numpy", "pandas", "opencv", "nlp", "llm", "langchain",
  "data science",
  // API / protocols / security
  "rest", "graphql", "grpc", "websocket", "oauth", "jwt", "api",
  // Tooling / practices
  "git", "ci/cd", "agile", "scrum", "kanban", "tdd", "devops", "linux",
  "jira", "figma", "jest", "cypress", "playwright", "selenium", "pytest",
  "tableau", "power bi", "looker", "prisma", "flutter",
];

// Does `token` appear in `text` as a distinct term? Alphanumeric tokens use a
// word boundary so "go" can't match inside "good"; tokens with special chars
// (c++, c#, ci/cd, node.js) fall back to substring — they're distinctive enough
// not to false-match, and word boundaries don't behave around punctuation.
// `text` should be lowercased by the caller for the substring path.
export function tokenInText(token: string, text: string): boolean {
  const t = token.toLowerCase();
  if (!t) return false;
  if (/[^a-z0-9 ]/i.test(t)) return text.includes(t);
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}

// Extract the dictionary keywords that appear in `text` (word-boundary aware).
export function extractKeywords(text: string, dict: string[] = TECH_KEYWORDS): string[] {
  const lower = text.toLowerCase();
  const found: string[] = [];
  for (const kw of dict) {
    if (tokenInText(kw, lower)) found.push(kw);
  }
  return found;
}
