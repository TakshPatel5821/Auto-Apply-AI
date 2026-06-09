import { claudeCompleteJSON } from "@/lib/ai/claude";
import {
  EligibilityError,
  ValidationError,
  type AchievementId,
  type EmployerId,
  type FactBook,
  type FactSelection,
  type JobAnalysis,
  type Skill,
  type SkillId,
} from "../types";

const SYSTEM =
  "You are a résumé strategist. You decide which of the candidate's REAL facts to " +
  "feature for a specific job. You return only fact IDs and orderings. You never write " +
  "prose. You never invent facts. Every ID you return must exist in the supplied FactBook.";

// ─── Deterministic skill ↔ JD matching ───────────────────────────────────────
// Match a token against text with rough word boundaries (handles +, #, /, . as in
// c++, tcp/ip, node.js). Mirrors the matcher in load-facts.
function tokenMatches(token: string, text: string): boolean {
  const esc = token.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`, "i").test(text);
}

// A JD-required string matches a FactBook skill when the skill's canonical name or
// any synonym lines up with it (bounded, either direction).
function reqMatchesSkill(reqLower: string, skill: Skill): boolean {
  const phrases = [skill.canonical, ...skill.synonyms].map((p) => p.toLowerCase());
  return phrases.some((p) => tokenMatches(p, reqLower) || tokenMatches(reqLower, p));
}

// Exact intersection of analysis.requiredSkills ↔ FactBook skills. Deterministic;
// drives the 30% eligibility floor and composeLetter's "maps directly to …" line.
export function computeRequiredSkillMatch(
  analysis: JobAnalysis,
  facts: FactBook
): { present: SkillId[]; absent: string[] } {
  const present = new Set<SkillId>();
  const absent: string[] = [];
  for (const req of analysis.requiredSkills) {
    const reqLower = req.toLowerCase().trim();
    if (!reqLower) continue;
    let matched = false;
    for (const skill of facts.skills.values()) {
      if (reqMatchesSkill(reqLower, skill)) {
        present.add(skill.id);
        matched = true;
      }
    }
    if (!matched) absent.push(req);
  }
  return { present: [...present], absent };
}

// ─── Prompt ──────────────────────────────────────────────────────────────────
function serializeFactBook(facts: FactBook) {
  return {
    skills: [...facts.skills.values()].map((s) => ({ id: s.id, canonical: s.canonical, synonyms: s.synonyms })),
    employers: [...facts.employers.values()].map((e) => ({
      id: e.id, name: e.name, role: e.role, dates: e.dates,
      achievementIds: e.achievementIds, technologyIds: e.technologyIds,
    })),
    projects: [...facts.projects.values()].map((p) => ({
      id: p.id, name: p.name, stack: p.stack, description: p.description,
    })),
    achievements: [...facts.achievements.values()].map((a) => ({
      id: a.id, employerId: a.employerId, text: a.text, skillIds: a.skillIds,
    })),
  };
}

function serializeAnalysis(analysis: JobAnalysis) {
  return {
    companyName: analysis.companyName,
    jobTitle: analysis.jobTitle,
    requiredSkills: analysis.requiredSkills,
    niceToHaveSkills: analysis.niceToHaveSkills,
    atsKeywords: analysis.atsKeywords,
    domainTags: analysis.domainTags,
    experienceLevel: analysis.experienceLevel,
    requiredYears: analysis.requiredYears,
    // Excerpt only — used to pull a verbatim companyDetail for the letter close.
    jobDescription: analysis.jobDescription.slice(0, 2500),
  };
}

function buildUserPrompt(analysis: JobAnalysis, facts: FactBook): string {
  return `<facts>
${JSON.stringify(serializeFactBook(facts), null, 2)}
</facts>

<job>
${JSON.stringify(serializeAnalysis(analysis), null, 2)}
</job>

Decide:

1. summarySkills: 2–3 SkillIds from facts.skills that best match jobAnalysis.requiredSkills. Order by relevance.
2. summaryEmployerOrProject: optional. The single best EmployerId or ProjectId to anchor the summary in one real achievement.
3. letterParagraphs.hook.skills: same 2–3 skills as summarySkills (or a close variant).
4. letterParagraphs.evidence.achievements: exactly 2 AchievementIds from DIFFERENT employers. Pick the two that map most strongly to jobAnalysis.requiredSkills.
5. letterParagraphs.close.companyDetail: ONE short string (≤ 12 words) pulled verbatim from the JD that names a real product, mission, or technology. No paraphrasing.
6. presentRequiredSkills: SkillIds whose canonical or synonyms match a string in jobAnalysis.requiredSkills.
7. absentRequiredSkills: jobAnalysis.requiredSkills strings that have NO matching skill in facts.skills.
8. resumeSkillOrder: a permutation of ALL facts.skills IDs (every id exactly once). Put presentRequiredSkills first.
9. resumeAchievementOrder: an object keyed by each EmployerId; the value is that employer's achievement IDs in the order they should appear (you may reorder but never drop or invent).

Return ONE JSON object matching FactSelection:
{
  "summarySkills": ["skill:..."],
  "summaryEmployerOrProject": "employer:... or project:...",
  "letterParagraphs": {
    "hook": { "skills": ["skill:..."] },
    "evidence": { "achievements": ["achievement:...", "achievement:..."] },
    "close": { "companyDetail": "..." }
  },
  "presentRequiredSkills": ["skill:..."],
  "absentRequiredSkills": ["..."],
  "resumeSkillOrder": ["skill:...", "... every skill id exactly once ..."],
  "resumeAchievementOrder": { "employer:...": ["achievement:..."] }
}
No prose. No fences.`;
}

// ─── Parsing ─────────────────────────────────────────────────────────────────
function asIdArray<T extends string>(v: unknown): T[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean) as T[];
}

function toAchievementOrder(raw: unknown): Map<EmployerId, AchievementId[]> {
  const m = new Map<EmployerId, AchievementId[]>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        const emp = o.employerId ?? o.employer ?? o.id;
        const list = o.achievementIds ?? o.achievements ?? o.order;
        if (typeof emp === "string") m.set(emp as EmployerId, asIdArray<AchievementId>(list));
      }
    }
  } else if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      m.set(k as EmployerId, asIdArray<AchievementId>(v));
    }
  }
  return m;
}

function parseSelection(raw: Record<string, unknown>): FactSelection {
  const lp = (raw.letterParagraphs as Record<string, unknown>) || {};
  const hook = (lp.hook as Record<string, unknown>) || {};
  const evidence = (lp.evidence as Record<string, unknown>) || {};
  const close = (lp.close as Record<string, unknown>) || {};
  const evAch = asIdArray<AchievementId>(evidence.achievements);

  const anchor = typeof raw.summaryEmployerOrProject === "string" ? raw.summaryEmployerOrProject.trim() : "";

  return {
    summarySkills: asIdArray<SkillId>(raw.summarySkills),
    summaryEmployerOrProject: anchor ? (anchor as EmployerId) : undefined,
    letterParagraphs: {
      hook: { skills: asIdArray<SkillId>(hook.skills) },
      evidence: { achievements: [evAch[0], evAch[1]] as [AchievementId, AchievementId] },
      close: { companyDetail: typeof close.companyDetail === "string" ? close.companyDetail.trim() : "" },
    },
    presentRequiredSkills: asIdArray<SkillId>(raw.presentRequiredSkills),
    absentRequiredSkills: asIdArray<string>(raw.absentRequiredSkills),
    resumeSkillOrder: asIdArray<SkillId>(raw.resumeSkillOrder),
    resumeAchievementOrder: toAchievementOrder(raw.resumeAchievementOrder),
  };
}

// ─── Verification (deterministic, exported for tests) ────────────────────────
export function verifySelection(sel: FactSelection, facts: FactBook): void {
  // Every ID must exist in the FactBook
  for (const id of sel.summarySkills) if (!facts.skills.has(id)) throw new ValidationError("selection", `unknown skill ${id}`);
  for (const id of sel.letterParagraphs.evidence.achievements) {
    if (!facts.achievements.has(id)) throw new ValidationError("selection", `unknown achievement ${id}`);
  }
  // Exactly 2 evidence achievements from DIFFERENT employers
  const [a, b] = sel.letterParagraphs.evidence.achievements;
  const empA = facts.achievements.get(a)!.employerId;
  const empB = facts.achievements.get(b)!.employerId;
  if (empA === empB) throw new ValidationError("selection", "evidence achievements share an employer");
  // resumeSkillOrder must be a permutation
  if (sel.resumeSkillOrder.length !== facts.skills.size) throw new ValidationError("selection", "skill order is not a permutation");
  const skillSet = new Set(sel.resumeSkillOrder);
  for (const id of facts.skills.keys()) if (!skillSet.has(id)) throw new ValidationError("selection", `skill ${id} missing from order`);
  // resumeAchievementOrder must be a permutation per employer
  for (const [empId, emp] of facts.employers) {
    const ordered = sel.resumeAchievementOrder.get(empId) ?? [];
    if (ordered.length !== emp.achievementIds.length) throw new ValidationError("selection", `employer ${empId} achievement order wrong length`);
    const set = new Set(ordered);
    for (const id of emp.achievementIds) if (!set.has(id)) throw new ValidationError("selection", `employer ${empId} missing achievement ${id}`);
  }
  // Required-skill floor
  if (sel.presentRequiredSkills.length / Math.max(1, sel.presentRequiredSkills.length + sel.absentRequiredSkills.length) < 0.3) {
    throw new EligibilityError("less than 30% of required skills are present");
  }
}

// ─── Public entry point ──────────────────────────────────────────────────────
// ONE Claude call → a FactSelection of IDs (never prose). presentRequiredSkills /
// absentRequiredSkills are recomputed deterministically (exact intersection) so
// the eligibility floor never depends on the LLM. Verification failures retry
// ONCE with the reason fed back; a second failure throws (no silent accept).
export async function selectFacts(analysis: JobAnalysis, facts: FactBook): Promise<FactSelection> {
  const base = buildUserPrompt(analysis, facts);
  const { present, absent } = computeRequiredSkillMatch(analysis, facts);

  let lastErr: ValidationError | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt =
      attempt === 1
        ? base
        : `${base}\n\nYour previous answer was REJECTED: ${lastErr?.reason}. Return a corrected JSON object that fixes exactly that problem (keep every id real and every ordering a complete permutation).`;

    const raw = await claudeCompleteJSON<Record<string, unknown>>(prompt, SYSTEM, 2000);
    const sel = parseSelection(raw);
    // Deterministic override — these are exact intersections, not judgment calls.
    sel.presentRequiredSkills = present;
    sel.absentRequiredSkills = absent;

    try {
      verifySelection(sel, facts);
      return sel;
    } catch (e) {
      if (e instanceof EligibilityError) throw e; // disqualified — retrying won't help
      if (e instanceof ValidationError) { lastErr = e; continue; }
      throw e;
    }
  }
  throw lastErr ?? new ValidationError("selection", "failed verification after retry");
}
