import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";

// Aggregates job + application data for the analytics dashboard.
export async function GET(_req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [apps, jobs] = await Promise.all([
    prisma.application.findMany({
      where: { userId: "local" },
      select: { status: true, createdAt: true, appliedAt: true },
    }),
    prisma.job.findMany({
      where: { isSpam: false, isBlacklisted: false },
      select: { platform: true, status: true, matchScore: true, atsScore: true },
    }),
  ]);

  // ── Applications per day (last 14 days) ──────────────────────────────────
  const DAYS = 14;
  const dayKey = (d: Date) => d.toISOString().slice(0, 10);
  const byDay = new Map<string, { created: number; applied: number }>();
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    byDay.set(dayKey(d), { created: 0, applied: 0 });
  }
  for (const a of apps) {
    const c = byDay.get(dayKey(new Date(a.createdAt)));
    if (c) c.created++;
    if (a.appliedAt) {
      const ap = byDay.get(dayKey(new Date(a.appliedAt)));
      if (ap) ap.applied++;
    }
  }
  const perDay = [...byDay.entries()].map(([date, v]) => ({
    date: date.slice(5), // MM-DD
    created: v.created,
    applied: v.applied,
  }));

  // ── Platform breakdown ───────────────────────────────────────────────────
  const platformMap = new Map<string, number>();
  for (const j of jobs) platformMap.set(j.platform, (platformMap.get(j.platform) || 0) + 1);
  const platforms = [...platformMap.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);

  // ── Match-score distribution (lower = better) ────────────────────────────
  const buckets: Record<string, number> = {
    "Strong (1-3)": 0,
    "Good (4-5)": 0,
    "Borderline (6)": 0,
    "Weak (7-8)": 0,
    "Skip (9-10)": 0,
  };
  for (const j of jobs) {
    const m = j.matchScore;
    if (m == null) continue;
    if (m <= 3) buckets["Strong (1-3)"]++;
    else if (m <= 5) buckets["Good (4-5)"]++;
    else if (m <= 6) buckets["Borderline (6)"]++;
    else if (m <= 8) buckets["Weak (7-8)"]++;
    else buckets["Skip (9-10)"]++;
  }
  const matchDistribution = Object.entries(buckets).map(([name, value]) => ({ name, value }));

  // ── Application status funnel ─────────────────────────────────────────────
  const statusOrder = [
    "PENDING",
    "APPROVED",
    "IN_PROGRESS",
    "SUBMITTED",
    "CONFIRMED",
    "INTERVIEW_SCHEDULED",
    "OFFER_RECEIVED",
    "REJECTED",
    "FAILED",
  ];
  const statusMap = new Map<string, number>();
  for (const a of apps) statusMap.set(a.status, (statusMap.get(a.status) || 0) + 1);
  const statusFunnel = statusOrder
    .filter((s) => statusMap.has(s))
    .map((s) => ({ name: s.replace(/_/g, " "), value: statusMap.get(s)! }));

  // ── Headline numbers ──────────────────────────────────────────────────────
  const submittedStatuses = [
    "SUBMITTED",
    "CONFIRMED",
    "INTERVIEW_SCHEDULED",
    "OFFER_RECEIVED",
    "REJECTED",
  ];
  const submitted = apps.filter((a) => submittedStatuses.includes(a.status)).length;
  const interviews = apps.filter((a) =>
    ["INTERVIEW_SCHEDULED", "OFFER_RECEIVED"].includes(a.status)
  ).length;
  const offers = apps.filter((a) => a.status === "OFFER_RECEIVED").length;
  const rejected = apps.filter((a) => a.status === "REJECTED").length;
  // A "response" = any reply after submitting (interview, offer, or rejection).
  const responses = interviews + offers + rejected;
  const atsScores = jobs.map((j) => j.atsScore).filter((x): x is number => x != null);
  const avgAts = atsScores.length
    ? +(atsScores.reduce((a, b) => a + b, 0) / atsScores.length).toFixed(1)
    : 0;

  return NextResponse.json({
    perDay,
    platforms,
    matchDistribution,
    statusFunnel,
    summary: {
      totalApplications: apps.length,
      submitted,
      interviews,
      offers,
      avgAts,
      interviewRate: submitted ? Math.round((interviews / submitted) * 100) : 0,
      responseRate: submitted ? Math.round((responses / submitted) * 100) : 0,
      offerRate: submitted ? Math.round((offers / submitted) * 100) : 0,
    },
  });
}
