import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { runScreeningLoop } from "@/lib/ats-screen/screening-loop";
import { getLatestScreening, saveScreeningResult } from "@/lib/ats-screen/persist";
import { Logger } from "@/lib/logging/logger";

// POST { jobId, resumeId? } → run the employer-ATS screening loop, persist the
// result (accepted OR rejected, with round history), and return it.
export async function POST(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const jobId: string | undefined = body.jobId;
  if (!jobId) {
    return NextResponse.json({ error: "jobId required" }, { status: 400 });
  }

  const resumeId =
    body.resumeId ||
    (await prisma.resume.findFirst({ where: { userId: "local", isActive: true }, select: { id: true } }))?.id;
  if (!resumeId) {
    return NextResponse.json({ error: "No active résumé found" }, { status: 400 });
  }

  try {
    const result = await runScreeningLoop(resumeId, jobId, { maxRounds: 3, withRecruiterNote: true });
    const saved = await saveScreeningResult(jobId, resumeId, result);
    return NextResponse.json({ success: true, screening: { id: saved.id, createdAt: saved.createdAt, ...result } });
  } catch (e) {
    await Logger.error("ATS-SCREEN", `Screening failed for job ${jobId}: ${e}`);
    return NextResponse.json({ error: `Screening failed: ${e instanceof Error ? e.message : e}` }, { status: 500 });
  }
}

// GET ?jobId=… → the latest persisted screening for a job (no re-run).
export async function GET(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const jobId = req.nextUrl.searchParams.get("jobId");
  if (!jobId) {
    return NextResponse.json({ error: "jobId required" }, { status: 400 });
  }
  const latest = await getLatestScreening(jobId);
  return NextResponse.json({ screening: latest });
}
