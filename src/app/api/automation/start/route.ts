import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { automationEngine } from "@/lib/automation/automation-engine";
import { prisma } from "@/lib/db/prisma";
import { SearchConfig } from "@/types";

export async function POST(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { mode = "manual", maxApplicationsPerDay = 20, maxJobsToScrape = 20, platforms } = body;

  const activeResume = await prisma.resume.findFirst({
    where: { userId: "local", isActive: true },
    select: { id: true },
  });

  if (!activeResume) {
    return NextResponse.json({ error: "No active resume. Upload a resume first." }, { status: 400 });
  }

  const settings = await prisma.userSettings.findUnique({
    where: { userId: "local" },
  });

  const searchConfig: SearchConfig = {
    keywords: settings?.searchKeywords?.length
      ? settings.searchKeywords
      : (process.env.JOB_SEARCH_KEYWORDS?.split(",").map((k) => k.trim()) || ["Software Engineer"]),
    locations: settings?.searchLocations?.length
      ? settings.searchLocations
      : (process.env.JOB_SEARCH_LOCATIONS?.split(",").map((l) => l.trim()) || ["Remote"]),
    remote: settings?.remoteOnly ?? true,
    hybrid: true,
    onsite: false,
    requireSponsorship: settings?.requireSponsorship ?? false,
    experienceLevels: settings?.experienceLevels?.length
      ? settings.experienceLevels
      : ["entry", "mid"],
    platforms:
      Array.isArray(platforms) && platforms.length > 0
        ? platforms
        : settings?.enabledPlatforms?.length
          ? settings.enabledPlatforms
          : ["linkedin", "indeed"],
    maxJobs: maxJobsToScrape,
  };

  automationEngine.start({
    searchConfig,
    resumeId: activeResume.id,
    mode: mode as "auto" | "manual",
    maxApplicationsPerDay,
    maxJobsToScrape,
  });

  return NextResponse.json({
    success: true,
    message: `Automation started in ${mode} mode`,
  });
}
