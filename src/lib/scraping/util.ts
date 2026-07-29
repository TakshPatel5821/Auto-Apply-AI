// Shared helpers for the API/feed/JSON-LD scrapers. Keeping HTML→text, keyword
// filtering, and ScrapedJob construction in one place means every new source
// produces a uniform, well-formed job (and we don't re-derive defaults wrongly).

import * as cheerio from "cheerio";
import { ScrapedJob } from "@/types";

/** Decode the handful of HTML entities that show up in job descriptions. */
export function decodeEntities(s: string): string {
  return (s || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, " ");
}

/** Strip HTML to readable plain text (cheerio first, regex fallback). */
export function htmlToText(html: string): string {
  const input = html || "";
  if (!/[<&]/.test(input)) return input.replace(/\s+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
  try {
    const $ = cheerio.load(decodeEntities(input));
    $("script, style").remove();
    return $.text().replace(/\s+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
  } catch {
    return decodeEntities(input).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
}

export function isRemoteText(s: string): boolean {
  return /\bremote\b|work\s*from\s*home|\bwfh\b|anywhere|distributed/i.test(s || "");
}
export function isHybridText(s: string): boolean {
  return /\bhybrid\b/i.test(s || "");
}

/** A job matches if any keyword appears in its title or description. Empty list = match all. */
export function matchesKeywords(job: { jobTitle: string; description: string }, keywords: string[]): boolean {
  const kw = (keywords || []).map((k) => k.toLowerCase().trim()).filter(Boolean);
  if (kw.length === 0) return true;
  const hay = `${job.jobTitle} ${job.description}`.toLowerCase();
  return kw.some((k) => hay.includes(k));
}

/** Best-effort salary range parse from free text (e.g. "$120k – $150k"). */
export function parseSalary(text?: string): { salary?: string; salaryMin?: number; salaryMax?: number } {
  if (!text) return {};
  const cleaned = text.replace(/,/g, "");
  const k = /k/i.test(text) ? 1000 : 1;
  const range = cleaned.match(/\$?\s*(\d+(?:\.\d+)?)\s*k?\s*[-–to]+\s*\$?\s*(\d+(?:\.\d+)?)\s*k?/i);
  if (range) {
    return { salary: text.trim(), salaryMin: Math.round(parseFloat(range[1]) * k), salaryMax: Math.round(parseFloat(range[2]) * k) };
  }
  const single = cleaned.match(/\$\s*(\d+(?:\.\d+)?)\s*k?/i);
  if (single) {
    const v = Math.round(parseFloat(single[1]) * k);
    return { salary: text.trim(), salaryMin: v, salaryMax: v };
  }
  return { salary: text.trim() };
}

/** Construct a fully-formed ScrapedJob from the fields a source actually has. */
export function makeJob(p: {
  platform: string;
  url: string;
  companyName: string;
  jobTitle: string;
  platformJobId?: string;
  applyUrl?: string;
  location?: string;
  salary?: string;
  salaryMin?: number;
  salaryMax?: number;
  jobType?: string;
  isRemote?: boolean;
  isHybrid?: boolean;
  description?: string;
  experienceLevel?: string;
  scrapedAt?: Date;
}): ScrapedJob {
  const location = (p.location || "").trim();
  return {
    platform: p.platform,
    platformJobId: p.platformJobId,
    url: p.url,
    applyUrl: p.applyUrl || p.url,
    isEasyApply: false,
    companyName: p.companyName.trim() || "Unknown",
    jobTitle: p.jobTitle.trim(),
    location,
    salary: p.salary,
    salaryMin: p.salaryMin,
    salaryMax: p.salaryMax,
    jobType: p.jobType,
    isRemote: p.isRemote ?? isRemoteText(`${location} ${p.jobTitle}`),
    isHybrid: p.isHybrid ?? isHybridText(location),
    requiresSponsorship: false,
    experienceLevel: p.experienceLevel,
    description: (p.description || "").trim() || `${p.companyName} — ${p.jobTitle}`,
    requirements: [],
    responsibilities: [],
    niceToHave: [],
    benefits: [],
    scrapedAt: p.scrapedAt || new Date(),
  };
}
