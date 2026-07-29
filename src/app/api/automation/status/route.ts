import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { automationEngine } from "@/lib/automation/automation-engine";
import { prisma } from "@/lib/db/prisma";

export async function GET(_req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const state = automationEngine.getState();

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [
    totalJobs,
    analyzedJobs,
    appliedToday,
    totalApplications,
    scrapedToday,
    fitJobs,
    recentLogs,
  ] = await Promise.all([
    prisma.job.count({ where: { isSpam: false, isBlacklisted: false } }),
    prisma.job.count({ where: { status: { in: ["ANALYZED", "TAILORED", "APPLIED"] } } }),
    prisma.application.count({
      where: { userId: "local", appliedAt: { gte: today } },
    }),
    prisma.application.count({ where: { userId: "local" } }),
    prisma.job.count({
      where: { scrapedAt: { gte: today }, isSpam: false },
    }),
    prisma.job.count({
      where: {
        matchScore: { lte: 6 },
        isSpam: false,
        isBlacklisted: false,
      },
    }),
    prisma.automationLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        level: true,
        category: true,
        message: true,
        createdAt: true,
      },
    }),
  ]);

  return NextResponse.json({
    state,
    stats: {
      totalJobs,
      analyzedJobs,
      appliedToday,
      totalApplications,
      scrapedToday,
      fitJobs,
    },
    recentLogs,
  });
}

export async function PUT(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { action } = await req.json();

  if (action === "pause") {
    await automationEngine.pause();
  } else if (action === "resume") {
    await automationEngine.resume();
  } else if (action === "confirmSubmitted") {
    await automationEngine.confirmSubmitted();
  }

  return NextResponse.json({ success: true, state: automationEngine.getState() });
}
