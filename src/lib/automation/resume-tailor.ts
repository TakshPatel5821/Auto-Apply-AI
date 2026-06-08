import { prisma } from "@/lib/db/prisma";
import { claudeFullTailor, detectHallucinations, llmFindHallucinations, extractCandidateFacts, claudeTailorResumeContent, type ResumeContentTailor } from "@/lib/ai/claude";
import { matchAchievements, validateATS, scoreLetter, isAcceptable } from "@/lib/cover-letter/quality";
import { getApplicationFolder, saveApplicationFiles } from "@/lib/storage/file-manager";
import { Logger } from "@/lib/logging/logger";
import { compileLatexToPDF, pdfPageCount } from "./latex-compiler";
import { buildResumeLatex, BASE_SUMMARY, RESUME_EXPERIENCE, RESUME_PROJECTS, RESUME_SKILLS, type ResumeEntry, type ResumeOverrides } from "./resume-template";
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

  // Step 2: generate the tailored summary + cover letter + ATS analysis.
  const aiStart = Date.now();
  const parsed = resume.parsedData as Record<string, unknown>;
  const facts = extractCandidateFacts(parsed);
  let tailored = await claudeFullTailor(parsed, job.description, job.jobTitle, job.companyName);

  // Step 2b: production quality gate + retry loop. For each attempt:
  //   • regex hallucination guard (free) + LLM fact-checker (lists unsupported
  //     claims the regex can't catch) → factual accuracy
  //   • deterministic structure validation (length, company/role, no
  //     placeholder/section/dupes)
  //   • ATS coverage of the job's required skills
  //   • a single quality score (hallucinations heavily penalized)
  // A letter is ACCEPTED only when it's clean + structurally valid + ATS ≥ 70% +
  // quality passes. Otherwise we regenerate (with the issues AND deterministically
  // matched real achievements as guidance) up to MAX_ATTEMPTS, keeping the best.
  const findHallucinations = async (letter: string): Promise<string[]> => [
    ...detectHallucinations(letter, parsed, job.description, job.companyName),
    ...(await llmFindHallucinations(letter, parsed, job.companyName)),
  ];
  const MAX_ATTEMPTS = Math.max(1, Math.min(3, Number(process.env.COVER_LETTER_MAX_ATTEMPTS) || 3));
  try {
    let best = tailored;
    let bestComposite = -Infinity;
    let feedback: string[] = [];
    let matched: string[] = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const cand = attempt === 1
        ? tailored
        : await claudeFullTailor(parsed, job.description, job.jobTitle, job.companyName, feedback, matched);

      const reqSkills = cand.jobAnalysis?.requiredSkills?.length
        ? cand.jobAnalysis.requiredSkills
        : (cand.jobAnalysis?.atsKeywords || []);
      const structure = validateCoverLetter(cand.coverLetter, job.companyName, job.jobTitle, cand.jobAnalysis?.atsKeywords || []);
      const halluc = await findHallucinations(cand.coverLetter);
      const ats = validateATS(cand.coverLetter, reqSkills);
      const quality = scoreLetter(halluc.length, ats.score);
      const accepted = isAcceptable(structure.valid, halluc.length, ats, quality);

      const composite = -1000 * halluc.length + (structure.valid ? 100 : 0) + quality.score + ats.score * 10;
      if (composite > bestComposite) { bestComposite = composite; best = cand; }

      await Logger.info("TAILOR", `Cover letter attempt ${attempt}/${MAX_ATTEMPTS}: ${halluc.length} hallucination(s), ATS ${Math.round(ats.score * 100)}%, quality ${Math.round(quality.score)}${accepted ? " ✓ accepted" : ""}`);
      if (accepted) { best = cand; break; }

      // Prepare guidance for the next attempt: real matched achievements + the
      // specific issues + required skills the candidate GENUINELY has but omitted.
      matched = matchAchievements(facts, reqSkills);
      const missingHave = ats.missing.filter((s) =>
        facts.skills.some((fs) => fs.toLowerCase().includes(s.toLowerCase()) || s.toLowerCase().includes(fs.toLowerCase()))
      );
      feedback = [
        ...halluc.map((c) => `unsupported claim: "${c}" — remove it or restate as a verified fact`),
        ...structure.issues,
        ...(missingHave.length ? [`naturally include these required skills you genuinely have: ${missingHave.join(", ")}`] : []),
      ];
    }
    tailored = best;
  } catch (e) {
    await Logger.warn("TAILOR", `Quality gate skipped (non-fatal): ${e}`);
  }

  // Step 2c: reorder skills + reword bullets to mirror the JD — validated
  // (skills must be a permutation; bullets truth-checked) so nothing is invented.
  // The 1-page guarantee is enforced after compiling (Step 4).
  let overrides: ResumeOverrides = {};
  try {
    const content = await claudeTailorResumeContent(job.description, job.jobTitle, job.companyName);
    overrides = buildSafeOverrides(content, parsed, job.description, job.companyName);
    const parts = [
      overrides.skills ? "skills reordered" : null,
      overrides.experienceBullets ? "experience reworded" : null,
      overrides.projectBullets ? "projects reworded" : null,
    ].filter(Boolean);
    await Logger.info("TAILOR", parts.length ? `Résumé content tailored: ${parts.join(", ")}` : "Résumé content kept canonical (overrides failed validation)");
  } catch (e) {
    await Logger.warn("TAILOR", `Résumé content tailoring skipped (non-fatal): ${e}`);
  }
  // The résumé LaTeX actually used everywhere (tex file, PDF, DB). Built from the
  // tailored summary + validated overrides; may revert to canonical in Step 4.
  let finalLatex = buildResumeLatex(tailored.tailoredSummary, overrides);

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
    resumeTex: finalLatex,
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
    pdfPath = await compileLatexToPDF(finalLatex, folderPath, "resume").catch((e) => {
      Logger.warn("TAILOR", `PDF compilation error: ${e}`);
      return null;
    });
    // 1-page guarantee: if the reworded bullets pushed it to 2 pages, revert to
    // the canonical résumé content (summary still tailored) and recompile.
    if (pdfPath) {
      const pages = pdfPageCount(folderPath, "resume");
      if (pages && pages > 1) {
        await Logger.warn("TAILOR", `Tailored résumé spilled to ${pages} pages — reverting to canonical one-page content`);
        finalLatex = buildResumeLatex(tailored.tailoredSummary);
        pdfPath = await compileLatexToPDF(finalLatex, folderPath, "resume").catch(() => null);
      }
    }
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
      latexContent: finalLatex,
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

  if (/\[[^\]]{1,30}\]|\{\{|\}\}|\bx{2,}\s*%|\bTODO\b|\binsert (your|the|company|role)\b|lorem ipsum|\byour name\b|\b(OPENING|MATCH|VALUE|CLOSING)\b\s*:/i.test(raw)) {
    issues.push("contains placeholder / template-section text");
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

// True if `cand` is a reordering of `orig` (same multiset of items) — used to
// guarantee skill reordering never ADDS or DROPS a skill.
export function isPermutation(cand: string[], orig: string[]): boolean {
  if (!Array.isArray(cand) || cand.length !== orig.length) return false;
  const norm = (s: string) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
  const a = cand.map(norm).sort();
  const b = orig.map(norm).sort();
  return a.every((x, i) => x === b[i]);
}

// Turn the AI's reorder/reword output into SAFE résumé overrides:
//   • skills: accepted per-group only if it's a true permutation (no invented skills)
//   • bullets: accepted only if same count AND no fabricated metric/tech vs the
//     candidate's real résumé corpus (reuses the hallucination guard); otherwise
//     that section keeps its canonical bullets.
export function buildSafeOverrides(
  content: ResumeContentTailor,
  parsed: Record<string, unknown>,
  jobDescription: string,
  company: string
): ResumeOverrides {
  const out: ResumeOverrides = {};

  // Allowed corpus = real parsed résumé + the canonical template content.
  const canonText = [
    RESUME_EXPERIENCE.flatMap((e) => e.bullets).join(" \n "),
    RESUME_PROJECTS.flatMap((p) => p.bullets).join(" \n "),
    RESUME_SKILLS.flatMap((g) => g.items).join(", "),
  ].join(" \n ");
  const canonSkills = RESUME_SKILLS.flatMap((g) => g.items);
  const parsedSkills = Array.isArray(parsed.skills) ? (parsed.skills as unknown[]).map(String) : [];
  const mergedForCheck: Record<string, unknown> = {
    rawText: `${typeof parsed.rawText === "string" ? parsed.rawText : ""} \n ${canonText}`,
    skills: [...parsedSkills, ...canonSkills],
    technologies: parsed.technologies,
  };

  if (content.reorderedSkills?.length === RESUME_SKILLS.length) {
    out.skills = RESUME_SKILLS.map((g, i) =>
      isPermutation(content.reorderedSkills[i] || [], g.items) ? content.reorderedSkills[i] : g.items
    );
  }

  const checkBullets = (cand: string[][], canon: ResumeEntry[]): string[][] | null => {
    if (!Array.isArray(cand) || cand.length !== canon.length) return null;
    for (let i = 0; i < canon.length; i++) {
      const c = cand[i];
      if (!Array.isArray(c) || c.length !== canon[i].bullets.length || c.some((b) => !b || !b.trim())) return null;
      if (detectHallucinations(c.join("\n"), mergedForCheck, jobDescription, company).length) return null;
    }
    return cand;
  };

  const exp = checkBullets(content.experienceBullets || [], RESUME_EXPERIENCE);
  if (exp) out.experienceBullets = exp;
  const proj = checkBullets(content.projectBullets || [], RESUME_PROJECTS);
  if (proj) out.projectBullets = proj;

  return out;
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
