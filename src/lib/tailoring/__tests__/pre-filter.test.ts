import { describe, it, expect } from "vitest";
import { buildFactBook, defaultCandidate } from "@/lib/tailoring/facts/load-facts";
import { preFilter } from "@/lib/tailoring/routing/pre-filter";
import { EligibilityError, type Candidate, type JobAnalysis } from "@/lib/tailoring/types";

function analysis(over: Partial<JobAnalysis>): JobAnalysis {
  return {
    jobId: "j", companyName: "Acme", jobTitle: "Engineer", jobDescription: "",
    requiredSkills: [], niceToHaveSkills: [], requiredYears: 0, experienceLevel: "entry",
    atsKeywords: [], domainTags: [], seniorityFlags: [],
    ...over,
  };
}

function fbWith(candidate: Partial<Candidate>) {
  return buildFactBook({ ...defaultCandidate(), ...candidate });
}

describe("preFilter", () => {
  it("rejects a senior-titled role when yoe < 5", () => {
    const fb = fbWith({ yearsOfProfessionalExperience: 0.5 });
    expect(() => preFilter(analysis({ seniorityFlags: ["senior"] }), fb)).toThrow(EligibilityError);
  });

  it("rejects requiredYears = 5 when yoe = 0", () => {
    const fb = fbWith({ yearsOfProfessionalExperience: 0, experienceLevel: "intern" });
    expect(() => preFilter(analysis({ requiredYears: 5, experienceLevel: "mid" }), fb)).toThrow(EligibilityError);
  });

  it("rejects a hard clinical/healthcare domain with no candidate overlap", () => {
    // The spec's hardDomains list (implemented verbatim) gates clinical/medical-device,
    // representing the healthcare space the candidate has zero exposure to.
    const fb = fbWith({});
    expect(() => preFilter(analysis({ domainTags: ["clinical"] }), fb)).toThrow(EligibilityError);
  });

  it("passes an entry-level web role within reach", () => {
    const fb = fbWith({ yearsOfProfessionalExperience: 0.5 });
    expect(() => preFilter(analysis({ requiredYears: 1, experienceLevel: "entry", domainTags: ["web"], requiredSkills: ["python"] }), fb)).not.toThrow();
  });
});
