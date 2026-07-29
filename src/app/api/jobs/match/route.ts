import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { scrapingOrchestrator } from "@/lib/scraping/scraping-orchestrator";

export async function POST(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { resumeId } = await req.json();

  if (!resumeId) {
    return NextResponse.json({ error: "resumeId required" }, { status: 400 });
  }

  scrapingOrchestrator.analyzeAndScoreJobs(resumeId);

  return NextResponse.json({
    success: true,
    message: "Job matching started in background",
  });
}
