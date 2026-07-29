import { describe, it, expect } from "vitest";
import { classifyField, validateValue, type FieldContext } from "@/lib/automation/field-classifier";

const f = (label: string, extra: Partial<FieldContext> = {}): FieldContext => ({ label, type: "text", ...extra });

describe("classifyField — new/ATS-specific coverage", () => {
  const cases: [string, string][] = [
    ["How many years of experience do you have with React?", "work_experience"],
    ["Number of years in software engineering", "work_experience"],
    ["LinkedIn Profile URL", "contact"],
    ["Portfolio / personal website", "contact"],
    ["Stack Overflow profile", "contact"],
    ["GitLab URL", "contact"],
    ["Are you able to commute to this office?", "availability"],
    ["Are you willing to work overtime or weekends?", "availability"],
    ["Earliest start date / availability", "availability"],
    ["Expected joining date", "availability"],
    ["Desired salary (USD)", "salary"],
    ["What are your wage expectations?", "salary"],
    ["Core competencies", "skills"],
    ["Areas of expertise", "skills"],
    ["How did you hear about us?", "open_ended"],
  ];
  for (const [label, expected] of cases) {
    it(`"${label}" → ${expected}`, () => {
      expect(classifyField(f(label)).category).toBe(expected);
    });
  }
});

describe("classifyField — edge cases never mis-fill", () => {
  it("empty label → unknown (will pause)", () => {
    expect(classifyField(f("")).category).toBe("unknown");
  });
  it("emoji-only label → unknown", () => {
    expect(classifyField(f("🎉🎊✨")).category).toBe("unknown");
  });
  it("non-English label with no known token → unknown", () => {
    expect(classifyField(f("Información adicional del candidato")).category).toBe("unknown");
  });
  it("a clear label still beats a misleading section heading", () => {
    expect(classifyField(f("Email Address", { sectionHeading: "Compensation" })).category).toBe("contact");
  });
});

describe("validateValue — salary accepts currency + safe placeholder", () => {
  const salary = classifyField(f("Desired Salary"));
  it("accepts a negotiable-style placeholder", () => {
    expect(validateValue(salary, "Negotiable").ok).toBe(true);
    expect(validateValue(salary, "Competitive").ok).toBe(true);
  });
  it("accepts a currency code or symbol amount", () => {
    expect(validateValue(salary, "USD").ok).toBe(true);
    expect(validateValue(salary, "$120,000").ok).toBe(true);
  });
  it("rejects a salary value with no number/currency/placeholder", () => {
    expect(validateValue(salary, "lots of money please").ok).toBe(false);
  });
});
