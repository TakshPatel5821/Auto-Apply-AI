// Shared agent core — the single set of operations behind every "agent surface"
// (the headless CLI and the MCP server). Both call THESE functions so behavior
// can't drift between them. Each function drives the same engine the web app
// uses (orchestrator, tailoring, ApplyEngine) against the shared database.

import { prisma } from "@/lib/db/prisma";
import { scrapingOrchestrator } from "@/lib/scraping/scraping-orchestrator";
import { SearchConfig } from "@/types";

export interface DiscoverOverrides {
  keywords?: string[];
  locations?: string[];
  platforms?: string[];
  maxJobs?: number;
}

export interface DiscoverResult {
  newCount: number;
  fitCount: number;
  notFitCount: number;
  fitJobIds: string[];
}

export async function getActiveResumeId(): Promise<string | null> {
  const r = await prisma.resume.findFirst({ where: { userId: "local", isActive: true }, select: { id: true } });
  return r?.id ?? null;
}

/** Build a SearchConfig from saved settings, with optional per-call overrides. */
export async function buildSearchConfig(overrides: DiscoverOverrides = {}): Promise<SearchConfig> {
  const settings = await prisma.userSettings.findUnique({ where: { userId: "local" } });
  return {
    keywords: overrides.keywords?.length
      ? overrides.keywords
      : settings?.searchKeywords?.length
        ? settings.searchKeywords
        : process.env.JOB_SEARCH_KEYWORDS?.split(",").map((k) => k.trim()) || ["Software Engineer"],
    locations: overrides.locations?.length
      ? overrides.locations
      : settings?.searchLocations?.length
        ? settings.searchLocations
        : process.env.JOB_SEARCH_LOCATIONS?.split(",").map((l) => l.trim()) || ["Remote"],
    remote: settings?.remoteOnly ?? true,
    hybrid: true,
    onsite: false,
    requireSponsorship: settings?.requireSponsorship ?? false,
    experienceLevels: settings?.experienceLevels?.length ? settings.experienceLevels : ["entry", "mid"],
    platforms: overrides.platforms?.length
      ? overrides.platforms
      : settings?.enabledPlatforms?.length
        ? settings.enabledPlatforms
        : ["greenhouse", "lever", "ashby", "workday"],
    maxJobs: overrides.maxJobs ?? 30,
  };
}

/** Run one discovery pass. Returns counts + the ids of newly-found fit jobs. */
export async function discover(overrides: DiscoverOverrides = {}): Promise<DiscoverResult> {
  const resumeId = (await getActiveResumeId()) ?? undefined;
  const config = await buildSearchConfig(overrides);
  const fitJobIds: string[] = [];
  const res = await scrapingOrchestrator.startScraping(config, resumeId, (jobId) => fitJobIds.push(jobId));
  return { ...res, fitJobIds };
}

export interface JobRow {
  id: string;
  jobTitle: string;
  companyName: string;
  platform: string;
  matchScore: number;
  status: string;
  location: string | null;
  url: string;
}

export async function listJobs(opts: { fit?: boolean; limit?: number } = {}): Promise<JobRow[]> {
  const jobs = await prisma.job.findMany({
    where: { isSpam: false, isBlacklisted: false, ...(opts.fit ? { matchScore: { lte: 6 } } : {}) },
    orderBy: [{ matchScore: "asc" }, { scrapedAt: "desc" }],
    take: opts.limit ?? 25,
    select: {
      id: true, jobTitle: true, companyName: true, platform: true,
      matchScore: true, status: true, location: true, url: true, applyUrl: true,
    },
  });
  return jobs.map((j) => ({
    id: j.id,
    jobTitle: j.jobTitle,
    companyName: j.companyName,
    platform: j.platform,
    matchScore: j.matchScore ?? 10,
    status: j.status,
    location: j.location,
    url: j.applyUrl || j.url,
  }));
}

export interface ApplyResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  applicationId?: string;
  message: string;
}

/** Tailor a résumé/cover letter for one job and submit it via the ApplyEngine. */
export async function applyToJob(jobId: string): Promise<ApplyResult> {
  const { tailorJob, EligibilityError } = await import("@/lib/tailoring");
  const { ApplyEngine } = await import("@/lib/automation/apply-engine");
  const { getApplicationFolder } = await import("@/lib/storage/file-manager");

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return { ok: false, message: `Job ${jobId} not found` };
  const resumeId = await getActiveResumeId();
  if (!resumeId) return { ok: false, message: "No active resume — upload one in the app first" };

  let tailored;
  try {
    tailored = await tailorJob(resumeId, jobId);
  } catch (e) {
    if (e instanceof EligibilityError) return { ok: false, skipped: true, reason: e.reason, message: `Skipped — not eligible: ${e.reason}` };
    throw e;
  }

  const app = await prisma.application.upsert({
    where: { jobId },
    update: { tailoredResumeId: tailored.tailoredResumeId, coverLetterId: tailored.coverLetterId, status: "APPROVED" },
    create: {
      userId: "local", jobId, resumeId,
      tailoredResumeId: tailored.tailoredResumeId, coverLetterId: tailored.coverLetterId,
      status: "APPROVED", folderPath: getApplicationFolder(job.companyName, job.jobTitle),
    },
  });

  await new ApplyEngine().applyToJob(app.id);
  return { ok: true, applicationId: app.id, message: `Submitted application ${app.id} for ${job.jobTitle} @ ${job.companyName}` };
}
