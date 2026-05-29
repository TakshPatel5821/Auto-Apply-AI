import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";

export async function GET(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "50");

  const where: Record<string, unknown> = { userId: "local" };
  if (status) where.status = status;

  const [applications, total] = await Promise.all([
    prisma.application.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        job: {
          select: {
            id: true,
            companyName: true,
            jobTitle: true,
            location: true,
            platform: true,
            matchScore: true,
            atsScore: true,
            url: true,
            applyUrl: true,
            isEasyApply: true,
          },
        },
        tailoredResume: {
          select: { id: true, atsScore: true, texPath: true, pdfPath: true },
        },
        coverLetter: {
          select: { id: true, texPath: true, pdfPath: true },
        },
      },
    }),
    prisma.application.count({ where }),
  ]);

  return NextResponse.json({ applications, total, page, limit });
}
