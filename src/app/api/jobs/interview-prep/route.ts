import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { claudeInterviewPrep } from "@/lib/ai/claude";

// Generates AI interview prep for a specific job against the active résumé.
export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { jobId } = await req.json();
  if (!jobId) {
    return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  }

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const resume = await prisma.resume.findFirst({
    where: { userId: "local", isActive: true },
  });
  if (!resume) {
    return NextResponse.json({ error: "No active résumé — upload and activate one first." }, { status: 400 });
  }

  try {
    const prep = await claudeInterviewPrep(
      resume.parsedData as Record<string, unknown>,
      job.description || "",
      job.jobTitle,
      job.companyName
    );
    return NextResponse.json({ prep, jobTitle: job.jobTitle, companyName: job.companyName });
  } catch (e) {
    return NextResponse.json({ error: `Interview prep generation failed: ${String(e)}` }, { status: 500 });
  }
}
