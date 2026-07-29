// Shared test fixtures for the tailoring suite.
//
// Employer, achievement and skill IDs are derived from the configured résumé
// (config/resume.json, falling back to config/resume.example.json), so fixtures
// must READ them off the FactBook rather than hardcoding one person's employers.
// That keeps the suite green for any contributor's résumé config.

import type { Employer, FactBook } from "@/lib/tailoring/types";

/** The first two employers in the configured résumé, for two-evidence selections. */
export function firstTwoEmployers(fb: FactBook): [Employer, Employer] {
  const employers = [...fb.employers.values()];
  if (employers.length < 2) {
    throw new Error(
      `Tailoring fixtures need a résumé config with at least 2 experience entries (found ${employers.length}).`
    );
  }
  return [employers[0], employers[1]];
}

/** One achievement id from each of the first two employers. */
export function twoEvidenceAchievements(fb: FactBook) {
  const [first, second] = firstTwoEmployers(fb);
  return [first.achievementIds[0], second.achievementIds[0]] as const;
}
