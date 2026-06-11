import { claudeCompleteJSON } from "@/lib/ai/claude";
import { humanList } from "./text-utils";
import {
  EligibilityError,
  ValidationError,
  type AchievementId,
  type Employer,
  type EmployerId,
  type FactBook,
  type FactSelection,
  type JobAnalysis,
  type ProjectId,
  type Skill,
  type SkillId,
  type TailorHints,
} from "../types";

const SYSTEM =
  "You are a résumé strategist. You decide which of the candidate's REAL facts to " +
  "feature for a specific job. You return only fact IDs and one short verbatim detail. " +
  "You never write prose. You never invent facts. Every ID you return must exist in the " +
  "supplied FactBook.";

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

// Split a list of JD skill strings into those the candidate genuinely has (present)
// and those they lack (absent), synonym-aware. Deterministic.
export function matchSkillStrings(
  skillStrings: string[],
  facts: FactBook
): { present: SkillId[]; absent: string[] } {
  const present = new Set<SkillId>();
  const absent: string[] = [];
  for (const req of skillStrings) {
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

// Exact intersection of analysis.requiredSkills ↔ FactBook skills. Drives the 30%
// eligibility floor and composeLetter's "maps directly to …" line.
export function computeRequiredSkillMatch(
  analysis: JobAnalysis,
  facts: FactBook
): { present: SkillId[]; absent: string[] } {
  return matchSkillStrings(analysis.requiredSkills, facts);
}

// ─── Deterministic orderings (no LLM) ────────────────────────────────────────
// These are permutations of known sets, not judgment calls — so we build them in
// TypeScript. This removes the single most brittle ask (a 32-item permutation a
// small model can't reproduce) and is valid by construction.
function deterministicSkillOrder(facts: FactBook, present: SkillId[], featured: SkillId[] = []): SkillId[] {
  const seen = new Set<SkillId>();
  const order: SkillId[] = [];
  const push = (id: SkillId) => { if (facts.skills.has(id) && !seen.has(id)) { seen.add(id); order.push(id); } };
  for (const id of featured) push(id); // screening-loop emphasis first
  for (const id of present) push(id);
  for (const id of facts.skills.keys()) push(id);
  return order;
}

function deterministicAchievementOrder(facts: FactBook, present: SkillId[]): Map<EmployerId, AchievementId[]> {
  const presentSet = new Set(present);
  const m = new Map<EmployerId, AchievementId[]>();
  for (const [id, emp] of facts.employers) {
    const relevant = (aid: AchievementId) =>
      facts.achievements.get(aid)!.skillIds.some((s) => presentSet.has(s)) ? 0 : 1;
    const sorted = emp.achievementIds
      .map((aid, i) => ({ aid, i, r: relevant(aid) }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map((x) => x.aid);
    m.set(id, sorted);
  }
  return m;
}

// ─── Deterministic fallbacks for the judgment picks ──────────────────────────
function bestAchievementFor(emp: Employer, facts: FactBook, present: SkillId[]): AchievementId {
  const presentSet = new Set(present);
  let best = emp.achievementIds[0];
  let bestScore = -1;
  for (const aid of emp.achievementIds) {
    const score = facts.achievements.get(aid)!.skillIds.filter((s) => presentSet.has(s)).length;
    if (score > bestScore) { bestScore = score; best = aid; }
  }
  return best;
}

function deterministicEvidence(
  facts: FactBook,
  present: SkillId[],
  featured: SkillId[] = []
): [AchievementId, AchievementId] {
  // Bias toward achievements that demonstrate the featured skills, then present.
  const priority = [...new Set([...featured, ...present])];
  const emps = [...facts.employers.values()];
  const a = bestAchievementFor(emps[0], facts, priority);
  const b = bestAchievementFor(emps[1] ?? emps[0], facts, priority);
  return [a, b];
}

// The verbatim JD pull can carry banned/second-person language ("Leverage a
// robust tech stack…") or be a whole sentence. Sanitize it; fall back to a clean,
// grounded phrase built from the candidate's present required skills.
const BANNED_DETAIL = /\b(extensive experience|expert in|passionate about|team player|results-driven|leverage|synergy|wide range of)\b/gi;
function cleanCompanyDetail(rawDetail: string, present: SkillId[], facts: FactBook): string {
  let d = (rawDetail || "").replace(/\s*\n\s*/g, " ").replace(/^["'\s]+|["'\s]+$/g, "");
  d = d.replace(BANNED_DETAIL, "").replace(/\s{2,}/g, " ").replace(/[.,;:]+$/g, "").trim();
  const words = d ? d.split(/\s+/) : [];
  const clean = d.length > 0 && words.length <= 12 && !/\b(you|your|we|us|our)\b/i.test(d);
  if (clean) return d;
  const skills = present.slice(0, 3).map((id) => facts.skills.get(id)?.canonical).filter((s): s is string => !!s);
  return skills.length ? `building reliable software with ${humanList(skills)}` : "building reliable, well-tested software";
}

// ─── Prompt ──────────────────────────────────────────────────────────────────
function serializeFactBook(facts: FactBook) {
  return {
    skills: [...facts.skills.values()].map((s) => ({ id: s.id, canonical: s.canonical })),
    employers: [...facts.employers.values()].map((e) => ({
      id: e.id, name: e.name, role: e.role, achievementIds: e.achievementIds,
    })),
    projects: [...facts.projects.values()].map((p) => ({ id: p.id, name: p.name })),
    achievements: [...facts.achievements.values()].map((a) => ({
      id: a.id, employerId: a.employerId, text: a.text,
    })),
  };
}

function buildUserPrompt(analysis: JobAnalysis, facts: FactBook): string {
  return `<facts>
${JSON.stringify(serializeFactBook(facts), null, 2)}
</facts>

<job>
${JSON.stringify(
    {
      companyName: analysis.companyName,
      jobTitle: analysis.jobTitle,
      requiredSkills: analysis.requiredSkills,
      atsKeywords: analysis.atsKeywords,
      jobDescription: analysis.jobDescription.slice(0, 2500),
    },
    null,
    2
  )}
</job>

Decide and return ONE JSON object with EXACTLY these keys (ids must come from the FactBook):
{
  "summarySkills": ["skill:..."],            // 2-3 SkillIds that best match the required skills, most relevant first
  "summaryEmployerOrProject": "employer:... or project:...",  // the single best anchor
  "evidenceAchievements": ["achievement:...", "achievement:..."],  // exactly 2, from DIFFERENT employers
  "companyDetail": "..."                     // ONE short phrase (<= 12 words) pulled VERBATIM from the job description
}
No prose. No fences. No other keys.`;
}

// ─── Parsing + deterministic assembly ────────────────────────────────────────
function asIdArray<T extends string>(v: unknown): T[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean) as T[];
}

function parseSelection(
  raw: Record<string, unknown>,
  facts: FactBook,
  analysis: JobAnalysis,
  present: SkillId[],
  absent: string[],
  skillOrder: SkillId[],
  achOrder: Map<EmployerId, AchievementId[]>,
  featured: SkillId[] = []
): FactSelection {
  const lp = (raw.letterParagraphs as Record<string, unknown>) || {};
  const lpEvidence = (lp.evidence as Record<string, unknown>) || {};
  const lpClose = (lp.close as Record<string, unknown>) || {};
  const lpHook = (lp.hook as Record<string, unknown>) || {};

  // Summary skills — screening-loop "feature these" first, then the LLM's picks,
  // topped up to 2-3 from present-required (or any) skills.
  const llmSummary = asIdArray<SkillId>(raw.summarySkills ?? lpHook.skills).filter((id) => facts.skills.has(id));
  let summarySkills = [...new Set([...featured, ...llmSummary])].slice(0, 3);
  if (summarySkills.length < 2) {
    const pool = (present.length ? present : [...facts.skills.keys()]).filter((id) => !summarySkills.includes(id));
    summarySkills = [...summarySkills, ...pool].slice(0, 3);
  }

  // Anchor — LLM employer/project if real, else the first employer.
  const rawAnchor = typeof raw.summaryEmployerOrProject === "string" ? raw.summaryEmployerOrProject.trim() : "";
  let anchor: EmployerId | ProjectId | undefined;
  if (rawAnchor.startsWith("employer:") && facts.employers.has(rawAnchor as EmployerId)) anchor = rawAnchor as EmployerId;
  else if (rawAnchor.startsWith("project:") && facts.projects.has(rawAnchor as ProjectId)) anchor = rawAnchor as ProjectId;
  if (!anchor) anchor = [...facts.employers.keys()][0];

  // Evidence — LLM pair if valid (both real, different employers), else derived.
  const rawEvidence = asIdArray<AchievementId>(raw.evidenceAchievements ?? lpEvidence.achievements);
  const validPair =
    rawEvidence.length >= 2 &&
    facts.achievements.has(rawEvidence[0]) &&
    facts.achievements.has(rawEvidence[1]) &&
    facts.achievements.get(rawEvidence[0])!.employerId !== facts.achievements.get(rawEvidence[1])!.employerId;
  const evidence: [AchievementId, AchievementId] = validPair
    ? [rawEvidence[0], rawEvidence[1]]
    : deterministicEvidence(facts, present, featured);

  // Company detail — sanitized LLM verbatim phrase, else a clean grounded phrase.
  const rawDetail = (typeof raw.companyDetail === "string" ? raw.companyDetail : (lpClose.companyDetail as string) || "").trim();
  const detail = cleanCompanyDetail(rawDetail, present, facts);

  return {
    summarySkills,
    summaryEmployerOrProject: anchor,
    letterParagraphs: {
      hook: { skills: summarySkills },
      evidence: { achievements: evidence },
      close: { companyDetail: detail },
    },
    presentRequiredSkills: present,
    absentRequiredSkills: absent,
    resumeSkillOrder: skillOrder,
    resumeAchievementOrder: achOrder,
  };
}

// ─── Verification (deterministic, exported for tests) ────────────────────────
export function verifySelection(sel: FactSelection, facts: FactBook): void {
  for (const id of sel.summarySkills) if (!facts.skills.has(id)) throw new ValidationError("selection", `unknown skill ${id}`);
  for (const id of sel.letterParagraphs.evidence.achievements) {
    if (!facts.achievements.has(id)) throw new ValidationError("selection", `unknown achievement ${id}`);
  }
  const [a, b] = sel.letterParagraphs.evidence.achievements;
  const empA = facts.achievements.get(a)!.employerId;
  const empB = facts.achievements.get(b)!.employerId;
  if (empA === empB) throw new ValidationError("selection", "evidence achievements share an employer");
  if (sel.resumeSkillOrder.length !== facts.skills.size) throw new ValidationError("selection", "skill order is not a permutation");
  const skillSet = new Set(sel.resumeSkillOrder);
  for (const id of facts.skills.keys()) if (!skillSet.has(id)) throw new ValidationError("selection", `skill ${id} missing from order`);
  for (const [empId, emp] of facts.employers) {
    const ordered = sel.resumeAchievementOrder.get(empId) ?? [];
    if (ordered.length !== emp.achievementIds.length) throw new ValidationError("selection", `employer ${empId} achievement order wrong length`);
    const set = new Set(ordered);
    for (const id of emp.achievementIds) if (!set.has(id)) throw new ValidationError("selection", `employer ${empId} missing achievement ${id}`);
  }
  if (sel.presentRequiredSkills.length / Math.max(1, sel.presentRequiredSkills.length + sel.absentRequiredSkills.length) < 0.3) {
    throw new EligibilityError("less than 30% of required skills are present");
  }
}

// ─── Public entry point ──────────────────────────────────────────────────────
// ONE Claude call → judgment picks only (summary skills, anchor, two evidence
// achievements, a verbatim company detail). Orderings, present/absent, and any
// missing/invalid judgment pick are filled deterministically from REAL facts, so
// the selection is always valid + fully grounded on any model (incl. local
// Ollama). verifySelection is the final guard (it can only throw the eligibility
// floor once the structure is built deterministically).
export async function selectFacts(
  analysis: JobAnalysis,
  facts: FactBook,
  hints?: TailorHints
): Promise<FactSelection> {
  const { present, absent } = computeRequiredSkillMatch(analysis, facts);
  const featured = (hints?.featureSkillIds ?? []).filter((id) => facts.skills.has(id));
  const skillOrder = deterministicSkillOrder(facts, present, featured);
  const achOrder = deterministicAchievementOrder(facts, present);

  let raw: Record<string, unknown> = {};
  try {
    raw = await claudeCompleteJSON<Record<string, unknown>>(buildUserPrompt(analysis, facts), SYSTEM, 700);
  } catch {
    // Malformed JSON from a weak model → full deterministic selection (still real).
    raw = {};
  }

  const sel = parseSelection(raw, facts, analysis, present, absent, skillOrder, achOrder, featured);
  verifySelection(sel, facts); // structurally valid by construction; may throw the 30% floor
  return sel;
}
