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
import { EligibilityError, ValidationError, type FactBook, type FactSelection, type TailorResult } from "./types";

// Re-export the error types + result shape so callers import everything from
// "@/lib/tailoring".
export { EligibilityError, ValidationError } from "./types";
export type { TailorResult } from "./types";

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

// The ONE public entry point. Signature is unchanged from the old engine so the
// three callers keep working. The LLM runs only in analyzeJob + selectFacts, and
// both return structured data — a fabricated skill cannot be expressed because
// there is no fact id for it.
export async function tailorJob(resumeId: string, jobId: string): Promise<TailorResult> {
  const start = Date.now();
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new Error("Job not found");

  const facts = await loadFacts(resumeId);
  const analysis = await analyzeJob(jobId);

  let summary = "";
  let letter = "";
  try {
    // Cheap routing gates first — an ineligible job never gets marked TAILORING.
    preFilter(analysis, facts);

    await prisma.job.update({ where: { id: jobId }, data: { status: "TAILORING" } });
    await Logger.info("TAILOR-V3", `Tailoring ${job.jobTitle} @ ${job.companyName}`);

    const sel = await selectFacts(analysis, facts); // may throw EligibilityError (30% floor)
    summary = composeSummary(sel, facts);
    letter = composeLetter(sel, facts, analysis);
    validateOutputs(summary, letter, analysis, sel, facts);

    const folderPath = getApplicationFolder(job.companyName, job.jobTitle);
    const overrideTex = renderResumeLatex(sel, facts, summary);
    const canonicalTex = renderCanonicalResumeLatex(summary);
    const letterTex = renderLetterLatex(letter, facts, analysis);
    const { resumePdf, letterPdf, resumeTexUsed } = await compileBoth(
      overrideTex,
      canonicalTex,
      letterTex,
      folderPath
    );

    const { atsScore, keywordsAdded } = atsMetrics(sel, facts);
    const tailoringNotes = `Featured ${keywordsAdded.slice(0, 6).join(", ") || "core skills"}${
      sel.absentRequiredSkills.length ? `; not claimed: ${sel.absentRequiredSkills.slice(0, 6).join(", ")}` : ""
    }`;

    const result = await persist({
      resumeId,
      jobId,
      companyName: job.companyName,
      jobTitle: job.jobTitle,
      jobDescription: job.description,
      matchScore: job.matchScore,
      folderPath,
      summary,
      letter,
      resumeTex: resumeTexUsed,
      letterTex,
      resumePdf,
      letterPdf,
      atsScore,
      keywordsAdded,
      sectionsModified: ["summary", "skills", "experience"],
      tailoringNotes,
    });

    const secs = ((Date.now() - start) / 1000).toFixed(1);
    await Logger.success("TAILOR-V3", `Tailored ${job.companyName} in ${secs}s (PDF: ${resumePdf ? "ready" : "skipped/failed"})`);
    return result;
  } catch (e) {
    if (e instanceof EligibilityError) {
      // Soft-skip: mark the job SKIPPED so all callers get consistent DB state,
      // then rethrow so each caller does its own bookkeeping.
      await prisma.job.update({ where: { id: jobId }, data: { status: "SKIPPED" } }).catch(() => {});
      await Logger.info("TAILOR-V3", `Skipped ${job.jobTitle} @ ${job.companyName}: ${e.reason}`);
    } else if (e instanceof ValidationError) {
      await Logger.error("TAILOR-V3", JSON.stringify({ jobId, gate: e.gate, reason: e.reason, summary, letter }));
    }
    throw e;
  }
}
