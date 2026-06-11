import { claudeComplete } from "@/lib/ai/claude";
import { computeRequiredSkillMatch } from "@/lib/tailoring/composition/select-facts";
import type { FactBook, FactSelection, JobAnalysis } from "@/lib/tailoring/types";
import type { Gap, ScreenResult } from "./types";

// The employer "accepts" at/above this keyword-coverage fraction. Below it, the
// candidate genuinely lacks too much of the stack — an honest, unfixable reject.
const ACCEPT_THRESHOLD = Number(process.env.ATS_ACCEPT_THRESHOLD) || 0.4;

function inText(term: string, text: string): boolean {
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${esc}\\b`, "i").test(text);
}

// Screen a generated application the way an employer's ATS + a recruiter would.
// Coverage comes from the FactBook (what the candidate genuinely has vs. what the
// JD requires); "coverable" gaps are real skills the pitch under-featured.
export function screenApplication(
  analysis: JobAnalysis,
  facts: FactBook,
  sel: FactSelection,
  summary: string,
  letter: string
): ScreenResult {
  const { present, absent } = computeRequiredSkillMatch(analysis, facts);
  const total = present.length + absent.length;
  const coverage = total > 0 ? present.length / total : 1;
  const score = Math.round(coverage * 100);

  const matched = present.map((id) => facts.skills.get(id)!.canonical);

  // The "pitch" the employer reads first — summary + cover letter. A present skill
  // not mentioned here is under-featured (coverable), not absent.
  const pitch = `${summary}\n${letter}`;
  const coverableGaps: Gap[] = present
    .filter((id) => !inText(facts.skills.get(id)!.canonical, pitch))
    .map((id) => ({ skill: facts.skills.get(id)!.canonical, status: "coverable", factId: id }));

  const absentGaps: Gap[] = absent.map((s) => ({ skill: s, status: "absent" }));

  let decision: ScreenResult["decision"];
  if (coverage < ACCEPT_THRESHOLD) decision = "reject"; // too much of the stack is genuinely missing
  else if (coverableGaps.length > 0) decision = "reject"; // fixable — re-tailor to feature them
  else decision = "accept";

  const comments = buildComments(decision, score, matched, coverableGaps, absentGaps);
  return { decision, score, matched, coverableGaps, absentGaps, comments };
}

function buildComments(
  decision: ScreenResult["decision"],
  score: number,
  matched: string[],
  coverable: Gap[],
  absent: Gap[]
): string[] {
  const c: string[] = [];
  c.push(`ATS keyword coverage: ${score}%.`);
  if (matched.length) c.push(`Strong match on ${matched.slice(0, 6).join(", ")}.`);
  if (coverable.length) c.push(`You have these but didn't surface them — feature them: ${coverable.map((g) => g.skill).join(", ")}.`);
  if (absent.length) c.push(`Required but not in your background: ${absent.map((g) => g.skill).join(", ")} (don't claim it — a gap to close).`);
  c.push(decision === "accept" ? "Decision: ACCEPT — moving to review." : "Decision: REJECT.");
  return c;
}

// Optional: a short, grounded recruiter note (LLM). Never changes the decision —
// it only narrates it. Degrades to "" if the model is unavailable.
export async function recruiterNote(
  analysis: JobAnalysis,
  result: ScreenResult
): Promise<string> {
  const system =
    "You are a hiring screener writing a one or two sentence internal note about a candidate's application. " +
    "Base it ONLY on the provided matched skills and gaps — never invent. Be direct and professional.";
  const prompt = `Role: ${analysis.jobTitle}
Decision: ${result.decision} (coverage ${result.score}%)
Genuinely has: ${result.matched.join(", ") || "—"}
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
