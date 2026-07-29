// SmartRecruiters — public Posting API. The listing endpoint returns postings
// without the full description, so we fetch each posting's detail (capped per
// company) to get the job-ad text. Both endpoints are public, no auth.

import { ScrapedJob } from "@/types";
import { politeGet } from "./http-client";
import { htmlToText, makeJob, matchesKeywords } from "./util";
import { ScraperSource, SourceSearchConfig, runBoards } from "./source";

// Curated default boards. Stale/invalid tokens are harmless — the API 404s and
// runBoards() skips them (same contract as Greenhouse).
export const DEFAULT_SMARTRECRUITERS_COMPANIES = [
  "Square", "Visa", "Bosch", "Ubisoft", "Skyscanner",
  "AveryDennison", "ASML", "IKEA", "Marley", "Biocon",
];

const MAX_DETAIL_PER_COMPANY = 25;

interface SrPostingSummary {
  id: string;
  name: string;
  ref?: string;
  releasedDate?: string;
  location?: { city?: string; region?: string; country?: string; remote?: boolean };
}
interface SrPostingDetail {
  jobAd?: { sections?: Record<string, { title?: string; text?: string }> };
  applyUrl?: string;
}

export function smartRecruitersCompanyFromUrl(url: string): string | null {
  const m = url.match(/smartrecruiters\.com\/([A-Za-z0-9][A-Za-z0-9-]*)/);
  return m ? m[1] : null;
}

function locText(loc?: SrPostingSummary["location"]): string {
  if (!loc) return "";
  if (loc.remote) return "Remote";
  return [loc.city, loc.region, loc.country].filter(Boolean).join(", ");
}

async function fetchDetailText(company: string, id: string): Promise<string> {
  const d = await politeGet<SrPostingDetail>(`https://api.smartrecruiters.com/v1/companies/${company}/postings/${id}`);
  const sections = d?.jobAd?.sections;
  if (!sections) return "";
  return Object.values(sections).map((s) => htmlToText(s?.text || "")).filter(Boolean).join("\n\n");
}

async function fetchBoard(company: string, keywords: string[]): Promise<ScrapedJob[]> {
  const data = await politeGet<{ content?: SrPostingSummary[] }>(
    `https://api.smartrecruiters.com/v1/companies/${company}/postings?limit=100`
  );
  const content = data?.content;
  if (!Array.isArray(content)) return [];

  // Pre-filter by title when keywords are given, so we only fetch detail for
  // plausibly-relevant postings (keeps the per-company request count sane).
  const kw = keywords.map((k) => k.toLowerCase()).filter(Boolean);
  const candidates = (kw.length
    ? content.filter((p) => kw.some((k) => p.name.toLowerCase().includes(k)))
    : content
  ).slice(0, MAX_DETAIL_PER_COMPANY);

  const out: ScrapedJob[] = [];
  for (const p of candidates) {
    const description = await fetchDetailText(company, p.id);
    const job = makeJob({
      platform: "smartrecruiters",
      platformJobId: p.id,
      url: p.ref || `https://jobs.smartrecruiters.com/${company}/${p.id}`,
      companyName: company,
      jobTitle: p.name,
      location: locText(p.location),
      description,
      isRemote: !!p.location?.remote,
      scrapedAt: p.releasedDate ? new Date(p.releasedDate) : new Date(),
    });
    // With a description now in hand, apply the full keyword filter.
    if (matchesKeywords(job, keywords)) out.push(job);
  }
  return out;
}

export const smartRecruitersSource: ScraperSource = {
  id: "smartrecruiters",
  label: "SmartRecruiters",
  kind: "ats",
  defaultCompanies: DEFAULT_SMARTRECRUITERS_COMPANIES,
  supports: (url) => /smartrecruiters\.com/i.test(url),
  parseUrl: async (url) => {
    const company = smartRecruitersCompanyFromUrl(url);
    return company ? fetchBoard(company, []) : [];
  },
  search: (cfg: SourceSearchConfig) =>
    runBoards(cfg.companies?.length ? cfg.companies : DEFAULT_SMARTRECRUITERS_COMPANIES, fetchBoard, cfg, "SMARTRECRUITERS"),
};
