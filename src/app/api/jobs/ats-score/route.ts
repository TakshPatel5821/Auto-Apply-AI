import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { analyzeATS } from "@/lib/ai/ats-analyzer";

// POST { jobId, resumeId? } → on-demand ATS analysis of a job vs. the résumé.
export async function POST(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { jobId, resumeId } = await req.json();
  if (!jobId) {
    return NextResponse.json({ error: "jobId required" }, { status: 400 });
  }

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  // Use the requested résumé, else the active one.
  const resume = resumeId
    ? await prisma.resume.findUnique({ where: { id: resumeId } })
    : await prisma.resume.findFirst({ where: { isActive: true } });
  if (!resume) {
    return NextResponse.json({ error: "No résumé found — upload one first" }, { status: 400 });
  }

  try {
    const analysis = await analyzeATS(
      (resume.parsedData as Record<string, unknown>) || {},
      job.description || ""
    );
    return NextResponse.json({ analysis });
  } catch (e) {
    return NextResponse.json({ error: `ATS analysis failed: ${e}` }, { status: 500 });
  }
}
