// Lever — public postings API. Like Greenhouse, Lever has no global search; jobs
// live on per-company boards at api.lever.co/v0/postings/{company}?mode=json,
// which returns full postings as JSON (far more reliable than scraping HTML).

import { ScrapedJob } from "@/types";
import { politeGet } from "./http-client";
import { htmlToText, makeJob, matchesKeywords } from "./util";
import { ScraperSource, SourceSearchConfig, runBoards } from "./source";

export const DEFAULT_LEVER_COMPANIES = [
  "netflix", "spotify", "lever", "plaid", "ramp", "notion", "brex",
  "github", "atlassian", "nubank", "kraken", "mistral", "anthropic",
];

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl?: string;
  categories?: { location?: string; team?: string; commitment?: string };
  descriptionPlain?: string;
  description?: string;
  createdAt?: number;
  workplaceType?: string;
}

/** Extract a Lever board token from a jobs.lever.co or api.lever.co URL. */
export function leverCompanyFromUrl(url: string): string | null {
  const m = url.match(/lever\.co\/(?:v0\/postings\/)?([a-z0-9][a-z0-9-]*)/i);
  return m ? m[1].toLowerCase() : null;
}

async function fetchBoard(company: string, keywords: string[]): Promise<ScrapedJob[]> {
  const data = await politeGet<LeverPosting[]>(`https://api.lever.co/v0/postings/${company}?mode=json`);
  if (!Array.isArray(data)) return [];
  return data
    .map((p) => {
      const location = p.categories?.location || "";
      return makeJob({
        platform: "lever",
        platformJobId: p.id,
        url: p.hostedUrl,
        applyUrl: p.applyUrl || p.hostedUrl,
        companyName: company,
        jobTitle: p.text,
        location,
        jobType: p.categories?.commitment,
        description: htmlToText(p.descriptionPlain || p.description || ""),
        isRemote: /remote/i.test(`${location} ${p.workplaceType || ""}`),
        scrapedAt: p.createdAt ? new Date(p.createdAt) : new Date(),
      });
    })
    .filter((j) => matchesKeywords(j, keywords));
}

export const leverSource: ScraperSource = {
  id: "lever",
  label: "Lever",
  kind: "ats",
  defaultCompanies: DEFAULT_LEVER_COMPANIES,
  supports: (url) => /lever\.co/i.test(url),
  parseUrl: async (url) => {
    const company = leverCompanyFromUrl(url);
    return company ? fetchBoard(company, []) : [];
  },
  search: (cfg: SourceSearchConfig) =>
    runBoards(cfg.companies?.length ? cfg.companies : DEFAULT_LEVER_COMPANIES, fetchBoard, cfg, "LEVER"),
};
