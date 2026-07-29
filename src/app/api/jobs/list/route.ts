import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";

export async function GET(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");
  const platform = searchParams.get("platform");
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "50");
  const search = searchParams.get("search");
  const minScore = searchParams.get("minScore");
  const maxScore = searchParams.get("maxScore");

  const where: Record<string, unknown> = {
    isBlacklisted: false,
    isSpam: false,
  };

  if (status) where.status = status;
  if (platform) where.platform = platform;
  if (minScore || maxScore) {
    where.matchScore = {
      ...(minScore ? { gte: parseFloat(minScore) } : {}),
      ...(maxScore ? { lte: parseFloat(maxScore) } : {}),
    };
  }
  if (search) {
    where.OR = [
      { jobTitle: { contains: search, mode: "insensitive" } },
      { companyName: { contains: search, mode: "insensitive" } },
    ];
  }

  const [jobs, total] = await Promise.all([
    prisma.job.findMany({
      where,
      orderBy: [{ matchScore: "asc" }, { scrapedAt: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
      include: {
        application: { select: { status: true, appliedAt: true } },
        _count: { select: { tailoredResumes: true } },
      },
    }),
    prisma.job.count({ where }),
  ]);

  return NextResponse.json({ jobs, total, page, limit });
}
