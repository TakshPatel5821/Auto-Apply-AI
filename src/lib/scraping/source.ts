// The unified scraper contract. Every source (ATS board, remote-job feed, or
// the generic JSON-LD scraper) implements ScraperSource, so the registry can
// (a) claim a pasted URL via supports()/parseUrl(), and (b) run a keyword
// search across all sources uniformly via search().

import { ScrapedJob } from "@/types";
import { Logger } from "@/lib/logging/logger";

export interface SourceSearchConfig {
  keywords: string[];
  locations: string[];
  remote?: boolean;
  maxJobs?: number;
  /** Board tokens for ATS sources (e.g. Lever/Greenhouse company slugs). */
  companies?: string[];
  /** Called as each job is found, for live streaming into the pipeline. */
  onJob?: (job: ScrapedJob) => Promise<void>;
}

export interface ScraperSource {
  id: string;
  label: string;
  kind: "ats" | "feed" | "generic";
  /** True if this source recognizes (and can parse) the given URL. */
  supports(url: string): boolean;
  /** Extract jobs from a single pasted board/job URL. */
  parseUrl?(url: string): Promise<ScrapedJob[]>;
  /** Keyword/location search across this source's boards/feeds. */
  search?(config: SourceSearchConfig): Promise<ScrapedJob[]>;
  /** Curated default board tokens (ATS sources only). */
  defaultCompanies?: string[];
}

/**
 * Run a per-company fetch across many ATS boards, streaming each job and
 * honoring maxJobs. A bad board logs and is skipped — never throws.
 */
export async function runBoards(
  companies: string[],
  fetchOne: (company: string, keywords: string[]) => Promise<ScrapedJob[]>,
  cfg: SourceSearchConfig,
  logTag: string
): Promise<ScrapedJob[]> {
  const out: ScrapedJob[] = [];
  for (const company of companies) {
    if (cfg.maxJobs && out.length >= cfg.maxJobs) break;
    try {
      const jobs = await fetchOne(company, cfg.keywords);
      for (const j of jobs) {
        out.push(j);
        if (cfg.onJob) await cfg.onJob(j).catch(() => {});
        if (cfg.maxJobs && out.length >= cfg.maxJobs) break;
      }
    } catch (e) {
      await Logger.warn(logTag, `skip ${company}: ${String(e).slice(0, 100)}`);
    }
  }
  return out;
}

/** Stream an already-fetched list of jobs, honoring maxJobs + onJob. */
export async function streamJobs(jobs: ScrapedJob[], cfg: SourceSearchConfig): Promise<ScrapedJob[]> {
  const out: ScrapedJob[] = [];
  for (const j of jobs) {
    if (cfg.maxJobs && out.length >= cfg.maxJobs) break;
    out.push(j);
    if (cfg.onJob) await cfg.onJob(j).catch(() => {});
  }
  return out;
}
