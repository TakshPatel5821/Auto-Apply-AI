import { describe, it, expect } from "vitest";
import { isPermutation, buildSafeOverrides } from "@/lib/automation/resume-tailor";
import { RESUME_SKILLS, RESUME_EXPERIENCE, RESUME_PROJECTS } from "@/lib/automation/resume-template";
import type { ResumeContentTailor } from "@/lib/ai/claude";

const parsed = {
  rawText: "Python PHP SQL MySQL IoT Azure Linux Wireshark Tableau Excel",
  skills: ["Python", "PHP", "SQL"],
  technologies: ["MySQL", "Azure"],
};
const jd = "Looking for a Python and SQL data pipeline engineer.";

// Reworded bullets that only use facts/tech already in the résumé (safe).
const safeExp = [
  [
    "Built a Python IoT data acquisition system integrating sensors with real-time cloud pipelines for temperature, humidity, air quality, and pressure.",
    "Created Python and SQL backend pipelines plus Tableau and Excel dashboards for live sensor visualization and remote monitoring.",
    "Used TCP/IP networking, Wireshark analysis, and secure protocols on Linux/UNIX for reliable operation.",
  ],
  [
    "Built PHP and MySQL backend modules with secure authentication, session management, and input validation; tuned database queries for performance.",
    "Implemented secure authentication to protect against common web vulnerabilities.",
    "Worked with teammates on code review and quality to improve backend performance.",
  ],
];

function content(over: Partial<ResumeContentTailor>): ResumeContentTailor {
  return { reorderedSkills: [], experienceBullets: [], projectBullets: [], ...over };
}

describe("isPermutation", () => {
  it("true when reordered, false when an item is added or dropped", () => {
    expect(isPermutation(["b", "a"], ["a", "b"])).toBe(true);
    expect(isPermutation(["a", "b", "c"], ["a", "b"])).toBe(false); // added
    expect(isPermutation(["a"], ["a", "b"])).toBe(false); // dropped
  });
});

describe("buildSafeOverrides", () => {
  it("accepts skills reordering that is a true permutation", () => {
    const reorderedSkills = RESUME_SKILLS.map((g) => [...g.items].reverse());
    const out = buildSafeOverrides(content({ reorderedSkills }), parsed, jd, "Acme");
    expect(out.skills?.[0]).toEqual([...RESUME_SKILLS[0].items].reverse());
  });

  it("rejects a skill group that adds a new skill (keeps canonical for it)", () => {
    const reorderedSkills = RESUME_SKILLS.map((g, i) =>
      i === 0 ? [...g.items, "Rust"] : [...g.items].reverse()
    );
    const out = buildSafeOverrides(content({ reorderedSkills }), parsed, jd, "Acme");
    expect(out.skills?.[0]).toEqual(RESUME_SKILLS[0].items); // fell back
    expect(out.skills?.[1]).toEqual([...RESUME_SKILLS[1].items].reverse()); // accepted
  });

  it("accepts reworded bullets that only use real facts", () => {
    const out = buildSafeOverrides(content({ experienceBullets: safeExp }), parsed, jd, "Acme");
    expect(out.experienceBullets).toEqual(safeExp);
  });

  it("rejects ALL bullet overrides if any introduces a fabricated metric", () => {
    const bad = JSON.parse(JSON.stringify(safeExp));
    bad[0][0] = "Built a Python IoT system that improved efficiency by 30%.";
    const out = buildSafeOverrides(content({ experienceBullets: bad }), parsed, jd, "Acme");
    expect(out.experienceBullets).toBeUndefined();
  });

  it("rejects bullet overrides with the wrong bullet count", () => {
    const wrongCount = [safeExp[0].slice(0, 2), safeExp[1]]; // first entry missing a bullet
    const out = buildSafeOverrides(content({ experienceBullets: wrongCount }), parsed, jd, "Acme");
    expect(out.experienceBullets).toBeUndefined();
  });

  it("rejects bullets that inject a technology not in résumé or JD", () => {
    const bad = JSON.parse(JSON.stringify(safeExp));
    bad[1][0] = "Built PHP and MySQL modules and deployed them on Kubernetes and AWS.";
    const out = buildSafeOverrides(content({ experienceBullets: bad }), parsed, jd, "Acme");
    expect(out.experienceBullets).toBeUndefined();
  });
});
