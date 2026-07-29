// ─── Dropdown Intelligence (#3) + Education normalization (#10) ───────────────
// Given a profile value and a dropdown's actual option list, pick the best
// matching option DETERMINISTICALLY — no AI. Handles the common ATS variations:
// state abbreviations, country spellings, degree levels, yes/no phrasings.

const US_STATES: Record<string, string> = {
  al: "Alabama", ak: "Alaska", az: "Arizona", ar: "Arkansas", ca: "California",
  co: "Colorado", ct: "Connecticut", de: "Delaware", fl: "Florida", ga: "Georgia",
  hi: "Hawaii", id: "Idaho", il: "Illinois", in: "Indiana", ia: "Iowa",
  ks: "Kansas", ky: "Kentucky", la: "Louisiana", me: "Maine", md: "Maryland",
  ma: "Massachusetts", mi: "Michigan", mn: "Minnesota", ms: "Mississippi", mo: "Missouri",
  mt: "Montana", ne: "Nebraska", nv: "Nevada", nh: "New Hampshire", nj: "New Jersey",
  nm: "New Mexico", ny: "New York", nc: "North Carolina", nd: "North Dakota", oh: "Ohio",
  ok: "Oklahoma", or: "Oregon", pa: "Pennsylvania", ri: "Rhode Island", sc: "South Carolina",
  sd: "South Dakota", tn: "Tennessee", tx: "Texas", ut: "Utah", vt: "Vermont",
  va: "Virginia", wa: "Washington", wv: "West Virginia", wi: "Wisconsin", wy: "Wyoming",
  dc: "District of Columbia",
};

const COUNTRY_ALIASES: Record<string, string> = {
  usa: "United States", us: "United States", "u.s.": "United States",
  "u.s.a.": "United States", america: "United States", "united states of america": "United States",
  uk: "United Kingdom", "u.k.": "United Kingdom",
};

const DEGREE_LEVELS: { level: string; rx: RegExp }[] = [
  { level: "Doctorate", rx: /ph\.?d|doctor|doctorate/i },
  { level: "Master's", rx: /master|m\.?s\.?\b|m\.?eng|mba|m\.?b\.?a|ms in|graduate/i },
  { level: "Bachelor's", rx: /bachelor|b\.?s\.?\b|b\.?e\.?\b|b\.?tech|undergrad/i },
  { level: "Associate", rx: /associate|a\.?a\.?\b|a\.?s\.?\b/i },
  { level: "High School", rx: /high school|diploma|ged/i },
];

const norm = (s: string) => (s || "").toLowerCase().replace(/[.\s_-]+/g, " ").trim();

// Map a free value to a canonical degree LEVEL (for "Degree Level" dropdowns).
export function normalizeDegreeLevel(value: string): string | null {
  for (const d of DEGREE_LEVELS) if (d.rx.test(value)) return d.level;
  return null;
}

// Expand a value into the set of strings we should try to match against options.
function candidatesFor(value: string, kind?: string): string[] {
  const v = value.trim();
  const lower = norm(v);
  const out = new Set<string>([v, lower]);

  if (kind === "state") {
    if (US_STATES[lower]) out.add(US_STATES[lower]);
    // reverse: full name → keep; also add abbreviation
    for (const [abbr, full] of Object.entries(US_STATES)) {
      if (norm(full) === lower) out.add(abbr.toUpperCase());
    }
  }
  if (kind === "country") {
    if (COUNTRY_ALIASES[lower]) out.add(COUNTRY_ALIASES[lower]);
    out.add("United States"); // common default alias target
  }
  if (kind === "degree") {
    const lvl = normalizeDegreeLevel(v);
    if (lvl) out.add(lvl);
  }
  if (kind === "yesno") {
    if (/^(y|yes|true|authorized|citizen|permanent resident|1)/i.test(v)) {
      ["Yes", "Y", "True", "I am authorized"].forEach((x) => out.add(x));
    }
    if (/^(n|no|false|0)/i.test(v)) ["No", "N", "False"].forEach((x) => out.add(x));
  }
  return [...out].filter(Boolean);
}

export interface DropdownOption { value: string; text: string }

// Phase 5: a scored match so the caller can PAUSE on a weak/ambiguous result
// instead of filling blindly. Tiers: 1.0 exact (normalized) · 0.85 whole-word
// prefix · 0.6 loose substring (≥4 chars). `ambiguous` is true when the top two
// options score nearly the same (and it's not an exact 1.0 hit) — the engine
// then leaves the dropdown for the human rather than guessing between them.
export interface DropdownMatch { value: string | null; score: number; ambiguous: boolean }

function isPlaceholder(text: string): boolean {
  return /^(select|choose|please|--|\.\.\.|none|n\/a)\b/.test(norm(text));
}

// Last-resort resolver for NON-sensitive dropdowns where strict scoring was
// ambiguous or found nothing: take the first option that shares a substring with
// the value, else the option with the most token overlap. Deterministic (first
// wins) so the choice is reproducible. Returns an option.value or null.
function fallbackResolve(value: string, options: DropdownOption[], kind?: string): string | null {
  const cands = candidatesFor(value, kind).map(norm).filter((c) => c.length >= 3);
  if (cands.length === 0) return null;
  const real = options.filter((o) => !isPlaceholder(o.text));

  // 1) First option whose text contains (or is contained by) a candidate.
  for (const o of real) {
    const ot = norm(o.text);
    if (ot && cands.some((c) => ot.includes(c) || c.includes(ot))) return o.value;
  }

  // 2) Token overlap: the option sharing the most ≥3-char tokens with the value.
  const valTokens = new Set(cands.flatMap((c) => c.split(" ")).filter((t) => t.length >= 3));
  let best: { value: string; overlap: number } | null = null;
  for (const o of real) {
    const otTokens = norm(o.text).split(" ").filter((t) => t.length >= 3);
    let overlap = 0;
    for (const t of otTokens) if (valTokens.has(t)) overlap++;
    if (overlap > 0 && (!best || overlap > best.overlap)) best = { value: o.value, overlap };
  }
  return best?.value ?? null;
}

export function matchDropdownOptionScored(
  value: string,
  options: DropdownOption[],
  kind?: string,
  opts?: { allowFallback?: boolean }
): DropdownMatch {
  if (!value || options.length === 0) return { value: null, score: 0, ambiguous: false };
  const cands = candidatesFor(value, kind).map(norm).filter((c) => c.length >= 2);
  if (cands.length === 0) return { value: null, score: 0, ambiguous: false };

  let best: { value: string; score: number } | null = null;
  let secondScore = 0;

  for (const o of options) {
    if (isPlaceholder(o.text)) continue;
    const ot = norm(o.text), ov = norm(o.value);
    let s = 0;
    for (const c of cands) {
      if (ot === c || ov === c) { s = Math.max(s, 1.0); }
      else if (ot.startsWith(c + " ") || c.startsWith(ot + " ")) { s = Math.max(s, 0.85); }
      else if (c.length >= 4 && (ot.includes(c) || c.includes(ot))) { s = Math.max(s, 0.6); }
    }
    if (!best || s > best.score) { secondScore = best?.score ?? secondScore; best = { value: o.value, score: s }; }
    else if (s > secondScore) { secondScore = s; }
  }

  // Nothing scored — optionally fall back (non-sensitive callers only).
  if (!best || best.score === 0) {
    if (opts?.allowFallback) {
      const fb = fallbackResolve(value, options, kind);
      if (fb) return { value: fb, score: 0.55, ambiguous: false };
    }
    return { value: null, score: 0, ambiguous: false };
  }

  // Ambiguous when not an exact hit and the runner-up is within 0.15.
  const ambiguous = best.score < 1.0 && best.score - secondScore < 0.15;
  if (ambiguous && opts?.allowFallback) {
    const fb = fallbackResolve(value, options, kind);
    if (fb) return { value: fb, score: Math.max(best.score, 0.55), ambiguous: false };
  }
  return { value: best.value, score: best.score, ambiguous };
}

// Back-compat: choose the best option, or null if nothing matches well OR the
// match is ambiguous (so callers that ignore scoring still fail safe).
export function matchDropdownOption(
  value: string,
  options: DropdownOption[],
  kind?: string
): string | null {
  const m = matchDropdownOptionScored(value, options, kind);
  if (m.ambiguous) return null;
  return m.value;
}
