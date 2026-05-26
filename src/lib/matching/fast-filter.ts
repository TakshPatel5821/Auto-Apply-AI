// Instant keyword-based pre-filter — runs BEFORE any AI or embedding call.
// Eliminates obvious mismatches in microseconds.

export interface FilterResult {
  score: number;
  skip: boolean;
  reason: string;
  matchedKeywords: string[];
  missingKeywords: string[];
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

  // Skip true senior/executive roles (be careful not to skip senior-friendly intern postings)
  const strictSeniorPattern = /\b(10\+\s*years|8\+\s*years|staff engineer|principal engineer|vp of engineering|director of engineering|cto |chief technology|svp |evp )\b/i;
  if (strictSeniorPattern.test(jobText)) {
    return { score: 0, skip: true, reason: "Requires 8+ years or executive level", matchedKeywords: [], missingKeywords: [] };
  }

  // ─── Intern/Entry-level boost ───────────────────────────────────────────────
  const internSignals = ["intern", "internship", "co-op", "coop", "new grad", "entry level", "entry-level", "junior", "0-2 years", "0-1 year", "recent graduate", "graduating"];
  const isInternPosting = internSignals.some((s) => jobText.includes(s));
  const internBonus = isInternPosting ? 25 : 0;

  // ─── Search keyword matching ────────────────────────────────────────────────
  const matchedKeywords: string[] = [];
  const missingKeywords: string[] = [];
  for (const kw of searchKeywords) {
    (jobText.includes(kw.toLowerCase()) ? matchedKeywords : missingKeywords).push(kw);
  }

  // ─── Tech skill matching ────────────────────────────────────────────────────
  const techKeywords = [
    "react", "typescript", "javascript", "python", "node", "nodejs",
    "java", "go", "golang", "rust", "c++", "c#", "sql", "postgresql",
    "mongodb", "redis", "aws", "gcp", "azure", "docker", "kubernetes",
    "graphql", "rest", "api", "git", "ci/cd", "agile", "next.js", "nextjs",
    "vue", "angular", "django", "fastapi", "spring", "rails", "flutter",
    "tensorflow", "pytorch", "machine learning", "ml", "data science",
    "devops", "linux", "bash", "terraform", "ansible",
  ];

  let skillMatches = 0;
  let techMentioned = 0;
  const matchedSkills: string[] = [];

  for (const tech of techKeywords) {
    if (jobText.includes(tech)) {
      techMentioned++;
      if (candidateSet.has(tech)) {
        skillMatches++;
        matchedSkills.push(tech);
      }
    }
  }

  const skillScore = techMentioned > 0
    ? Math.round((skillMatches / Math.min(techMentioned, 8)) * 100)
    : 50;

  // Title relevance: check if search keyword root appears in title
  const titleRelevant = searchKeywords.some((kw) =>
    titleLower.includes(kw.toLowerCase().split(" ")[0])
  );
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
