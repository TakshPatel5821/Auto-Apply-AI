// ─── Tailoring v3 — shared types ─────────────────────────────────────────────
// The contract that makes hallucination structurally impossible: the LLM never
// writes prose. It selects FactIds from the FactBook (a strict allowlist built
// from the canonical résumé) and deterministic templates compose the text.

export type SkillId = `skill:${string}`;
export type EmployerId = `employer:${string}`;
export type ProjectId = `project:${string}`;
export type AchievementId = `achievement:${string}`;
export type FactId = SkillId | EmployerId | ProjectId | AchievementId;

export interface Skill { id: SkillId; canonical: string; synonyms: string[]; }

export interface Achievement {
  id: AchievementId;
  employerId: EmployerId;
  text: string;
  skillIds: SkillId[];        // every skill this achievement legitimately demonstrates
  keywords: string[];         // lowercased nouns ≥ 5 chars, for binding check
}

export interface Employer {
  id: EmployerId;
  name: string;
  role: string;
  dates: string;
  achievementIds: AchievementId[];
  technologyIds: SkillId[];
}

export interface Project {
  id: ProjectId;
  name: string;
  stack: SkillId[];
  description: string;
  keywords: string[];
}

export interface Candidate {
  fullName: string;
  email: string;
  phone: string;
  location: string;
  github?: string;
  linkedin?: string;
  degree: string;
  gradMonth: string;
  gradYear: number;
  graduated: boolean;                      // grad date has passed (past vs. future tense)
  yearsOfProfessionalExperience: number;   // internships count as fractional
  experienceLevel: "intern" | "entry" | "mid" | "senior";
}

export interface FactBook {
  candidate: Candidate;
  skills: Map<SkillId, Skill>;
  employers: Map<EmployerId, Employer>;
  projects: Map<ProjectId, Project>;
  achievements: Map<AchievementId, Achievement>;
}

export interface JobAnalysis {
  jobId: string;
  companyName: string;
  jobTitle: string;
  jobDescription: string;
  requiredSkills: string[];         // raw strings from JD
  niceToHaveSkills: string[];
  requiredYears: number;
  experienceLevel: "intern" | "entry" | "mid" | "senior";
  atsKeywords: string[];            // 10–20 high-signal terms exactly as in JD
  domainTags: string[];             // ["healthcare","aerospace","fintech",...]
  seniorityFlags: string[];         // ["senior","lead","staff","principal","director", ...] if title matches
}

export interface FactSelection {
  summarySkills: SkillId[];                              // 2–3 skills to feature
  summaryEmployerOrProject?: EmployerId | ProjectId;     // optional anchor for sentence 2
  letterParagraphs: {
    hook: { skills: SkillId[] };
    evidence: { achievements: [AchievementId, AchievementId] };  // exactly 2, from different employers
    close: { companyDetail: string };                    // one real detail from JD
  };
  presentRequiredSkills: SkillId[];                      // intersection of requiredSkills ↔ FactBook.skills
  absentRequiredSkills: string[];                        // JD-required strings with no matching skill
  resumeSkillOrder: SkillId[];                           // permutation of all FactBook skills, prioritized
  resumeAchievementOrder: Map<EmployerId, AchievementId[]>; // permutation per employer
}

export interface TailorResult { tailoredResumeId: string; coverLetterId: string; }

// Feedback from the employer-side screening loop: real skills the candidate has
// but the materials under-featured, to surface more prominently next round.
export interface TailorHints { featureSkillIds?: SkillId[]; }

export class EligibilityError extends Error {
  constructor(public reason: string) { super(reason); }
}

export class ValidationError extends Error {
  constructor(public gate: string, public reason: string) {
    super(`${gate}: ${reason}`);
  }
}
