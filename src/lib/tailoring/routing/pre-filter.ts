import { EligibilityError, type FactBook, type JobAnalysis } from "../types";

// Pure routing gate (no LLM). Throws EligibilityError when the candidate is
// clearly disqualified, so tailorJob can soft-skip the job instead of generating
// (and then having to validate / discard) materials it should never produce.
export function preFilter(analysis: JobAnalysis, facts: FactBook): void {
  const c = facts.candidate;

  // 1. Senior-title gate
  if (analysis.seniorityFlags.length > 0 && c.yearsOfProfessionalExperience < 5) {
    throw new EligibilityError(
      `senior-titled role (${analysis.seniorityFlags.join("/")}) but candidate has ${c.yearsOfProfessionalExperience} yrs`
    );
  }

  // 2. Years gate
  if (analysis.requiredYears > c.yearsOfProfessionalExperience + 1 && analysis.experienceLevel !== "intern") {
    throw new EligibilityError(
      `requires ${analysis.requiredYears} yrs, candidate has ${c.yearsOfProfessionalExperience}`
    );
  }

  // 3. Domain gate — reject jobs in domains the candidate has zero exposure to
  const candidateDomains = new Set<string>();
  for (const skill of facts.skills.values()) candidateDomains.add(skill.canonical.toLowerCase());
  for (const ach of facts.achievements.values()) {
    for (const kw of ach.keywords) candidateDomains.add(kw);
  }
  const hardDomains = ["aerospace", "flight software", "space", "embedded automotive", "medical device", "clinical"];
  for (const tag of analysis.domainTags) {
    if (hardDomains.includes(tag.toLowerCase())) {
      const hasAnyOverlap = [...candidateDomains].some((d) => d.includes(tag.toLowerCase()));
      if (!hasAnyOverlap) {
        throw new EligibilityError(`domain "${tag}" has zero overlap with candidate's experience`);
      }
    }
  }

  // 4. Required-skill floor — must have at least 30% of required skills.
  // (computed in selectFacts; re-thrown there if it's too low)
}
