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

  // ATS keyword floor. Count the JD's atsKeywords AND the present required-skill
  // canonicals (those ARE the job's key skills the candidate genuinely has, and
  // composeLetter features them). The requirement is capped at what the candidate
  // can TRUTHFULLY surface (atsTerms that appear in their real corpus) — a grounded
  // letter must never be forced to add a phantom keyword just to clear a floor.
  const esc = (k: string) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const inText = (k: string, text: string) => new RegExp(`\\b${esc(k)}\\b`, "i").test(text);
  const presentCanon = sel.presentRequiredSkills
    .map((id) => facts.skills.get(id)?.canonical)
    .filter((s): s is string => !!s);
  const atsTerms = [...new Set([...analysis.atsKeywords, ...presentCanon])];
  const corpus = [
    ...[...facts.skills.values()].flatMap((s) => [s.canonical, ...s.synonyms]),
    ...[...facts.achievements.values()].map((a) => a.text),
    ...[...facts.projects.values()].map((p) => `${p.name} ${p.description}`),
  ].join(" ");
  const grounded = atsTerms.filter((k) => inText(k, corpus)).length; // achievable ceiling
  const kwHits = atsTerms.filter((k) => inText(k, letter)).length;
  const need = Math.min(3, grounded);
  if (kwHits < need) throw new ValidationError("letter", `ATS keyword hits ${kwHits} < ${need}`);
}
