// Workable — public widget API at
// apply.workable.com/api/v1/widget/accounts/{company}?details=true, returning a
// company's published jobs as JSON.

import { ScrapedJob } from "@/types";
import { politeGet } from "./http-client";
import { htmlToText, makeJob, matchesKeywords } from "./util";
import { ScraperSource, SourceSearchConfig, runBoards } from "./source";

export const DEFAULT_WORKABLE_COMPANIES = [
  "workable", "remote", "deel", "veriff", "pipedrive", "bolt",
  "personio", "gympass", "swissborg", "blockchain",
];

interface WorkableJob {
  id?: string;
  title: string;
  shortcode?: string;
  url?: string;
  application_url?: string;
  country?: string;
  city?: string;
  state?: string;
  region?: string;
  telecommuting?: boolean;
  department?: string;
  type?: string;
  description?: string;
  created_at?: string;
}

export function workableCompanyFromUrl(url: string): string | null {
  // apply.workable.com/{company}/...  OR  {company}.workable.com
  const sub = url.match(/^https?:\/\/([a-z0-9-]+)\.workable\.com/i);
  if (sub && sub[1] !== "apply" && sub[1] !== "www") return sub[1].toLowerCase();
  const path = url.match(/apply\.workable\.com\/([a-z0-9-]+)/i);
  return path ? path[1].toLowerCase() : null;
}

async function fetchBoard(company: string, keywords: string[]): Promise<ScrapedJob[]> {
  const data = await politeGet<{ jobs?: WorkableJob[] }>(
    `https://apply.workable.com/api/v1/widget/accounts/${company}?details=true`
  );
  const jobs = data?.jobs;
  if (!Array.isArray(jobs)) return [];
  return jobs
    .map((j) => {
      const location = j.telecommuting ? "Remote" : [j.city, j.state, j.country].filter(Boolean).join(", ");
      const url = j.url || (j.shortcode ? `https://apply.workable.com/${company}/j/${j.shortcode}/` : `https://apply.workable.com/${company}/`);
      return makeJob({
        platform: "workable",
        platformJobId: j.shortcode || j.id,
        url,
        applyUrl: j.application_url || url,
        companyName: company,
        jobTitle: j.title,
        location,
        jobType: j.type,
        description: htmlToText(j.description || ""),
        isRemote: !!j.telecommuting,
        scrapedAt: j.created_at ? new Date(j.created_at) : new Date(),
      });
    })
    .filter((job) => matchesKeywords(job, keywords));
}

export const workableSource: ScraperSource = {
  id: "workable",
  label: "Workable",
  kind: "ats",
  defaultCompanies: DEFAULT_WORKABLE_COMPANIES,
  supports: (url) => /workable\.com/i.test(url),
  parseUrl: async (url) => {
    const company = workableCompanyFromUrl(url);
    return company ? fetchBoard(company, []) : [];
  },
  search: (cfg: SourceSearchConfig) =>
    runBoards(cfg.companies?.length ? cfg.companies : DEFAULT_WORKABLE_COMPANIES, fetchBoard, cfg, "WORKABLE"),
};
