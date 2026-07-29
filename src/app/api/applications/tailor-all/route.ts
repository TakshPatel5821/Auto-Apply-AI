import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { tailorJob, EligibilityError } from "@/lib/tailoring";
import { getApplicationFolder } from "@/lib/storage/file-manager";
import { Logger } from "@/lib/logging/logger";

// One bulk-tailor run at a time — tailoring is heavy (Claude + LaTeX compile),
// so we never run two passes concurrently.
let tailorRunning = false;

// Job statuses we should NOT re-tailor: already applied / in a terminal pipeline
// state, or explicitly skipped by the user. Everything else (FOUND, ANALYZED, …)
// is eligible IF it has no tailored résumé yet.
const SKIP_STATUSES = [
  "APPLYING",
  "APPLIED",
  "INTERVIEWING",
  "OFFERED",
  "REJECTED",
  "WITHDRAWN",
  "SKIPPED",
] as const;

async function eligibleJobs(limit: number) {
  return prisma.job.findMany({
    where: {
      isBlacklisted: false,
      isSpam: false,
      status: { notIn: [...SKIP_STATUSES] },
      // No tailored résumé generated yet → still needs analyze + cover letter + résumé.
      tailoredResumes: { none: {} },
    },
    // Best matches first (lower matchScore = better fit), newest as tiebreaker.
    orderBy: [{ matchScore: "asc" }, { scrapedAt: "desc" }],
    take: limit,
    select: { id: true, jobTitle: true, companyName: true },
  });
}

async function runBulkTailor(resumeId: string, limit: number): Promise<void> {
  if (tailorRunning) {
    await Logger.warn("TAILOR-ALL", "Bulk tailor already running — ignoring duplicate trigger");
    return;
  }
  tailorRunning = true;

  try {
    const jobs = await eligibleJobs(limit);
    await Logger.info("TAILOR-ALL", `Tailoring résumé + cover letter for ${jobs.length} job(s)`);

    let succeeded = 0;
    let skipped = 0;
    let failed = 0;

    for (const job of jobs) {
      try {
        await Logger.info("TAILOR-ALL", `→ ${job.jobTitle} @ ${job.companyName}`);
        const { tailoredResumeId, coverLetterId } = await tailorJob(resumeId, job.id);

        const folderPath = getApplicationFolder(job.companyName, job.jobTitle);
        // Create/refresh the application so it's ready to review & submit — but keep
        // it PENDING (never auto-submitted by this endpoint).
        await prisma.application.upsert({
          where: { jobId: job.id },
          update: { tailoredResumeId, coverLetterId, folderPath },
          create: {
            userId: "local",
            jobId: job.id,
            resumeId,
            tailoredResumeId,
            coverLetterId,
            status: "PENDING",
            folderPath,
          },
        });
        succeeded++;
      } catch (e) {
        if (e instanceof EligibilityError) {
          skipped++;
          await Logger.info("TAILOR-ALL", `Skipped ${job.companyName}: ${e.reason}`);
          continue;
        }
        failed++;
        await Logger.error("TAILOR-ALL", `Failed: ${job.companyName} — ${e}`);
      }
    }

    await Logger.success("TAILOR-ALL", `Bulk tailor done — ${succeeded} tailored, ${skipped} skipped, ${failed} failed`);
  } finally {
    tailorRunning = false;
  }
}

export async function POST(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (tailorRunning) {
    return NextResponse.json({
      success: false,
      running: true,
      message: "Bulk tailor is already running — watch the logs.",
    });
  }

  const body = await req.json().catch(() => ({}));
  const limit = Math.max(1, Math.min(50, body.limit ?? 25));

  // Pick the resume to tailor from: explicit, else the active one.
  const resumeId =
    body.resumeId ||
    (
      await prisma.resume.findFirst({
        where: { userId: "local", isActive: true },
        select: { id: true },
      })
    )?.id;

  if (!resumeId) {
    return NextResponse.json(
      { success: false, message: "No active résumé found — upload and activate a résumé first." },
      { status: 400 }
    );
  }

  const jobs = await eligibleJobs(limit);
  if (jobs.length === 0) {
    return NextResponse.json({
      success: false,
      message: "No jobs need tailoring — every job already has a tailored résumé.",
    });
  }

  // Fire and forget — the UI watches the logs and refreshes as applications appear.
  runBulkTailor(resumeId, limit);

  return NextResponse.json({
    success: true,
    queued: jobs.length,
    message: `Tailoring résumé + cover letter for ${jobs.length} job(s) — watch the logs.`,
  });
}

export async function GET() {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ running: tailorRunning });
}
