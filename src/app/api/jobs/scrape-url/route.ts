import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { scrapingOrchestrator } from "@/lib/scraping/scraping-orchestrator";

// Ingest a pasted job/board URL (or a list). The scraper registry routes each
// URL to the matching source (Lever/Ashby/Greenhouse/…) or the universal
// JSON-LD parser for any other career page. A single URL is awaited for instant
// feedback; a list runs in the background.
export async function POST(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const raw: unknown = Array.isArray(body.urls) ? body.urls : body.url ? [body.url] : [];
  const urls = (Array.isArray(raw) ? raw : [])
    .map((u) => String(u || "").trim())
    .filter((u) => /^https?:\/\//i.test(u));
  const resumeId: string | undefined = body.resumeId;

  if (!urls.length) {
    return NextResponse.json({ error: "Provide a `url` or `urls` array of http(s) links" }, { status: 400 });
  }

  if (urls.length === 1) {
    const result = await scrapingOrchestrator.scrapeUrls(urls, resumeId);
    if (resumeId && result.jobIds.length) {
      scrapingOrchestrator.analyzeAndScoreJobs(resumeId).catch(() => {});
    }
    return NextResponse.json({ success: true, ...result });
  }

  // Multiple URLs → background.
  scrapingOrchestrator.scrapeUrls(urls, resumeId).then((r) => {
    if (resumeId && r.jobIds.length) return scrapingOrchestrator.analyzeAndScoreJobs(resumeId);
  });
  return NextResponse.json({ success: true, message: `Ingesting ${urls.length} URLs in the background` });
}
