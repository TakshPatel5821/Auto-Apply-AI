import { claudeComplete } from "@/lib/ai/claude";
import { computeRequiredSkillMatch, matchSkillStrings } from "@/lib/tailoring/composition/select-facts";
import type { FactBook, FactSelection, JobAnalysis, SkillId } from "@/lib/tailoring/types";
import type { Gap, ScreenResult } from "./types";

// The employer "accepts" at/above this required-coverage fraction. Below it, the
// candidate genuinely lacks too much of the stack — an honest, unfixable reject.
const ACCEPT_THRESHOLD = Number(process.env.ATS_ACCEPT_THRESHOLD) || 0.4;

// Score weights (required coverage dominates; evidence + nice-to-have refine it).
const W_REQUIRED = 0.55;
const W_EVIDENCE = 0.25;
const W_NICE = 0.2;

function inText(term: string, text: string): boolean {
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${esc}\\b`, "i").test(text);
}

// Screen a generated application the way an employer's ATS + a recruiter would:
//   • required-skill coverage (from the FactBook — what the candidate truly has)
//   • evidence quality (does the cover letter SHOW the skill via a real
//     achievement/project, or just name it?)
//   • nice-to-have coverage
//   • experience fit
// Gaps are split into coverable (real skill under-featured → the loop can fix it)
// and absent (genuinely missing → never claimed).
export function screenApplication(
  analysis: JobAnalysis,
  facts: FactBook,
  sel: FactSelection,
  summary: string,
  letter: string
): ScreenResult {
  const canon = (id: SkillId) => facts.skills.get(id)!.canonical;
  const pitch = `${summary}\n${letter}`;

  // 1. Required coverage.
  const req = computeRequiredSkillMatch(analysis, facts);
  const reqTotal = req.present.length + req.absent.length;
  const requiredCoverage = reqTotal > 0 ? req.present.length / reqTotal : 1;

  // 2. Mention vs evidence. "Evidence" = the skill appears in a concrete artifact
  // the letter actually cites — one of the two evidence achievements or a project
  // named in the letter — not merely listed in the hook / "maps to" line.
  const evidenceAch = sel.letterParagraphs.evidence.achievements
    .map((id) => facts.achievements.get(id)?.text ?? "")
    .join(" ");
  let evidenceCorpus = evidenceAch;
  for (const p of facts.projects.values()) {
    if (inText(p.name, letter)) {
      evidenceCorpus += ` ${p.name} ${p.description} ${p.stack.map((id) => canon(id)).join(" ")}`;
    }
  }

  const mentioned = req.present.filter((id) => inText(canon(id), pitch));
  const notMentioned = req.present.filter((id) => !inText(canon(id), pitch));
  const evidenced = mentioned.filter((id) => inText(canon(id), evidenceCorpus));
  const mentionedNotEvidenced = mentioned.filter((id) => !inText(canon(id), evidenceCorpus)).map((id) => canon(id));
  const evidenceRate = req.present.length > 0 ? evidenced.length / req.present.length : 1;

  // 3. Nice-to-have coverage.
  const nice = matchSkillStrings(analysis.niceToHaveSkills, facts);
  const niceTotal = nice.present.length + nice.absent.length;
  const niceToHaveCoverage = niceTotal > 0 ? nice.present.length / niceTotal : 1;

  // 4. Weighted score.
  const score = Math.round((W_REQUIRED * requiredCoverage + W_EVIDENCE * evidenceRate + W_NICE * niceToHaveCoverage) * 100);

  // Gaps.
  const coverableGaps: Gap[] = notMentioned.map((id) => ({ skill: canon(id), status: "coverable", factId: id }));
  const absentGaps: Gap[] = req.absent.map((s) => ({ skill: s, status: "absent" }));

  // 5. Experience fit (informational — preFilter already hard-gates the extremes).
  const yoe = facts.candidate.yearsOfProfessionalExperience;
  let experienceNote: string | undefined;
  if (analysis.requiredYears > 0) {
    experienceNote =
      yoe + 0.0001 >= analysis.requiredYears
        ? `Experience: meets the ${analysis.requiredYears}-yr ask (${yoe} yrs).`
        : `Experience: below the ${analysis.requiredYears}-yr ask (${yoe} yrs) — emphasize impact over tenure.`;
  }

  // 6. Decision. Hard reject when too much of the required stack is genuinely
  // absent; otherwise reject (fixable) while any present skill is unmentioned;
  // else accept. Evidence + nice-to-have shape the SCORE, not acceptance.
  let decision: ScreenResult["decision"];
  if (requiredCoverage < ACCEPT_THRESHOLD) decision = "reject";
  else if (coverableGaps.length > 0) decision = "reject";
  else decision = "accept";

  const comments = buildComments({
    decision,
    score,
    matched: mentioned.map((id) => canon(id)),
    evidenced: evidenced.map((id) => canon(id)),
    mentionedNotEvidenced,
    coverableGaps,
    absentGaps,
    nice: { present: nice.present.map((id) => canon(id)), missing: nice.absent },
    experienceNote,
  });

  return {
    decision,
    score,
    matched: mentioned.map((id) => canon(id)),
    coverableGaps,
    absentGaps,
    mentionedNotEvidenced,
    niceToHave: { present: nice.present.map((id) => canon(id)), missing: nice.absent },
    breakdown: { requiredCoverage, evidenceRate, niceToHaveCoverage },
    experienceNote,
    comments,
  };
}

function buildComments(x: {
  decision: ScreenResult["decision"];
  score: number;
  matched: string[];
  evidenced: string[];
  mentionedNotEvidenced: string[];
  coverableGaps: Gap[];
  absentGaps: Gap[];
  nice: { present: string[]; missing: string[] };
  experienceNote?: string;
}): string[] {
  const c: string[] = [];
  c.push(`Recruiter score: ${x.score}/100.`);
  if (x.evidenced.length) c.push(`Demonstrated with real work: ${x.evidenced.slice(0, 6).join(", ")}.`);
  else if (x.matched.length) c.push(`Lists ${x.matched.slice(0, 6).join(", ")}.`);
  if (x.mentionedNotEvidenced.length) c.push(`Listed but not shown — back these with a project/bullet: ${x.mentionedNotEvidenced.join(", ")}.`);
  if (x.coverableGaps.length) c.push(`You have these but didn't surface them — feature them: ${x.coverableGaps.map((g) => g.skill).join(", ")}.`);
  if (x.nice.present.length) c.push(`Nice-to-haves you have: ${x.nice.present.slice(0, 6).join(", ")}.`);
  if (x.absentGaps.length) c.push(`Required but not in your background: ${x.absentGaps.map((g) => g.skill).join(", ")} (don't claim it — a gap to close).`);
  if (x.experienceNote) c.push(x.experienceNote);
  c.push(x.decision === "accept" ? "Decision: ACCEPT — moving to review." : "Decision: REJECT.");
  return c;
}

// Optional: a short, grounded recruiter note (LLM). Never changes the decision —
// it only narrates it. Degrades to "" if the model is unavailable.
export async function recruiterNote(analysis: JobAnalysis, result: ScreenResult): Promise<string> {
  const system =
    "You are a hiring screener writing a one or two sentence internal note about a candidate's application. " +
    "Base it ONLY on the provided matched skills and gaps — never invent. Be direct and professional.";
  const prompt = `Role: ${analysis.jobTitle}
Decision: ${result.decision} (score ${result.score}/100)
Demonstrated: ${result.matched.join(", ") || "—"}
Listed but not shown: ${result.mentionedNotEvidenced.join(", ") || "—"}
Under-featured (has, didn't show): ${result.coverableGaps.map((g) => g.skill).join(", ") || "—"}
Missing from background: ${result.absentGaps.map((g) => g.skill).join(", ") || "—"}

Write the internal note (1-2 sentences).`;
  try {
    const note = await claudeComplete(prompt, system, 160);
    return (note || "").trim();
  } catch {
    return "";
  }
}
