// We Work Remotely — public RSS feeds. The main feed plus a few category feeds
// give good coverage; each <item> title is "Company: Position".

import * as cheerio from "cheerio";
import { ScrapedJob } from "@/types";
import { politeGet } from "./http-client";
import { htmlToText, makeJob, matchesKeywords } from "./util";
import { ScraperSource, SourceSearchConfig, streamJobs } from "./source";

const FEEDS = [
  "https://weworkremotely.com/remote-jobs.rss",
  "https://weworkremotely.com/categories/remote-programming-jobs.rss",
  "https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss",
  "https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss",
  "https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss",
];

function parseFeed(xml: string): ScrapedJob[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const out: ScrapedJob[] = [];
  $("item").each((_, el) => {
    const item = $(el);
    const rawTitle = item.find("title").first().text().trim();
    const link = item.find("link").first().text().trim();
    const region = item.find("region").first().text().trim();
    const description = htmlToText(item.find("description").first().text());
    const pub = item.find("pubDate").first().text().trim();
    if (!rawTitle || !link) return;

    // "Company: Position" — split on the first colon.
    const colon = rawTitle.indexOf(":");
    const companyName = colon > 0 ? rawTitle.slice(0, colon).trim() : "Unknown";
    const jobTitle = colon > 0 ? rawTitle.slice(colon + 1).trim() : rawTitle;
    const idMatch = link.match(/remote-jobs\/([^/?#]+)/i);

    out.push(
      makeJob({
        platform: "weworkremotely",
        platformJobId: idMatch ? idMatch[1] : link,
        url: link,
        companyName,
        jobTitle,
        location: region || "Remote",
        description,
        isRemote: true,
        scrapedAt: pub ? new Date(pub) : new Date(),
      })
    );
  });
  return out;
}

async function fetchAll(keywords: string[]): Promise<ScrapedJob[]> {
  const seen = new Set<string>();
  const out: ScrapedJob[] = [];
  for (const feed of FEEDS) {
    const xml = await politeGet<string>(feed, { responseType: "text" });
    if (!xml || typeof xml !== "string") continue;
    for (const job of parseFeed(xml)) {
      const key = job.url;
      if (seen.has(key)) continue;
      seen.add(key);
      if (matchesKeywords(job, keywords)) out.push(job);
    }
  }
  return out;
}

export const weWorkRemotelySource: ScraperSource = {
  id: "weworkremotely",
  label: "We Work Remotely",
  kind: "feed",
  supports: (url) => /weworkremotely\.com/i.test(url),
  parseUrl: async () => fetchAll([]),
  search: async (cfg: SourceSearchConfig) => streamJobs(await fetchAll(cfg.keywords), cfg),
};
