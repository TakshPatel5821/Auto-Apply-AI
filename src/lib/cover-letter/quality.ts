// ─── Cover-letter deterministic gates (Achievement match · ATS · Quality) ─────
// These are the non-AI pieces of the production cover-letter pipeline. They make
// achievement selection deterministic (not the model's choice), measure ATS
// keyword coverage, and turn everything into a single pass/fail quality score.

import type { CandidateFacts } from "@/lib/ai/claude";

// Cosine-ish token overlap between two short strings (0..1).
function similarity(a: string, b: string): number {
  const tok = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9+#.]+/g) || []).filter((w) => w.length > 2));
  const A = tok(a);
  const B = tok(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / Math.sqrt(A.size * B.size);
}

// Deterministically pick the candidate's most relevant VERIFIED claims for this
// job — the model must build the MATCH paragraph from these, not invent its own.
export function matchAchievements(facts: CandidateFacts, requiredSkills: string[], k = 3): string[] {
  const q = [...requiredSkills, ...facts.skills.slice(0, 10)].join(" ");
  return [...facts.verifiedClaims]
    .map((claim) => ({ claim, score: similarity(claim, q) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.claim);
}

export interface AtsResult { score: number; missing: string[] }

// Fraction of the job's required skills that actually appear in the letter.
export function validateATS(letter: string, requiredSkills: string[]): AtsResult {
  const skills = (requiredSkills || []).map((s) => (s || "").trim()).filter(Boolean);
  if (!skills.length) return { score: 1, missing: [] };
  const lower = (letter || "").toLowerCase();
  const missing = skills.filter((s) => !lower.includes(s.toLowerCase()));
  return { score: (skills.length - missing.length) / skills.length, missing };
}

export interface QualityResult { score: number; passed: boolean }

// One number from accuracy + ATS coverage. Hallucinations are heavily penalized;
// `passed` also hard-requires zero hallucinations (a clean letter can't be bought
// back by keyword coverage).
export function scoreLetter(hallucinations: number, atsScore: number): QualityResult {
  const score = 100 - hallucinations * 25 + atsScore * 20;
  return { score, passed: hallucinations === 0 && score >= 95 };
}

// The PDF gate: only "accept" a letter if it's structurally valid, has zero
// hallucinations, decent ATS coverage, and passes the quality bar.
export function isAcceptable(
  structureValid: boolean,
  hallucinations: number,
  ats: AtsResult,
  quality: QualityResult
): boolean {
  return structureValid && hallucinations === 0 && ats.score >= 0.7 && quality.passed;
}
