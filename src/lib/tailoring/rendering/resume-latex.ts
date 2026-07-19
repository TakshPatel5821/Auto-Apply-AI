import {
  buildResumeLatex,
  escapeTex,
  RESUME_EXPERIENCE,
  RESUME_PROJECTS,
  RESUME_SKILLS,
  type ResumeEntry,
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

  // Selected GitHub projects (FactBook ids "project:gh-…") surface first, then the
  // canonical projects, capped to keep the résumé one page (the compile step also
  // falls back to canonical if it ever spills to a second page).
  const ghEntries: ResumeEntry[] = [...facts.projects.values()]
    .filter((p) => p.id.startsWith("project:gh-"))
    .map((p) => {
      const stackNames = p.stack.map((id) => facts.skills.get(id)?.canonical).filter((s): s is string => !!s);
      const heading = `\\textbf{${escapeTex(p.name)}}${stackNames.length ? ` $|$ \\textit{${escapeTex(stackNames.join(", "))}}` : ""}`;
      return { heading, bullets: [p.description] };
    });
  const projects = ghEntries.length ? [...ghEntries, ...RESUME_PROJECTS].slice(0, 4) : undefined;

  const overrides: ResumeOverrides = { skills, experienceBullets, ...(projects ? { projects } : {}) };
  return buildResumeLatex(summary, overrides);
}
