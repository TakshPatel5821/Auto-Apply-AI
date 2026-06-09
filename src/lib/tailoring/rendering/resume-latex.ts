import {
  buildResumeLatex,
  RESUME_EXPERIENCE,
  RESUME_SKILLS,
  type ResumeOverrides,
} from "@/lib/automation/resume-template";
import type { FactBook, FactSelection, SkillId } from "../types";

// The canonical one-page résumé (summary tailored, content untouched). Used as the
// guaranteed-fits fallback when the reordered version spills to a second page.
export function renderCanonicalResumeLatex(summary: string): string {
  return buildResumeLatex(summary);
}

// Render the résumé from the selection: tailored summary + skill reordering
// (resumeSkillOrder) + per-employer bullet reordering (resumeAchievementOrder).
// Both overrides are permutations BY CONSTRUCTION — we only sort each group's own
// items / each employer's own bullets, never adding, dropping, or inventing.
export function renderResumeLatex(sel: FactSelection, facts: FactBook, summary: string): string {
  const canonToId = new Map<string, SkillId>();
  for (const s of facts.skills.values()) canonToId.set(s.canonical, s.id);
  const rank = new Map<SkillId, number>();
  sel.resumeSkillOrder.forEach((id, i) => rank.set(id, i));
  const rankOf = (item: string) => {
    const id = canonToId.get(item);
    return id != null && rank.has(id) ? rank.get(id)! : Number.MAX_SAFE_INTEGER;
  };

  const skills: string[][] = RESUME_SKILLS.map((g) => [...g.items].sort((a, b) => rankOf(a) - rankOf(b)));

  const employers = [...facts.employers.values()];
  const experienceBullets: string[][] = RESUME_EXPERIENCE.map((entry, i) => {
    const emp = employers[i];
    const order = emp ? sel.resumeAchievementOrder.get(emp.id) : undefined;
    if (!emp || !order || order.length !== emp.achievementIds.length) return entry.bullets;
    const bullets = order
      .map((id) => facts.achievements.get(id)?.text)
      .filter((t): t is string => !!t);
    return bullets.length === entry.bullets.length ? bullets : entry.bullets;
  });

  const overrides: ResumeOverrides = { skills, experienceBullets };
  return buildResumeLatex(summary, overrides);
}
