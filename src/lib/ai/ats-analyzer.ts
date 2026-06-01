// ─── ATS Score Analyzer ───────────────────────────────────────────────────────
// Given a résumé + a job description, computes a transparent ATS match score:
//   • score 0-100 (weighted: required keywords matter 2x nice-to-haves)
//   • strong matches (required keywords the résumé already has)
//   • missing keywords (what to add if true)
//   • concrete suggestions
//
// Keyword extraction reuses claudeAnalyzeJob (one AI call). Matching itself is
// deterministic substring matching against the résumé corpus — so the score is
// explainable, not a black-box number.

import { claudeAnalyzeJob } from "./claude";

export interface FitBreakdown {
  technical: number; // keyword/skill coverage
  experience: number; // years vs required
  education: number; // degree level vs required
  overall: number; // weighted blend
}

export interface AtsAnalysis {
  score: number; // 0-100 (keyword coverage)
  fit: FitBreakdown;
  strongMatches: string[]; // required keywords present in résumé
  matchedKeywords: string[]; // all matched (required + nice)
  missingKeywords: string[]; // not found in résumé
  suggestions: string[];
}

// ── Fit sub-scores ────────────────────────────────────────────────────────────

function experienceFit(resumeData: Record<string, unknown>, yearsRequired: number): number {
  const have = Number(resumeData.yearsOfExperience) || 0;
  if (!yearsRequired || yearsRequired <= 0) return 85; // unspecified → assume fine
  if (have >= yearsRequired) return 100;
  const gap = yearsRequired - have;
  return Math.max(35, Math.round(100 - gap * 15)); // -15 pts per missing year
}

const DEGREE_RANK: Record<string, number> = { phd: 4, master: 3, bachelor: 2, associate: 1 };

function highestDegreeRank(resumeData: Record<string, unknown>): number {
  const edu = resumeData.education;
  let rank = 0;
  if (Array.isArray(edu)) {
    for (const e of edu as Record<string, unknown>[]) {
      const d = `${e.degree || ""}`.toLowerCase();
      if (/ph\.?d|doctor/.test(d)) rank = Math.max(rank, 4);
      else if (/master|m\.s|m\.eng|mba/.test(d)) rank = Math.max(rank, 3);
      else if (/bachelor|b\.s|b\.e|b\.tech|undergrad/.test(d)) rank = Math.max(rank, 2);
      else if (/associate/.test(d)) rank = Math.max(rank, 1);
    }
  }
  return rank;
}

function requiredDegreeRank(jd: string): number {
  const t = jd.toLowerCase();
  if (/ph\.?d|doctorate/.test(t)) return 4;
  if (/master'?s|m\.s\.|graduate degree/.test(t)) return 3;
  if (/bachelor'?s|b\.s\.|b\.e\.|undergraduate degree|4-year degree/.test(t)) return 2;
  if (/associate'?s degree/.test(t)) return 1;
  return 0; // no explicit requirement
}

function educationFit(resumeData: Record<string, unknown>, jd: string): number {
  const required = requiredDegreeRank(jd);
  if (required === 0) return 90; // no stated requirement
  const have = highestDegreeRank(resumeData);
  if (have >= required) return 100;
  return Math.max(40, 100 - (required - have) * 25);
}

// Keyword-coverage ATS % (0-100) from matched vs. missing skills — no AI call.
// Used to populate Job.atsKeywordScore during scraping/analysis.
export function atsKeywordPct(matching: string[], missing: string[]): number | null {
  const total = matching.length + missing.length;
  if (total === 0) return null;
  return Math.round((100 * matching.length) / total);
}

function uniqLower(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of arr) {
    const v = (raw || "").trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

// Build one lowercased text blob of everything the résumé contains.
function corpusFromResume(resumeData: Record<string, unknown>): string {
  const parts: string[] = [];
  const pushArr = (v: unknown) => {
    if (Array.isArray(v)) parts.push(v.map(String).join(" "));
  };
  pushArr(resumeData.skills);
  pushArr(resumeData.technologies);
  pushArr(resumeData.atsKeywords);
  pushArr(resumeData.domains);
  if (typeof resumeData.summary === "string") parts.push(resumeData.summary);
  if (typeof resumeData.rawText === "string") parts.push(resumeData.rawText);

  const exp = resumeData.experience;
  if (Array.isArray(exp)) {
    for (const e of exp as Record<string, unknown>[]) {
      if (typeof e.title === "string") parts.push(e.title);
      if (typeof e.description === "string") parts.push(e.description);
      pushArr(e.bullets);
      pushArr(e.technologies);
    }
  }
  const proj = resumeData.projects;
  if (Array.isArray(proj)) {
    for (const p of proj as Record<string, unknown>[]) {
      if (typeof p.name === "string") parts.push(p.name);
      if (typeof p.description === "string") parts.push(p.description);
      pushArr(p.technologies);
      pushArr(p.bullets);
    }
  }
  return parts.join(" \n ").toLowerCase();
}

// Is the keyword present in the résumé corpus? Substring match, with a couple of
// common normalizations (e.g. "node.js" vs "nodejs", "c#"/"c++" kept literal).
function present(keyword: string, corpus: string): boolean {
  const k = keyword.toLowerCase().trim();
  if (!k) return false;
  if (corpus.includes(k)) return true;
  const collapsed = k.replace(/[.\s_-]/g, "");
  if (collapsed.length >= 3 && corpus.replace(/[.\s_-]/g, "").includes(collapsed)) return true;
  return false;
}

function buildSuggestions(
  missingRequired: string[],
  missingNice: string[],
  score: number
): string[] {
  const s: string[] = [];
  if (missingRequired.length) {
    s.push(
      `Add these required keywords (only if you genuinely have the experience): ${missingRequired
        .slice(0, 8)
        .join(", ")}.`
    );
    s.push("Mirror the job posting's exact wording — ATS systems match literal phrases.");
  }
  if (missingNice.length) {
    s.push(`Nice-to-have keywords you could weave in: ${missingNice.slice(0, 6).join(", ")}.`);
  }
  if (score >= 80) s.push("Strong match — apply with confidence.");
  else if (score >= 60) s.push("Decent match — tailoring the summary to the missing keywords will help.");
  else s.push("Weak keyword match — review whether this role truly fits before applying.");
  return s;
}

export async function analyzeATS(
  resumeData: Record<string, unknown>,
  jobDescription: string
): Promise<AtsAnalysis> {
  const ja = (await claudeAnalyzeJob(jobDescription)) as {
    requiredSkills?: string[];
    niceToHaveSkills?: string[];
    technologies?: string[];
    atsKeywords?: string[];
    yearsRequired?: number;
  };

  const required = uniqLower([...(ja.requiredSkills || []), ...(ja.technologies || [])]);
  const requiredSet = new Set(required.map((r) => r.toLowerCase()));
  const nice = uniqLower([...(ja.niceToHaveSkills || []), ...(ja.atsKeywords || [])]).filter(
    (k) => !requiredSet.has(k.toLowerCase())
  );

  const corpus = corpusFromResume(resumeData);

  const matchedReq = required.filter((k) => present(k, corpus));
  const missingReq = required.filter((k) => !present(k, corpus));
  const matchedNice = nice.filter((k) => present(k, corpus));
  const missingNice = nice.filter((k) => !present(k, corpus));

  // Weighted: each required keyword counts double.
  const totalWeight = required.length * 2 + nice.length;
  const gotWeight = matchedReq.length * 2 + matchedNice.length;
  const score = totalWeight ? Math.round((100 * gotWeight) / totalWeight) : 50;

  // Fit breakdown: technical (keyword coverage) + experience + education.
  const technical = score;
  const experience = experienceFit(resumeData, ja.yearsRequired || 0);
  const education = educationFit(resumeData, jobDescription);
  const overall = Math.round(technical * 0.5 + experience * 0.3 + education * 0.2);

  return {
    score,
    fit: { technical, experience, education, overall },
    strongMatches: matchedReq.slice(0, 12),
    matchedKeywords: [...matchedReq, ...matchedNice],
    missingKeywords: [...missingReq, ...missingNice].slice(0, 15),
    suggestions: buildSuggestions(missingReq, missingNice, score),
  };
}
