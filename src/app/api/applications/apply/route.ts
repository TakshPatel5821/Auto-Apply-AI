import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { tailorJob, EligibilityError } from "@/lib/tailoring";
import { ApplyEngine } from "@/lib/automation/apply-engine";
import { getApplicationFolder } from "@/lib/storage/file-manager";
import { Logger } from "@/lib/logging/logger";

export async function POST(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { applicationId, jobId, resumeId, action } = body;

  // Resolve applicationId from either applicationId directly, or via jobId
  async function resolveApp() {
    if (applicationId) {
      return prisma.application.findUnique({ where: { id: applicationId } });
    }
    if (jobId) {
      return prisma.application.findUnique({ where: { jobId } });
    }
    return null;
  }

  if (action === "tailor") {
    if (!jobId) {
      return NextResponse.json({ error: "jobId required for tailor" }, { status: 400 });
    }
    const activeResume =
      resumeId ||
      (
        await prisma.resume.findFirst({
          where: { userId: "local", isActive: true },
          select: { id: true },
        })
      )?.id;

    if (!activeResume) {
      return NextResponse.json({ error: "No active resume found" }, { status: 400 });
    }

    let tailored;
    try {
      tailored = await tailorJob(activeResume, jobId);
    } catch (e) {
      if (e instanceof EligibilityError) {
        // Soft-skip: not a fit for this candidate. 200 so the UI can show the reason.
        return NextResponse.json({ success: false, skipped: true, reason: e.reason });
      }
      throw e;
    }
    const { tailoredResumeId, coverLetterId } = tailored;

    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

    const folderPath = getApplicationFolder(job.companyName, job.jobTitle);

    const application = await prisma.application.upsert({
      where: { jobId },
      update: { tailoredResumeId, coverLetterId, folderPath },
      create: {
        userId: "local",
        jobId,
        resumeId: activeResume,
        tailoredResumeId,
        coverLetterId,
        status: "PENDING",
        folderPath,
      },
    });

    return NextResponse.json({ success: true, application });
  }

  if (action === "approve") {
    const app = await resolveApp();
    if (!app) {
      return NextResponse.json({ error: "Application not found" }, { status: 404 });
    }
    const updated = await prisma.application.update({
      where: { id: app.id },
      data: { status: "APPROVED" },
    });
    return NextResponse.json({ success: true, application: updated });
  }

  if (action === "submit") {
    const app = await resolveApp();
    if (!app) {
      return NextResponse.json({ error: "Application not found" }, { status: 404 });
    }

    // Auto-approve if still pending so the apply engine can use it
    if (app.status === "PENDING") {
      await prisma.application.update({
        where: { id: app.id },
        data: { status: "APPROVED" },
      });
    }

    // Run the apply engine in background — UI doesn't have to wait for the browser
    const engine = new ApplyEngine();
    engine.applyToJob(app.id).catch(async (e) => {
      await Logger.error("APPLY-ROUTE", `Background apply failed: ${e}`);
    });

    return NextResponse.json({
      success: true,
      message: "Application submission started — watch the logs",
    });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
