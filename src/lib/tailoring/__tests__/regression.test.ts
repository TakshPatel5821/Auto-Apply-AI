import { describe, it, expect } from "vitest";
import { buildFactBook, defaultCandidate } from "@/lib/tailoring/facts/load-facts";
import { preFilter } from "@/lib/tailoring/routing/pre-filter";
import { computeRequiredSkillMatch, verifySelection } from "@/lib/tailoring/composition/select-facts";
import {
  EligibilityError,
  ValidationError,
  type AchievementId,
  type EmployerId,
  type FactBook,
  type FactSelection,
  type JobAnalysis,
  type SkillId,
} from "@/lib/tailoring/types";
import { firstTwoEmployers, twoEvidenceAchievements } from "./fixtures";

function analysis(over: Partial<JobAnalysis>): JobAnalysis {
  return {
    jobId: "j", companyName: "Acme", jobTitle: "Engineer", jobDescription: "",
    requiredSkills: [], niceToHaveSkills: [], requiredYears: 0, experienceLevel: "entry",
    atsKeywords: [], domainTags: [], seniorityFlags: [],
    ...over,
  };
}

// A fully-valid selection over the real FactBook (passes verifySelection).
function validSelection(fb: FactBook): FactSelection {
  const order = new Map<EmployerId, AchievementId[]>();
  for (const [id, e] of fb.employers) order.set(id, [...e.achievementIds]);
  const [first] = firstTwoEmployers(fb);
  return {
    summarySkills: ["skill:python"] as SkillId[],
    summaryEmployerOrProject: first.id as EmployerId,
    letterParagraphs: {
      hook: { skills: ["skill:python"] as SkillId[] },
      evidence: { achievements: [...twoEvidenceAchievements(fb)] as [AchievementId, AchievementId] },
      close: { companyDetail: "x" },
    },
    presentRequiredSkills: ["skill:python"] as SkillId[],
    absentRequiredSkills: [],
    resumeSkillOrder: [...fb.skills.keys()],
    resumeAchievementOrder: order,
  };
}

describe("regression: Vast (aerospace) — preFilter", () => {
  it("rejects an aerospace-tagged JD with zero candidate overlap", () => {
    const fb = buildFactBook(defaultCandidate());
    expect(() => preFilter(analysis({ domainTags: ["aerospace"] }), fb)).toThrow(EligibilityError);
  });
});

describe("regression: Mountain Park (Active Directory) — 30% floor", () => {
  it("yields an empty required-skill match and trips the eligibility floor", () => {
    const fb = buildFactBook(defaultCandidate());
    const a = analysis({ requiredSkills: ["Active Directory", "LDAP", "Group Policy"] });
    const { present, absent } = computeRequiredSkillMatch(a, fb);
    expect(present.length).toBe(0);
    expect(absent.length).toBe(3);

    const sel = validSelection(fb);
    sel.presentRequiredSkills = present;
    sel.absentRequiredSkills = absent;
    expect(() => verifySelection(sel, fb)).toThrow(EligibilityError);
  });
});

describe("regression: unknown fact id — verifySelection", () => {
  it("throws ValidationError when an evidence achievement id does not exist", () => {
    const fb = buildFactBook(defaultCandidate());
    const sel = validSelection(fb);
    sel.letterParagraphs.evidence.achievements = [
      "achievement:does-not-exist" as AchievementId,
      twoEvidenceAchievements(fb)[1],
    ];
    let caught: unknown;
    try { verifySelection(sel, fb); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).reason).toMatch(/unknown achievement/);
  });
});
