import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { saveUploadedResume } from "@/lib/storage/file-manager";
import { extractTextFromFile } from "@/lib/resume/parser";
import { quickExtract } from "@/lib/resume/quick-extract";
import { prisma } from "@/lib/db/prisma";
import { Logger } from "@/lib/logging/logger";
import { seedProfileFromActiveResume } from "@/lib/profile/profile-store";

// Upload: save + quick extract (instant) then AI parse in background
export async function POST(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await req.formData();
  const file = formData.get("resume") as File;
  const setActive = formData.get("setActive") !== "false";

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const { filePath } = saveUploadedResume(buffer, file.name);

  // Step 1 — Extract text (fast, no AI)
  let rawText = "";
  try {
    rawText = await extractTextFromFile(filePath);
  } catch (e) {
    return NextResponse.json({ error: `Could not read file: ${e}` }, { status: 400 });
  }

  // Step 2 — Quick regex-based extraction (instant, no AI)
  const quick = quickExtract(rawText);

  if (setActive) {
    await prisma.resume.updateMany({ where: { userId: "local" }, data: { isActive: false } });
  }

  // Step 3 — Save to DB immediately with quick data
  const resume = await prisma.resume.create({
    data: {
      userId: "local",
      fileName: file.name,
      originalPath: filePath,
      fileType: file.type || "unknown",
      fileSize: buffer.length,
      parsedData: { rawText: rawText.slice(0, 2000), contactInfo: quick as object, aiParsed: false } as object,
      skills: quick.skills,
      experience: [],
      education: [],
      projects: [],
      achievements: [],
      technologies: quick.technologies,
      domains: [],
      atsKeywords: quick.technologies.slice(0, 10),
      yearsOfExperience: quick.yearsOfExperience || null,
      summary: null,
      isActive: setActive,
    },
  });

  // Step 4 — AI deep parse in background (non-blocking)
  deepParseInBackground(resume.id, rawText).catch(() => {});

  return NextResponse.json({
    success: true,
    resume: {
      ...resume,
      aiParsing: true, // tell frontend AI parse is still running
    },
  });
}

async function deepParseInBackground(resumeId: string, rawText: string) {
  await Logger.info("RESUME", "Starting AI deep parse in background", { resumeId });

  try {
    const { claudeParseResume } = await import("@/lib/ai/claude");
    // Send only first 4000 chars to keep Ollama fast
    const parsed = await claudeParseResume(rawText.slice(0, 4000)) as Record<string, unknown>;

    await prisma.resume.update({
      where: { id: resumeId },
      data: {
        parsedData: { ...parsed, aiParsed: true } as object,
        skills: (parsed.skills as string[]) || [],
        experience: ((parsed.experience as object[]) || []),
        education: ((parsed.education as object[]) || []),
        projects: ((parsed.projects as object[]) || []),
        achievements: (parsed.achievements as string[]) || [],
        technologies: (parsed.technologies as string[]) || [],
        domains: (parsed.domains as string[]) || [],
        atsKeywords: (parsed.atsKeywords as string[]) || [],
        yearsOfExperience: (parsed.yearsOfExperience as number) || null,
        summary: (parsed.summary as string) || null,
      },
    });

    await Logger.success("RESUME", "AI deep parse complete", { resumeId });

    // Seed the structured Profile (V2) from the freshly parsed résumé — fills
    // blanks only, never touches fields the user has locked.
    try {
      await seedProfileFromActiveResume();
    } catch { /* non-fatal */ }
  } catch (e) {
    await Logger.warn("RESUME", "AI deep parse failed, quick extract used instead", {
      resumeId,
      error: String(e),
    });
  }
}

export async function GET(_req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const resumes = await prisma.resume.findMany({
    where: { userId: "local" },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      fileName: true,
      fileType: true,
      fileSize: true,
      skills: true,
      technologies: true,
      yearsOfExperience: true,
      summary: true,
      isActive: true,
      parsedData: true,
      createdAt: true,
      _count: { select: { tailoredVersions: true } },
    },
  });

  return NextResponse.json({ resumes });
}
