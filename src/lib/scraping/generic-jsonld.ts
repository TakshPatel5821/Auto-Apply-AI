// The universal scraper: given ANY URL, extract a job using schema.org
// structured data. Most ATS career pages and aggregators embed a
// `JobPosting` as JSON-LD (and some as microdata) — parsing that is far more
// reliable than per-site HTML selectors and instantly covers thousands of
// sites. Falls back to a conservative heuristic only when the page clearly is a
// job posting. Honors robots.txt (this is arbitrary third-party fetching).

import * as cheerio from "cheerio";
import { ScrapedJob } from "@/types";
import { politeGet } from "./http-client";
import { htmlToText, makeJob } from "./util";
import { ScraperSource } from "./source";

type Json = unknown;

const asObj = (v: Json): Record<string, Json> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Json>) : null;
const asArr = (v: Json): Json[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
const str = (v: Json): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const num = (v: Json): number | undefined => {
  const n = typeof v === "number" ? v : parseFloat(str(v).replace(/[, ]/g, ""));
  return Number.isFinite(n) ? n : undefined;
};
const clean = (s: string) => (s || "").replace(/\s+/g, " ").trim();

const ROLE_RX = /(engineer|developer|programmer|designer|manager|scientist|analyst|architect|devops|\bsre\b|lead|director|product|data|\bml\b|\bai\b|full[-\s]?stack|front[-\s]?end|back[-\s]?end|intern|specialist|consultant|administrator|recruiter)/i;

/** Brand name from a hostname, e.g. "boards.greenhouse.io" → "Greenhouse". */
function hostBrand(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const parts = host.split(".");
    const core = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    return core ? core.charAt(0).toUpperCase() + core.slice(1) : host;
  } catch {
    return "Unknown";
  }
}

function hasType(o: Record<string, Json>, t: string): boolean {
  return asArr(o["@type"]).some((x) => typeof x === "string" && x.toLowerCase() === t.toLowerCase());
}

/** Recursively gather every JobPosting object from a parsed JSON-LD value. */
function collectJobPostings(node: Json, acc: Record<string, Json>[]): void {
  if (Array.isArray(node)) {
    for (const n of node) collectJobPostings(n, acc);
    return;
  }
  const o = asObj(node);
  if (!o) return;
  if (hasType(o, "JobPosting")) acc.push(o);
  if (o["@graph"]) collectJobPostings(o["@graph"], acc);
}

function mapJobPosting(o: Record<string, Json>, sourceUrl: string): ScrapedJob | null {
  const title = clean(str(o.title) || str(o.name));
  if (!title) return null;

  const org = asObj(o.hiringOrganization);
  const company = clean(org ? str(org.name) : str(o.hiringOrganization)) || hostBrand(sourceUrl);

  const locParts: string[] = [];
  for (const jl of asArr(o.jobLocation)) {
    const jlo = asObj(jl);
    const addr = jlo ? asObj(jlo.address) : null;
    if (addr) {
      locParts.push([str(addr.addressLocality), str(addr.addressRegion), str(addr.addressCountry)].filter(Boolean).join(", "));
    } else if (jlo) {
      locParts.push(str(jlo.name));
    }
  }
  const location = locParts.filter(Boolean).join(" / ");
  const remote = /telecommute/i.test(str(o.jobLocationType)) || (!location && /remote/i.test(title));

  let salary: string | undefined;
  let salaryMin: number | undefined;
  let salaryMax: number | undefined;
  const bs = asObj(o.baseSalary);
  if (bs) {
    const val = asObj(bs.value);
    if (val) {
      salaryMin = num(val.minValue) ?? num(val.value);
      salaryMax = num(val.maxValue) ?? num(val.value);
    }
    const amount = val ? str(val.minValue) || str(val.value) : "";
    salary = [str(bs.currency), amount].filter(Boolean).join(" ") || undefined;
  }

  const identifier = (() => {
    const io = asObj(o.identifier);
    return clean(io ? str(io.value) : str(o.identifier));
  })();

  return makeJob({
    platform: "jsonld",
    platformJobId: identifier || undefined,
    url: clean(str(o.url)) || sourceUrl,
    companyName: company,
    jobTitle: title,
    location,
    jobType: clean(asArr(o.employmentType).map(str).filter(Boolean).join(", ")),
    description: htmlToText(str(o.description)),
    isRemote: remote,
    salary,
    salaryMin,
    salaryMax,
    scrapedAt: o.datePosted ? new Date(str(o.datePosted)) : new Date(),
  });
}

/** Parse the schema.org JobPosting microdata pattern (itemtype/itemprop). */
function fromMicrodata($: cheerio.CheerioAPI, sourceUrl: string): ScrapedJob | null {
  const root = $('[itemtype*="JobPosting" i]').first();
  if (!root.length) return null;
  const prop = (name: string): string => {
    const el = root.find(`[itemprop="${name}"]`).first();
    if (!el.length) return "";
    return clean(el.attr("content") || el.text());
  };
  const title = prop("title");
  if (!title) return null;
  const company = prop("hiringOrganization") || root.find('[itemprop="hiringOrganization"] [itemprop="name"]').first().text().trim() || hostBrand(sourceUrl);
  return makeJob({
    platform: "microdata",
    url: sourceUrl,
    companyName: clean(company) || hostBrand(sourceUrl),
    jobTitle: title,
    location: prop("jobLocation") || prop("addressLocality"),
    description: htmlToText($('[itemprop="description"]').first().html() || prop("description")),
    jobType: prop("employmentType"),
  });
}

/** Last resort: only treat the page as a job if it clearly is one. */
function heuristic($: cheerio.CheerioAPI, sourceUrl: string): ScrapedJob | null {
  const title = clean(
    $('meta[property="og:title"]').attr("content") || $("h1").first().text() || $("title").text()
  ).slice(0, 150);
  const hasApply = $('a, button').toArray().some((el) => /\bapply\b/i.test($(el).text()));
  const urlIsJobby = /\/(jobs?|careers?|positions?|openings?|vacanc)/i.test(sourceUrl);
  const looksJob = !!title && (ROLE_RX.test(title) || urlIsJobby || hasApply);
  if (!looksJob) return null;

  const company = clean($('meta[property="og:site_name"]').attr("content") || "") || hostBrand(sourceUrl);
  let desc = clean($("article").first().text()) || clean($("main").first().text());
  if (desc.length < 120) {
    // Largest text block on the page.
    let best = "";
    $("section, div").each((_, el) => {
      const t = clean($(el).text());
      if (t.length > best.length) best = t;
    });
    desc = best;
  }
  if (desc.length < 80) return null; // not enough substance to be a real posting
  return makeJob({
    platform: "generic",
    url: sourceUrl,
    companyName: company,
    jobTitle: title,
    description: desc.slice(0, 8000),
  });
}

/** Extract job(s) from a page's HTML. Returns [] if none found. */
export function extractJobsFromHtml(html: string, sourceUrl: string): ScrapedJob[] {
  const $ = cheerio.load(html);

  // 1) JSON-LD (most reliable).
  const postings: Record<string, Json>[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text() || $(el).text();
    if (!raw.trim()) return;
    try {
      collectJobPostings(JSON.parse(raw), postings);
    } catch {
      // Some sites concatenate multiple JSON objects or have trailing commas;
      // try to recover the first {...} block.
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        try { collectJobPostings(JSON.parse(m[0]), postings); } catch { /* give up on this block */ }
      }
    }
  });
  const jsonLdJobs = postings.map((p) => mapJobPosting(p, sourceUrl)).filter((j): j is ScrapedJob => !!j);
  if (jsonLdJobs.length) return jsonLdJobs;

  // 2) Microdata.
  const micro = fromMicrodata($, sourceUrl);
  if (micro) return [micro];

  // 3) Heuristic (conservative).
  const h = heuristic($, sourceUrl);
  return h ? [h] : [];
}

/** Fetch a URL politely (robots-respecting) and extract any job(s) on it. */
export async function scrapeJobUrl(url: string): Promise<ScrapedJob[]> {
  const html = await politeGet<string>(url, { responseType: "text", respectRobots: true, timeout: 20000 });
  if (!html || typeof html !== "string") return [];
  try {
    return extractJobsFromHtml(html, url);
  } catch {
    return [];
  }
}

// Generic is the universal fallback — it claims any http(s) URL, so the registry
// only reaches it AFTER the specific sources decline. It has no keyword search
// (it works per-URL), only parseUrl.
export const genericSource: ScraperSource = {
  id: "generic",
  label: "Generic (JSON-LD / schema.org)",
  kind: "generic",
  supports: (url) => /^https?:\/\//i.test(url),
  parseUrl: (url) => scrapeJobUrl(url),
};
