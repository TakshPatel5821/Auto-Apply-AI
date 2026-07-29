import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";

export async function GET(_req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [
    totalJobs,
    analyzedJobs,
    appliedToday,
    totalApplications,
    byStatus,
    byPlatform,
    topMatchJobs,
    recentApplications,
  ] = await Promise.all([
    prisma.job.count({ where: { isSpam: false, isBlacklisted: false } }),
    prisma.job.count({ where: { status: { in: ["ANALYZED", "TAILORED", "APPLIED"] } } }),
    prisma.application.count({ where: { userId: "local", appliedAt: { gte: today } } }),
    prisma.application.count({ where: { userId: "local" } }),
    prisma.application.groupBy({
      by: ["status"],
      _count: { status: true },
      where: { userId: "local" },
    }),
    prisma.job.groupBy({
      by: ["platform"],
      _count: { platform: true },
      where: { isSpam: false, isBlacklisted: false },
    }),
    prisma.job.findMany({
      where: { matchScore: { lte: 5 }, status: "ANALYZED" },
      orderBy: { matchScore: "asc" },
      take: 5,
      select: { companyName: true, jobTitle: true, matchScore: true, platform: true },
    }),
    prisma.application.findMany({
      where: { userId: "local" },
      orderBy: { updatedAt: "desc" },
      take: 5,
      include: {
        job: { select: { companyName: true, jobTitle: true } },
      },
    }),
  ]);

  return NextResponse.json({
    totalJobs,
    analyzedJobs,
    appliedToday,
    totalApplications,
    byStatus,
    byPlatform,
    topMatchJobs,
    recentApplications,
  });
}
