import { prisma } from "@/lib/db/prisma";
import {
  claudeTailorResume,
  claudeGenerateCoverLetter,
  claudeAnalyzeJob,
  claudeGenerateLatexResume,
} from "@/lib/ai/claude";
import { getApplicationFolder, saveApplicationFiles } from "@/lib/storage/file-manager";
import { Logger } from "@/lib/logging/logger";
import { TailoredResumeResult, CoverLetterResult } from "@/types";
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

% HEADER
\\begin{center}
{\\Huge \\textbf{CANDIDATE_NAME}} \\\\[2pt]
{\\small PHONE $\\cdot$ EMAIL $\\cdot$ LOCATION} \\\\
{\\small \\href{LINKEDIN}{LinkedIn} $\\cdot$ \\href{GITHUB}{GitHub} $\\cdot$ \\href{PORTFOLIO}{Portfolio}}
\\end{center}

\\vspace{-8pt}
\\hrule
\\vspace{4pt}

% SUMMARY
\\textbf{\\large Summary} \\\\
SUMMARY_TEXT

\\vspace{4pt}
\\hrule
\\vspace{4pt}

% EXPERIENCE
\\textbf{\\large Experience}
\\begin{itemize}[leftmargin=*, noitemsep, topsep=2pt]
EXPERIENCE_ITEMS
\\end{itemize}

\\vspace{4pt}
\\hrule
\\vspace{4pt}

% SKILLS
\\textbf{\\large Technical Skills} \\\\
\\textbf{Languages:} LANGUAGES \\\\
\\textbf{Frameworks:} FRAMEWORKS \\\\
\\textbf{Tools:} TOOLS \\\\
\\textbf{Databases:} DATABASES

\\vspace{4pt}
\\hrule
\\vspace{4pt}

% EDUCATION
\\textbf{\\large Education}
\\begin{itemize}[leftmargin=*, noitemsep, topsep=2pt]
EDUCATION_ITEMS
\\end{itemize}

\\end{document}`;

export async function tailorResumeForJob(
  resumeId: string,
  jobId: string
): Promise<{ tailoredResumeId: string; coverLetterId: string }> {
  const resume = await prisma.resume.findUnique({ where: { id: resumeId } });
  const job = await prisma.job.findUnique({ where: { id: jobId } });

  if (!resume || !job) throw new Error("Resume or job not found");

  await prisma.job.update({ where: { id: jobId }, data: { status: "TAILORING" } });
  await Logger.info("TAILOR", `Tailoring resume for ${job.jobTitle} @ ${job.companyName}`, { jobId });

  // Get or generate LaTeX content
  let originalLatex = "";
  const existingTailored = await prisma.tailoredResume.findFirst({
    where: { resumeId },
  });

  if (existingTailored?.latexContent) {
    originalLatex = existingTailored.latexContent;
  } else {
    // Generate initial LaTeX from parsed resume data
    const result = await claudeGenerateLatexResume(
      resume.parsedData as Record<string, unknown>
    ) as { latexContent: string };
    originalLatex = result.latexContent || DEFAULT_LATEX_TEMPLATE;
  }

  // Analyze job
  const jobAnalysis = await claudeAnalyzeJob(job.description) as Record<string, unknown>;

  // Tailor resume
  const tailored = await claudeTailorResume(
    originalLatex,
    job.description,
    resume.parsedData as Record<string, unknown>,
    jobAnalysis
  ) as TailoredResumeResult;

  // Generate cover letter
  const coverLetterResult = await claudeGenerateCoverLetter(
    job.description,
    job.companyName,
    job.jobTitle,
    resume.parsedData as Record<string, unknown>
  ) as { content: string };

  // Create application folder and save files
  const folderPath = getApplicationFolder(job.companyName, job.jobTitle);
  const paths = saveApplicationFiles(folderPath, {
    resumeTex: tailored.latexContent,
    coverLetterTex: generateCoverLetterTex(
      coverLetterResult.content,
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
      tailoredAt: new Date().toISOString(),
    },
  });

  // Compile to PDF via Overleaf
  await Logger.info("TAILOR", "Compiling tailored resume to PDF via Overleaf...");
  let pdfPath: string | null = null;
  try {
    pdfPath = await compileLatexToPDF(tailored.latexContent, folderPath);
    if (pdfPath) {
      await Logger.success("TAILOR", `Resume PDF ready: ${pdfPath}`);
    } else {
      await Logger.warn("TAILOR", "Overleaf compilation returned null — .tex saved, PDF unavailable");
    }
  } catch (e) {
    await Logger.warn("TAILOR", `PDF compilation error: ${e} — continuing without PDF`);
  }

  const tailoredResume = await prisma.tailoredResume.create({
    data: {
      resumeId,
      jobId,
      latexContent: tailored.latexContent,
      texPath: paths.resumeTex || null,
      pdfPath: pdfPath || null,
      atsScore: tailored.atsScore,
      keywordsAdded: tailored.keywordsAdded || [],
      sectionsModified: tailored.sectionsModified || [],
      tailoringNotes: tailored.tailoringNotes || null,
    },
  });

  const coverLetter = await prisma.coverLetter.create({
    data: {
      jobId,
      content: coverLetterResult.content,
      texPath: paths.coverLetterTex || null,
    },
  });

  await prisma.job.update({
    where: { id: jobId },
    data: { status: "TAILORED" },
  });

  await Logger.success("TAILOR", `Resume tailored for ${job.companyName}`, {
    atsScore: tailored.atsScore,
    keywordsAdded: tailored.keywordsAdded?.length || 0,
  });

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
