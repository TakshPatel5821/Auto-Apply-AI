// Instant keyword-based pre-filter — runs before any AI call
// Eliminates obvious mismatches without touching Ollama

export interface FilterResult {
  score: number;       // 0–100, higher = better
  skip: boolean;       // true = don't bother AI scoring
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
  const candidateSet = new Set(
    [...candidateSkills, ...candidateTech].map((s) => s.toLowerCase())
  );

  // Hard skip: spam signals
  const spamPhrases = [
    "mlm", "pyramid", "unlimited earning", "work from home opportunity",
    "no experience required", "be your own boss", "100% commission only",
  ];
  if (spamPhrases.some((p) => jobText.includes(p))) {
    return { score: 0, skip: true, reason: "Spam job detected", matchedKeywords: [], missingKeywords: [] };
  }

  // Hard skip: sponsorship mismatch
  if (!options.requireSponsorship) {
    const noSponsorPhrases = ["no sponsorship", "must be authorized", "citizens only", "gc or citizen"];
    if (noSponsorPhrases.some((p) => jobText.includes(p))) {
      return { score: 0, skip: true, reason: "No sponsorship available", matchedKeywords: [], missingKeywords: [] };
    }
  }

  // Hard skip: senior/staff/principal required but candidate is entry/mid
  const seniorRequired = /\b(10\+|8\+|staff engineer|principal engineer|vp of|director of)\b/.test(jobText);
  if (seniorRequired) {
    return { score: 0, skip: true, reason: "Requires 8+ years / staff level", matchedKeywords: [], missingKeywords: [] };
  }

  // Keyword matching
  const matchedKeywords: string[] = [];
  const missingKeywords: string[] = [];

  for (const kw of searchKeywords) {
    if (jobText.includes(kw.toLowerCase())) {
      matchedKeywords.push(kw);
    } else {
      missingKeywords.push(kw);
    }
  }

  // Skill matching
  const techKeywords = [
    "react", "typescript", "javascript", "python", "node", "nodejs",
    "java", "go", "golang", "rust", "c++", "c#", "sql", "postgresql",
    "mongodb", "redis", "aws", "gcp", "azure", "docker", "kubernetes",
    "graphql", "rest", "api", "git", "ci/cd", "agile", "nextjs", "vue",
    "angular", "django", "fastapi", "spring", "rails", "flutter",
  ];

  let skillMatches = 0;
  let totalRelevantSkills = 0;
  const matchedSkills: string[] = [];

  for (const tech of techKeywords) {
    if (jobText.includes(tech)) {
      totalRelevantSkills++;
      if (candidateSet.has(tech)) {
        skillMatches++;
        matchedSkills.push(tech);
      }
    }
  }

  const skillScore = totalRelevantSkills > 0
    ? Math.round((skillMatches / Math.min(totalRelevantSkills, 8)) * 100)
    : 50;

  // Title relevance bonus
  const titleRelevant = searchKeywords.some((kw) =>
    jobTitle.toLowerCase().includes(kw.toLowerCase().split(" ")[0])
  );
  const titleBonus = titleRelevant ? 20 : 0;

  const finalScore = Math.min(100, skillScore + titleBonus);

  // Skip if clearly not relevant (score < 20 means almost no skill overlap)
  if (finalScore < 20 && totalRelevantSkills > 3) {
    return {
      score: finalScore,
      skip: true,
      reason: `Low skill overlap (${skillMatches}/${totalRelevantSkills} tech skills matched)`,
      matchedKeywords: matchedSkills,
      missingKeywords,
    };
  }

  return {
    score: finalScore,
    skip: false,
    reason: `${skillMatches} skill matches, title ${titleRelevant ? "relevant" : "tangential"}`,
    matchedKeywords: [...matchedKeywords, ...matchedSkills],
    missingKeywords,
  };
}
