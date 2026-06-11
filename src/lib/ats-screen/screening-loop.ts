import { composeApplication, finalize, EligibilityError } from "@/lib/tailoring";
import { loadFacts } from "@/lib/tailoring/facts/load-facts";
import { analyzeJob } from "@/lib/tailoring/analysis/analyze-jd";
import { computeRequiredSkillMatch } from "@/lib/tailoring/composition/select-facts";
import type { SkillId } from "@/lib/tailoring/types";
import { Logger } from "@/lib/logging/logger";
import { recruiterNote, screenApplication } from "./screen";
import type { LoopResult, LoopRound } from "./types";

export interface LoopOptions {
  maxRounds?: number;
  withRecruiterNote?: boolean; // add an LLM "internal note" to each round (optional)
}

// The closed loop. Applicant agent generates → employer ATS screens → on reject,
// the candidate's REAL under-featured skills are fed back to feature next round.
// It NEVER invents a skill: when only genuinely-absent gaps remain, it stops with
// an honest reject + a learn-list. The accepted version is the only one compiled
// to PDF + persisted.
export async function runScreeningLoop(
  resumeId: string,
  jobId: string,
  opts: LoopOptions = {}
): Promise<LoopResult> {
  const maxRounds = Math.max(1, Math.min(5, opts.maxRounds ?? 3));
  const rounds: LoopRound[] = [];
  let featureSkillIds: SkillId[] = [];

  for (let r = 1; r <= maxRounds; r++) {
    let composed;
    try {
      composed = await composeApplication(resumeId, jobId, { featureSkillIds });
    } catch (e) {
      if (e instanceof EligibilityError) {
        // Pre-filter / 30% floor said it's not a fit at all — honest reject, but
        // still report the actual coverage + the skills to learn.
        let finalScore = 0;
        let learnList: string[] = [];
        try {
          const facts = await loadFacts(resumeId);
          const analysis = await analyzeJob(jobId);
          const m = computeRequiredSkillMatch(analysis, facts);
          const total = m.present.length + m.absent.length;
          finalScore = total ? Math.round((m.present.length / total) * 100) : 0;
          learnList = m.absent;
        } catch { /* keep defaults */ }
        return { accepted: false, rounds, finalScore, learnList, reason: e.reason };
      }
      throw e;
    }

    const screen = screenApplication(composed.analysis, composed.facts, composed.sel, composed.summary, composed.letter);
    if (opts.withRecruiterNote) {
      const note = await recruiterNote(composed.analysis, screen);
      if (note) screen.comments.push(`Recruiter: ${note}`);
    }
    rounds.push({
      round: r,
      featured: featureSkillIds.map((id) => composed.facts.skills.get(id)?.canonical ?? id),
      screen,
    });
    await Logger.info(
      "ATS-SCREEN",
      `Round ${r}: ${screen.decision.toUpperCase()} (${screen.score}%) — coverable ${screen.coverableGaps.length}, absent ${screen.absentGaps.length}`
    );

    if (screen.decision === "accept") {
      const { tailoredResumeId, coverLetterId } = await finalize(resumeId, jobId, composed);
      return { accepted: true, rounds, finalScore: screen.score, learnList: [], reason: "accepted", tailoredResumeId, coverLetterId };
    }

    // Reject → feature the coverable (real-but-under-shown) gaps next round.
    const newFeatures = screen.coverableGaps
      .map((g) => g.factId)
      .filter((x): x is string => !!x) as SkillId[];
    const merged = [...new Set([...featureSkillIds, ...newFeatures])];

    if (merged.length === featureSkillIds.length) {
      // Nothing new we can truthfully surface → only genuinely-absent gaps remain.
      const learnList = screen.absentGaps.map((g) => g.skill);
      return {
        accepted: false,
        rounds,
        finalScore: screen.score,
        learnList,
        reason: learnList.length ? "honest reject — skills to learn" : "no further improvement possible",
      };
    }
    featureSkillIds = merged;
  }

  const last = rounds[rounds.length - 1];
  return {
    accepted: false,
    rounds,
    finalScore: last?.screen.score ?? 0,
    learnList: last?.screen.absentGaps.map((g) => g.skill) ?? [],
    reason: "max rounds reached",
  };
}
