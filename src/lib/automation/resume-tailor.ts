import { prisma } from "@/lib/db/prisma";
import { claudeFullTailor, checkTailorAlignment } from "@/lib/ai/claude";
import { getApplicationFolder, saveApplicationFiles } from "@/lib/storage/file-manager";
import { Logger } from "@/lib/logging/logger";
import { compileLatexToPDF } from "./latex-compiler";
import { buildResumeLatex, BASE_SUMMARY } from "./resume-template";
import { loadProfile } from "@/lib/profile/profile-store";

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
  const parsed = resume.parsedData as Record<string, unknown>;
  let tailored = await claudeFullTailor(parsed, job.description, job.jobTitle, job.companyName);

  // Step 2b: quality gates. (1) deterministic cover-letter validation (length,
  // company/role mention, no greeting/closing/placeholder/dupes, JD keywords) and
  // (2) AI alignment (summary + letter consistent, on-role, no fabrication). If
  // either fails, regenerate BOTH once with the issues as feedback, keep the best.
  try {
    const kws1 = tailored.jobAnalysis?.atsKeywords || [];
    const v1 = validateCoverLetter(tailored.coverLetter, job.companyName, job.jobTitle, kws1);
    const a1 = await checkTailorAlignment(
      tailored.tailoredSummary, tailored.coverLetter,
      job.jobTitle, job.companyName, job.description, parsed
    );
    if (!v1.valid || !a1.aligned) {
      const feedback = [...v1.issues, ...a1.issues];
      await Logger.warn("TAILOR", `Quality gate failed (align ${a1.score}/10) — regenerating: ${feedback.slice(0, 5).join("; ")}`);
      const retry = await claudeFullTailor(parsed, job.description, job.jobTitle, job.companyName, feedback);
      const v2 = validateCoverLetter(retry.coverLetter, job.companyName, job.jobTitle, retry.jobAnalysis?.atsKeywords || []);
      const a2 = await checkTailorAlignment(
        retry.tailoredSummary, retry.coverLetter,
        job.jobTitle, job.companyName, job.description, parsed
      );
      // Prefer the attempt with a VALID cover letter; tie-break on alignment.
      const score1 = (v1.valid ? 100 : 0) + a1.score;
      const score2 = (v2.valid ? 100 : 0) + a2.score;
      if (score2 >= score1) {
        tailored = retry;
        await Logger.info("TAILOR", `Regenerated — cover ${v2.valid ? "valid" : v2.issues.length + " issue(s)"}, align ${a2.score}/10`);
      } else {
        await Logger.info("TAILOR", `Kept first attempt (cover ${v1.valid ? "valid" : "invalid"}, align ${a1.score}/10)`);
      }
    } else {
      await Logger.info("TAILOR", `Cover letter valid + aligned (${a1.score}/10)`);
    }
  } catch (e) {
    await Logger.warn("TAILOR", `Quality gate skipped (non-fatal): ${e}`);
  }

  const aiSeconds = ((Date.now() - aiStart) / 1000).toFixed(1);
  await Logger.info("TAILOR", `AI step done in ${aiSeconds}s (ATS score: ${tailored.atsScore}/10)`);

  // Step 3: save .tex + cover letter + metadata to the application folder.
  const folderPath = getApplicationFolder(job.companyName, job.jobTitle);
  // Contact for the cover-letter header: résumé's parsed contact, with the
  // structured Profile filling any gaps (e.g. when the résumé didn't parse a
  // name) so the letter never shows a blank header / "Applicant".
  const resumeContact = (resume.parsedData as { contactInfo?: CoverContact })?.contactInfo || {};
  const contactInfo = await mergeProfileContact(resumeContact);
  const paths = saveApplicationFiles(folderPath, {
    resumeTex: tailored.tailoredLatex,
    coverLetterTex: generateCoverLetterTex(
      tailored.coverLetter,
      job.companyName,
      job.jobTitle,
      contactInfo
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
    pdfPath = await compileLatexToPDF(tailored.tailoredLatex, folderPath, "resume").catch((e) => {
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
          contactInfo
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

interface CoverContact {
  name?: string;
  email?: string;
  phone?: string;
  location?: string;
  portfolio?: string;
  website?: string;
  linkedin?: string;
}

// Fill missing résumé-contact fields from the structured Profile so the cover
// letter always has a real name + contact line (the Profile is user-curated).
async function mergeProfileContact(resumeContact: CoverContact): Promise<CoverContact> {
  const p: Record<string, { value?: string }> = await loadProfile().catch(() => ({}));
  const val = (k: string) => (p[k]?.value || "").trim() || undefined;
  const profileName =
    val("fullName") ||
    [val("firstName"), val("lastName")].filter(Boolean).join(" ").trim() ||
    undefined;
  const city = val("city");
  const state = val("state");
  const profileLocation = [city, state].filter(Boolean).join(", ") || undefined;
  return {
    name: resumeContact.name || profileName,
    email: resumeContact.email || val("email"),
    phone: resumeContact.phone || val("phone"),
    location: resumeContact.location || profileLocation,
    portfolio: resumeContact.portfolio || val("portfolio"),
    website: resumeContact.website || val("website"),
    linkedin: resumeContact.linkedin || val("linkedin"),
  };
}

// Strip any greeting / sign-off the model may have included so the template adds
// EXACTLY one of each — kills the duplicate "Dear …" / "Sincerely …" bug.
export function stripGreetingClosing(content: string): string {
  let body = (content || "").trim();
  body = body.replace(/^\s*(dear\b[^\n]*|to whom it may concern[^\n]*|hello[^\n]*|hi\b[^\n]*)\n+/i, "");
  // Only strip a real sign-off that sits on its OWN line (optionally followed by
  // a name). NOT "Thank you …"/"best …" inside the legitimate closing paragraph.
  body = body.replace(
    /\n+\s*(sincerely|best regards|kind regards|warm regards|warmly|respectfully|regards|yours (truly|sincerely))[,.]?\s*(\n[\s\S]*)?$/i,
    ""
  );
  return body.trim();
}

export interface CoverValidation { valid: boolean; issues: string[] }

// Deterministic (no-AI) quality gate for the cover-letter BODY — runs before PDF
// and drives regeneration. Checks: no stray greeting/closing, 250-450 words,
// company + role mentioned, no placeholders, no duplicate paragraphs, and that
// enough of the job's key terms actually appear (real JD matching).
export function validateCoverLetter(
  rawBody: string,
  company: string,
  role: string,
  keywords: string[] = []
): CoverValidation {
  const issues: string[] = [];
  const raw = (rawBody || "").trim();
  if (!raw) return { valid: false, issues: ["empty cover letter"] };
  const lower = raw.toLowerCase();

  // Greeting/closing must NOT be in the body (template adds exactly one each).
  if (/^\s*(dear|to whom it may concern|hello|hi)\b/i.test(raw)) {
    issues.push("greeting in body — remove it (added automatically)");
  }
  if (/\n\s*(sincerely|best regards|kind regards|warm regards|regards|respectfully|yours (truly|sincerely))\b/i.test(lower)) {
    issues.push("sign-off in body — remove it (added automatically)");
  }

  const body = stripGreetingClosing(raw);
  const words = body.split(/\s+/).filter(Boolean).length;
  if (words < 250) issues.push(`too short (${words} words; aim 250-450)`);
  if (words > 460) issues.push(`too long (${words} words; aim 250-450)`);

  const firstCompanyWord = (company || "").toLowerCase().split(/\s+/)[0];
  if (firstCompanyWord && !lower.includes(firstCompanyWord)) {
    issues.push(`mention the company by name (${company})`);
  }
  const roleWords = (role || "").toLowerCase().split(/\s+/)
    .filter((w) => w.length > 3 && !["the", "and", "for", "with", "your", "this"].includes(w));
  if (roleWords.length && !roleWords.some((w) => lower.includes(w))) {
    issues.push(`reference the role (${role})`);
  }

  if (/\[[^\]]{1,30}\]|\bx{2,}\s*%|\bTODO\b|\binsert (your|the|company|role)\b|lorem ipsum|\byour name\b/i.test(raw)) {
    issues.push("contains placeholder text");
  }

  const paras = body.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim().toLowerCase()).filter(Boolean);
  const seen = new Set<string>();
  for (const p of paras) {
    if (p.length > 20 && seen.has(p)) { issues.push("contains a duplicated paragraph"); break; }
    seen.add(p);
  }

  const kws = (keywords || []).map((k) => (k || "").trim()).filter(Boolean);
  if (kws.length) {
    const hits = kws.filter((k) => lower.includes(k.toLowerCase())).length;
    const need = Math.min(3, Math.max(2, Math.ceil(kws.length * 0.25)));
    if (hits < need) issues.push(`include more of the job's key terms (${hits}/${need}): ${kws.slice(0, 8).join(", ")}`);
  }

  return { valid: issues.length === 0, issues };
}

// Escape text for LaTeX. Backslash first, then the special characters.
function escapeLatex(s: string): string {
  return (s || "")
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([&%$#_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

// A professional cover-letter layout that MIRRORS the résumé: a centered name +
// contact header, today's date, the recipient block, a proper greeting, the
// tailored body (real paragraphs), and a signed closing. Replaces the old bare
// `letter`-class output that had no header, no date, and an empty address.
function generateCoverLetterTex(
  content: string,
  company: string,
  jobTitle: string,
  contact: CoverContact = {}
): string {
  const name = escapeLatex(contact.name || "Applicant");
  const contactLine = [contact.phone, contact.email, contact.location]
    .filter(Boolean)
    .map((s) => escapeLatex(s as string))
    .join(" $|$ ");
  const linkLine = [contact.portfolio || contact.website, contact.linkedin]
    .filter(Boolean)
    .map((s) => escapeLatex(s as string))
    .join(" $|$ ");

  const date = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  // The AI body is paragraphs only; strip any greeting/closing it may have added
  // (single-source: the template adds exactly one each), then normalize into
  // LaTeX paragraphs.
  const body = stripGreetingClosing(content);
  let paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => escapeLatex(p.replace(/\s*\n\s*/g, " ").trim()))
    .filter(Boolean)
    .join("\n\n");
  if (!paragraphs) {
    paragraphs = escapeLatex(
      `I am excited to apply for the ${jobTitle} position at ${company} and have attached my résumé for your review.`
    );
  }

  const header = [`{\\LARGE\\bfseries ${name}}`];
  if (contactLine) header.push(contactLine);
  if (linkLine) header.push(linkLine);

  const L: string[] = [
    "\\documentclass[11pt]{article}",
    "\\usepackage[margin=1in]{geometry}",
    "\\usepackage{parskip}",
    "\\setlength{\\parskip}{0.7em}",
    "\\pagestyle{empty}",
    "\\begin{document}",
    "",
    "{\\centering",
    header.join("\\\\[3pt]\n"),
    "\\par}",
    "\\vspace{1.4em}",
    "",
    escapeLatex(date),
    "",
    "Hiring Manager\\\\",
    `${escapeLatex(company)}\\\\`,
    `Re: ${escapeLatex(jobTitle)}`,
    "",
    "Dear Hiring Manager,",
    "",
    paragraphs,
    "",
    "\\vspace{0.6em}",
    "Sincerely,\\\\[1.4em]",
    name,
    "",
    "\\end{document}",
  ];
  return L.join("\n");
}
