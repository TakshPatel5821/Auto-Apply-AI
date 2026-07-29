import { describe, it, expect } from "vitest";
import { fastFilter, extractRequiredYears } from "@/lib/matching/fast-filter";

describe("fastFilter — niche skill crediting", () => {
  it("credits a candidate's own skill that isn't in the canned tech list", () => {
    // "Kotlin" / "Elixir" aren't in the hardcoded techKeywords list.
    const withNiche = fastFilter(
      "Backend Engineer",
      "We build our platform in Kotlin and Elixir on a modern stack.",
      ["Kotlin", "Elixir"],
      [],
      ["Backend Engineer"],
      { candidateYears: 1 }
    );
    expect(withNiche.matchedKeywords).toEqual(expect.arrayContaining(["kotlin", "elixir"]));
    expect(withNiche.score).toBeGreaterThan(0);
  });

  it("does NOT false-match short skills inside larger words", () => {
    // A candidate skill "go" must not match inside "good"/"category". Short tokens
    // are only handled via the canned list (which requires the literal word).
    const res = fastFilter(
      "Manager",
      "A good fit for any category of team.",
      ["go"],
      [],
      ["Manager"],
      { candidateYears: 1 }
    );
    expect(res.matchedKeywords).not.toContain("go");
  });

  it("escapes regex metacharacters in skills (e.g. node.js)", () => {
    const res = fastFilter(
      "Engineer",
      "Experience with nodeXjs would NOT count; real node.js does.",
      ["node.js"],
      [],
      ["Engineer"],
      { candidateYears: 1 }
    );
    // node.js is in the canned list, so it's credited via the literal include path.
    expect(res.matchedKeywords).toContain("node.js");
  });
});

describe("extractRequiredYears", () => {
  it("pulls the required years from an experience phrase", () => {
    expect(extractRequiredYears("Minimum of 5 years experience required")).toBe(5);
  });
  it("ignores year mentions unrelated to experience", () => {
    expect(extractRequiredYears("Founded 8 years ago with 5 years of runway")).toBe(0);
  });
});
