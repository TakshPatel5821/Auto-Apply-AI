import { prisma } from "@/lib/db/prisma";
import { saveApplicationFiles } from "@/lib/storage/file-manager";
import type { TailorResult } from "../types";

export interface PersistArgs {
  resumeId: string;
  jobId: string;
  companyName: string;
  jobTitle: string;
  jobDescription: string;
  matchScore: number | null;
  folderPath: string;
  summary: string;
  letter: string;
  resumeTex: string;
  letterTex: string;
  resumePdf: string | null;
  letterPdf: string | null;
  atsScore: number;
  keywordsAdded: string[];
  sectionsModified: string[];
  tailoringNotes: string;
}

// Save .tex + cover letter + job description + metadata to the application folder,
// then create the TailoredResume + CoverLetter rows and flip the job to TAILORED.
// Reuses the existing file-manager + folder layout (same filenames as before).
export async function persist(a: PersistArgs): Promise<TailorResult> {
  const paths = saveApplicationFiles(a.folderPath, {
    resumeTex: a.resumeTex,
    coverLetterTex: a.letterTex,
    jobDescription: a.jobDescription,
    metadata: {
      jobId: a.jobId,
      resumeId: a.resumeId,
      companyName: a.companyName,
      jobTitle: a.jobTitle,
      matchScore: a.matchScore,
      atsScore: a.atsScore,
      tailoredSummary: a.summary,
      keywordsAdded: a.keywordsAdded,
      tailoringNotes: a.tailoringNotes,
      tailoredAt: new Date().toISOString(),
    },
  });

  const tailoredResume = await prisma.tailoredResume.create({
    data: {
      resumeId: a.resumeId,
      jobId: a.jobId,
      latexContent: a.resumeTex,
      texPath: paths.resumeTex || null,
      pdfPath: a.resumePdf,
      atsScore: a.atsScore,
      keywordsAdded: a.keywordsAdded,
      sectionsModified: a.sectionsModified,
      tailoringNotes: a.tailoringNotes || null,
    },
  });

  const coverLetter = await prisma.coverLetter.create({
    data: {
      jobId: a.jobId,
      content: a.letter,
      texPath: paths.coverLetterTex || null,
      pdfPath: a.letterPdf,
    },
  });

  await prisma.job.update({ where: { id: a.jobId }, data: { status: "TAILORED" } });

  return { tailoredResumeId: tailoredResume.id, coverLetterId: coverLetter.id };
}
