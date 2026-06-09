import type { Candidate, EmployerId, FactBook, FactSelection, ProjectId } from "../types";
import { humanList, lowerFirst, truncate } from "./text-utils";

// Every word in the summary comes from LEVEL_PHRASE, a real skill canonical, or a
// real achievement/project text. There is no "creative" path — nothing the LLM
// wrote freely can appear here.
export const LEVEL_PHRASE: Record<Candidate["experienceLevel"], string> = {
  intern: "Software engineering intern",
  entry: "Entry-level software engineer",
  mid: "Software engineer",
  senior: "Senior software engineer",
};

export function composeSummary(sel: FactSelection, facts: FactBook): string {
  const c = facts.candidate;
  const skillNames = sel.summarySkills.map((id) => facts.skills.get(id)!.canonical);
  const levelPhrase = LEVEL_PHRASE[c.experienceLevel];
  const skillList = humanList(skillNames);

  let sentence2 = "";
  if (sel.summaryEmployerOrProject) {
    if (sel.summaryEmployerOrProject.startsWith("employer:")) {
      const emp = facts.employers.get(sel.summaryEmployerOrProject as EmployerId)!;
      const ach = facts.achievements.get(emp.achievementIds[0])!;
      // The achievement text is verb-initial; anchor it after the employer rather
      // than prefixing another verb ("Built Architected …").
      sentence2 = ` At ${emp.name}, ${lowerFirst(truncate(ach.text, 120))}`;
    } else {
      const proj = facts.projects.get(sel.summaryEmployerOrProject as ProjectId)!;
      // "--" not "—": LaTeX-safe in the résumé summary.
      sentence2 = ` Recent project: ${proj.name} -- ${truncate(proj.description, 90)}`;
    }
  }

  return `${levelPhrase} with hands-on ${skillList}.${sentence2}`;
}
