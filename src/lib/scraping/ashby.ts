// Ashby — public job-board posting API at
// api.ashbyhq.com/posting-api/job-board/{company}?includeCompensation=true,
// returning all live postings as JSON.

import { ScrapedJob } from "@/types";
import { politeGet } from "./http-client";
import { htmlToText, makeJob, matchesKeywords, parseSalary } from "./util";
import { ScraperSource, SourceSearchConfig, runBoards } from "./source";

export const DEFAULT_ASHBY_COMPANIES = [
  "ramp", "openai", "linear", "runway", "vercel", "replicate",
  "hex", "modal", "clipboardhealth", "posthog", "supabase",
];

interface AshbyJob {
  id: string;
  title: string;
  location?: string;
  isRemote?: boolean;
  employmentType?: string;
  descriptionHtml?: string;
  descriptionPlain?: string;
  jobUrl?: string;
  applyUrl?: string;
  compensation?: { compensationTierSummary?: string };
  publishedAt?: string;
}

/** Ashby board token from jobs.ashbyhq.com/{company} or the API URL. */
export function ashbyCompanyFromUrl(url: string): string | null {
  const m = url.match(/ashbyhq\.com\/(?:posting-api\/job-board\/)?([a-z0-9][a-z0-9-]*)/i);
  return m ? m[1].toLowerCase() : null;
}

async function fetchBoard(company: string, keywords: string[]): Promise<ScrapedJob[]> {
  const data = await politeGet<{ jobs?: AshbyJob[] }>(
    `https://api.ashbyhq.com/posting-api/job-board/${company}?includeCompensation=true`
  );
  const jobs = data?.jobs;
  if (!Array.isArray(jobs)) return [];
  return jobs
    .map((j) => {
      const sal = parseSalary(j.compensation?.compensationTierSummary);
      return makeJob({
        platform: "ashby",
        platformJobId: j.id,
        url: j.jobUrl || j.applyUrl || `https://jobs.ashbyhq.com/${company}`,
        applyUrl: j.applyUrl || j.jobUrl,
        companyName: company,
        jobTitle: j.title,
        location: j.location || "",
        jobType: j.employmentType,
        description: htmlToText(j.descriptionHtml || j.descriptionPlain || ""),
        isRemote: j.isRemote ?? /remote/i.test(j.location || ""),
        ...sal,
        scrapedAt: j.publishedAt ? new Date(j.publishedAt) : new Date(),
      });
    })
    .filter((job) => matchesKeywords(job, keywords));
}

export const ashbySource: ScraperSource = {
  id: "ashby",
  label: "Ashby",
  kind: "ats",
  defaultCompanies: DEFAULT_ASHBY_COMPANIES,
  supports: (url) => /ashbyhq\.com/i.test(url),
  parseUrl: async (url) => {
    const company = ashbyCompanyFromUrl(url);
    return company ? fetchBoard(company, []) : [];
  },
  search: (cfg: SourceSearchConfig) =>
    runBoards(cfg.companies?.length ? cfg.companies : DEFAULT_ASHBY_COMPANIES, fetchBoard, cfg, "ASHBY"),
};
