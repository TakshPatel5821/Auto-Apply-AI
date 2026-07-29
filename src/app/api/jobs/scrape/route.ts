import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { scrapingOrchestrator } from "@/lib/scraping/scraping-orchestrator";
import { listSources } from "@/lib/scraping/registry";
import { SearchConfig } from "@/types";

// Discovery: which scraper sources exist (for the dashboard's platform toggles).
// Browser-based sources (LinkedIn/Indeed) plus every registry source.
export async function GET() {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const browser = [
    { id: "linkedin", label: "LinkedIn", kind: "browser", hasSearch: true },
    { id: "indeed", label: "Indeed", kind: "browser", hasSearch: true },
  ];
  return NextResponse.json({ sources: [...browser, ...listSources()] });
}

export async function POST(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const {
    keywords = process.env.JOB_SEARCH_KEYWORDS?.split(",").map((k) => k.trim()) || [],
    locations = process.env.JOB_SEARCH_LOCATIONS?.split(",").map((l) => l.trim()) || ["Remote"],
    remote = true,
    hybrid = true,
    onsite = false,
    requireSponsorship = false,
    experienceLevels = ["entry", "mid"],
    platforms = ["linkedin", "indeed"],
    maxJobs = 20,
    resumeId,
  } = body;

  const config: SearchConfig = {
    keywords,
    locations,
    remote,
    hybrid,
    onsite,
    requireSponsorship,
    experienceLevels,
    platforms,
    maxJobs,
  };

  // Run scraping in background
  scrapingOrchestrator.startScraping(config, resumeId).then(async () => {
    if (resumeId) {
      await scrapingOrchestrator.analyzeAndScoreJobs(resumeId);
    }
  });

  return NextResponse.json({
    success: true,
    message: "Scraping started in background",
    config,
  });
}
