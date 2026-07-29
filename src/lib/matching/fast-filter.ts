// Instant keyword-based pre-filter — runs BEFORE any AI or embedding call.
// Eliminates obvious mismatches in microseconds.

import { TECH_KEYWORDS, tokenInText } from "./keywords";

export interface FilterResult {
  score: number;
  skip: boolean;
  reason: string;
  matchedKeywords: string[];
  missingKeywords: string[];
}

// Pull the highest "N years (of) experience" requirement out of a job
// description. Returns 0 if none stated. Handles "4 years", "4+ years",
// "3-5 years", "minimum of 5 years", "5 yrs".
export function extractRequiredYears(text: string): number {
  const t = text.toLowerCase();
  let maxYears = 0;
  // Matches: "4 years", "4+ years", "3-5 years", "5 yrs", "5 yr"
  const re = /(\d{1,2})\s*(?:\+|-\s*\d{1,2})?\s*(?:years?|yrs?)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const n = parseInt(m[1], 10);
    // Only treat it as an experience requirement when "experience" is nearby,
    // so we don't catch "founded 5 years ago" / "5 years of runway" etc.
    const ctx = t.slice(Math.max(0, m.index - 15), m.index + 40);
    if (/experien|exp\b|background|working|industry|professional/.test(ctx) && n <= 25) {
      maxYears = Math.max(maxYears, n);
    }
  }
  return maxYears;
}

export function fastFilter(
  jobTitle: string,
  jobDescription: string,
  candidateSkills: string[],
  candidateTech: string[],
  searchKeywords: string[],
  options: {
    blacklistCompanies?: string[];
    minSalary?: number;
    salaryMin?: number;
    requireSponsorship?: boolean;
    candidateYears?: number;     // candidate's years of experience
    entryLevelTarget?: boolean;  // user is targeting entry/intern roles
  } = {}
): FilterResult {
  const jobText = `${jobTitle} ${jobDescription}`.toLowerCase();
  const titleLower = jobTitle.toLowerCase();
  const candidateSet = new Set(
    [...candidateSkills, ...candidateTech].map((s) => s.toLowerCase())
  );

  // ─── Hard skips ────────────────────────────────────────────────────────────

  const spamPhrases = [
    "mlm", "pyramid", "unlimited earning", "be your own boss",
    "100% commission only", "no experience required to earn",
    "work from home opportunity - earn", "make money from home",
  ];
  if (spamPhrases.some((p) => jobText.includes(p))) {
    return { score: 0, skip: true, reason: "Spam/MLM detected", matchedKeywords: [], missingKeywords: [] };
  }

  if (!options.requireSponsorship) {
    const noSponsor = ["no sponsorship", "must be authorized to work", "citizens only", "gc or citizen", "no h1b", "no h-1b", "not eligible for sponsorship"];
    if (noSponsor.some((p) => jobText.includes(p))) {
      return { score: 0, skip: true, reason: "No visa sponsorship available", matchedKeywords: [], missingKeywords: [] };
    }
  }

  // Skip true senior/executive roles by TITLE (catches the obvious ones).
  const strictSeniorPattern = /\b(staff engineer|principal engineer|senior staff|lead engineer|vp of engineering|director of engineering|cto |chief technology|svp |evp |head of engineering|distinguished engineer)\b/i;
  if (strictSeniorPattern.test(jobText)) {
    return { score: 0, skip: true, reason: "Senior/executive title", matchedKeywords: [], missingKeywords: [] };
  }

  // ─── Intern/Entry-level boost ───────────────────────────────────────────────
  const internSignals = ["intern", "internship", "co-op", "coop", "new grad", "entry level", "entry-level", "junior", "0-2 years", "0-1 year", "recent graduate", "graduating"];
  const isInternPosting = internSignals.some((s) => jobText.includes(s));

  // ─── Experience-gap skip (the real fix) ─────────────────────────────────────
  // Extract the required years from the description and skip roles that demand
  // meaningfully more than the candidate has. e.g. a "4 years experience" /
  // "3 years building…" posting is senior for an entry-level candidate.
  // Tolerance of +1 year (you can stretch one year); intern postings are exempt
  // since they often list "nice to have" years without truly requiring them.
  const candidateYears = options.candidateYears ?? 0;
  const requiredYears = extractRequiredYears(jobDescription);
  if (
    !isInternPosting &&
    requiredYears > 0 &&
    requiredYears > candidateYears + 1
  ) {
    return {
      score: 0,
      skip: true,
      reason: `Requires ~${requiredYears} yrs experience (you have ${candidateYears})`,
      matchedKeywords: [],
      missingKeywords: [],
    };
  }
  // When the user is explicitly targeting entry-level, also skip "senior"
  // wording in the title even without a year count.
  if (options.entryLevelTarget && /\bsenior\b|\bsr\.?\b|\blead\b/i.test(titleLower) && !isInternPosting) {
    return { score: 0, skip: true, reason: "Senior title (you're targeting entry-level)", matchedKeywords: [], missingKeywords: [] };
  }
  const internBonus = isInternPosting ? 25 : 0;

  // ─── Search keyword matching ────────────────────────────────────────────────
  // Word-boundary matching so a search term like "go" or "ai" can't match inside
  // an unrelated word in the posting.
  const matchedKeywords: string[] = [];
  const missingKeywords: string[] = [];
  for (const kw of searchKeywords) {
    (tokenInText(kw, jobText) ? matchedKeywords : missingKeywords).push(kw);
  }

  // ─── Tech skill matching (shared dictionary) ────────────────────────────────
  const techKeywords = TECH_KEYWORDS;

  let skillMatches = 0;
  let techMentioned = 0;
  const matchedSkills: string[] = [];

  for (const tech of techKeywords) {
    if (tokenInText(tech, jobText)) {
      techMentioned++;
      if (candidateSet.has(tech)) {
        skillMatches++;
        matchedSkills.push(tech);
      }
    }
  }

  // Also credit the candidate's OWN skills that literally appear in the job text
  // but aren't in the canned tech list — otherwise niche stacks (Kotlin, Scala,
  // .NET, Elixir, Swift, Snowflake…) never count and the match % understates a
  // real fit. Same term-boundary matching, and only for tokens ≥3 chars so short
  // names like "go"/"c" (handled by the canned list) can't false-match.
  const cannedSet = new Set(techKeywords);
  const alreadyMatched = new Set(matchedSkills);
  for (const skill of candidateSet) {
    if (skill.length < 3 || cannedSet.has(skill) || alreadyMatched.has(skill)) continue;
    if (tokenInText(skill, jobText)) {
      skillMatches++;
      techMentioned++;
      matchedSkills.push(skill);
      alreadyMatched.add(skill);
    }
  }

  const skillScore = techMentioned > 0
    ? Math.round((skillMatches / Math.min(techMentioned, 8)) * 100)
    : 50;

  // Title relevance: does the first word of a search keyword appear in the title
  // as a distinct word (not a substring of a larger word)?
  const titleRelevant = searchKeywords.some((kw) => {
    const root = kw.toLowerCase().split(" ")[0];
    return root.length > 0 && tokenInText(root, titleLower);
  });
  const titleBonus = titleRelevant ? 20 : 0;

  const finalScore = Math.min(100, skillScore + titleBonus + internBonus);

  // Skip if very low overlap AND no intern signals AND has many tech requirements
  if (finalScore < 15 && !isInternPosting && techMentioned > 4) {
    return {
      score: finalScore,
      skip: true,
      reason: `Low skill overlap (${skillMatches}/${techMentioned} tech matched)`,
      matchedKeywords: matchedSkills,
      missingKeywords,
    };
  }

  return {
    score: finalScore,
    skip: false,
    reason: `${skillMatches} skill matches${isInternPosting ? " [intern posting +boost]" : ""}, title ${titleRelevant ? "relevant" : "tangential"}`,
    matchedKeywords: [...matchedKeywords, ...matchedSkills],
    missingKeywords,
  };
}
