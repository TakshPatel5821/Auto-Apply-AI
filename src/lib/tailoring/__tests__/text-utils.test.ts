import { describe, it, expect } from "vitest";
import { clip } from "@/lib/tailoring/composition/text-utils";
import { buildFactBook, defaultCandidate } from "@/lib/tailoring/facts/load-facts";
import { composeSummary } from "@/lib/tailoring/composition/summary-builder";
import type { EmployerId, FactSelection, JobAnalysis, SkillId } from "@/lib/tailoring/types";
import { firstTwoEmployers } from "./fixtures";

describe("clip", () => {
  it("returns short text unchanged, minus trailing punctuation", () => {
    expect(clip("Built a REST API.", 95)).toBe("Built a REST API");
  });

  it("cuts at a word boundary", () => {
    expect(clip("alpha beta gamma delta", 13)).toBe("alpha beta");
  });

  it("never ends on a dangling connective word", () => {
    const text =
      "Architected a Python-based IoT data acquisition system integrating multi-sensor hardware with real-time cloud pipelines.";
    const out = clip(text, 95);
    expect(out).toBe("Architected a Python-based IoT data acquisition system integrating multi-sensor hardware");
    expect(out).not.toMatch(/\b(with|and|of|to|for|the|a)$/i);
  });

  it("strips several dangling words in a row", () => {
    expect(clip("Shipped the parser and the", 26 - 1)).toBe("Shipped the parser");
  });
});

describe("composeSummary with an employer anchor", () => {
  it("does not end the achievement fragment mid-clause", () => {
    const fb = buildFactBook(defaultCandidate());
    const [first, second] = firstTwoEmployers(fb);
    const sel: FactSelection = {
      summarySkills: ["skill:python", "skill:sql"] as SkillId[],
      summaryEmployerOrProject: first.id as EmployerId,
      letterParagraphs: {
        hook: { skills: ["skill:python"] as SkillId[] },
        evidence: { achievements: [first.achievementIds[0], second.achievementIds[0]] },
        close: { companyDetail: "x" },
      },
      presentRequiredSkills: ["skill:python", "skill:sql"] as SkillId[],
      absentRequiredSkills: [],
      resumeSkillOrder: [...fb.skills.keys()],
      resumeAchievementOrder: new Map(),
    };
    const analysis: JobAnalysis = {
      jobId: "j", companyName: "Acme", jobTitle: "Backend Engineer", jobDescription: "",
      requiredSkills: ["python", "sql"], niceToHaveSkills: [], requiredYears: 0,
      experienceLevel: "entry", atsKeywords: [], domainTags: [], seniorityFlags: [],
    };
    const summary = composeSummary(sel, fb, analysis);
    expect(summary.length).toBeLessThanOrEqual(280);
    expect(summary).not.toMatch(/\b(with|and|of|to|for|the|a|using|including)\.$/i);
  });
});
