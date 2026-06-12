import type { Candidate, EmployerId, FactBook, FactSelection, JobAnalysis, ProjectId } from "../types";
import { clip, humanList, lowerFirst } from "./text-utils";

// Every word in the summary comes from LEVEL_PHRASE, a real skill canonical, or a
// real achievement/project text. There is no "creative" path — nothing the LLM
// wrote freely can appear here.
export const LEVEL_PHRASE: Record<Candidate["experienceLevel"], string> = {
  intern: "Software engineering intern",
  entry: "Entry-level software engineer",
  mid: "Software engineer",
  senior: "Senior software engineer",
};

// Turn a raw job title into a clean role noun for the summary — strip
// seniority words, parentheticals, "- Remote", and roman-numeral levels.
function roleNoun(title: string): string {
  let t = (title || "").replace(/\(.*?\)/g, "").split(/[-–—|/]/)[0].trim();
  t = t
    .replace(/\b(senior|sr\.?|junior|jr\.?|lead|staff|principal|entry[- ]?level|mid[- ]?level|i{1,3}|iv|v|remote|hybrid|onsite|contract|intern)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return t || "software engineering";
}

// JD-targeted, still 100% real: names the role being applied for and leads with
// the required skills the candidate genuinely HAS (their matched keywords), then
// anchors one real achievement/project. Stays within the 280-char summary gate.
export function composeSummary(sel: FactSelection, facts: FactBook, analysis: JobAnalysis): string {
  const c = facts.candidate;
  const levelPhrase = LEVEL_PHRASE[c.experienceLevel];

  const matched = sel.presentRequiredSkills.map((id) => facts.skills.get(id)?.canonical).filter((s): s is string => !!s);
  const fallback = sel.summarySkills.map((id) => facts.skills.get(id)?.canonical).filter((s): s is string => !!s);
  const featured = (matched.length ? matched : fallback).slice(0, 4);

  const role = roleNoun(analysis.jobTitle);
  const s1 = `${levelPhrase} targeting ${role} roles, with hands-on ${humanList(featured)}.`;

  let s2 = "";
  if (sel.summaryEmployerOrProject) {
    if (sel.summaryEmployerOrProject.startsWith("employer:")) {
      const emp = facts.employers.get(sel.summaryEmployerOrProject as EmployerId)!;
      const ach = facts.achievements.get(emp.achievementIds[0])!;
      s2 = ` Recent work: ${lowerFirst(clip(ach.text, 95))}.`;
    } else {
      const proj = facts.projects.get(sel.summaryEmployerOrProject as ProjectId)!;
      const stack = humanList(proj.stack.map((id) => facts.skills.get(id)?.canonical).filter((s): s is string => !!s));
      // "--" not "—": LaTeX-safe in the résumé summary.
      s2 = stack ? ` Recent project: ${proj.name} (${stack}).` : ` Recent project: ${proj.name} -- ${clip(proj.description, 80)}.`;
    }
  }

  const full = `${s1}${s2}`;
  return full.length <= 278 ? full : s1; // honor the 280-char summary gate
}
