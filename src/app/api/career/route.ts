import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { claudeCareerAdvice } from "@/lib/ai/claude";

// Skill-gap analysis + AI career roadmap from the active résumé vs scraped-job demand.
export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(_req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const resume = await prisma.resume.findFirst({ where: { userId: "local", isActive: true } });
  if (!resume) {
    return NextResponse.json({ error: "No active résumé — upload and activate one first." }, { status: 400 });
  }

  const jobs = await prisma.job.findMany({
    where: { isSpam: false, isBlacklisted: false },
    select: { jobTitle: true, missingSkills: true, matchingSkills: true, salaryMin: true, salaryMax: true },
    take: 400,
  });

  const has = new Set(
    [...(resume.skills || []), ...(resume.technologies || [])]
      .map((s) => s.toLowerCase().trim())
      .filter(Boolean)
  );

  const gap = new Map<string, number>();
  const strength = new Map<string, number>();
  const titleFreq = new Map<string, number>();
  const salaries: number[] = [];

  for (const j of jobs) {
    for (const s of j.missingSkills || []) {
      const k = s.trim();
      if (k && !has.has(k.toLowerCase())) gap.set(k, (gap.get(k) || 0) + 1);
    }
    for (const s of j.matchingSkills || []) {
      const k = s.trim();
      if (k) strength.set(k, (strength.get(k) || 0) + 1);
    }
    const t = j.jobTitle?.trim();
    if (t) titleFreq.set(t, (titleFreq.get(t) || 0) + 1);
    if (j.salaryMin) salaries.push(j.salaryMin);
    if (j.salaryMax) salaries.push(j.salaryMax);
  }

  const top = (m: Map<string, number>, n: number) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([skill, count]) => ({ skill, count }));

  const topGaps = top(gap, 15);
  const topStrengths = top(strength, 12);
  const commonTitles = [...titleFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t]) => t);
  const salaryRange = salaries.length
    ? `$${Math.min(...salaries).toLocaleString()} - $${Math.max(...salaries).toLocaleString()}`
    : "";

  const pd = resume.parsedData as { contactInfo?: { name?: string } } | null;

  try {
    const advice = await claudeCareerAdvice(
      {
        name: pd?.contactInfo?.name || "Candidate",
        years: resume.yearsOfExperience || 0,
        skills: resume.skills || [],
        technologies: resume.technologies || [],
      },
      { topGaps, topStrengths, commonTitles, jobsAnalyzed: jobs.length, salaryRange }
    );
    return NextResponse.json({ advice, gaps: topGaps, strengths: topStrengths, jobsAnalyzed: jobs.length });
  } catch (e) {
    return NextResponse.json({ error: `Career analysis failed: ${String(e)}` }, { status: 500 });
  }
}
