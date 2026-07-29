import type { Job } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { Logger } from "@/lib/logging/logger";
import { getApplicationFolder } from "@/lib/storage/file-manager";
import { loadFacts } from "./facts/load-facts";
import { analyzeJob } from "./analysis/analyze-jd";
import { preFilter } from "./routing/pre-filter";
import { selectFacts } from "./composition/select-facts";
import { composeSummary } from "./composition/summary-builder";
import { composeLetter } from "./composition/letter-builder";
import { validateOutputs } from "./validation/gates";
import { renderCanonicalResumeLatex, renderResumeLatex } from "./rendering/resume-latex";
import { renderLetterLatex } from "./rendering/letter-latex";
import { compileBoth } from "./rendering/compile";
import { persist } from "./persistence/save";
import {
  EligibilityError,
  ValidationError,
  type FactBook,
  type FactSelection,
  type JobAnalysis,
  type TailorHints,
  type TailorResult,
} from "./types";

// Re-export the error types + result shape so callers import everything from
// "@/lib/tailoring".
export { EligibilityError, ValidationError } from "./types";
export type { TailorResult, TailorHints } from "./types";

// The generated application materials, before any PDF compile or DB write. The
// screening loop regenerates this cheaply each round and only finalizes the
// accepted version.
export interface ComposedApplication {
  job: Job;
  facts: FactBook;
  analysis: JobAnalysis;
  sel: FactSelection;
  summary: string;
  letter: string;
}

// A simple, deterministic ATS score (0–10) + featured keywords from the
// deterministic required-skill match — no LLM scoring.
function atsMetrics(sel: FactSelection, facts: FactBook): { atsScore: number; keywordsAdded: string[] } {
  const present = sel.presentRequiredSkills;
  const total = present.length + sel.absentRequiredSkills.length;
  const atsScore = total > 0 ? Math.round((present.length / total) * 10) : 5;
  const keywordsAdded = present
    .map((id) => facts.skills.get(id)?.canonical)
    .filter((s): s is string => !!s);
  return { atsScore, keywordsAdded };
}

// Pure generation: loadFacts → analyzeJob → preFilter → selectFacts → compose →
// validate. NO DB writes, NO PDF compile. Throws EligibilityError (not a fit) or
// ValidationError (a template regression). `hints` lets a caller (the screening
// loop) ask selectFacts to feature specific REAL skills more prominently.
export async function composeApplication(
  resumeId: string,
  jobId: string,
  hints?: TailorHints
): Promise<ComposedApplication> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new Error("Job not found");

  const facts = await loadFacts(resumeId);
  const analysis = await analyzeJob(jobId);
  preFilter(analysis, facts);

  const sel = await selectFacts(analysis, facts, hints); // may throw EligibilityError (30% floor)
  const summary = composeSummary(sel, facts, analysis);
  const letter = composeLetter(sel, facts, analysis);
  try {
    validateOutputs(summary, letter, analysis, sel, facts);
  } catch (e) {
    if (e instanceof ValidationError) {
      await Logger.error("TAILOR-V3", JSON.stringify({ jobId, gate: e.gate, reason: e.reason, summary, letter }));
    }
    throw e;
  }

  return { job, facts, analysis, sel, summary, letter };
}

// Compile both PDFs + persist the TailoredResume / CoverLetter (sets the job
// TAILORED). The back half of tailorJob, reusable by the screening loop once an
// application is accepted.
export async function finalize(resumeId: string, jobId: string, c: ComposedApplication): Promise<TailorResult> {
  const folderPath = getApplicationFolder(c.job.companyName, c.job.jobTitle);
  const overrideTex = renderResumeLatex(c.sel, c.facts, c.summary);
  const canonicalTex = renderCanonicalResumeLatex(c.summary);
  const letterTex = renderLetterLatex(c.letter, c.facts, c.analysis);
  const { resumePdf, letterPdf, resumeTexUsed } = await compileBoth(overrideTex, canonicalTex, letterTex, folderPath);

  const { atsScore, keywordsAdded } = atsMetrics(c.sel, c.facts);
  const tailoringNotes = `Featured ${keywordsAdded.slice(0, 6).join(", ") || "core skills"}${
    c.sel.absentRequiredSkills.length ? `; not claimed: ${c.sel.absentRequiredSkills.slice(0, 6).join(", ")}` : ""
  }`;

  return persist({
    resumeId,
    jobId,
    companyName: c.job.companyName,
    jobTitle: c.job.jobTitle,
    jobDescription: c.job.description,
    matchScore: c.job.matchScore,
    folderPath,
    summary: c.summary,
    letter: c.letter,
    resumeTex: resumeTexUsed,
    letterTex,
    resumePdf,
    letterPdf,
    atsScore,
    keywordsAdded,
    sectionsModified: ["summary", "skills", "experience"],
    tailoringNotes,
  });
}

// The ONE public entry point. Signature is backward-compatible (the optional
// hints are only used by the screening loop). The LLM runs only in analyzeJob +
// selectFacts, both returning structured data — a fabricated skill cannot be
// expressed because there is no fact id for it.
export async function tailorJob(resumeId: string, jobId: string, hints?: TailorHints): Promise<TailorResult> {
  const start = Date.now();
  try {
    const composed = await composeApplication(resumeId, jobId, hints);

    await prisma.job.update({ where: { id: jobId }, data: { status: "TAILORING" } });
    await Logger.info("TAILOR-V3", `Tailoring ${composed.job.jobTitle} @ ${composed.job.companyName}`);

    const result = await finalize(resumeId, jobId, composed);
    const secs = ((Date.now() - start) / 1000).toFixed(1);
    await Logger.success("TAILOR-V3", `Tailored ${composed.job.companyName} in ${secs}s`);
    return result;
  } catch (e) {
    if (e instanceof EligibilityError) {
      await prisma.job.update({ where: { id: jobId }, data: { status: "SKIPPED" } }).catch(() => {});
      await Logger.info("TAILOR-V3", `Skipped job ${jobId}: ${e.reason}`);
    }
    throw e;
  }
}
