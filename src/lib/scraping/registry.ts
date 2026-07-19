// The scraper registry: the single place that knows every source. It powers
//   • URL paste  → sourceForUrl(url) claims it (specific source, else generic)
//   • "search all" → searchAllSources() runs every board/feed in parallel
// New sources only need to be added to SOURCES below.

import { ScrapedJob } from "@/types";
import { Logger } from "@/lib/logging/logger";
import { ScraperSource, SourceSearchConfig } from "./source";
import { GreenhouseScraper, DEFAULT_GREENHOUSE_COMPANIES } from "./greenhouse";
import { leverSource } from "./lever";
import { ashbySource } from "./ashby";
import { smartRecruitersSource } from "./smartrecruiters";
import { workableSource } from "./workable";
import { recruiteeSource } from "./recruitee";
import { workdaySource } from "./workday";
import { remoteOkSource } from "./remoteok";
import { remotiveSource } from "./remotive";
import { weWorkRemotelySource } from "./weworkremotely";
import { hackerNewsSource } from "./hackernews-hiring";
import { genericSource } from "./generic-jsonld";
import { companiesFor } from "./company-catalog";

// Adapter over the existing Greenhouse class so it fits the ScraperSource shape.
const greenhouseSource: ScraperSource = {
  id: "greenhouse",
  label: "Greenhouse",
  kind: "ats",
  defaultCompanies: DEFAULT_GREENHOUSE_COMPANIES,
  supports: (url) => /greenhouse\.io|boards\.greenhouse/i.test(url),
  parseUrl: async (url) => {
    const token = url.match(/greenhouse\.io\/(?:embed\/job_board\?for=|boards\/)?([a-z0-9_-]+)/i)?.[1];
    if (!token) return [];
    return new GreenhouseScraper().scrapeJobs([token], [], []);
  },
  search: (cfg: SourceSearchConfig) =>
    new GreenhouseScraper().scrapeJobs(
      cfg.companies?.length ? cfg.companies : DEFAULT_GREENHOUSE_COMPANIES,
      cfg.keywords,
      cfg.locations,
      cfg.onJob
    ),
};

// All keyword-searchable sources (ATS boards + remote feeds). The generic
// JSON-LD source is intentionally NOT here — it's the per-URL fallback only.
export const SOURCES: ScraperSource[] = [
  greenhouseSource,
  leverSource,
  ashbySource,
  smartRecruitersSource,
  workableSource,
  recruiteeSource,
  workdaySource,
  remoteOkSource,
  remotiveSource,
  weWorkRemotelySource,
  hackerNewsSource,
];

export { genericSource };

/** The source that claims `url`, or the generic JSON-LD scraper as fallback. */
export function sourceForUrl(url: string): ScraperSource {
  return SOURCES.find((s) => s.supports(url)) || genericSource;
}

/** Extract jobs from a single pasted URL (board or individual posting). */
export async function parseUrl(url: string): Promise<ScrapedJob[]> {
  const src = sourceForUrl(url);
  if (src.parseUrl) {
    const jobs = await src.parseUrl(url).catch(() => [] as ScrapedJob[]);
    // A specific source that found nothing on an individual posting URL still
    // benefits from the JSON-LD fallback (e.g. a Lever job detail page).
    if (jobs.length === 0 && src.id !== "generic" && genericSource.parseUrl) {
      return genericSource.parseUrl(url).catch(() => []);
    }
    return jobs;
  }
  return genericSource.parseUrl ? genericSource.parseUrl(url).catch(() => []) : [];
}

export interface SearchAllOptions {
  /** Restrict to these source ids; default = all. */
  sources?: string[];
  /** Max sources fetched at once (per-domain rate-limiting still applies). */
  concurrency?: number;
}

/**
 * Run every (selected) source's keyword search in parallel with a concurrency
 * cap. Each source also streams via cfg.onJob; this returns the aggregate too.
 * A failing source is logged and skipped — never aborts the whole search.
 */
export async function searchAllSources(cfg: SourceSearchConfig, opts: SearchAllOptions = {}): Promise<ScrapedJob[]> {
  const selected = opts.sources?.length ? SOURCES.filter((s) => opts.sources!.includes(s.id)) : SOURCES;
  const searchable = selected.filter((s) => typeof s.search === "function");
  const concurrency = Math.max(1, opts.concurrency ?? 4);

  // When the caller didn't pin specific companies, draw each ATS source's board
  // tokens from the catalog (built-in ∪ imported) rather than its tiny inline
  // default — this is what lets discovery scale as the catalog grows.
  const cfgFor = (src: ScraperSource): SourceSearchConfig =>
    cfg.companies?.length ? cfg : { ...cfg, companies: companiesFor(src.id) };

  const results: ScrapedJob[] = [];
  let idx = 0;
  const worker = async (): Promise<void> => {
    while (idx < searchable.length) {
      const src = searchable[idx++];
      try {
        await Logger.info("SCRAPER", `▶ ${src.label} search…`);
        const jobs = await src.search!(cfgFor(src));
        results.push(...jobs);
        await Logger.success("SCRAPER", `✓ ${src.label}: ${jobs.length} job(s)`);
      } catch (e) {
        await Logger.warn("SCRAPER", `source ${src.id} failed: ${String(e).slice(0, 120)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, searchable.length) }, worker));
  return results;
}

/** Metadata for the UI / API (which sources exist and what they can do). */
export function listSources(): { id: string; label: string; kind: string; hasSearch: boolean; defaultCompanies?: string[] }[] {
  return [...SOURCES, genericSource].map((s) => ({
    id: s.id,
    label: s.label,
    kind: s.kind,
    hasSearch: typeof s.search === "function",
    defaultCompanies: s.defaultCompanies,
  }));
}
