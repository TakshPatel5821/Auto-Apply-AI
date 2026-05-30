import { prisma } from "@/lib/db/prisma";
import { claudeFullTailor } from "@/lib/ai/claude";
import { getApplicationFolder, saveApplicationFiles } from "@/lib/storage/file-manager";
import { Logger } from "@/lib/logging/logger";
import { compileLatexToPDF } from "./latex-compiler";
import { buildResumeLatex, BASE_SUMMARY } from "./resume-template";

// Save .tex only and skip the local PDF compile (e.g. on a machine without the
// LaTeX engine installed). Legacy SKIP_OVERLEAF is still honored.
const SKIP_PDF = process.env.SKIP_PDF === "true" || process.env.SKIP_OVERLEAF === "true";

export async function tailorResumeForJob(
  resumeId: string,
  jobId: string
): Promise<{ tailoredResumeId: string; coverLetterId: string }> {
  const start = Date.now();

  const resume = await prisma.resume.findUnique({ where: { id: resumeId } });
  const job = await prisma.job.findUnique({ where: { id: jobId } });

  if (!resume || !job) throw new Error("Resume or job not found");

  await prisma.job.update({ where: { id: jobId }, data: { status: "TAILORING" } });
  await Logger.info("TAILOR", `Tailoring resume for ${job.jobTitle} @ ${job.companyName}`);

  // Step 1: baseline LaTeX = the fixed, page-tested template with the neutral
  // summary. Used as the diff baseline; each job's version only swaps in a
  // job-tailored Professional Summary, so it always compiles to one page.
  const originalLatex = resume.baseLatex || buildResumeLatex(BASE_SUMMARY);
  if (!resume.baseLatex) {
    await prisma.resume
      .update({ where: { id: resumeId }, data: { baseLatex: originalLatex } })
      .catch(() => {});
  }

  // Step 2: one model call — tailored summary + cover letter + ATS analysis.
  // The résumé LaTeX is built locally from the template + tailored summary.
  const aiStart = Date.now();
  const tailored = await claudeFullTailor(
    resume.parsedData as Record<string, unknown>,
    job.description,
    job.jobTitle,
    job.companyName
  );
  const aiSeconds = ((Date.now() - aiStart) / 1000).toFixed(1);
  await Logger.info("TAILOR", `AI step done in ${aiSeconds}s (ATS score: ${tailored.atsScore}/10)`);

  // Step 3: save .tex + cover letter + metadata to the application folder.
  const folderPath = getApplicationFolder(job.companyName, job.jobTitle);
  const paths = saveApplicationFiles(folderPath, {
    resumeTex: tailored.tailoredLatex,
    coverLetterTex: generateCoverLetterTex(
      tailored.coverLetter,
      job.companyName,
      job.jobTitle,
      (resume.parsedData as { contactInfo?: { name?: string } })?.contactInfo?.name
    ),
    jobDescription: job.description,
    metadata: {
      jobId,
      resumeId,
      companyName: job.companyName,
      jobTitle: job.jobTitle,
      matchScore: job.matchScore,
      atsScore: tailored.atsScore,
      tailoredSummary: tailored.tailoredSummary,
      tailoringNotes: tailored.tailoringNotes,
      tailoredAt: new Date().toISOString(),
    },
  });

  // Step 4: compile the PDF locally (Tectonic, ~3s) and AWAIT it so the apply
  // step has a real résumé PDF to upload. (The old design compiled via Overleaf
  // in the background, so apply usually ran before any PDF existed.)
  let pdfPath: string | null = null;
  let coverLetterPdfPath: string | null = null;
  if (SKIP_PDF) {
    await Logger.info("TAILOR", "SKIP_PDF=true — saved .tex only, no PDF compiled");
  } else {
    pdfPath = await compileLatexToPDF(tailored.tailoredLatex, folderPath).catch((e) => {
      Logger.warn("TAILOR", `PDF compilation error: ${e}`);
      return null;
    });
    // Compile the cover letter too, so apply can upload it when a job requires
    // a cover-letter file (not just a paste-in text box). Named cover_letter.pdf.
    if (paths.coverLetterTex) {
      coverLetterPdfPath = await compileLatexToPDF(
        generateCoverLetterTex(
          tailored.coverLetter,
          job.companyName,
          job.jobTitle,
          (resume.parsedData as { contactInfo?: { name?: string } })?.contactInfo?.name
        ),
        folderPath,
        "cover_letter"
      ).catch((e) => {
        Logger.warn("TAILOR", `Cover letter PDF error: ${e}`);
        return null;
      });
    }
  }

  // Step 5: persist DB records with the PDF path already set.
  const tailoredResume = await prisma.tailoredResume.create({
    data: {
      resumeId,
      jobId,
      latexContent: tailored.tailoredLatex,
      texPath: paths.resumeTex || null,
      pdfPath,
      atsScore: tailored.atsScore,
      keywordsAdded: tailored.keywordsAdded || [],
      sectionsModified: tailored.sectionsModified || [],
      tailoringNotes: tailored.tailoringNotes || null,
    },
  });

  const coverLetter = await prisma.coverLetter.create({
    data: {
      jobId,
      content: tailored.coverLetter,
      texPath: paths.coverLetterTex || null,
      pdfPath: coverLetterPdfPath,
    },
  });

  await prisma.job.update({ where: { id: jobId }, data: { status: "TAILORED" } });

  const totalSeconds = ((Date.now() - start) / 1000).toFixed(1);
  await Logger.success(
    "TAILOR",
    `Tailored ${job.companyName} in ${totalSeconds}s (AI: ${aiSeconds}s, PDF: ${
      pdfPath ? "ready" : SKIP_PDF ? "skipped" : "failed"
    })`
  );

  return { tailoredResumeId: tailoredResume.id, coverLetterId: coverLetter.id };
}

function generateCoverLetterTex(
  content: string,
  company: string,
  jobTitle: string,
  candidateName?: string
): string {
  const escapedContent = content
    .replace(/&/g, "\\&")
    .replace(/%/g, "\\%")
    .replace(/\$/g, "\\$")
    .replace(/#/g, "\\#")
    .replace(/_/g, "\\_");

  return `\\documentclass[12pt]{letter}
\\usepackage[margin=1in]{geometry}
\\signature{${candidateName || "Applicant"}}
\\address{}
\\begin{document}
\\begin{letter}{Hiring Manager\\\\${company}\\\\Re: ${jobTitle} Position}
\\opening{Dear Hiring Manager,}
${escapedContent}
\\closing{Sincerely,}
\\end{letter}
\\end{document}`;
}
