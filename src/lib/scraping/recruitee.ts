// Recruitee — public offers API at {company}.recruitee.com/api/offers/,
// returning a company's published roles as JSON.

import { ScrapedJob } from "@/types";
import { politeGet } from "./http-client";
import { htmlToText, makeJob, matchesKeywords } from "./util";
import { ScraperSource, SourceSearchConfig, runBoards } from "./source";

export const DEFAULT_RECRUITEE_COMPANIES = [
  "recruitee", "usabilla", "framer", "messagebird", "otrium", "mollie",
];

interface RecruiteeOffer {
  id?: number;
  title: string;
  slug?: string;
  careers_url?: string;
  careers_apply_url?: string;
  location?: string;
  city?: string;
  country_code?: string;
  description?: string;
  requirements?: string;
  department?: string;
  employment_type_code?: string;
  remote?: boolean;
  published_at?: string;
}

export function recruiteeCompanyFromUrl(url: string): string | null {
  const m = url.match(/^https?:\/\/([a-z0-9-]+)\.recruitee\.com/i);
  return m ? m[1].toLowerCase() : null;
}

async function fetchBoard(company: string, keywords: string[]): Promise<ScrapedJob[]> {
  const data = await politeGet<{ offers?: RecruiteeOffer[] }>(`https://${company}.recruitee.com/api/offers/`);
  const offers = data?.offers;
  if (!Array.isArray(offers)) return [];
  return offers
    .map((o) => {
      const location = o.remote ? "Remote" : (o.location || [o.city, o.country_code].filter(Boolean).join(", "));
      const description = [htmlToText(o.description || ""), htmlToText(o.requirements || "")].filter(Boolean).join("\n\n");
      return makeJob({
        platform: "recruitee",
        platformJobId: o.id != null ? String(o.id) : o.slug,
        url: o.careers_url || `https://${company}.recruitee.com/o/${o.slug || ""}`,
        applyUrl: o.careers_apply_url || o.careers_url,
        companyName: company,
        jobTitle: o.title,
        location,
        jobType: o.employment_type_code,
        description,
        isRemote: !!o.remote,
        scrapedAt: o.published_at ? new Date(o.published_at) : new Date(),
      });
    })
    .filter((job) => matchesKeywords(job, keywords));
}

export const recruiteeSource: ScraperSource = {
  id: "recruitee",
  label: "Recruitee",
  kind: "ats",
  defaultCompanies: DEFAULT_RECRUITEE_COMPANIES,
  supports: (url) => /recruitee\.com/i.test(url),
  parseUrl: async (url) => {
    const company = recruiteeCompanyFromUrl(url);
    return company ? fetchBoard(company, []) : [];
  },
  search: (cfg: SourceSearchConfig) =>
    runBoards(cfg.companies?.length ? cfg.companies : DEFAULT_RECRUITEE_COMPANIES, fetchBoard, cfg, "RECRUITEE"),
};
