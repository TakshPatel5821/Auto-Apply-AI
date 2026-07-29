import { describe, it, expect } from "vitest";
import { resolveField, seedProfileFromResume, type Profile } from "@/lib/profile/profile";

describe("resolveField — label → profile spec", () => {
  const empty: Profile = {};

  it("maps name/email to identity/contact", () => {
    expect(resolveField("First Name", empty)?.spec.key).toBe("firstName");
    expect(resolveField("Email Address", empty)?.spec.key).toBe("email");
  });

  it("'gender pronouns' resolves to pronouns, NOT gender", () => {
    expect(resolveField("What gender pronouns do you prefer?", empty)?.spec.key).toBe("pronouns");
    expect(resolveField("What is your gender identity?", empty)?.spec.key).toBe("gender");
  });

  it("government-official question resolves to a compliance spec", () => {
    const r = resolveField(
      "Are you related to or have a close personal relationship with a government official?",
      empty
    );
    expect(r?.spec.compliance).toBe(true);
  });

  it("salary + citizenship are compliance (AI never fills)", () => {
    expect(resolveField("Desired salary", empty)?.spec.compliance).toBe(true);
    expect(resolveField("Are you a U.S. citizen?", empty)?.spec.compliance).toBe(true);
  });

  it("visa/sponsorship resolve to immigration compliance specs", () => {
    expect(resolveField("Will you require visa sponsorship?", empty)?.spec.key).toBe("requiresSponsorship");
    expect(resolveField("Are you legally authorized to work in the US?", empty)?.spec.key).toBe("workAuthorized");
  });

  it("preference fields resolve (work mode, relocate, start date)", () => {
    expect(resolveField("Are you willing to work from the office?", empty)?.spec.key).toBe("workPreference");
    expect(resolveField("Are you willing to relocate?", empty)?.spec.key).toBe("willingToRelocate");
    expect(resolveField("When can you start?", empty)?.spec.key).toBe("startDate");
  });

  it("returns a stored value when present", () => {
    const profile: Profile = {
      firstName: { value: "Taksh", category: "identity", confidence: 1, locked: true, kind: "text" },
    };
    const r = resolveField("First Name", profile);
    expect(r?.field?.value).toBe("Taksh");
    expect(r?.field?.locked).toBe(true);
  });
});

describe("seedProfileFromResume", () => {
  it("seeds identity/contact/current-role/skills without clobbering locked fields", () => {
    const existing: Profile = {
      firstName: { value: "LOCKED", category: "identity", confidence: 1, locked: true, kind: "text" },
    };
    const seeded = seedProfileFromResume(existing, {
      contactInfo: { name: "Taksh Patel", email: "t@x.com", location: "Arlington" },
      yearsOfExperience: 2,
      experience: [{ company: "Acme", title: "Engineer", current: true }],
      skills: ["TypeScript", "React", "Node"],
    });
    expect(seeded.firstName.value).toBe("LOCKED"); // locked untouched
    expect(seeded.email.value).toBe("t@x.com");
    expect(seeded.currentCompany.value).toBe("Acme");
    expect(seeded.currentTitle.value).toBe("Engineer");
    expect(seeded.skills.value).toContain("TypeScript");
  });
});
