// ─── Canonical résumé configuration ──────────────────────────────────────────
// The candidate's real, hand-verified résumé facts. This is the SINGLE source of
// truth the whole tailoring pipeline builds its FactBook from: the tailor may
// reorder and reword what is here, but it can never invent a fact that is not.
//
// Resolution order (first hit wins):
//   1. $RESUME_CONFIG_PATH            — explicit override (CI, Docker, tests)
//   2. <cwd>/config/resume.json       — your real résumé (gitignored)
//   3. <cwd>/config/resume.example.json — committed placeholder, so a fresh
//                                       clone boots and every test still runs
//
// Personal data deliberately does NOT live in source. Keeping it in a gitignored
// config file is what lets this repository be published without shipping one
// person's name, phone number, and work history to everyone who clones it.

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { z } from "zod";

// ─── Schema ──────────────────────────────────────────────────────────────────
// Validated on load so a malformed hand-edited config fails loudly at startup
// with a field path, instead of silently rendering a broken résumé.

const nonEmpty = z.string().trim().min(1);

const contactSchema = z.object({
  fullName: nonEmpty,
  email: nonEmpty.email("must be a valid email address"),
  phone: nonEmpty,
  location: nonEmpty,
  github: z.string().trim().optional(),
  linkedin: z.string().trim().optional(),
});

const educationSchema = z.object({
  school: nonEmpty,
  location: z.string().trim().default(""),
  start: nonEmpty,
  end: nonEmpty,
  degree: nonEmpty,
});

const experienceSchema = z.object({
  company: nonEmpty,
  location: z.string().trim().default(""),
  start: nonEmpty,
  end: nonEmpty,
  title: nonEmpty,
  bullets: z.array(nonEmpty).min(1, "each experience entry needs at least one bullet"),
});

const projectSchema = z.object({
  name: nonEmpty,
  tech: z.string().trim().default(""),
  bullets: z.array(nonEmpty).min(1, "each project needs at least one bullet"),
});

const skillGroupSchema = z.object({
  label: nonEmpty,
  items: z.array(nonEmpty).min(1),
});

// `_comment` / `$schema` are documentation keys in the example file — allowed
// through and ignored rather than rejected.
const resumeConfigSchema = z.object({
  contact: contactSchema,
  baseSummary: nonEmpty,
  education: z.array(educationSchema).min(1),
  experience: z.array(experienceSchema),
  projects: z.array(projectSchema),
  skills: z.array(skillGroupSchema).min(1),
  certifications: z.array(nonEmpty).default([]),
});

export type ResumeConfig = z.infer<typeof resumeConfigSchema>;
export type EducationEntry = z.infer<typeof educationSchema>;
export type ExperienceEntry = z.infer<typeof experienceSchema>;
export type ProjectEntry = z.infer<typeof projectSchema>;

// ─── Loading ─────────────────────────────────────────────────────────────────

export const REAL_CONFIG_PATH = join(process.cwd(), "config", "resume.json");
export const EXAMPLE_CONFIG_PATH = join(process.cwd(), "config", "resume.example.json");

function resolveConfigPath(): string {
  const override = process.env.RESUME_CONFIG_PATH;
  if (override && existsSync(override)) return override;
  if (existsSync(REAL_CONFIG_PATH)) return REAL_CONFIG_PATH;
  return EXAMPLE_CONFIG_PATH;
}

/** True when running on the committed placeholder rather than a real résumé. */
export function isUsingExampleResume(): boolean {
  return resolveConfigPath() === EXAMPLE_CONFIG_PATH;
}

let cached: ResumeConfig | null = null;

/**
 * Read, validate and cache the résumé config. Throws a descriptive error if the
 * file is missing or invalid — this is startup configuration, so failing fast
 * beats generating a résumé full of blanks.
 */
export function loadResumeConfig(): ResumeConfig {
  if (cached) return cached;

  const path = resolveConfigPath();
  if (!existsSync(path)) {
    throw new Error(
      `Résumé config not found. Copy config/resume.example.json to config/resume.json and fill in your details (looked for: ${path}).`
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    throw new Error(`Résumé config at ${path} is not valid JSON: ${(e as Error).message}`);
  }

  const parsed = resumeConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  • ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Résumé config at ${path} is invalid:\n${details}`);
  }

  cached = parsed.data;
  return cached;
}

/** Test-only: drop the cache so a different config file can be loaded. */
export function resetResumeConfigCache(): void {
  cached = null;
}
