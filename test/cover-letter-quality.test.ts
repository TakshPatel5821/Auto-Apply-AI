import { describe, it, expect } from "vitest";
import { matchAchievements, validateATS, scoreLetter, isAcceptable } from "@/lib/cover-letter/quality";
import { extractCandidateFacts } from "@/lib/ai/claude";

const resume = {
  rawText: "Python PHP SQL MySQL IoT Azure Linux Wireshark",
  skills: ["Python", "PHP", "SQL"],
  technologies: ["MySQL", "Azure"],
  yearsOfExperience: 1.5,
  experience: [{ company: "Brainy Bean Info Tech", title: "Intern", bullets: ["Built Python IoT data pipelines", "Developed PHP/MySQL backends"] }],
  projects: [{ name: "Weather App", bullets: ["Built a responsive weather app with JavaScript"] }],
  achievements: [],
};

describe("extractCandidateFacts — extended fields", () => {
  it("includes verifiedClaims, technologies, experienceYears", () => {
    const f = extractCandidateFacts(resume);
    expect(f.verifiedClaims.length).toBeGreaterThan(0);
    expect(f.verifiedClaims.join(" ")).toMatch(/Python IoT data pipelines/i);
    expect(f.experienceYears).toBe(1.5);
    expect(f.technologies.map((t) => t.toLowerCase())).toContain("python");
  });
});

describe("matchAchievements", () => {
  it("ranks the most relevant verified claim first (deterministic)", () => {
    const f = extractCandidateFacts(resume);
    const matched = matchAchievements(f, ["Python", "data pipelines", "backend"], 2);
    expect(matched.length).toBeLessThanOrEqual(2);
    expect(matched[0].toLowerCase()).toContain("python");
  });

  it("only ever returns real verified claims (never invents)", () => {
    const f = extractCandidateFacts(resume);
    const matched = matchAchievements(f, ["Kubernetes", "Go", "Rust"], 3);
    for (const m of matched) expect(f.verifiedClaims).toContain(m);
  });
});

describe("validateATS", () => {
  it("scores keyword coverage and lists missing skills", () => {
    const letter = "I work with Python and SQL on data pipelines.";
    const r = validateATS(letter, ["Python", "SQL", "Kubernetes"]);
    expect(r.score).toBeCloseTo(2 / 3, 5);
    expect(r.missing).toEqual(["Kubernetes"]);
  });
  it("is a perfect score when there are no required skills", () => {
    expect(validateATS("anything", []).score).toBe(1);
  });
});

describe("scoreLetter + isAcceptable", () => {
  it("a clean, well-covered letter passes", () => {
    const q = scoreLetter(0, 1);
    expect(q.passed).toBe(true);
    expect(isAcceptable(true, 0, { score: 1, missing: [] }, q)).toBe(true);
  });
  it("any hallucination fails, regardless of ATS", () => {
    const q = scoreLetter(1, 1);
    expect(q.passed).toBe(false);
    expect(isAcceptable(true, 1, { score: 1, missing: [] }, q)).toBe(false);
  });
  it("low ATS coverage is not acceptable even when clean", () => {
    const q = scoreLetter(0, 0.5);
    expect(isAcceptable(true, 0, { score: 0.5, missing: ["x", "y"] }, q)).toBe(false);
  });
});
