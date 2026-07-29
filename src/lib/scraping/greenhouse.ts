import axios from "axios";
import * as cheerio from "cheerio";
import { ScrapedJob } from "@/types";
import { Logger } from "@/lib/logging/logger";

// Greenhouse has no global keyword search — jobs live on per-company boards. The
// public JSON API (boards-api.greenhouse.io) is far more reliable than scraping
// board HTML and returns full descriptions, so we use it. Each "company" is a
// Greenhouse board token (usually the lowercased company name, e.g. "stripe").

// Curated default boards used when the user hasn't set their own companies.
// Stale/invalid tokens are harmless — the API 404s and we skip them.
export const DEFAULT_GREENHOUSE_COMPANIES = [
  "stripe", "databricks", "coinbase", "robinhood", "doordash",
  "gitlab", "figma", "dropbox", "instacart", "reddit",
  "discord", "plaid", "brex", "ramp", "airbnb",
];

interface GhJob {
  id: number;
  title: string;
  absolute_url: string;
  updated_at?: string;
  location?: { name?: string };
  content?: string; // HTML-entity-encoded description (with ?content=true)
}

function decodeEntities(s: string): string {
  return (s || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}

function htmlToText(html: string): string {
  try {
    const $ = cheerio.load(decodeEntities(html || ""));
    return $.text().replace(/\s+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
  } catch {
    return decodeEntities(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
}

// ── US / remote location filter ───────────────────────────────────────────────
// The Greenhouse API returns a company's jobs WORLDWIDE. When the user's
// configured locations are US-centric, keep only US (or remote) postings.
const US_STATE_ABBR = new Set([
  "al","ak","az","ar","ca","co","ct","de","fl","ga","hi","id","il","in","ia","ks",
  "ky","la","me","md","ma","mi","mn","ms","mo","mt","ne","nv","nh","nj","nm","ny",
  "nc","nd","oh","ok","or","pa","ri","sc","sd","tn","tx","ut","vt","va","wa","wv",
  "wi","wy","dc",
]);
const US_STATE_NAMES = [
  "alabama","alaska","arizona","arkansas","california","colorado","connecticut",
  "delaware","florida","georgia","hawaii","idaho","illinois","indiana","iowa",
  "kansas","kentucky","louisiana","maine","maryland","massachusetts","michigan",
  "minnesota","mississippi","missouri","montana","nebraska","nevada","hampshire",
  "jersey","mexico","york","carolina","dakota","ohio","oklahoma","oregon",
  "pennsylvania","rhode island","tennessee","texas","utah","vermont","virginia",
  "washington","wisconsin","wyoming",
];
// Common non-US markers seen in Greenhouse locations.
const NON_US = [
  "india","bengaluru","bangalore","ireland","dublin","united kingdom","london",
  "australia","sydney","melbourne","canada","toronto","vancouver","singapore",
  "germany","berlin","france","paris","spain","netherlands","amsterdam","japan",
  "tokyo","brazil","mexico city","poland","romania","emea","apac","latam","uk",
];

// Major US city aliases that won't trip the state-name/abbr checks.
const US_CITIES = [
  "new york", "nyc", "san francisco", "sf bay", " sf,", "los angeles", "chicago",
  "boston", "austin", "denver", "atlanta", "miami", "dallas", "houston",
  "philadelphia", "phoenix", "san diego", "san jose", "portland", "nashville",
  "remote in us", "remote - us", "us remote", "remote (us",
];

function isUsOrRemote(location: string): boolean {
  const l = (location || "").toLowerCase();
  if (!l) return false;

  // Foreign markers take priority — "IN-Bengaluru", "Bengaluru, India", etc.
  // (handles the false positive where "in" looks like the Indiana abbreviation).
  if (NON_US.some((c) => l.includes(c))) {
    // …unless it's an explicitly US-remote multi-region posting.
    if (/remote in us|us remote|united states/.test(l)) return true;
    return false;
  }

  // Explicit US signals.
  if (/\bunited states\b|\bu\.?s\.?a\.?\b|\bu\.?s\.?\b|\bamerica\b|remote.*us|us.*remote/.test(l)) return true;
  if (US_CITIES.some((c) => l.includes(c))) return true;
  if (US_STATE_NAMES.some((s) => l.includes(s))) return true;
  // 2-letter state abbreviations as whole tokens (e.g. "Seattle, WA").
  if (l.split(/[^a-z]+/).some((tok) => US_STATE_ABBR.has(tok))) return true;

  // Bare "remote" with no foreign country → treat as remote-eligible.
  if (/\bremote\b/.test(l)) return true;

  return false;
}

// Does the user's configured locations indicate they want US jobs?
function wantsUsOnly(locations: string[]): boolean {
  const blob = (locations || []).join(" ").toLowerCase();
  if (!blob.trim()) return false;
  return (
    /\busa?\b|united states|america|remote/.test(blob) ||
    US_STATE_NAMES.some((s) => blob.includes(s)) ||
    blob.split(/[^a-z]+/).some((tok) => US_STATE_ABBR.has(tok))
  );
}

export class GreenhouseScraper {
  // `locations` lets us drop non-US postings when the user's search is US-based
  // (the Greenhouse API returns a company's jobs worldwide).
  // `onJob` streams each matching job as it's found — same live, per-job logging
  // as the LinkedIn scraper — instead of returning one silent batch.
  async scrapeJobs(
    companies: string[],
    keywords: string[],
    locations: string[] = [],
    onJob?: (job: ScrapedJob) => Promise<void>
  ): Promise<ScrapedJob[]> {
    const jobs: ScrapedJob[] = [];
    const usOnly = wantsUsOnly(locations);

    await Logger.info("GREENHOUSE", `Launching Greenhouse scrape — ${companies.length} board(s)`);

    for (const company of companies) {
      try {
        await Logger.info("GREENHOUSE", `── Board: ${company} ──`);
        const scraped = await this.scrapeCompany(company, keywords, usOnly);
        await Logger.info("GREENHOUSE", `${company}: ${scraped.length} matching job(s) on board`);

        // Stream each job with per-job progress, like LinkedIn's [i/N] lines.
        for (let i = 0; i < scraped.length; i++) {
          const job = scraped[i];
          await Logger.success(
            "GREENHOUSE",
            `[${i + 1}/${scraped.length}] Scraped: "${job.jobTitle}" @ ${company} [${job.location || "n/a"}] — desc: ${job.description.length} chars`
          );
          jobs.push(job);
          if (onJob) {
            try {
              await onJob(job);
            } catch (e) {
              await Logger.warn("GREENHOUSE", `onJob callback failed: ${e}`);
            }
          }
        }
        await new Promise((r) => setTimeout(r, 600));
      } catch {
        // 404 = not a Greenhouse board (or wrong slug) — expected, non-fatal.
        await Logger.warn("GREENHOUSE", `Skipped ${company} (no public board / bad slug)`);
      }
    }

    await Logger.success("GREENHOUSE", `Greenhouse scrape done — ${jobs.length} job(s) collected`);
    return jobs;
  }

  private async scrapeCompany(company: string, keywords: string[], usOnly: boolean): Promise<ScrapedJob[]> {
    const token = company.toLowerCase().trim().replace(/\s+/g, "");
    const url = `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`;

    const res = await axios.get<{ jobs: GhJob[] }>(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; JobAgent/1.0)" },
      timeout: 15000,
    });

    const all = res.data?.jobs || [];
    const kw = keywords.map((k) => k.toLowerCase()).filter(Boolean);

    return all
      .filter((j) => {
        if (kw.length === 0) return true;
        const hay = `${j.title} ${j.content || ""}`.toLowerCase();
        return kw.some((k) => hay.includes(k));
      })
      // Drop non-US/remote jobs when the user's search is US-centric.
      .filter((j) => !usOnly || isUsOrRemote(j.location?.name || ""))
      .map((j) => {
        const location = j.location?.name || "";
        const description = htmlToText(j.content || "") || `${company} — ${j.title}`;
        return {
          platform: "greenhouse",
          platformJobId: String(j.id),
          url: j.absolute_url,
          applyUrl: j.absolute_url,
          isEasyApply: false,
          companyName: company,
          jobTitle: j.title,
          location,
          isRemote: /remote/i.test(location),
          isHybrid: /hybrid/i.test(location),
          requiresSponsorship: false,
          description,
          requirements: [],
          responsibilities: [],
          niceToHave: [],
          benefits: [],
          scrapedAt: new Date(),
        } as ScrapedJob;
      });
  }
}
