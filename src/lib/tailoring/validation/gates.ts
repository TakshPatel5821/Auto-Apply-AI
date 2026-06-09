import { ValidationError, type FactBook, type FactSelection, type JobAnalysis } from "../types";

// Defense in depth. Composition (step 6) already guarantees most of these by
// construction; these gates re-check the final strings so that if someone later
// edits a template and breaks an invariant, it fails LOUDLY rather than shipping.
// Every gate THROWS — there is no retry here.
export function validateOutputs(
  summary: string,
  letter: string,
  analysis: JobAnalysis,
  sel: FactSelection,
  facts: FactBook
): void {
  // Summary gates
  if (summary.length > 280) throw new ValidationError("summary", `length ${summary.length} > 280`);
  if (
    /\b(expert|specialist|specializing|extensive experience|seasoned|veteran|mid[- ]?level|senior)\b/i.test(summary) &&
    facts.candidate.yearsOfProfessionalExperience < 3
  ) {
    throw new ValidationError("summary", "seniority overclaim");
  }

  // Letter structural gates
  const paragraphs = letter.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  if (paragraphs.length !== 3) throw new ValidationError("letter", `paragraphs=${paragraphs.length}, want 3`);
  const words = letter.trim().split(/\s+/).length;
  if (words < 160 || words > 300) throw new ValidationError("letter", `words=${words}, want 160–300`);

  // Voice gates
  const youCount = (letter.match(/\b(you|your|you've|you'll|you're|yours)\b/gi) || []).length;
  if (youCount > 2) throw new ValidationError("letter", `second-person count ${youCount}`);
  const iCount = (letter.match(/\bI\b/g) || []).length;
  if (iCount < 3) throw new ValidationError("letter", `first-person count ${iCount}`);
  if (/\bwe(?:'re| are) (?:excited|looking forward|pleased)\b/i.test(letter)) {
    throw new ValidationError("letter", "company-voice phrasing");
  }

  // Placeholder-label leak gate
  if (/^(?:\s*(?:first|second|third|fourth|paragraph\s*\d+|p\d+)\s*[—–\-:])/im.test(letter)) {
    throw new ValidationError("letter", "placeholder labels leaked");
  }

  // Forbidden phrases
  if (/\b(extensive experience|expert in|passionate about|team player|results-driven|leverage|synergy|wide range of)\b/i.test(letter)) {
    throw new ValidationError("letter", "banned phrase");
  }

  // Employer-binding gate — each evidence employer must be named in a paragraph
  // that also contains one of that employer's real achievement keywords.
  for (const empId of new Set([
    facts.achievements.get(sel.letterParagraphs.evidence.achievements[0])!.employerId,
    facts.achievements.get(sel.letterParagraphs.evidence.achievements[1])!.employerId,
  ])) {
    const emp = facts.employers.get(empId)!;
    const para = paragraphs.find((p) => p.includes(emp.name));
    if (!para) throw new ValidationError("letter", `employer ${emp.name} not mentioned`);
    const empKeywords = emp.achievementIds.flatMap((id) => facts.achievements.get(id)!.keywords);
    const hit = empKeywords.some((kw) => para.toLowerCase().includes(kw));
    if (!hit) throw new ValidationError("letter", `employer ${emp.name} mentioned without matching achievement keyword`);
  }

  // ATS keyword floor
  const kwHits = analysis.atsKeywords.filter((k) =>
    new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(letter)
  ).length;
  if (kwHits < 3) throw new ValidationError("letter", `ATS keyword hits ${kwHits} < 3`);
}
