import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { ApplyEngine } from "@/lib/automation/apply-engine";
import { Logger } from "@/lib/logging/logger";

// Single shared engine instance to avoid spawning multiple browsers at once
let bulkRunning = false;

async function runBulkApply(limit: number): Promise<void> {
  if (bulkRunning) {
    await Logger.warn("APPLY-ALL", "Bulk apply already running — ignoring duplicate trigger");
    return;
  }
  bulkRunning = true;

  try {
    const apps = await prisma.application.findMany({
      where: { userId: "local", status: { in: ["APPROVED", "PENDING"] } },
      take: limit,
      orderBy: [{ status: "asc" }, { createdAt: "asc" }],
      include: { job: { select: { jobTitle: true, companyName: true } } },
    });

    await Logger.info("APPLY-ALL", `Starting bulk apply for ${apps.length} applications`);

    const engine = new ApplyEngine();
    let succeeded = 0;
    let failed = 0;

    for (const app of apps) {
      try {
        // Auto-approve pending so they qualify
        if (app.status === "PENDING") {
          await prisma.application.update({
            where: { id: app.id },
            data: { status: "APPROVED" },
          });
        }

        await Logger.info("APPLY-ALL", `→ ${app.job.jobTitle} @ ${app.job.companyName}`);
        const ok = await engine.applyToJob(app.id);
        if (ok) succeeded++;
        else failed++;

        // Pause between apps
        await new Promise((r) => setTimeout(r, 8000 + Math.random() * 7000));
      } catch (e) {
        failed++;
        await Logger.error("APPLY-ALL", `Failed: ${app.job.companyName}: ${e}`);
      }
    }

    await Logger.success("APPLY-ALL", `Bulk apply done — ${succeeded} succeeded, ${failed} failed`);
  } finally {
    bulkRunning = false;
  }
}

export async function POST(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const limit = Math.max(1, Math.min(50, body.limit ?? 20));

  const pendingCount = await prisma.application.count({
    where: { userId: "local", status: { in: ["APPROVED", "PENDING"] } },
  });

  if (pendingCount === 0) {
    return NextResponse.json({
      success: false,
      message: "No applications waiting to be submitted. Run the automation first to tailor resumes.",
    });
  }

  // Fire and forget
  runBulkApply(limit);

  return NextResponse.json({
    success: true,
    message: `Bulk apply started for up to ${Math.min(limit, pendingCount)} applications — watch the logs`,
    queued: Math.min(limit, pendingCount),
  });
}

export async function GET() {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ running: bulkRunning });
}
