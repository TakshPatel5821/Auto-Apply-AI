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

// Choose the best option for `value` from `options`. Returns the option's
// underlying `value` (for selectOption), or null if nothing matches well.
export function matchDropdownOption(
  value: string,
  options: DropdownOption[],
  kind?: string
): string | null {
  if (!value || options.length === 0) return null;
  const cands = candidatesFor(value, kind).map(norm);

  // 1) Exact (normalized) match on option text or value.
  for (const o of options) {
    const ot = norm(o.text), ov = norm(o.value);
    if (cands.includes(ot) || cands.includes(ov)) return o.value;
  }
  // 2) Whole-word containment (avoid "in" matching "India"): match option that
  //    starts-with or equals a candidate, or candidate starts-with option text.
  for (const o of options) {
    const ot = norm(o.text);
    if (!ot) continue;
    for (const c of cands) {
      if (c.length < 2) continue;
      if (ot === c || ot.startsWith(c + " ") || c.startsWith(ot + " ")) return o.value;
    }
  }
  // 3) Loose substring only for longer candidates (≥4 chars) to limit false hits.
  for (const o of options) {
    const ot = norm(o.text);
    for (const c of cands) {
      if (c.length >= 4 && (ot.includes(c) || c.includes(ot))) return o.value;
    }
  }
  return null;
}
