// Minimal GitHub REST client (no SDK). Public repos work unauthenticated (60
// req/hr); pass a personal-access token for private repos + a 5000/hr limit.
const GH = "https://api.github.com";

export interface GhRepo {
  name: string;
  fullName: string; // owner/name
  description: string | null;
  htmlUrl: string;
  language: string | null;
  fork: boolean;
  archived: boolean;
  topics: string[];
  stars: number;
  pushedAt: string | null;
}

function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "ai-job-agent",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

export async function fetchRepos(username: string, token?: string): Promise<GhRepo[]> {
  const res = await fetch(
    `${GH}/users/${encodeURIComponent(username)}/repos?per_page=100&sort=pushed&type=owner`,
    { headers: headers(token) }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub repos ${res.status}: ${body.slice(0, 160)}`);
  }
  const arr = (await res.json()) as Record<string, unknown>[];
  return arr.map((r) => ({
    name: String(r.name),
    fullName: String(r.full_name),
    description: (r.description as string | null) ?? null,
    htmlUrl: String(r.html_url),
    language: (r.language as string | null) ?? null,
    fork: Boolean(r.fork),
    archived: Boolean(r.archived),
    topics: Array.isArray(r.topics) ? (r.topics as string[]) : [],
    stars: Number(r.stargazers_count) || 0,
    pushedAt: (r.pushed_at as string | null) ?? null,
  }));
}

// The README endpoint returns the repo's README regardless of filename/branch.
// Returns "" if there is none (or on any error — README is best-effort context).
export async function fetchReadme(fullName: string, token?: string): Promise<string> {
  try {
    const res = await fetch(`${GH}/repos/${fullName}/readme`, { headers: headers(token) });
    if (!res.ok) return "";
    const data = (await res.json()) as { content?: string; encoding?: string };
    if (!data.content) return "";
    return Buffer.from(data.content, (data.encoding as BufferEncoding) || "base64").toString("utf-8");
  } catch {
    return "";
  }
}
