import { prisma } from "@/lib/db/prisma";
import { claudeCompleteJSON } from "@/lib/ai/claude";
import { fetchReadme, fetchRepos, type GhRepo } from "./client";

export interface CleanProject {
  repo: string;
  title: string;
  bullet: string;
  stack: string[];
}

function titleCase(name: string): string {
  return name.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase());
}

// Deterministic fallback when the LLM is unavailable or skips a repo. Still real —
// derived from the repo's own metadata.
function heuristic(repo: GhRepo): CleanProject {
  const stack = [repo.language, ...repo.topics].filter((s): s is string => !!s);
  return {
    repo: repo.fullName,
    title: titleCase(repo.name),
    bullet: repo.description?.trim() || `${titleCase(repo.name)} — a project built with ${repo.language || "code"}.`,
    stack: [...new Set(stack)].slice(0, 6),
  };
}

type CleanInput = { repo: string; name: string; description: string | null; language: string | null; topics: string[]; readme: string };

// Clean in chunks so a big account (40+ repos) never blows the model's context.
// Each chunk is independent — a failed chunk just falls back to heuristics.
async function llmClean(items: CleanInput[]): Promise<Map<string, CleanProject>> {
  const merged = new Map<string, CleanProject>();
  const CHUNK = 8;
  for (let i = 0; i < items.length; i += CHUNK) {
    try {
      const part = await llmCleanChunk(items.slice(i, i + CHUNK));
      for (const [k, v] of part) merged.set(k, v);
    } catch {
      /* chunk failed → those repos use the heuristic fallback in the caller */
    }
  }
  return merged;
}

// One batched LLM call: turn messy repo names + READMEs into clean résumé entries.
// Grounded — the model may fix typos/naming and summarize, never invent features.
async function llmCleanChunk(items: CleanInput[]): Promise<Map<string, CleanProject>> {
  const system =
    "You turn a developer's GitHub repos into clean, professional résumé project entries. " +
    "Use ONLY the provided repo info + README excerpt — never invent features or technologies. " +
    "For each repo return: a presentable Title (fix bad names/typos, e.g. 'Live_wether' → 'Live Weather App'), " +
    "one concise résumé Bullet (what it does + how, past tense, <= 24 words, no fluff), and the real tech Stack. Return JSON only.";
  const payload = items.map((i) => ({
    repo: i.repo,
    name: i.name,
    description: i.description,
    language: i.language,
    topics: i.topics,
    readme: (i.readme || "").slice(0, 700),
  }));
  const prompt = `Repos:\n${JSON.stringify(payload)}\n\nReturn ONE JSON object:\n{"projects":[{"repo":"<exact repo value above>","title":"...","bullet":"...","stack":["..."]}]}`;
  const raw = (await claudeCompleteJSON<{ projects?: Record<string, unknown>[] }>(prompt, system, 1800)) || {};
  const m = new Map<string, CleanProject>();
  for (const p of raw.projects || []) {
    const repo = String(p.repo || "").trim();
    if (!repo) continue;
    m.set(repo, {
      repo,
      title: String(p.title || "").trim(),
      bullet: String(p.bullet || "").trim(),
      stack: Array.isArray(p.stack) ? (p.stack as unknown[]).map(String).filter(Boolean) : [],
    });
  }
  return m;
}

// Fetch the user's repos (skip forks / archived / the profile repo), read each
// README, clean them, and upsert into GithubProject. `selected` is preserved on
// re-fetch so the user's curation survives.
export interface ImportStats {
  fetched: number; // total repos GitHub returned
  forks: number; // how many of those are forks
  imported: number; // how many were cleaned + stored
}

export async function importGithubProjects(
  username: string,
  token?: string,
  opts: { includeForks?: boolean } = {}
): Promise<{ projects: Awaited<ReturnType<typeof prisma.githubProject.upsert>>[]; stats: ImportStats }> {
  const all = await fetchRepos(username, token);
  const forks = all.filter((r) => r.fork).length;
  const repos = all.filter(
    (r) => !r.archived && r.name.toLowerCase() !== username.toLowerCase() && (opts.includeForks || !r.fork)
  );

  const withReadme = await Promise.all(
    repos.map(async (r) => ({ r, readme: await fetchReadme(r.fullName, token) }))
  );

  let cleaned = new Map<string, CleanProject>();
  if (withReadme.length) {
    try {
      cleaned = await llmClean(
        withReadme.map(({ r, readme }) => ({
          repo: r.fullName,
          name: r.name,
          description: r.description,
          language: r.language,
          topics: r.topics,
          readme,
        }))
      );
    } catch {
      cleaned = new Map();
    }
  }

  const out = [];
  for (const { r, readme } of withReadme) {
    const c = cleaned.get(r.fullName);
    const h = heuristic(r);
    const final: CleanProject = {
      repo: r.fullName,
      title: c?.title || h.title,
      bullet: c?.bullet || h.bullet,
      stack: (c?.stack?.length ? c.stack : h.stack).slice(0, 6),
    };
    const data = {
      name: final.title,
      bullet: final.bullet,
      stack: final.stack,
      url: r.htmlUrl,
      language: r.language,
      stars: r.stars,
      topics: r.topics,
      hasReadme: !!readme,
      pushedAt: r.pushedAt ? new Date(r.pushedAt) : null,
    };
    const row = await prisma.githubProject.upsert({
      where: { repo: r.fullName },
      update: data, // note: does NOT touch `selected` — user's curation is preserved
      create: { repo: r.fullName, selected: false, ...data },
    });
    out.push(row);
  }
  return { projects: out, stats: { fetched: all.length, forks, imported: out.length } };
}
