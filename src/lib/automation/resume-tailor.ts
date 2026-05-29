import { prisma } from "@/lib/db/prisma";
import {
  claudeFullTailor,
  claudeGenerateLatexResume,
} from "@/lib/ai/claude";
import { getApplicationFolder, saveApplicationFiles } from "@/lib/storage/file-manager";
import { Logger } from "@/lib/logging/logger";
import { compileLatexToPDF } from "./overleaf";

const DEFAULT_LATEX_TEMPLATE = `\\documentclass[10pt,letterpaper]{article}
\\usepackage[margin=0.5in]{geometry}
\\usepackage{enumitem}
\\usepackage{hyperref}
\\usepackage{fontawesome5}
\\usepackage[T1]{fontenc}
\\usepackage{lmodern}
\\pagestyle{empty}

\\begin{document}

\\begin{center}
{\\Huge \\textbf{CANDIDATE_NAME}} \\\\[2pt]
{\\small PHONE $\\cdot$ EMAIL $\\cdot$ LOCATION} \\\\
{\\small \\href{LINKEDIN}{LinkedIn} $\\cdot$ \\href{GITHUB}{GitHub} $\\cdot$ \\href{PORTFOLIO}{Portfolio}}
\\end{center}

\\vspace{-8pt}
\\hrule
\\vspace{4pt}

\\textbf{\\large Summary} \\\\
SUMMARY_TEXT

\\vspace{4pt}
\\hrule
\\vspace{4pt}

\\textbf{\\large Experience}
\\begin{itemize}[leftmargin=*, noitemsep, topsep=2pt]
EXPERIENCE_ITEMS
\\end{itemize}

\\vspace{4pt}
\\hrule
\\vspace{4pt}

\\textbf{\\large Technical Skills} \\\\
\\textbf{Languages:} LANGUAGES \\\\
\\textbf{Frameworks:} FRAMEWORKS \\\\
\\textbf{Tools:} TOOLS \\\\
\\textbf{Databases:} DATABASES

\\vspace{4pt}
\\hrule
\\vspace{4pt}

\\textbf{\\large Education}
\\begin{itemize}[leftmargin=*, noitemsep, topsep=2pt]
EDUCATION_ITEMS
\\end{itemize}

\\end{document}`;

const SKIP_OVERLEAF = process.env.SKIP_OVERLEAF === "true";

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

  // Step 1: Get or generate LaTeX (cached across all jobs for this resume)
  let originalLatex = "";
  const existingTailored = await prisma.tailoredResume.findFirst({ where: { resumeId } });
  if (existingTailored?.latexContent) {
    originalLatex = existingTailored.latexContent;
  } else {
    await Logger.info("TAILOR", "Generating base LaTeX from resume (one-time)...");
    const result = await claudeGenerateLatexResume(
      resume.parsedData as Record<string, unknown>
    ) as { latexContent: string };
    originalLatex = result.latexContent || DEFAULT_LATEX_TEMPLATE;
  }

  // Step 2: ONE combined Claude call — analyze + tailor + cover letter
  // Prompt caching makes subsequent jobs much faster (system + resume cached).
  const aiStart = Date.now();
  const tailored = await claudeFullTailor(
    resume.parsedData as Record<string, unknown>,
    originalLatex,
    job.description,
    job.jobTitle,
    job.companyName
  );
  const aiSeconds = ((Date.now() - aiStart) / 1000).toFixed(1);
  await Logger.info("TAILOR", `AI step done in ${aiSeconds}s (ATS score: ${tailored.atsScore}/10)`);

  // Step 3: Save .tex files to disk immediately
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
      tailoringNotes: tailored.tailoringNotes,
      tailoredAt: new Date().toISOString(),
    },
  });

  // Step 4: Kick off Overleaf compilation in the background (don't await it).
  // The function returns immediately; the apply engine can check for the PDF later.
  // If SKIP_OVERLEAF=true, skip compilation entirely.
  let pdfPath: string | null = null;
  let pdfPromise: Promise<string | null> = Promise.resolve(null);

  if (SKIP_OVERLEAF) {
    await Logger.info("TAILOR", "SKIP_OVERLEAF=true — skipping PDF compilation, .tex saved only");
  } else {
    await Logger.info("TAILOR", "Compiling PDF via Overleaf in background...");
    pdfPromise = compileLatexToPDF(tailored.tailoredLatex, folderPath).catch((e) => {
      Logger.warn("TAILOR", `PDF compilation error: ${e}`);
      return null;
    });
  }

  // Step 5: Save DB records immediately with whatever PDF state we have.
  // If Overleaf is running async, pdfPath updates when ready.
  const tailoredResume = await prisma.tailoredResume.create({
    data: {
      resumeId,
      jobId,
      latexContent: tailored.tailoredLatex,
      texPath: paths.resumeTex || null,
      pdfPath: null, // updated below when Overleaf finishes
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
    },
  });

  await prisma.job.update({ where: { id: jobId }, data: { status: "TAILORED" } });

  // When PDF finishes compiling (could be 30-60s later), update the DB
  pdfPromise.then(async (path) => {
    if (path) {
      pdfPath = path;
      await prisma.tailoredResume.update({
        where: { id: tailoredResume.id },
        data: { pdfPath: path },
      });
      await Logger.success("TAILOR", `PDF ready: ${job.companyName} — ${path}`);
    }
  }).catch(async (e) => {
    await Logger.warn("TAILOR", `PDF background save failed: ${e}`);
  });

  const totalSeconds = ((Date.now() - start) / 1000).toFixed(1);
  await Logger.success(
    "TAILOR",
    `Tailored ${job.companyName} in ${totalSeconds}s (AI: ${aiSeconds}s, PDF: ${SKIP_OVERLEAF ? "skipped" : "background"})`
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
