// ─── Phase 1: Strict Field Classification + Safety Gates ──────────────────────
// Before ANY value is written to a form field, we classify what the blank is
// actually asking for, decide whether AI may answer it, gate on confidence, and
// validate that a candidate value even makes sense for the field. This is the
// safety net that stops "1.5 years of experience" landing in a government-
// official dropdown or "Dear Hiring Manager" in a LinkedIn URL box.
//
// Nothing here fills anything — it only CLASSIFIES and VALIDATES. The apply
// engine consumes these decisions.

// ── 1.1 The 17 canonical field categories ─────────────────────────────────────
export type FieldCategory =
  | "identity"            // name (first/last/full/preferred)
  | "contact"             // email, phone
  | "address"            // street/city/state/zip/country
  | "education"          // school, degree, major, GPA, grad date
  | "work_experience"    // years of experience, current employer/title
  | "skills"             // skills list, technologies
  | "resume_upload"      // resume / CV file input
  | "cover_letter"       // cover letter file or text
  | "work_authorization" // legally authorized to work?
  | "sponsorship"        // will you need visa sponsorship?
  | "eeo"                // gender, race/ethnicity, pronouns, LGBTQ+
  | "veteran"            // veteran / military status
  | "disability"         // disability status
  | "salary"             // salary expectation / minimum
  | "availability"       // start date, notice period, willing to relocate
  | "open_ended"         // free-text essays (why this role, describe X)
  | "unknown";           // could not classify

// ── DOM input type buckets ─────────────────────────────────────────────────────
export type DomKind = "email" | "phone" | "url" | "number" | "date" | "text" | "select" | "radio" | "checkbox" | "textarea" | "file";

// What the classifier needs. Mirrors DetectedField but kept independent so the
// classifier has no dependency on the apply engine.
export interface FieldContext {
  label: string;
  type: string;           // raw DOM type / "select" / "radio" / "textarea" / "checkbox"
  name?: string;
  placeholder?: string;
  ariaLabel?: string;
  sectionHeading?: string; // nearest section/legend heading (Phase 3 will enrich)
  options?: string[];      // dropdown / radio options
  required?: boolean;
}

// ── 1.2 Do-not-AI policy ───────────────────────────────────────────────────────
// AI must NEVER fabricate answers for these. They are either deterministic facts
// (name/email) or legally sensitive (visa/EEO/salary). They come from the
// structured profile, locked memory, or they pause for the human — never a guess.
export const DO_NOT_AI: ReadonlySet<FieldCategory> = new Set<FieldCategory>([
  "identity",
  "contact",
  "address",
  "education",
  "work_authorization",
  "sponsorship",
  "eeo",
  "veteran",
  "disability",
  "salary",
  "resume_upload",
  "cover_letter",
]);

// Sensitive / legal categories: profile-backed value ONLY, otherwise PAUSE.
// We never let memory-guessing or a résumé shortcut answer these either.
export const SENSITIVE: ReadonlySet<FieldCategory> = new Set<FieldCategory>([
  "work_authorization",
  "sponsorship",
  "eeo",
  "veteran",
  "disability",
  "salary",
]);

// Only these categories may receive an AI-generated answer.
export const AI_ALLOWED: ReadonlySet<FieldCategory> = new Set<FieldCategory>([
  "open_ended",
]);

export function isDoNotAI(cat: FieldCategory): boolean {
  return DO_NOT_AI.has(cat);
}
export function isSensitive(cat: FieldCategory): boolean {
  return SENSITIVE.has(cat);
}
export function aiMayAnswer(cat: FieldCategory): boolean {
  return AI_ALLOWED.has(cat);
}

// ── 1.3 Confidence gates ───────────────────────────────────────────────────────
// One source of truth for the thresholds the engine uses to decide autofill vs
// fill+verify vs pause. Sensitive fields ignore these and demand a profile value.
export const CONFIDENCE = {
  AUTOFILL: 0.95,  // >= : fill and trust
  VERIFY: 0.85,    // >= : fill, then read back to confirm it landed
  SUGGEST: 0.60,   // >= : too low to submit — leave blank, pause for review
  // < SUGGEST     :     leave blank, ask the human
} as const;

export type FillDecision = "autofill" | "fill_and_verify" | "pause_low_confidence" | "pause_blank";

// Map a (category, confidence) pair to what the engine should do.
export function decideFill(cat: FieldCategory, confidence: number, hasProfileValue: boolean): FillDecision {
  // Sensitive/legal: must be profile-backed, else pause regardless of confidence.
  if (isSensitive(cat) && !hasProfileValue) return "pause_blank";
  if (confidence >= CONFIDENCE.AUTOFILL) return "autofill";
  if (confidence >= CONFIDENCE.VERIFY) return "fill_and_verify";
  if (confidence >= CONFIDENCE.SUGGEST) return "pause_low_confidence";
  return "pause_blank";
}

// ── Classification ─────────────────────────────────────────────────────────────
// Normalize a label for matching: strip asterisks, collapse whitespace, lowercase.
const norm = (s?: string) => (s || "").replace(/\*/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

// Patterns are ordered MOST-SPECIFIC FIRST. The first category whose pattern hits
// any of the field's text signals (label + name + placeholder + aria + heading) wins.
const CATEGORY_PATTERNS: { cat: FieldCategory; rx: RegExp }[] = [
  // Resume / cover letter uploads (file inputs usually, but labels vary).
  { cat: "resume_upload", rx: /\b(resume|résumé|\bcv\b|curriculum\s*vitae)\b/i },
  { cat: "cover_letter", rx: /cover\s*letter|motivation\s*letter/i },

  // Work authorization vs sponsorship — keep sponsorship FIRST (more specific).
  { cat: "sponsorship", rx: /sponsor(ship)?|require.*visa|visa.*support|h-?1b.*transfer|need.*sponsor/i },
  { cat: "work_authorization", rx: /authoriz(ed|ation)\s*to\s*work|legally\s*(authorized|able|entitled)\s*to\s*work|eligible\s*to\s*work|work\s*authorization|right\s*to\s*work|work\s*permit/i },

  // EEO / diversity (gender, race, pronouns, LGBTQ+).
  { cat: "eeo", rx: /\bgender\b|\bsex\b|pronoun|\brace\b|ethnicity|hispanic|latino|lgbtq|sexual\s*orientation|diversity/i },
  { cat: "veteran", rx: /veteran|military\s*status|armed\s*forces|protected\s*veteran/i },
  { cat: "disability", rx: /disab(led|ility)|accommodation|section\s*503/i },

  // Salary / compensation.
  { cat: "salary", rx: /salary|compensation|expected\s*pay|desired\s*pay|pay\s*expectation|hourly\s*rate|ctc|expected\s*ctc|rate\s*expectation|minimum.*(salary|pay|rate)|\bwage\b|remuneration|stipend/i },

  // Availability / logistics.
  { cat: "availability", rx: /start\s*date|available.*start|notice\s*period|when\s*can\s*you\s*(start|begin)|willing\s*to\s*relocate|relocat|willing\s*to\s*travel|work\s*from\s*(the\s*)?office|onsite|remote\s*preference|preferred\s*(office\s*)?location|over\s*time\b|overtime|weekends?|night\s*shift|shift\s*work|able\s*to\s*commute|\bcommute\b|earliest\s*(available|start|date)|how\s*soon|available\s*to\s*(start|begin|join)|date\s*available|join(ing)?\s*date/i },

  // Education.
  { cat: "education", rx: /degree|qualification|major|field\s*of\s*study|concentration|\bgpa\b|grade\s*point|university|college|school|institution|alma\s*mater|graduat(e|ion)|education\s*level/i },

  // Work experience (years / current role) — NOT essays.
  { cat: "work_experience", rx: /years?\s*of\s*experience|years?\s*experience|total\s*experience|relevant\s*experience|how\s*many\s*years|number\s*of\s*years|seniority\s*level|current\s*(employer|company|title|role|position)|present\s*(employer|company|title|role|position)|most\s*recent\s*(employer|company|title|role|position)|employment\s*history|work\s*history/i },

  // Skills.
  { cat: "skills", rx: /\bskills?\b|technolog(y|ies)|programming\s*languages?|tools?\s*you|tech\s*stack|proficienc|core\s*competenc|areas?\s*of\s*expertise/i },

  // Contact — BEFORE address so "Email Address" is contact, not address.
  { cat: "contact", rx: /e-?mail|phone|mobile|telephone|\bcell\b|contact\s*number|linkedin|github|gitlab|portfolio|website|personal\s*site|profile\s*url|profile\s*link|\burl\b|stack\s*overflow|behance|dribbble|twitter/i },

  // Address.
  { cat: "address", rx: /street|address|\bcity\b|town|\bstate\b|province|\bzip\b|postal\s*code|post\s*code|\bcountry\b|location/i },

  // Identity (name) — broad, so LAST among the deterministic ones.
  { cat: "identity", rx: /first\s*name|given\s*name|last\s*name|surname|family\s*name|middle\s*name|preferred\s*name|nickname|full\s*name|legal\s*name|\bname\b|fname|lname/i },

  // Open-ended essays — verbs that demand prose.
  { cat: "open_ended", rx: /why\s*(do\s*you|are\s*you|this|join|interested)|tell\s*us|describe|explain|what\s*(interests|excites|motivates|makes)|cover\s*letter|additional\s*(information|comments)|anything\s*else|in\s*your\s*own\s*words|elaborate|how\s*did\s*you\s*hear/i },
];

// Map raw DOM type → DomKind bucket.
export function domKindOf(type: string): DomKind {
  const t = (type || "").toLowerCase();
  if (t === "email") return "email";
  if (t === "tel") return "phone";
  if (t === "url") return "url";
  if (t === "number") return "number";
  if (t === "date" || t === "month") return "date";
  if (t === "select" || t === "select-one" || t === "select-multiple") return "select";
  if (t === "radio") return "radio";
  if (t === "checkbox") return "checkbox";
  if (t === "textarea") return "textarea";
  if (t === "file") return "file";
  return "text";
}

export interface Classification {
  category: FieldCategory;
  domKind: DomKind;
  // True when the option set looks like a yes/no (drives dropdown matching).
  isYesNo: boolean;
}

// Does an option list look like a binary yes/no?
function optionsAreYesNo(options?: string[]): boolean {
  if (!options || options.length === 0) return false;
  const real = options.map((o) => o.trim().toLowerCase()).filter((o) => o && !/^(select|choose|please|--|\.\.\.)/.test(o));
  if (real.length === 0 || real.length > 4) return false;
  return real.every((o) => /^(yes|no|y|n|true|false)\b/.test(o) || /\b(yes|no)\b/.test(o));
}

function isShortEmploymentHistoryLabel(text: string, sectionHeading?: string): boolean {
  const t = norm(text).replace(/[^a-z0-9]+/g, " ").trim();
  if (!t) return false;

  if (/^(job )?title$|^position( title)?$|^role( title)?$/.test(t)) return true;
  if (/^(company|company name|employer|employer name|organization|organization name)$/.test(t)) return true;
  if (/^(from date|to date)$/.test(t)) return true;

  const section = norm(sectionHeading);
  if (/^(start date|end date)$/.test(t) && /\b(employment|work history|experience|job history)\b/.test(section)) {
    return true;
  }

  return false;
}

// First category whose pattern hits the given text, or "unknown".
function matchCategory(text: string): FieldCategory {
  if (!text) return "unknown";
  for (const { cat, rx } of CATEGORY_PATTERNS) {
    if (rx.test(text)) return cat;
  }
  return "unknown";
}

// Classify a field from all the context we have.
export function classifyField(ctx: FieldContext): Classification {
  const domKind = domKindOf(ctx.type);

  // File inputs are resume/cover-letter by label, default resume.
  if (domKind === "file") {
    const hay = norm([ctx.label, ctx.name, ctx.ariaLabel].join(" "));
    const cat: FieldCategory = /cover\s*letter|motivation/.test(hay) ? "cover_letter" : "resume_upload";
    return { category: cat, domKind, isYesNo: false };
  }

  // Pass 1: the field's OWN text (label + name + placeholder + aria-label).
  // A clear label must win, so the section heading is NOT mixed in here.
  const shortSignals = [ctx.label, ctx.name, ctx.placeholder, ctx.ariaLabel]
    .map(norm)
    .filter(Boolean);
  if (shortSignals.some((s) => isShortEmploymentHistoryLabel(s, ctx.sectionHeading))) {
    return { category: "work_experience", domKind, isYesNo: optionsAreYesNo(ctx.options) };
  }

  const primary = [ctx.label, ctx.name, ctx.placeholder, ctx.ariaLabel]
    .map(norm)
    .filter(Boolean)
    .join(" • ");
  let category = matchCategory(primary);

  // Pass 2: only when the field's own text was inconclusive, let the nearest
  // section heading disambiguate (e.g. a bare "Status" under an "EEO" heading).
  if (category === "unknown" && ctx.sectionHeading) {
    category = matchCategory(norm(ctx.sectionHeading));
  }

  // A textarea with no specific category is almost always an essay.
  if (category === "unknown" && domKind === "textarea") category = "open_ended";

  return { category, domKind, isYesNo: optionsAreYesNo(ctx.options) };
}

// ── 1.4 Value validation ───────────────────────────────────────────────────────
// Before writing, confirm the candidate value is plausible for this field. This
// is the last line of defense against cross-field contamination (email in a name
// box, a paragraph in a yes/no dropdown, a school name in a degree field, …).

const EMAIL_RX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const URL_RX = /^(https?:\/\/|www\.)|\b[a-z0-9-]+\.(com|io|dev|net|org|me|co|ai|tech|edu|gov)\b/i;
const PHONE_RX = /^[+(]?[\d][\d\s().-]{6,}$/;
const DATE_RX = /^(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{1,2}[/-]\d{4}|(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{4}|present|current|now)$/i;
// Prose markers that should never appear in a deterministic/short field.
const PROSE_RX = /\b(dear|i am|i'm|i have|my name|experience|hiring manager|sincerely|excited|passionate|relevant for)\b/i;

function looksLikeEmail(v: string) { return EMAIL_RX.test(v.trim()); }
function looksLikeUrl(v: string) { return URL_RX.test(v.trim()); }
function digitCount(v: string) { return (v.match(/\d/g) || []).length; }
function wordCount(v: string) { return v.trim().split(/\s+/).filter(Boolean).length; }

export interface ValidationResult { ok: boolean; reason?: string }

// Validate `value` for a classified field.
export function validateValue(
  cls: Classification,
  value: string,
  // Kept for call-site symmetry with the dropdown path, which passes the option
  // list. Plain-value validation doesn't consult it.
  _options?: string[]
): ValidationResult {
  const v = (value || "").trim();
  if (!v) return { ok: false, reason: "empty" };

  const allowsUrl = cls.domKind === "url" || cls.category === "contact" || cls.category === "open_ended";
  const allowsEmail = cls.domKind === "email" || cls.category === "contact" || cls.category === "open_ended";
  const allowsPhone = cls.domKind === "phone" || cls.category === "contact" || cls.category === "open_ended";

  if (looksLikeUrl(v) && !allowsUrl) return { ok: false, reason: "URL in a non-URL field" };
  if (looksLikeEmail(v) && !allowsEmail) return { ok: false, reason: "email in a non-email field" };
  if (PHONE_RX.test(v) && digitCount(v) >= 7 && !allowsPhone) {
    return { ok: false, reason: "phone number in a non-phone field" };
  }

  // Dropdown/radio: the value must correspond to one of the real options.
  // (Actual option resolution is matchDropdownOption; here we reject obvious
  // prose dumped into a choice field.)
  if (cls.domKind === "select" || cls.domKind === "radio") {
    if (wordCount(v) > 12 || v.length > 120) {
      return { ok: false, reason: "paragraph in a choice field" };
    }
  }

  // Yes/No fields: must be a short yes/no-ish token, never a paragraph.
  if (cls.isYesNo) {
    if (wordCount(v) > 8 && !/^(yes|no)\b/i.test(v)) {
      return { ok: false, reason: "non-yes/no answer in a yes/no field" };
    }
  }

  switch (cls.domKind) {
    case "email":
      if (!looksLikeEmail(v)) return { ok: false, reason: "not an email address" };
      return { ok: true };
    case "phone": {
      const digits = digitCount(v);
      if (digits < 7 || digits > 15 || v.length > 25) return { ok: false, reason: "not a phone number" };
      if (looksLikeEmail(v)) return { ok: false, reason: "email in a phone field" };
      return { ok: true };
    }
    case "url":
      if (!looksLikeUrl(v) || PROSE_RX.test(v)) return { ok: false, reason: "not a URL" };
      return { ok: true };
    case "number":
      if (!/^[\d,.\s$]+$/.test(v)) return { ok: false, reason: "non-numeric value in a number field" };
      return { ok: true };
    case "date":
      if (looksLikeEmail(v) || looksLikeUrl(v)) return { ok: false, reason: "email/URL in a date field" };
      if (!DATE_RX.test(v)) return { ok: false, reason: "not a recognizable date" };
      return { ok: true };
    default:
      break;
  }

  // Category-specific sanity checks (independent of DOM type).
  switch (cls.category) {
    case "identity": {
      // A name is short, has no @, no URL, few digits, and isn't an address/prose.
      if (looksLikeEmail(v)) return { ok: false, reason: "email in a name field" };
      if (looksLikeUrl(v)) return { ok: false, reason: "URL in a name field" };
      if (digitCount(v) >= 3) return { ok: false, reason: "digits in a name field" };
      if (v.length > 60 || wordCount(v) > 6) return { ok: false, reason: "too long for a name" };
      if (/\b(street|avenue|\bave\b|road|\brd\b|suite|apt|blvd|drive)\b/i.test(v)) {
        return { ok: false, reason: "address in a name field" };
      }
      return { ok: true };
    }
    case "address":
      if (looksLikeEmail(v)) return { ok: false, reason: "email in an address field" };
      return { ok: true };
    case "education":
      // A degree/school value shouldn't be an email/url/phone or obvious prose.
      // Real values (degree, major, school) are short; a sentence is wrong here.
      if (looksLikeEmail(v) || looksLikeUrl(v)) return { ok: false, reason: "email/URL in an education field" };
      if (wordCount(v) > 12) return { ok: false, reason: "prose in an education field" };
      return { ok: true };
    case "work_experience":
      if (looksLikeEmail(v) || looksLikeUrl(v)) return { ok: false, reason: "email/URL in a work-history field" };
      if (PROSE_RX.test(v) || wordCount(v) > 12) return { ok: false, reason: "prose in a work-history field" };
      return { ok: true };
    case "salary": {
      // Amount fields want a number; but a currency-code dropdown ("USD"), a
      // currency symbol, or a deliberate non-numeric placeholder ("Negotiable",
      // "Competitive", "Market rate") are all legitimate salary answers too.
      const okCurrencyCode = /^(usd|eur|gbp|inr|cad|aud|chf|jpy|sgd|aed|nzd|zar)$/i.test(v);
      const okSymbol = /[$€£₹¥]/.test(v);
      const okPlaceholder = /^(negotiable|competitive|market(\s*rate)?|open|flexible|as\s*per\s*(company\s*)?standards?|doe|tbd|n\/?a)$/i.test(v);
      if (digitCount(v) === 0 && !okCurrencyCode && !okSymbol && !okPlaceholder) {
        return { ok: false, reason: "salary with no number" };
      }
      return { ok: true };
    }
    case "work_authorization":
    case "sponsorship":
      // These are yes/no — never a paragraph.
      if (wordCount(v) > 10) return { ok: false, reason: "prose in a yes/no authorization field" };
      return { ok: true };
    case "unknown":
      if (looksLikeEmail(v) || looksLikeUrl(v)) return { ok: false, reason: "email/URL in an unknown field" };
      if (PROSE_RX.test(v) || wordCount(v) > 12) return { ok: false, reason: "unsafe value for an unknown field" };
      return { ok: true };
    default:
      return { ok: true };
  }
}
