// Hacker News "Ask HN: Who is hiring?" — the monthly thread (posted by the
// `whoishiring` account) is a goldmine of direct-from-company roles. We find the
// latest thread via the Algolia API, then parse each top-level comment as a
// posting. Comment formats vary, so company/title are best-effort heuristics and
// the full comment is kept as the description.

import { ScrapedJob } from "@/types";
import { politeGet } from "./http-client";
import { htmlToText, makeJob, matchesKeywords } from "./util";
import { ScraperSource, SourceSearchConfig, streamJobs } from "./source";

interface AlgoliaHit { objectID: string; title?: string; created_at_i?: number }
interface HnItem { id: number; text?: string | null; author?: string; created_at?: string; children?: HnItem[] }

const ROLE_RX = /(engineer|developer|programmer|designer|manager|scientist|analyst|architect|devops|sre|lead|director|product|data|ml|ai|full[-\s]?stack|front[-\s]?end|back[-\s]?end|intern)/i;

async function latestThreadId(): Promise<string | null> {
  const data = await politeGet<{ hits?: AlgoliaHit[] }>(
    "https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&query=who%20is%20hiring&hitsPerPage=5"
  );
  const hits = (data?.hits || []).filter((h) => /who\s*is\s*hiring/i.test(h.title || ""));
  hits.sort((a, b) => (b.created_at_i || 0) - (a.created_at_i || 0));
  return hits[0]?.objectID || null;
}

/** Pull a company + role guess from the first line of a posting comment. */
function parseHeader(text: string): { company: string; title: string } {
  const firstLine = (text.split("\n").map((l) => l.trim()).find(Boolean) || "").slice(0, 200);
  const segments = firstLine.split(/\s[|•·—–]\s|\s-\s/).map((s) => s.trim()).filter(Boolean);
  const company = (segments[0] || "Unknown").slice(0, 80);
  const titleSeg = segments.find((s) => ROLE_RX.test(s)) || segments[1] || "";
  const title = (titleSeg || firstLine).slice(0, 120) || "See posting";
  return { company, title };
}

async function fetchAll(keywords: string[]): Promise<ScrapedJob[]> {
  const threadId = await latestThreadId();
  if (!threadId) return [];
  const thread = await politeGet<HnItem>(`https://hn.algolia.com/api/v1/items/${threadId}`);
  const children = thread?.children;
  if (!Array.isArray(children)) return [];

  const out: ScrapedJob[] = [];
  for (const c of children) {
    if (!c.text) continue; // deleted/empty
    const description = htmlToText(c.text);
    if (description.length < 30) continue;
    const { company, title } = parseHeader(description);
    out.push(
      makeJob({
        platform: "hackernews",
        platformJobId: String(c.id),
        url: `https://news.ycombinator.com/item?id=${c.id}`,
        companyName: company,
        jobTitle: title,
        location: /remote/i.test(description) ? "Remote" : "",
        description,
        scrapedAt: c.created_at ? new Date(c.created_at) : new Date(),
      })
    );
  }
  return out.filter((job) => matchesKeywords(job, keywords));
}

export const hackerNewsSource: ScraperSource = {
  id: "hackernews",
  label: "Hacker News — Who is hiring",
  kind: "feed",
  supports: (url) => /news\.ycombinator\.com/i.test(url),
  parseUrl: async () => fetchAll([]),
  search: async (cfg: SourceSearchConfig) => streamJobs(await fetchAll(cfg.keywords), cfg),
};
