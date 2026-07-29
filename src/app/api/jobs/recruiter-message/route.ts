import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { claudeRecruiterMessage } from "@/lib/ai/claude";

export const runtime = "nodejs";
export const maxDuration = 120;

// POST { jobId, recruiterName? } → AI-generated recruiter outreach (connection
// note + message + follow-up) for that job against the active résumé.
export async function POST(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { jobId, recruiterName } = await req.json();
  if (!jobId) {
    return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  }

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const resume = await prisma.resume.findFirst({ where: { userId: "local", isActive: true } });
  if (!resume) {
    return NextResponse.json({ error: "No active résumé — upload and activate one first." }, { status: 400 });
  }

  const pd = resume.parsedData as { contactInfo?: { name?: string } } | null;

  try {
    const outreach = await claudeRecruiterMessage(
      {
        name: pd?.contactInfo?.name || "Candidate",
        years: resume.yearsOfExperience || 0,
        skills: resume.skills || [],
      },
      { jobTitle: job.jobTitle, companyName: job.companyName, description: job.description || "" },
      recruiterName
    );
    return NextResponse.json({ outreach, jobTitle: job.jobTitle, companyName: job.companyName });
  } catch (e) {
    return NextResponse.json({ error: `Recruiter message generation failed: ${String(e)}` }, { status: 500 });
  }
}
