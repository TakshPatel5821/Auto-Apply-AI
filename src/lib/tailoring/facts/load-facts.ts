import { prisma } from "@/lib/db/prisma";
import {
  RESUME_EXPERIENCE,
  RESUME_PROJECTS,
  RESUME_SKILLS,
} from "@/lib/automation/resume-template";
import type {
  Achievement,
  AchievementId,
  Candidate,
  Employer,
  EmployerId,
  FactBook,
  Project,
  ProjectId,
  Skill,
  SkillId,
} from "../types";

// ─── Skill synonyms ──────────────────────────────────────────────────────────
// Drive JD-skill matching (Step 4/5) so e.g. "Node" in a posting maps to the
// skill:node.js fact. Keyed by the canonical skill lowercased. Keep alphabetized.
const SKILL_SYNONYMS: Record<string, string[]> = {
  "css": ["css3"],
  "excel": ["microsoft excel", "ms excel"],
  "git": ["version control"],
  "github": ["gh"],
  "html": ["html5"],
  "java": ["jdk"],
  "javascript": ["js", "ecmascript"],
  "linux/unix": ["linux", "unix"],
  "mysql": ["sql database", "my sql"],
  "node.js": ["nodejs", "node"],
  "php": ["php8"],
  "postgresql": ["postgres", "psql"],
  "powershell": ["ps", "windows powershell"],
  "python": ["py"],
  "react": ["react.js", "reactjs"],
  "rest apis": ["rest", "restful", "rest api", "api", "apis"],
  "sql": ["structured query language"],
  "tcp/ip": ["tcp", "networking"],
  "typescript": ["ts", "typed javascript"],
  "wireshark": ["packet analysis"],
};

// ─── Canonical candidate constants ───────────────────────────────────────────
// Mirror the hand-tuned résumé header + education in resume-template.ts. The DB
// Resume row's parsed contactInfo overrides these when present.
const CANONICAL_CONTACT = {
  fullName: "Patel Takshkumar Girishbhai",
  email: "takshpatel051102@gmail.com",
  phone: "+1 (214)-883-2966",
  location: "Arlington, TX",
  github: "github.com/TakshPatel5821",
  linkedin: undefined as string | undefined,
};
const CANONICAL_EDUCATION = {
  degree: "M.S. in Software Engineering",
  gradMonth: "May",
  gradYear: 2026,
};

// ─── Deterministic helpers ───────────────────────────────────────────────────

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const RE_TEXTBF = /\\textbf\{([^}]+)\}/;
const RE_TEXTIT = /\\textit\{([^}]+)\}/;
// The date range sits between \hfill and the line break (\\).
const RE_DATES = /\\hfill\s*([^\\]+?)\s*\\\\/;

function firstMatch(re: RegExp, s: string): string {
  return (s.match(re)?.[1] || "").trim();
}

// A small stoplist of common résumé verbs / filler so keywords stay nouny. The
// binding gate (Step 7) only needs a non-empty, distinctive keyword set per
// achievement, so this is intentionally conservative.
const KEYWORD_STOPLIST = new Set([
  "developed", "architected", "designed", "implemented", "created", "applied",
  "built", "independently", "responsive",
  "collaborated", "optimized", "integrated", "integrating", "tracking", "building",
  "launched", "supporting", "including", "improve", "improved", "enhance", "enhanced",
  "protect", "owning", "fetching", "review", "reviewed", "against", "various",
  "multiple", "several", "between", "through", "based", "using", "their",
  "overall", "common", "members", "remote", "live",
]);

// Lowercase, split on non-word, keep tokens ≥ 5 chars, drop the verb stoplist.
function extractKeywords(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of (text || "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (tok.length < 5) continue;
    if (KEYWORD_STOPLIST.has(tok)) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

// Match a skill token in text with rough word boundaries (handles tokens that
// contain +, #, /, . like c++, tcp/ip, node.js).
function tokenMatches(token: string, lowerText: string): boolean {
  const esc = token.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`, "i").test(lowerText);
}

// Return the SkillIds whose canonical name or any synonym appears in `text`.
function matchSkillIds(text: string, skills: Map<SkillId, Skill>): SkillId[] {
  const lower = (text || "").toLowerCase();
  const out: SkillId[] = [];
  for (const skill of skills.values()) {
    const candidates = [skill.canonical, ...skill.synonyms];
    if (candidates.some((c) => tokenMatches(c, lower))) out.push(skill.id);
  }
  return out;
}

// Sum the canonical experience date ranges (in months) → fractional years.
// Internships count as the fraction of a year they actually span.
const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
function monthsInRange(dates: string): number {
  // e.g. "Jan 2023 -- Apr 2023"
  const m = dates.match(/([A-Za-z]{3,})\s+(\d{4})\s*--\s*([A-Za-z]{3,})\s+(\d{4})/);
  if (!m) return 0;
  const a = MONTHS[m[1].slice(0, 3).toLowerCase()];
  const b = MONTHS[m[3].slice(0, 3).toLowerCase()];
  if (a == null || b == null) return 0;
  return (Number(m[4]) * 12 + b) - (Number(m[2]) * 12 + a);
}
function computeCanonicalYears(): number {
  const months = RESUME_EXPERIENCE.reduce(
    (sum, e) => sum + monthsInRange(firstMatch(RE_DATES, e.heading)),
    0
  );
  return Math.round((months / 12) * 100) / 100;
}

// Has the graduation date passed? True once we're into the month after it, so a
// "May 2026" grad reads "graduating" through May and "graduated" from June on.
function isGraduated(gradMonth: string, gradYear: number): boolean {
  const m = MONTHS[gradMonth.slice(0, 3).toLowerCase()];
  if (m == null) return false;
  return Date.now() >= new Date(gradYear, m + 1, 1).getTime();
}

// Map fractional years → coarse level. A graduating student with only internship
// spans lands in "intern"; this is a deterministic, documented threshold.
function levelFromYears(years: number): Candidate["experienceLevel"] {
  if (years < 1) return "intern";
  if (years < 3) return "entry";
  if (years < 6) return "mid";
  return "senior";
}

// ─── Candidate ───────────────────────────────────────────────────────────────

export function defaultCandidate(): Candidate {
  const years = computeCanonicalYears();
  return {
    fullName: CANONICAL_CONTACT.fullName,
    email: CANONICAL_CONTACT.email,
    phone: CANONICAL_CONTACT.phone,
    location: CANONICAL_CONTACT.location,
    github: CANONICAL_CONTACT.github,
    linkedin: CANONICAL_CONTACT.linkedin,
    degree: CANONICAL_EDUCATION.degree,
    gradMonth: CANONICAL_EDUCATION.gradMonth,
    gradYear: CANONICAL_EDUCATION.gradYear,
    graduated: isGraduated(CANONICAL_EDUCATION.gradMonth, CANONICAL_EDUCATION.gradYear),
    yearsOfProfessionalExperience: years,
    experienceLevel: levelFromYears(years),
  };
}

// Merge the DB-parsed contact over the canonical defaults. yoe prefers a positive
// DB value, else the canonical span computation.
function buildCandidate(parsedData: unknown, dbYears?: number | null): Candidate {
  const base = defaultCandidate();
  const contact =
    (parsedData && typeof parsedData === "object"
      ? (parsedData as { contactInfo?: Record<string, string> }).contactInfo
      : undefined) || {};
  const clean = (v?: string) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const years = typeof dbYears === "number" && dbYears > 0 ? dbYears : base.yearsOfProfessionalExperience;
  return {
    ...base,
    fullName: clean(contact.name) || base.fullName,
    email: clean(contact.email) || base.email,
    phone: clean(contact.phone) || base.phone,
    location: clean(contact.location) || base.location,
    github: clean(contact.github) || base.github,
    linkedin: clean(contact.linkedin) || base.linkedin,
    yearsOfProfessionalExperience: years,
    experienceLevel: levelFromYears(years),
  };
}

// ─── FactBook construction (pure) ────────────────────────────────────────────

export function buildFactBook(candidate: Candidate): FactBook {
  // 1. Skills — one fact per canonical skill item across all groups.
  const skills = new Map<SkillId, Skill>();
  for (const group of RESUME_SKILLS) {
    for (const item of group.items) {
      const id = `skill:${slugify(item)}` as SkillId;
      if (skills.has(id)) continue;
      skills.set(id, {
        id,
        canonical: item,
        synonyms: SKILL_SYNONYMS[item.toLowerCase()] || [],
      });
    }
  }

  // 2. Employers + their achievements.
  const employers = new Map<EmployerId, Employer>();
  const achievements = new Map<AchievementId, Achievement>();
  for (const entry of RESUME_EXPERIENCE) {
    const name = firstMatch(RE_TEXTBF, entry.heading);
    const role = firstMatch(RE_TEXTIT, entry.heading);
    const dates = firstMatch(RE_DATES, entry.heading);
    const empId = `employer:${slugify(name)}` as EmployerId;

    const achievementIds: AchievementId[] = [];
    const techIds = new Set<SkillId>();
    entry.bullets.forEach((text, i) => {
      const achId = `achievement:${slugify(name)}-${i + 1}` as AchievementId;
      const skillIds = matchSkillIds(text, skills);
      for (const s of skillIds) techIds.add(s);
      achievements.set(achId, {
        id: achId,
        employerId: empId,
        text,
        skillIds,
        keywords: extractKeywords(text),
      });
      achievementIds.push(achId);
    });

    employers.set(empId, {
      id: empId,
      name,
      role,
      dates,
      achievementIds,
      technologyIds: [...techIds],
    });
  }

  // 3. Projects — stack is the subset of FactBook skills named in the heading.
  const projects = new Map<ProjectId, Project>();
  for (const entry of RESUME_PROJECTS) {
    const name = firstMatch(RE_TEXTBF, entry.heading);
    const id = `project:${slugify(name)}` as ProjectId;
    const description = entry.bullets.join(" ");
    projects.set(id, {
      id,
      name,
      stack: matchSkillIds(`${entry.heading} ${description}`, skills),
      description,
      keywords: extractKeywords(`${name} ${description}`),
    });
  }

  return { candidate, skills, employers, projects, achievements };
}

// ─── Public entry point ──────────────────────────────────────────────────────
// Reads the canonical résumé content (resume-template.ts) plus the candidate's
// Resume row (contact info only) and returns a fully-built, immutable FactBook.
export async function loadFacts(resumeId: string): Promise<FactBook> {
  const resume = await prisma.resume.findUnique({ where: { id: resumeId } });
  const candidate = buildCandidate(resume?.parsedData, resume?.yearsOfExperience);
  return buildFactBook(candidate);
}
