import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";

// Returns the base résumé LaTeX vs the job-tailored LaTeX for a diff view.
// Query param: tailoredResumeId
export async function GET(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const tailoredResumeId = req.nextUrl.searchParams.get("tailoredResumeId");
  if (!tailoredResumeId) {
    return NextResponse.json({ error: "tailoredResumeId is required" }, { status: 400 });
  }

  const tailored = await prisma.tailoredResume.findUnique({ where: { id: tailoredResumeId } });
  if (!tailored) {
    return NextResponse.json({ error: "Tailored resume not found" }, { status: 404 });
  }

  const [job, resume, coverLetter] = await Promise.all([
    prisma.job.findUnique({ where: { id: tailored.jobId } }),
    prisma.resume.findUnique({ where: { id: tailored.resumeId } }),
    // The cover letter is the other artifact being submitted — surface it in the
    // same review gate so the user approves EVERYTHING before anything is sent.
    prisma.coverLetter.findFirst({ where: { jobId: tailored.jobId }, orderBy: { createdAt: "desc" } }),
  ]);

  // Baseline: the stored base LaTeX; fall back to the earliest tailored version
  // for résumés created before baseLatex was tracked.
  let original = resume?.baseLatex || "";
  if (!original) {
    const earliest = await prisma.tailoredResume.findFirst({
      where: { resumeId: tailored.resumeId },
      orderBy: { createdAt: "asc" },
    });
    original = earliest?.latexContent || "";
  }

  return NextResponse.json({
    companyName: job?.companyName ?? "",
    jobTitle: job?.jobTitle ?? "",
    original,
    tailored: tailored.latexContent || "",
    atsScore: tailored.atsScore ?? null,
    keywordsAdded: tailored.keywordsAdded ?? [],
    sectionsModified: tailored.sectionsModified ?? [],
    tailoringNotes: tailored.tailoringNotes ?? null,
    hasBaseline: original.length > 0,
    coverLetter: coverLetter?.content ?? null,
  });
}
