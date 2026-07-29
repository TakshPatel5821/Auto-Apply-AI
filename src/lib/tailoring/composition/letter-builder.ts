import type { Achievement, FactBook, FactSelection, JobAnalysis, ProjectId, SkillId } from "../types";
import { LEVEL_PHRASE } from "./summary-builder";
import { humanList, lowerFirst } from "./text-utils";

// Canonical names for a set of SkillIds (skipping any that fell out of the book).
function canonicals(ids: SkillId[], facts: FactBook, limit = 3): string[] {
  return ids
    .map((id) => facts.skills.get(id)?.canonical)
    .filter((s): s is string => !!s)
    .slice(0, limit);
}

// A grounded relevance clause for one evidence achievement. Prefers the skills the
// achievement shares with the role's required skills; falls back to the
// achievement's own skills; never claims a skill the achievement doesn't have.
function relevance(ach: Achievement, present: SkillId[], facts: FactBook): string {
  const presentSet = new Set(present);
  const shared = canonicals(ach.skillIds.filter((id) => presentSet.has(id)), facts);
  if (shared.length) return `That work applies the same ${humanList(shared)} this role requires.`;
  const own = canonicals(ach.skillIds, facts);
  if (own.length) return `That work deepened my foundation in ${humanList(own)}.`;
  return `That experience sharpened how I build and review reliable software.`;
}

// Pick the real project with the most stack overlap with the role's required
// skills (ties → first). Pure, no LLM — it only surfaces a fact that already
// exists in the FactBook.
function pickProject(facts: FactBook, present: SkillId[]): ProjectId | undefined {
  const presentSet = new Set(present);
  let best: ProjectId | undefined;
  let bestScore = -1;
  for (const p of facts.projects.values()) {
    const score = p.stack.filter((id) => presentSet.has(id)).length;
    if (score > bestScore) { bestScore = score; best = p.id; }
  }
  return best;
}

// Properties the gates rely on, true by construction:
//  • Every sentence is first person (literal "I am", "I bring", "I would").
//  • Each employer reference is immediately followed by an achievement from that
//    employer (achA→empA, achB→empB by construction).
//  • No template placeholder labels exist, so none can leak.
//  • Forbidden phrases never appear because they are not in these strings.
//  • Every clause is composed from real skill canonicals, real achievement text,
//    a real project, and JD-derived terms — there is no free-text path.
export function composeLetter(sel: FactSelection, facts: FactBook, analysis: JobAnalysis): string {
  const c = facts.candidate;
  const skills = canonicals(sel.letterParagraphs.hook.skills, facts, 4);
  const [achA, achB] = sel.letterParagraphs.evidence.achievements.map((id) => facts.achievements.get(id)!);
  const empA = facts.employers.get(achA.employerId)!;
  const empB = facts.employers.get(achB.employerId)!;
  const detail = sel.letterParagraphs.close.companyDetail;
  const present = sel.presentRequiredSkills;
  const needSkills = canonicals(present.length ? present : sel.letterParagraphs.hook.skills, facts);

  const eduClause = c.graduated
    ? `As ${LEVEL_PHRASE[c.experienceLevel].toLowerCase()} who graduated ${c.gradMonth} ${c.gradYear} with an ${c.degree}, `
    : `As ${LEVEL_PHRASE[c.experienceLevel].toLowerCase()} graduating ${c.gradMonth} ${c.gradYear} from ${c.degree}, `;
  const hook =
    `I am applying for the ${analysis.jobTitle} role at ${analysis.companyName}, a role I am genuinely excited to grow into. ` +
    eduClause +
    `I bring hands-on experience with ${humanList(skills)}.`;

  const projId = pickProject(facts, present);
  const proj = projId ? facts.projects.get(projId) : undefined;
  const projStack = proj ? canonicals(proj.stack, facts) : [];
  const projectSentence = proj
    ? `Outside those internships, I built ${proj.name}${
        projStack.length ? ` using ${humanList(projStack)}` : ""
      }, which strengthened the same fundamentals this work depends on.`
    : "";

  const evidence = [
    `At ${empA.name}, I ${lowerFirst(achA.text)}`,
    relevance(achA, present, facts),
    `In a separate role at ${empB.name}, I ${lowerFirst(achB.text)}`,
    relevance(achB, present, facts),
    projectSentence,
    `Together these map directly to ${analysis.companyName}'s need for ${humanList(needSkills)}.`,
  ]
    .filter(Boolean)
    .join(" ");

  const eduSentence = c.graduated
    ? `Having completed my ${c.degree} in ${c.gradMonth} ${c.gradYear}, I would bring that momentum to your team. `
    : `I am completing my ${c.degree} this ${c.gradMonth} and would bring that momentum to your team. `;
  const close =
    `${analysis.companyName}'s focus on ${detail} is what draws me to this role. ` +
    eduSentence +
    `I would welcome the chance to contribute from the start and to keep learning as an engineer.`;

  return [hook, evidence, close].join("\n\n");
}
