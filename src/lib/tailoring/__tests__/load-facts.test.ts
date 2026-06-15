import { describe, it, expect } from "vitest";
import {
  buildFactBook,
  defaultCandidate,
  dedupeGithubProjects,
  nearDuplicateProjectName,
} from "@/lib/tailoring/facts/load-facts";
import { RESUME_EXPERIENCE } from "@/lib/automation/resume-template";

describe("loadFacts / buildFactBook", () => {
  const fb = buildFactBook(defaultCandidate());

  it("every employer in RESUME_EXPERIENCE becomes an Employer with >=1 Achievement", () => {
    expect(fb.employers.size).toBe(RESUME_EXPERIENCE.length);
    for (const emp of fb.employers.values()) {
      expect(emp.name.length).toBeGreaterThan(0);
      expect(emp.achievementIds.length).toBeGreaterThan(0);
      for (const id of emp.achievementIds) {
        expect(fb.achievements.has(id)).toBe(true);
        expect(fb.achievements.get(id)!.employerId).toBe(emp.id);
      }
    }
  });

  it("every Achievement has non-empty keywords", () => {
    expect(fb.achievements.size).toBeGreaterThan(0);
    for (const ach of fb.achievements.values()) {
      expect(ach.keywords.length).toBeGreaterThan(0);
    }
  });

  it("every Skill has a canonical name", () => {
    expect(fb.skills.size).toBeGreaterThan(0);
    for (const skill of fb.skills.values()) {
      expect(skill.id.startsWith("skill:")).toBe(true);
      expect(skill.canonical.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("dedupeGithubProjects", () => {
  it("collapses a near-duplicate repo, keeping the entry with the real bullet", () => {
    const rows = [
      { name: "Test Case Check By Jacoco", bullet: "Code coverage analysis for Java projects using JaCoCo.", stars: 1 },
      { name: "TestCaseCheckByJacoco JAVA", bullet: "TestCaseCheckByJacoco JAVA a project built with code.", stars: 0 },
    ];
    const out = dedupeGithubProjects(rows);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Test Case Check By Jacoco");
  });

  it("keeps genuinely distinct projects", () => {
    const rows = [
      { name: "Bank Management System", bullet: "Web-based banking application.", stars: 2 },
      { name: "ai-job-agent", bullet: "Job application automation tool.", stars: 5 },
    ];
    expect(dedupeGithubProjects(rows)).toHaveLength(2);
  });

  it("does not collapse on short shared fragments", () => {
    expect(nearDuplicateProjectName("api", "apiserver")).toBe(false);
    expect(nearDuplicateProjectName("Weather", "WeatherApp")).toBe(true);
    expect(nearDuplicateProjectName("TestCaseCheckByJacoco", "TestCaseCheckByJacoco JAVA")).toBe(true);
  });
});
