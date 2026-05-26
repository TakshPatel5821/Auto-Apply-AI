import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { saveUploadedResume } from "@/lib/storage/file-manager";
import { parseResume } from "@/lib/resume/parser";
import { prisma } from "@/lib/db/prisma";
import { ParsedResume } from "@/types";

export async function POST(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await req.formData();
  const file = formData.get("resume") as File;
  const setActive = formData.get("setActive") === "true";

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  const allowedTypes = [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/msword",
    "text/plain",
    "application/zip",
    "application/x-zip-compressed",
  ];

  if (!allowedTypes.includes(file.type) && !file.name.endsWith(".tex")) {
    return NextResponse.json({ error: "Unsupported file type" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const { filePath, fileName } = saveUploadedResume(buffer, file.name);

  const parsed = await parseResume(filePath) as ParsedResume;

  if (setActive) {
    await prisma.resume.updateMany({
      where: { userId: "local" },
      data: { isActive: false },
    });
  }

  const resume = await prisma.resume.create({
    data: {
      userId: "local",
      fileName: file.name,
      originalPath: filePath,
      fileType: file.type || "unknown",
      fileSize: buffer.length,
      parsedData: parsed as object,
      skills: parsed.skills || [],
      experience: (parsed.experience || []) as object[],
      education: (parsed.education || []) as object[],
      projects: (parsed.projects || []) as object[],
      achievements: parsed.achievements || [],
      technologies: parsed.technologies || [],
      domains: parsed.domains || [],
      atsKeywords: parsed.atsKeywords || [],
      yearsOfExperience: parsed.yearsOfExperience || null,
      summary: parsed.summary || null,
      isActive: setActive,
    },
  });

  return NextResponse.json({ success: true, resume });
}

export async function GET(req: NextRequest) {
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
      createdAt: true,
      _count: { select: { tailoredVersions: true } },
    },
  });

  return NextResponse.json({ resumes });
}
