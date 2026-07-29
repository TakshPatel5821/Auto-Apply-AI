import { describe, it, expect } from "vitest";
import { present, atsKeywordPct, heuristicJobAnalysis } from "@/lib/ai/ats-analyzer";

// The résumé-corpus keyword matcher. These lock in the word-boundary behaviour:
// short tokens must NOT match inside longer words, punctuated tech names stay
// literal, and punctuation-insensitive variants (node.js ↔ nodejs) still match.
describe("present() — résumé keyword matching", () => {
  const corpus =
    "experienced in python, java, sql. built a category system and email training. " +
    "worked with node.js, c++, c#, and .net. co-founder of a cargo startup. react.js and asp.net."
      .toLowerCase();

  describe("no false positives inside longer words", () => {
    it.each([
      ["go", "cargo / category"],
      ["ai", "email / training"],
      ["r", "everywhere"],
      ["cat", "category"],
      ["art", "startup"],
      ["train", "training (substring, not a word)"],
    ])("does not match %j inside %s", (kw) => {
      expect(present(kw, corpus)).toBe(false);
    });
  });

  describe("real skills present as whole words", () => {
    it.each(["python", "java", "sql", "cargo"])("matches %j", (kw) => {
      expect(present(kw, corpus)).toBe(true);
    });
  });

  describe("punctuated tech names stay literal", () => {
    it.each(["c++", "c#", ".net"])("matches %j", (kw) => {
      expect(present(kw, corpus)).toBe(true);
    });
  });

  describe("punctuation-insensitive variants", () => {
    // "nodejs"/"reactjs" are the clean keyword vs. the punctuated corpus form.
    it.each(["node.js", "nodejs", "react.js", "reactjs"])(
      "matches %j against the corpus",
      (kw) => {
        expect(present(kw, corpus)).toBe(true);
      },
    );
  });

  it("is case-insensitive", () => {
    expect(present("PYTHON", corpus)).toBe(true);
    expect(present("Node.JS", corpus)).toBe(true);
  });

  it("returns false for empty / whitespace keywords", () => {
    expect(present("", corpus)).toBe(false);
    expect(present("   ", corpus)).toBe(false);
  });

  it("does not match an absent keyword", () => {
    expect(present("golang", corpus)).toBe(false);
    expect(present("kubernetes", corpus)).toBe(false);
  });
});

// The deterministic fallback that keeps the ATS checker working with no AI.
describe("heuristicJobAnalysis() — offline JD keyword extraction", () => {
  it("extracts required skills from a plain job description", () => {
    const ja = heuristicJobAnalysis(
      "Backend engineer with Python, AWS, and Docker. 4 years of experience required.",
    );
    expect(ja.requiredSkills).toEqual(expect.arrayContaining(["python", "aws", "docker"]));
    expect(ja.yearsRequired).toBe(4);
  });

  it("demotes terms under a 'nice to have' section to niceToHaveSkills", () => {
    const ja = heuristicJobAnalysis(
      "Required: Python and PostgreSQL.\nNice to have: Kubernetes and GraphQL experience.",
    );
    expect(ja.requiredSkills).toEqual(expect.arrayContaining(["python", "postgresql"]));
    expect(ja.requiredSkills).not.toContain("kubernetes");
    expect(ja.niceToHaveSkills).toEqual(expect.arrayContaining(["kubernetes", "graphql"]));
  });

  it("returns empty skill lists when the JD has no recognized tech", () => {
    const ja = heuristicJobAnalysis("Seeking a friendly office manager with great communication.");
    expect(ja.requiredSkills).toEqual([]);
    expect(ja.atsKeywords).toEqual([]);
  });
});

describe("atsKeywordPct()", () => {
  it("returns null when there is nothing to match", () => {
    expect(atsKeywordPct([], [])).toBeNull();
  });

  it("computes the matched fraction as a rounded percentage", () => {
    expect(atsKeywordPct(["a", "b", "c"], ["d"])).toBe(75); // 3 of 4
    expect(atsKeywordPct(["a"], ["b", "c"])).toBe(33); // 1 of 3 → 33
    expect(atsKeywordPct(["a", "b"], [])).toBe(100);
    expect(atsKeywordPct([], ["a", "b"])).toBe(0);
  });
});
