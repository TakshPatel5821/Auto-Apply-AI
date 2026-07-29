import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { scrapingOrchestrator } from "@/lib/scraping/scraping-orchestrator";
import { filterSafeUrls } from "@/lib/scraping/url-guard";

// Cap per request so one call can't fan out into thousands of outbound fetches.
const MAX_URLS_PER_REQUEST = 50;

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
  if (urls.length > MAX_URLS_PER_REQUEST) {
    return NextResponse.json(
      { error: `Too many URLs — send at most ${MAX_URLS_PER_REQUEST} per request.` },
      { status: 400 }
    );
  }

  // SSRF guard: never let a pasted URL point the server at loopback, private
  // networks, or cloud metadata endpoints.
  const { safe, rejected } = await filterSafeUrls(urls);
  if (!safe.length) {
    return NextResponse.json(
      { error: "No fetchable URLs — all were rejected.", rejected },
      { status: 400 }
    );
  }

  if (safe.length === 1) {
    const result = await scrapingOrchestrator.scrapeUrls(safe, resumeId);
    if (resumeId && result.jobIds.length) {
      scrapingOrchestrator.analyzeAndScoreJobs(resumeId).catch(() => {});
    }
    return NextResponse.json({ success: true, rejected, ...result });
  }

  // Multiple URLs → background. Swallow failures here: the orchestrator logs
  // them, and an unhandled rejection would take the server process down.
  scrapingOrchestrator
    .scrapeUrls(safe, resumeId)
    .then((r) => {
      if (resumeId && r.jobIds.length) return scrapingOrchestrator.analyzeAndScoreJobs(resumeId);
    })
    .catch(() => {});
  return NextResponse.json({
    success: true,
    rejected,
    message: `Ingesting ${safe.length} URLs in the background`,
  });
}
