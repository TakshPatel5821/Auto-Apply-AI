import { describe, it, expect } from "vitest";
import { buildFactBook, defaultCandidate } from "@/lib/tailoring/facts/load-facts";
import { composeLetter } from "@/lib/tailoring/composition/letter-builder";
import { validateOutputs } from "@/lib/tailoring/validation/gates";
import { ValidationError, type AchievementId, type EmployerId, type FactBook, type FactSelection, type JobAnalysis, type SkillId } from "@/lib/tailoring/types";
import { firstTwoEmployers, twoEvidenceAchievements } from "./fixtures";

function selection(fb: FactBook): FactSelection {
  const [first] = firstTwoEmployers(fb);
  return {
    summarySkills: ["skill:python"] as SkillId[],
    summaryEmployerOrProject: first.id as EmployerId,
    letterParagraphs: {
      hook: { skills: ["skill:python", "skill:sql"] as SkillId[] },
      evidence: { achievements: [...twoEvidenceAchievements(fb)] as [AchievementId, AchievementId] },
      close: { companyDetail: "real-time payment processing" },
    },
    presentRequiredSkills: ["skill:python", "skill:mysql", "skill:sql"] as SkillId[],
    absentRequiredSkills: [],
    resumeSkillOrder: [...fb.skills.keys()],
    resumeAchievementOrder: new Map(),
  };
}

const analysis: JobAnalysis = {
  jobId: "j", companyName: "Acme Corp", jobTitle: "Backend Engineer", jobDescription: "",
  requiredSkills: ["python", "mysql", "sql"], niceToHaveSkills: [], requiredYears: 0,
  experienceLevel: "entry", atsKeywords: ["Python", "MySQL", "SQL"], domainTags: [], seniorityFlags: [],
};

const fb = buildFactBook(defaultCandidate());
const sel = selection(fb);
const goodSummary = "Software engineering intern with hands-on Python and SQL.";
const goodLetter = composeLetter(sel, fb, analysis);

function reason(fn: () => void): string {
  try { fn(); } catch (e) { return e instanceof ValidationError ? e.reason : String(e); }
  return "(did not throw)";
}

describe("validateOutputs", () => {
  it("accepts the real composed outputs", () => {
    expect(() => validateOutputs(goodSummary, goodLetter, analysis, sel, fb)).not.toThrow();
  });

  it('flags a letter whose first paragraph leaks a "First — " label', () => {
    const bad = `First — ${goodLetter}`;
    expect(reason(() => validateOutputs(goodSummary, bad, analysis, sel, fb))).toMatch(/placeholder labels leaked/);
  });

  it("flags excess second-person", () => {
    const bad = goodLetter.replace(/your team\./, "your team. You, your, yours, you're, you've.");
    expect(reason(() => validateOutputs(goodSummary, bad, analysis, sel, fb))).toMatch(/second-person count/);
  });

  it('flags a banned phrase ("leverage")', () => {
    const bad = goodLetter.replace(/draws me to this role\./, "draws me to this role. I leverage synergy.");
    expect(reason(() => validateOutputs(goodSummary, bad, analysis, sel, fb))).toMatch(/banned phrase/);
  });

  it("flags a seniority overclaim in the summary (yoe < 3)", () => {
    const overclaim = "Specializing in flight software systems for mission-critical platforms.";
    expect(reason(() => validateOutputs(overclaim, goodLetter, analysis, sel, fb))).toMatch(/seniority overclaim/);
  });
});
