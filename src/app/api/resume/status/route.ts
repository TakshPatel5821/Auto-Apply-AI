import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";

// Poll this to know when AI parsing of an uploaded resume is done
export async function GET(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const resumeId = searchParams.get("id");

  if (!resumeId) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const resume = await prisma.resume.findUnique({
    where: { id: resumeId },
    select: {
      id: true,
      skills: true,
      technologies: true,
      yearsOfExperience: true,
      summary: true,
      parsedData: true,
    },
  });

  if (!resume) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const aiParsed = (resume.parsedData as { aiParsed?: boolean })?.aiParsed === true;

  return NextResponse.json({
    id: resume.id,
    aiParsed,
    skills: resume.skills,
    technologies: resume.technologies,
    yearsOfExperience: resume.yearsOfExperience,
    summary: resume.summary,
  });
}
