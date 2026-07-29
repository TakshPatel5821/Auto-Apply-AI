import { describe, it, expect } from "vitest";
import { tokenInText, extractKeywords, TECH_KEYWORDS } from "@/lib/matching/keywords";

describe("tokenInText", () => {
  it("matches whole-word alphanumeric tokens", () => {
    expect(tokenInText("go", "we use go for backend")).toBe(true);
    expect(tokenInText("python", "strong python skills")).toBe(true);
  });

  it("does not match a token inside a larger word", () => {
    expect(tokenInText("go", "a good fit for any category")).toBe(false);
    expect(tokenInText("java", "javascript only")).toBe(false); // 'java' inside 'javascript'
  });

  it("matches punctuated tokens by substring", () => {
    expect(tokenInText("c++", "5 years of c++")).toBe(true);
    expect(tokenInText("node.js", "built on node.js")).toBe(true);
    expect(tokenInText("ci/cd", "owns the ci/cd pipeline")).toBe(true);
    expect(tokenInText("node.js", "nodeXjs is not a match")).toBe(false);
  });

  it("is case-insensitive and handles empty input", () => {
    expect(tokenInText("AWS", "deployed to aws")).toBe(true);
    expect(tokenInText("", "anything")).toBe(false);
  });
});

describe("extractKeywords", () => {
  it("extracts the tech terms present in a job description", () => {
    const jd =
      "We're hiring a Python engineer. Experience with AWS, Docker, PostgreSQL, " +
      "and React required. Machine learning and Power BI are a plus.";
    const found = extractKeywords(jd);
    expect(found).toEqual(
      expect.arrayContaining(["python", "aws", "docker", "postgresql", "react", "machine learning", "power bi"]),
    );
  });

  it("does not extract absent terms or short false-positives", () => {
    const jd = "A good manager for the category team. Great culture.";
    const found = extractKeywords(jd);
    expect(found).not.toContain("go"); // inside 'good'/'category'
    expect(found).not.toContain("java");
  });

  it("uses TECH_KEYWORDS by default and accepts a custom dictionary", () => {
    expect(TECH_KEYWORDS.length).toBeGreaterThan(50);
    expect(extractKeywords("we love Rust here", ["rust", "go"])).toEqual(["rust"]);
  });
});
