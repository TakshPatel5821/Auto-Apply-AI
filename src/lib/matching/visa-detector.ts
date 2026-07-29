// ─── Visa / international-student signal detector ─────────────────────────────
// Deterministic scan of a job description for sponsorship + CPT/OPT signals.
// No external dataset needed for v1 — purely phrase matching, so it's fast and
// explainable. (A future version could cross-reference public H1B LCA data.)

export interface VisaInfo {
  sponsorshipStatus: "sponsors" | "no_sponsorship" | "unknown";
  acceptsCpt: boolean | null;
  acceptsOpt: boolean | null;
  intlFriendlyScore: number; // 0-10
}

// Phrases that clearly mean "we will NOT sponsor".
const NO_SPONSOR = [
  "not provide sponsorship",
  "not offer sponsorship",
  "unable to sponsor",
  "no sponsorship",
  "without sponsorship",
  "not sponsor",
  "do not sponsor",
  "does not sponsor",
  "will not sponsor",
  "cannot sponsor",
  "no visa sponsorship",
  "sponsorship is not available",
  "not eligible for sponsorship",
  "must be authorized to work in the united states without",
  "must be able to work without sponsorship",
  "us citizen or green card",
  "u.s. citizen or green card",
  "citizenship is required",
  "must be a us citizen",
  "security clearance", // clearance roles generally exclude non-citizens
];

// Phrases that clearly mean "we WILL sponsor".
const WILL_SPONSOR = [
  "visa sponsorship available",
  "will sponsor",
  "sponsorship available",
  "we sponsor",
  "offer sponsorship",
  "provide sponsorship",
  "h-1b sponsorship",
  "h1b sponsorship",
  "open to sponsorship",
  "sponsorship provided",
  "eligible for sponsorship",
];

function hasAny(text: string, phrases: string[]): boolean {
  return phrases.some((p) => text.includes(p));
}

export function detectVisaInfo(description: string): VisaInfo {
  const t = (description || "").toLowerCase();

  let sponsorshipStatus: VisaInfo["sponsorshipStatus"] = "unknown";
  // "No sponsorship" wording is usually explicit and overrides a generic mention.
  if (hasAny(t, NO_SPONSOR)) sponsorshipStatus = "no_sponsorship";
  else if (hasAny(t, WILL_SPONSOR)) sponsorshipStatus = "sponsors";

  // CPT/OPT explicit mentions (rare but strong signal).
  const acceptsCpt = /\bcpt\b|curricular practical training/.test(t)
    ? true
    : sponsorshipStatus === "no_sponsorship"
    ? false
    : null;
  const acceptsOpt = /\bopt\b|optional practical training|\bf-?1\b/.test(t)
    ? true
    : sponsorshipStatus === "no_sponsorship"
    ? false
    : null;

  // 0-10 friendliness score for quick sorting.
  let score = 5; // unknown baseline
  if (sponsorshipStatus === "sponsors") score = 9;
  else if (sponsorshipStatus === "no_sponsorship") score = 1;
  if (acceptsOpt === true) score = Math.min(10, score + 1);
  if (acceptsCpt === true) score = Math.min(10, score + 1);

  return { sponsorshipStatus, acceptsCpt, acceptsOpt, intlFriendlyScore: score };
}
