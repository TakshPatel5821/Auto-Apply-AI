import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";

// Edit a resume's parsed fields (summary, skills, years of experience) from the
// Resume tab. We update BOTH the top-level columns (shown in the UI) AND the
// parsedData JSON (read by tailoring + profile seeding) so edits actually take
// effect downstream.
export async function POST(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const { id } = body as { id?: string };
  if (!id) return NextResponse.json({ error: "missing id" }, { status: 400 });

  const existing = await prisma.resume.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Normalize inputs.
  const summary =
    typeof body.summary === "string" ? body.summary.trim() : undefined;
  const yearsOfExperience =
    body.yearsOfExperience === "" || body.yearsOfExperience == null
      ? undefined
      : Number(body.yearsOfExperience);
  const skills = Array.isArray(body.skills)
    ? (body.skills as unknown[]).map((s) => String(s).trim()).filter(Boolean)
    : typeof body.skills === "string"
    ? body.skills.split(",").map((s: string) => s.trim()).filter(Boolean)
    : undefined;

  if (yearsOfExperience != null && (Number.isNaN(yearsOfExperience) || yearsOfExperience < 0 || yearsOfExperience > 60)) {
    return NextResponse.json({ error: "invalid years of experience" }, { status: 400 });
  }

  // Merge into parsedData so tailoring/profile see the edits too.
  const parsed = (existing.parsedData as Record<string, unknown>) || {};
  const nextParsed = {
    ...parsed,
    ...(summary !== undefined ? { summary } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(yearsOfExperience !== undefined ? { yearsOfExperience } : {}),
  };

  const updated = await prisma.resume.update({
    where: { id },
    data: {
      ...(summary !== undefined ? { summary } : {}),
      ...(skills !== undefined ? { skills } : {}),
      ...(yearsOfExperience !== undefined ? { yearsOfExperience } : {}),
      parsedData: nextParsed as object,
    },
    select: { id: true, summary: true, skills: true, yearsOfExperience: true },
  });

  return NextResponse.json({ resume: updated });
}
