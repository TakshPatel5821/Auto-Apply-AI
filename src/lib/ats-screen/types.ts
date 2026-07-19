// ─── Employer-side ATS screening ─────────────────────────────────────────────
// The inverse of the applicant engine: given a generated application, decide as a
// recruiter's ATS would — accept or reject, with WHAT is missing and WHY.

export interface Gap {
  skill: string; // the JD-required skill the pitch is missing
  // coverable = the candidate genuinely HAS this (a real fact) but the summary /
  //   cover letter under-featured it → fixable by re-tailoring.
  // absent    = the candidate does NOT have it → unfixable without fabricating.
  status: "coverable" | "absent";
  factId?: string; // when coverable, the FactBook skill id that covers it
}

export interface ScreenResult {
  decision: "accept" | "reject";
  score: number; // 0–100 weighted recruiter score
  matched: string[]; // required skills the candidate genuinely has (and mentioned)
  coverableGaps: Gap[]; // present required skills NOT mentioned in the pitch (loop fixes)
  absentGaps: Gap[]; // required skills the candidate truly lacks (honest gaps)
  mentionedNotEvidenced: string[]; // present skills named but not shown with a real achievement/project
  niceToHave: { present: string[]; missing: string[] }; // nice-to-have coverage
  breakdown: { requiredCoverage: number; evidenceRate: number; niceToHaveCoverage: number }; // 0–1 each
  experienceNote?: string; // years-of-experience fit note
  comments: string[]; // recruiter-style notes
}

export interface LoopRound {
  round: number;
  featured: string[]; // skills the applicant agent was asked to emphasize this round
  screen: ScreenResult;
}

export interface LoopResult {
  accepted: boolean;
  rounds: LoopRound[];
  finalScore: number;
  learnList: string[]; // genuinely-absent skills to learn (when rejected)
  reason?: string; // why it stopped
  tailoredResumeId?: string;
  coverLetterId?: string;
}
