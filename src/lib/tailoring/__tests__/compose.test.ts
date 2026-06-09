import { describe, it, expect } from "vitest";
import { buildFactBook, defaultCandidate } from "@/lib/tailoring/facts/load-facts";
import { composeSummary, LEVEL_PHRASE } from "@/lib/tailoring/composition/summary-builder";
import { composeLetter } from "@/lib/tailoring/composition/letter-builder";
import type { AchievementId, EmployerId, FactBook, FactSelection, JobAnalysis, SkillId } from "@/lib/tailoring/types";

function selection(fb: FactBook): FactSelection {
  return {
    summarySkills: ["skill:python", "skill:sql"] as SkillId[],
    summaryEmployerOrProject: "employer:brainy-bean-info-tech" as EmployerId,
    letterParagraphs: {
      hook: { skills: ["skill:python", "skill:sql"] as SkillId[] },
      evidence: { achievements: ["achievement:brainy-bean-info-tech-1", "achievement:shubhkey-infotech-1"] as [AchievementId, AchievementId] },
      close: { companyDetail: "real-time payment processing" },
    },
    presentRequiredSkills: ["skill:python", "skill:mysql", "skill:sql"] as SkillId[],
    absentRequiredSkills: ["kubernetes"],
    resumeSkillOrder: [...fb.skills.keys()],
    resumeAchievementOrder: new Map(),
  };
}

const analysis: JobAnalysis = {
  jobId: "j", companyName: "Acme Corp", jobTitle: "Backend Engineer", jobDescription: "",
  requiredSkills: ["python", "mysql", "sql"], niceToHaveSkills: [], requiredYears: 0,
  experienceLevel: "entry", atsKeywords: [], domainTags: [], seniorityFlags: [],
};

describe("composeSummary", () => {
  const fb = buildFactBook(defaultCandidate());
  it("opens with the level phrase and lists the selected skills", () => {
    const summary = composeSummary(selection(fb), fb);
    expect(summary.startsWith(LEVEL_PHRASE[fb.candidate.experienceLevel])).toBe(true);
    expect(summary).toContain("Python");
    expect(summary).toContain("SQL");
  });
});

describe("composeLetter", () => {
  const fb = buildFactBook(defaultCandidate());
  const letter = composeLetter(selection(fb), fb, analysis);
  const paragraphs = letter.split(/\n{2,}/).filter((p) => p.trim().length > 0);

  it("has exactly 3 paragraphs", () => {
    expect(paragraphs.length).toBe(3);
  });

  it('contains the literal "I" at least 3 times', () => {
    expect((letter.match(/\bI\b/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it("names both selected employers in the evidence paragraph", () => {
    expect(paragraphs[1]).toContain("Brainy Bean Info Tech");
    expect(paragraphs[1]).toContain("Shubhkey Infotech");
  });
});
