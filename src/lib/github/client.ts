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

function mapRepo(r: Record<string, unknown>): GhRepo {
  return {
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
  };
}

// With a token we hit /user/repos (the token owner's OWN repos — includes private);
// without one, /users/{username}/repos (public only). Paginated up to 500 repos.
export async function fetchRepos(username: string, token?: string): Promise<GhRepo[]> {
  const out: GhRepo[] = [];
  for (let page = 1; page <= 5; page++) {
    const url = token
      ? `${GH}/user/repos?per_page=100&page=${page}&visibility=all&affiliation=owner,collaborator,organization_member&sort=pushed`
      : `${GH}/users/${encodeURIComponent(username)}/repos?per_page=100&page=${page}&sort=pushed`;
    const res = await fetch(url, { headers: headers(token) });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GitHub repos ${res.status}: ${body.slice(0, 160)}`);
    }
    const arr = (await res.json()) as Record<string, unknown>[];
    out.push(...arr.map(mapRepo));
    if (arr.length < 100) break;
  }
  return out;
}

// Verify a token + read its scopes (classic tokens expose them via the
// X-OAuth-Scopes header; fine-grained tokens return an empty list). login === null
// means the token is invalid/expired.
export async function ghAuthInfo(
  token: string
): Promise<{ login: string | null; scopes: string[]; ownedRepos: number }> {
  try {
    const res = await fetch(`${GH}/user`, { headers: headers(token) });
    if (!res.ok) return { login: null, scopes: [], ownedRepos: 0 };
    const scopes = (res.headers.get("x-oauth-scopes") || "").split(",").map((s) => s.trim()).filter(Boolean);
    const data = (await res.json()) as { login?: string; public_repos?: number; owned_private_repos?: number; total_private_repos?: number };
    const ownedRepos = (Number(data.public_repos) || 0) + (Number(data.owned_private_repos ?? data.total_private_repos) || 0);
    return { login: data.login || null, scopes, ownedRepos };
  } catch {
    return { login: null, scopes: [], ownedRepos: 0 };
  }
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
