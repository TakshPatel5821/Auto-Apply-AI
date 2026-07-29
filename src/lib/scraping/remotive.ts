// Remotive — public JSON API at remotive.com/api/remote-jobs?search=…, with a
// real keyword search server-side. We query per keyword and dedupe by id.

import { ScrapedJob } from "@/types";
import { politeGet } from "./http-client";
import { htmlToText, makeJob, parseSalary } from "./util";
import { ScraperSource, SourceSearchConfig, streamJobs } from "./source";

interface RemotiveJob {
  id: number;
  url: string;
  title: string;
  company_name: string;
  category?: string;
  job_type?: string;
  candidate_required_location?: string;
  publication_date?: string;
  salary?: string;
  description?: string;
}

async function fetchSearch(keyword: string): Promise<RemotiveJob[]> {
  const q = keyword ? `?search=${encodeURIComponent(keyword)}&limit=100` : "?limit=100";
  const data = await politeGet<{ jobs?: RemotiveJob[] }>(`https://remotive.com/api/remote-jobs${q}`);
  return Array.isArray(data?.jobs) ? data!.jobs! : [];
}

async function fetchAll(keywords: string[]): Promise<ScrapedJob[]> {
  const queries = keywords.length ? keywords.slice(0, 4) : [""];
  const seen = new Set<number>();
  const out: ScrapedJob[] = [];
  for (const kw of queries) {
    for (const j of await fetchSearch(kw)) {
      if (seen.has(j.id)) continue;
      seen.add(j.id);
      const sal = parseSalary(j.salary);
      out.push(
        makeJob({
          platform: "remotive",
          platformJobId: String(j.id),
          url: j.url,
          companyName: j.company_name,
          jobTitle: j.title,
          location: j.candidate_required_location || "Remote",
          jobType: j.job_type,
          description: htmlToText(j.description || ""),
          isRemote: true,
          experienceLevel: j.category,
          ...sal,
          scrapedAt: j.publication_date ? new Date(j.publication_date) : new Date(),
        })
      );
    }
  }
  return out;
}

export const remotiveSource: ScraperSource = {
  id: "remotive",
  label: "Remotive",
  kind: "feed",
  supports: (url) => /remotive\.(com|io)/i.test(url),
  parseUrl: async () => fetchAll([]),
  search: async (cfg: SourceSearchConfig) => streamJobs(await fetchAll(cfg.keywords), cfg),
};
