// Workday — the most common enterprise ATS. Its public career sites are SPAs,
// but each is backed by a JSON "CXS" API that the UI itself calls:
//   • listing : POST https://{host}/wday/cxs/{tenant}/{site}/jobs  (paged search)
//   • detail  : GET  https://{host}/wday/cxs/{tenant}/{site}{externalPath}
// A board lives at https://{tenant}.{wdN}.myworkdayjobs.com/{locale}/{site},
// so — unlike Lever/Ashby where a bare slug suffices — a Workday board is
// identified by the full {host, tenant, site} triple, which we carry as the
// "company" token (a board URL). Submission is handled separately by the
// existing Workday entry in ats-adapters.ts.

import { ScrapedJob } from "@/types";
import { politeGet, politePost } from "./http-client";
import { htmlToText, makeJob, matchesKeywords } from "./util";
import { ScraperSource, SourceSearchConfig } from "./source";
import { Logger } from "@/lib/logging/logger";

// Curated Workday boards as full URLs (host + locale + site differ per tenant).
export const DEFAULT_WORKDAY_BOARDS = [
  "https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite",
  "https://salesforce.wd12.myworkdayjobs.com/en-US/External_Career_Site",
  "https://cisco.wd5.myworkdayjobs.com/en-US/External",
  "https://nike.wd1.myworkdayjobs.com/en-US/nike",
  "https://red.wd5.myworkdayjobs.com/en-US/jobs",
  "https://adobe.wd5.myworkdayjobs.com/en-US/external_experienced",
  "https://workday.wd5.myworkdayjobs.com/en-US/Workday",
  "https://paypal.wd1.myworkdayjobs.com/en-US/jobs",
];

const MAX_PAGES = 5; // Workday returns 20/page; cap so one board can't dominate.
const PAGE_SIZE = 20;

export interface WorkdayBoard {
  /** e.g. nvidia.wd5.myworkdayjobs.com */
  host: string;
  /** Tenant id = first host label, e.g. "nvidia". */
  tenant: string;
  /** Career site id (path segment after the locale), e.g. "NVIDIAExternalCareerSite". */
  site: string;
  /** Locale segment if present, e.g. "en-US" (defaults to en-US). */
  locale: string;
  /** Job posting path when the URL points at a single job, e.g. "/job/.../JR123". */
  externalPath?: string;
}

const LOCALE_RE = /^[a-z]{2}(?:-[A-Za-z]{2})?$/;

/**
 * Parse a Workday board OR individual-job URL into its {host, tenant, site}
 * triple (plus an externalPath for job-detail URLs). Returns null if `url`
 * isn't a recognizable myworkdayjobs.com / Workday-hosted URL.
 */
export function parseWorkdayUrl(url: string): WorkdayBoard | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.host.toLowerCase();
  if (!/(?:^|\.)myworkdayjobs\.com$/.test(host) && !/\.workday\.com$/.test(host)) return null;

  const tenant = host.split(".")[0];
  const segs = u.pathname.split("/").filter(Boolean);
  if (segs.length === 0) return null;

  // Optional leading locale (en-US, fr, …); the site id is the segment after it.
  const hasLocale = LOCALE_RE.test(segs[0]);
  const locale = hasLocale ? segs[0] : "en-US";
  const site = hasLocale ? segs[1] : segs[0];
  if (!site) return null;

  // Everything from a /job/ segment onward is the posting's externalPath.
  const jobIdx = segs.findIndex((s) => s.toLowerCase() === "job");
  const externalPath = jobIdx >= 0 ? "/" + segs.slice(jobIdx).join("/") : undefined;

  return { host, tenant, site, locale, externalPath };
}

interface WorkdayPosting {
  title: string;
  externalPath: string; // e.g. /job/Santa-Clara-CA/Senior-Engineer_JR123
  locationsText?: string;
  postedOn?: string;
  bulletFields?: string[];
  timeType?: string;
}

interface WorkdayListResponse {
  total?: number;
  jobPostings?: WorkdayPosting[];
}

interface WorkdayDetailResponse {
  jobPostingInfo?: {
    jobDescription?: string;
    location?: string;
    timeType?: string;
    jobReqId?: string;
    startDate?: string;
    externalUrl?: string;
  };
}

const cxsBase = (b: WorkdayBoard) => `https://${b.host}/wday/cxs/${b.tenant}/${b.site}`;
const boardUrl = (b: WorkdayBoard) => `https://${b.host}/${b.locale}/${b.site}`;
const jobPageUrl = (b: WorkdayBoard, externalPath: string) => `https://${b.host}/${b.locale}/${b.site}${externalPath}`;

/** Fetch a job's full description via the detail CXS endpoint (best-effort). */
async function fetchDescription(b: WorkdayBoard, externalPath: string): Promise<string> {
  const detail = await politeGet<WorkdayDetailResponse>(`${cxsBase(b)}${externalPath}`);
  return htmlToText(detail?.jobPostingInfo?.jobDescription || "");
}

/** Search a single Workday board, paging through the CXS jobs endpoint. */
async function fetchBoard(boardToken: string, keywords: string[], maxJobs?: number): Promise<ScrapedJob[]> {
  const board = parseWorkdayUrl(boardToken);
  if (!board) {
    await Logger.warn("WORKDAY", `unrecognized board URL: ${boardToken.slice(0, 80)}`);
    return [];
  }
  // Workday filters server-side via searchText — join keywords into one query.
  const searchText = (keywords || []).join(" ").trim();
  const out: ScrapedJob[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await politePost<WorkdayListResponse>(`${cxsBase(board)}/jobs`, {
      appliedFacets: {},
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      searchText,
    });
    const postings = data?.jobPostings;
    if (!Array.isArray(postings) || postings.length === 0) break;

    for (const p of postings) {
      const location = p.locationsText || "";
      const url = jobPageUrl(board, p.externalPath);
      out.push(
        makeJob({
          platform: "workday",
          platformJobId: p.externalPath,
          url,
          applyUrl: url,
          companyName: board.tenant,
          jobTitle: p.title,
          location,
          jobType: p.timeType,
          // Listing has no description; bulletFields (req id / posted) are a stub
          // the detail fetch below replaces. Keep it cheap unless the job matches.
          description: (p.bulletFields || []).join(" • "),
          scrapedAt: p.postedOn && !/^posted/i.test(p.postedOn) ? new Date(p.postedOn) : new Date(),
        })
      );
      if (maxJobs && out.length >= maxJobs) break;
    }
    if ((maxJobs && out.length >= maxJobs) || postings.length < PAGE_SIZE) break;
  }

  // Title-level keyword filter first (cheap), then enrich the survivors with the
  // full description via the detail endpoint so downstream matching/tailoring has
  // real text to work with.
  const titleMatched = out.filter((j) => matchesKeywords({ jobTitle: j.jobTitle, description: "" }, keywords));
  const enriched = await Promise.all(
    titleMatched.map(async (j) => {
      const desc = await fetchDescription(board, j.platformJobId!).catch(() => "");
      return desc ? { ...j, description: desc } : j;
    })
  );
  return enriched;
}

export const workdaySource: ScraperSource = {
  id: "workday",
  label: "Workday",
  kind: "ats",
  defaultCompanies: DEFAULT_WORKDAY_BOARDS,
  supports: (url) => /myworkdayjobs\.com|\.workday\.com/i.test(url),
  parseUrl: async (url) => {
    const board = parseWorkdayUrl(url);
    if (!board) return [];
    // Single job posting → fetch just that one; otherwise treat as a board.
    if (board.externalPath) {
      const desc = await fetchDescription(board, board.externalPath).catch(() => "");
      const detail = await politeGet<WorkdayDetailResponse>(`${cxsBase(board)}${board.externalPath}`).catch(() => null);
      const url2 = jobPageUrl(board, board.externalPath);
      return [
        makeJob({
          platform: "workday",
          platformJobId: board.externalPath,
          url: url2,
          applyUrl: url2,
          companyName: board.tenant,
          jobTitle: detail?.jobPostingInfo?.jobReqId ? `${board.tenant} role ${detail.jobPostingInfo.jobReqId}` : board.tenant,
          location: detail?.jobPostingInfo?.location || "",
          jobType: detail?.jobPostingInfo?.timeType,
          description: desc,
        }),
      ];
    }
    return fetchBoard(boardUrl(board), []);
  },
  search: async (cfg: SourceSearchConfig) => {
    const boards = cfg.companies?.length ? cfg.companies : DEFAULT_WORKDAY_BOARDS;
    const out: ScrapedJob[] = [];
    for (const token of boards) {
      if (cfg.maxJobs && out.length >= cfg.maxJobs) break;
      const remaining = cfg.maxJobs ? cfg.maxJobs - out.length : undefined;
      const jobs = await fetchBoard(token, cfg.keywords, remaining).catch(async (e) => {
        await Logger.warn("WORKDAY", `skip ${token.slice(0, 60)}: ${String(e).slice(0, 100)}`);
        return [] as ScrapedJob[];
      });
      for (const j of jobs) {
        out.push(j);
        if (cfg.onJob) await cfg.onJob(j).catch(() => {});
        if (cfg.maxJobs && out.length >= cfg.maxJobs) break;
      }
    }
    return out;
  },
};
