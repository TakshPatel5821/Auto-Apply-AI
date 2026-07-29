import { describe, it, expect } from "vitest";
import {
  classifyField,
  validateValue,
  decideFill,
  isSensitive,
  aiMayAnswer,
  type FieldContext,
} from "@/lib/automation/field-classifier";

const f = (label: string, extra: Partial<FieldContext> = {}): FieldContext => ({
  label,
  type: "text",
  ...extra,
});

describe("classifyField — categories", () => {
  const cases: [string, string][] = [
    ["First Name", "identity"],
    ["Last Name *", "identity"],
    ["Email Address", "contact"],
    ["Phone Number", "contact"],
    ["Street Address", "address"],
    ["Highest Degree", "education"],
    ["University", "education"],
    ["Years of Experience", "work_experience"],
    ["Are you legally authorized to work in the US?", "work_authorization"],
    ["Will you now or in the future require visa sponsorship?", "sponsorship"],
    ["What is your gender identity?", "eeo"],
    ["What gender pronouns do you prefer?", "eeo"],
    ["What is your race or ethnicity?", "eeo"],
    ["What is your military status?", "veteran"],
    ["What is your disability status?", "disability"],
    ["Desired salary", "salary"],
    ["Expected compensation", "salary"],
    ["When can you start?", "availability"],
    ["Are you willing to relocate?", "availability"],
    ["Why are you interested in this role?", "open_ended"],
    ["Tell us about a project you're proud of", "open_ended"],
  ];
  for (const [label, expected] of cases) {
    it(`"${label}" → ${expected}`, () => {
      expect(classifyField(f(label)).category).toBe(expected);
    });
  }

  it("classifies the Robinhood government-official question as eeo/compliance-ish, never open_ended", () => {
    const label =
      "Do you currently hold or have you held, within the last 5 years, a position as a government official?";
    const cat = classifyField(f(label)).category;
    expect(cat).not.toBe("open_ended");
  });

  it("a bare textarea with no signal is open_ended", () => {
    expect(classifyField(f("", { type: "textarea" })).category).toBe("open_ended");
  });

  it("section heading only disambiguates when the field text is inconclusive", () => {
    // Clear label wins over a misleading section heading.
    expect(classifyField(f("First Name", { sectionHeading: "Compensation" })).category).toBe("identity");
    // Bare label leans on the heading.
    expect(classifyField(f("Amount", { sectionHeading: "Salary expectations" })).category).toBe("salary");
  });
});

describe("do-not-AI + sensitive policy", () => {
  it("only open_ended may be AI-answered", () => {
    expect(aiMayAnswer("open_ended")).toBe(true);
    for (const c of ["identity", "contact", "education", "work_authorization", "sponsorship", "eeo", "salary"] as const) {
      expect(aiMayAnswer(c)).toBe(false);
    }
  });
  it("legal/EEO/compensation categories are sensitive", () => {
    for (const c of ["work_authorization", "sponsorship", "eeo", "veteran", "disability", "salary"] as const) {
      expect(isSensitive(c)).toBe(true);
    }
    expect(isSensitive("identity")).toBe(false);
  });
});

describe("decideFill — confidence gates", () => {
  it("sensitive without a profile value always pauses", () => {
    expect(decideFill("sponsorship", 0.99, false)).toBe("pause_blank");
  });
  it("sensitive WITH a profile value follows normal gates", () => {
    expect(decideFill("sponsorship", 0.99, true)).toBe("autofill");
  });
  it(">=95 autofill, 85-94 verify, 60-84 pause, <60 pause", () => {
    expect(decideFill("contact", 0.96, false)).toBe("autofill");
    expect(decideFill("contact", 0.9, false)).toBe("fill_and_verify");
    expect(decideFill("open_ended", 0.7, false)).toBe("pause_low_confidence");
    expect(decideFill("open_ended", 0.4, false)).toBe("pause_blank");
  });
});

describe("validateValue — value must fit the field", () => {
  const cls = (label: string, type = "text", options?: string[]) =>
    classifyField({ label, type, options });

  it("rejects an email in a name field", () => {
    expect(validateValue(cls("First Name"), "me@example.com").ok).toBe(false);
  });
  it("rejects a URL / digits in a name field", () => {
    expect(validateValue(cls("Last Name"), "http://x.com").ok).toBe(false);
    expect(validateValue(cls("Last Name"), "John 12345").ok).toBe(false);
  });
  it("accepts a normal name", () => {
    expect(validateValue(cls("First Name"), "Jordan").ok).toBe(true);
  });
  it("email field requires an email", () => {
    expect(validateValue(cls("Email", "email"), "not an email").ok).toBe(false);
    expect(validateValue(cls("Email", "email"), "a@b.co").ok).toBe(true);
  });
  it("phone field rejects an email and requires digits", () => {
    expect(validateValue(cls("Phone", "tel"), "a@b.co").ok).toBe(false);
    expect(validateValue(cls("Phone", "tel"), "+1 (555) 010-4477").ok).toBe(true);
  });
  it("rejects a paragraph in a yes/no dropdown", () => {
    const c = cls("Authorized to work?", "select", ["Yes", "No"]);
    const para = "I have 1.5 years of experience which is relevant for most positions and roles.";
    expect(validateValue(c, para, ["Yes", "No"]).ok).toBe(false);
    expect(validateValue(c, "Yes", ["Yes", "No"]).ok).toBe(true);
  });
  it("rejects prose in an education/degree field", () => {
    const c = cls("Highest Degree");
    const para = "I studied many things over many years across multiple universities and programs worldwide.";
    expect(validateValue(c, para).ok).toBe(false);
    expect(validateValue(c, "Master of Science").ok).toBe(true);
  });
});
