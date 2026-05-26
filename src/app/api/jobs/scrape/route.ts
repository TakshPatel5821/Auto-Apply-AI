import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { scrapingOrchestrator } from "@/lib/scraping/scraping-orchestrator";
import { SearchConfig } from "@/types";

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
  };

  // Run scraping in background
  scrapingOrchestrator.startScraping(config).then(async () => {
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
