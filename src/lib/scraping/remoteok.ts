// RemoteOK — public JSON feed at remoteok.com/api. The first array element is
// legal/metadata and is skipped. All jobs are remote.

import { ScrapedJob } from "@/types";
import { politeGet } from "./http-client";
import { htmlToText, makeJob, matchesKeywords } from "./util";
import { ScraperSource, SourceSearchConfig, streamJobs } from "./source";

interface RemoteOkJob {
  id?: string | number;
  slug?: string;
  company?: string;
  position?: string;
  location?: string;
  tags?: string[];
  description?: string;
  url?: string;
  apply_url?: string;
  date?: string;
  salary_min?: number;
  salary_max?: number;
  legal?: string; // present on the metadata element
}

async function fetchAll(keywords: string[]): Promise<ScrapedJob[]> {
  const data = await politeGet<RemoteOkJob[]>("https://remoteok.com/api", {
    headers: { Accept: "application/json" },
  });
  if (!Array.isArray(data)) return [];
  return data
    .filter((j) => !j.legal && j.position) // drop the leading metadata element
    .map((j) =>
      makeJob({
        platform: "remoteok",
        platformJobId: j.id != null ? String(j.id) : j.slug,
        url: j.url || `https://remoteok.com/remote-jobs/${j.slug || ""}`,
        applyUrl: j.apply_url || j.url,
        companyName: j.company || "Unknown",
        jobTitle: j.position || "",
        location: j.location || "Remote",
        description: `${htmlToText(j.description || "")}${j.tags?.length ? `\n\nTags: ${j.tags.join(", ")}` : ""}`,
        isRemote: true,
        salaryMin: j.salary_min,
        salaryMax: j.salary_max,
        scrapedAt: j.date ? new Date(j.date) : new Date(),
      })
    )
    .filter((job) => matchesKeywords(job, keywords));
}

export const remoteOkSource: ScraperSource = {
  id: "remoteok",
  label: "RemoteOK",
  kind: "feed",
  supports: (url) => /remoteok\.(com|io)/i.test(url),
  parseUrl: async () => fetchAll([]),
  search: async (cfg: SourceSearchConfig) => streamJobs(await fetchAll(cfg.keywords), cfg),
};
