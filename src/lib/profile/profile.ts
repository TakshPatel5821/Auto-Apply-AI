// ─── Profile Engine V2 ────────────────────────────────────────────────────────
// A single structured source of truth for the candidate, replacing scattered
// free-text memory for the FIELDS WE CAN STRUCTURE. Each field carries a value,
// a category, a confidence (0-1), and a lock flag. The field resolver maps a
// detected form field → the right profile value deterministically, so we don't
// burn AI calls (or hallucinate) on name/email/phone/visa/education questions.
//
// Stored as one JSON row in UserSettings.profile (no migration churn). Memory
// (ApplicationMemory) still handles open-ended/free-text questions.

export type ProfileCategory =
  | "identity"
  | "contact"
  | "immigration"
  | "education"
  | "professional"
  | "preferences"   // salary / availability / relocation / work-mode / referral
  | "compliance";

export interface ProfileField {
  value: string;
  category: ProfileCategory;
  confidence: number; // 0-1; user-entered = 1.0, parsed = lower
  locked: boolean;
  // Optional enum hint for dropdown matching (e.g. "state", "country", "yesno").
  kind?: "text" | "email" | "phone" | "url" | "state" | "country" | "yesno" | "degree" | "date";
}

export type Profile = Record<string, ProfileField>;

// Canonical field keys + their metadata. The resolver matches form labels to
// these keys via the `match` regexes.
export interface FieldSpec {
  key: string;
  label: string;
  category: ProfileCategory;
  kind: ProfileField["kind"];
  match: RegExp; // tested against the normalized field label
  // Compliance fields must come from the profile — never AI. If unset here,
  // automation pauses for the human.
  compliance?: boolean;
}

// Order matters: more specific patterns first (e.g. "first name" before "name").
export const FIELD_SPECS: FieldSpec[] = [
  // Identity
  { key: "firstName", label: "First Name", category: "identity", kind: "text", match: /first\s*name|given\s*name|fname/i },
  { key: "middleName", label: "Middle Name", category: "identity", kind: "text", match: /middle\s*name|middle\s*initial/i },
  { key: "lastName", label: "Last Name", category: "identity", kind: "text", match: /last\s*name|surname|family\s*name|lname/i },
  { key: "preferredName", label: "Preferred Name", category: "identity", kind: "text", match: /preferred\s*name|nickname/i },
  { key: "fullName", label: "Full Name", category: "identity", kind: "text", match: /full\s*name|^name$|legal\s*name|your\s*name/i },

  // Contact
  { key: "email", label: "Email", category: "contact", kind: "email", match: /e-?mail/i },
  { key: "phone", label: "Phone", category: "contact", kind: "phone", match: /phone|mobile|telephone|cell\b|contact\s*number/i },
  { key: "addressLine", label: "Street Address", category: "contact", kind: "text", match: /street|address\s*line|address\s*1|mailing\s*address/i },
  { key: "city", label: "City", category: "contact", kind: "text", match: /\bcity\b|town/i },
  { key: "state", label: "State", category: "contact", kind: "state", match: /\bstate\b|province|region/i },
  { key: "zip", label: "Zip", category: "contact", kind: "text", match: /zip|postal\s*code|post\s*code/i },
  { key: "country", label: "Country", category: "contact", kind: "country", match: /\bcountry\b/i },

  // Immigration (compliance — never AI)
  { key: "workAuthorized", label: "Authorized to work in the US", category: "immigration", kind: "yesno", compliance: true, match: /authoriz(ed|ation) to work|legally (authorized|able) to work|work authorization|eligible to work/i },
  { key: "requiresSponsorship", label: "Requires visa sponsorship", category: "immigration", kind: "yesno", compliance: true, match: /require.*sponsor|need.*sponsor|sponsorship (now or in the future|required)/i },
  { key: "cptEligible", label: "CPT eligible", category: "immigration", kind: "yesno", compliance: true, match: /\bcpt\b|curricular practical training/i },
  { key: "optEligible", label: "OPT eligible", category: "immigration", kind: "yesno", compliance: true, match: /\bopt\b|optional practical training/i },
  { key: "stemOptEligible", label: "STEM OPT eligible", category: "immigration", kind: "yesno", compliance: true, match: /stem\s*opt/i },
  { key: "citizenship", label: "Citizenship / Work Status", category: "immigration", kind: "text", compliance: true, match: /citizen(ship)?|are\s*you\s*a\s*(u\.?s\.?\s*)?citizen|permanent\s*resident|immigration\s*status|residency\s*status/i },

  // Education
  { key: "degreeLevel", label: "Degree Level", category: "education", kind: "degree", match: /degree\s*level|highest\s*(degree|education)|education\s*level/i },
  { key: "degreeName", label: "Degree", category: "education", kind: "degree", match: /\bdegree\b|qualification/i },
  { key: "major", label: "Major", category: "education", kind: "text", match: /major|field\s*of\s*study|concentration|discipline/i },
  { key: "university", label: "University", category: "education", kind: "text", match: /university|college|school|institution|alma\s*mater/i },
  { key: "graduationDate", label: "Graduation Date", category: "education", kind: "date", match: /grad(uation)?\s*(date|year)|completion\s*date|end\s*date/i },
  { key: "gpa", label: "GPA", category: "education", kind: "text", match: /\bgpa\b|grade\s*point/i },

  // Professional
  { key: "currentTitle", label: "Current Job Title", category: "professional", kind: "text", match: /^(job\s*)?title$|^position( title)?$|^role( title)?$|current\s*(job\s*)?(title|role|position)|present\s*(title|role|position)|most\s*recent\s*(title|role|position)/i },
  { key: "currentCompany", label: "Current Employer", category: "professional", kind: "text", match: /^(company|company name|employer|employer name|organization|organization name)$|current\s*(employer|company|organization)|present\s*(employer|company)|most\s*recent\s*(employer|company)/i },
  { key: "yearsExperience", label: "Years of Experience", category: "professional", kind: "text", match: /years?\s*of\s*experience|years?\s*experience|total\s*experience|relevant\s*experience/i },
  { key: "skills", label: "Key Skills", category: "professional", kind: "text", match: /key\s*skills|technical\s*skills|core\s*skills|primary\s*skills|relevant\s*skills|^skills$/i },
  { key: "linkedin", label: "LinkedIn", category: "professional", kind: "url", match: /linkedin/i },
  { key: "github", label: "GitHub", category: "professional", kind: "url", match: /github/i },
  { key: "portfolio", label: "Portfolio", category: "professional", kind: "url", match: /portfolio/i },
  { key: "website", label: "Website", category: "professional", kind: "url", match: /website|personal\s*site|web\s*page/i },

  // Preferences (salary is sensitive — see field-classifier; others pause-if-unset
  // only when AI isn't allowed). Placed before compliance so order stays sane.
  { key: "salaryExpectation", label: "Salary Expectation", category: "preferences", kind: "text", compliance: true, match: /salary|compensation|expected\s*pay|desired\s*(pay|salary)|pay\s*expectation|hourly\s*rate|expected\s*ctc|\bctc\b|minimum.*(salary|pay|rate)/i },
  { key: "workPreference", label: "Work Mode (Remote/Onsite/Hybrid)", category: "preferences", kind: "text", match: /work\s*from\s*(the\s*)?office|on-?site|remote\s*(work|preference)?|hybrid|work\s*arrangement|work\s*setting/i },
  { key: "preferredLocation", label: "Preferred Work Location", category: "preferences", kind: "text", match: /preferred\s*(office\s*)?location|preferred\s*work\s*location|which\s*office|location\s*preference/i },
  { key: "willingToRelocate", label: "Willing to Relocate", category: "preferences", kind: "yesno", match: /willing\s*to\s*relocate|open\s*to\s*relocat|relocat/i },
  { key: "willingToTravel", label: "Willing to Travel", category: "preferences", kind: "yesno", match: /willing\s*to\s*travel|able\s*to\s*travel|travel\s*requirement/i },
  { key: "startDate", label: "Earliest Start Date / Availability", category: "preferences", kind: "text", match: /start\s*date|available.*start|when\s*can\s*you\s*(start|begin)|earliest\s*(start|availability)|availability\s*date|notice\s*period/i },
  { key: "referralSource", label: "How did you hear about us?", category: "preferences", kind: "text", match: /how\s*did\s*you\s*hear|referral\s*source|how\s*were\s*you\s*referred|where\s*did\s*you\s*(hear|find)/i },

  // Compliance / EEO (never AI — pause if unknown).
  // NOTE: pronouns/lgbtq come BEFORE gender — "gender pronouns" contains "gender".
  { key: "pronouns", label: "Preferred Pronouns", category: "compliance", kind: "text", compliance: true, match: /pronoun/i },
  { key: "lgbtq", label: "LGBTQ+ Identity", category: "compliance", kind: "text", compliance: true, match: /lgbtq|sexual\s*orientation/i },
  { key: "gender", label: "Gender", category: "compliance", kind: "text", compliance: true, match: /\bgender\b|gender\s*identity|\bsex\b/i },
  { key: "race", label: "Race / Ethnicity", category: "compliance", kind: "text", compliance: true, match: /race|ethnicity|hispanic|latino/i },
  { key: "veteranStatus", label: "Veteran Status", category: "compliance", kind: "yesno", compliance: true, match: /veteran|military|armed\s*forces/i },
  { key: "disabilityStatus", label: "Disability Status", category: "compliance", kind: "yesno", compliance: true, match: /disab(led|ility)|accessibility needs/i },
  { key: "governmentOfficial", label: "Government Official Relationship", category: "compliance", kind: "yesno", compliance: true, match: /government\s*official|public\s*official|conflict\s*of\s*interest|related\s*to.*official|hold.*government\s*position|recommended.*government/i },
  { key: "backgroundCheck", label: "Background Check Consent", category: "compliance", kind: "yesno", compliance: true, match: /background\s*check|criminal\s*record|felony|conviction|arrest/i },
  { key: "complianceOther", label: "Other Compliance", category: "compliance", kind: "text", compliance: true, match: /eeo|equal\s*employment|compliance|certification|legal.*status|fraud|corruption|bribery/i },
];

const NORM = (s: string) => (s || "").replace(/\*/g, "").replace(/\s+/g, " ").trim();

export interface FieldResolution {
  spec: FieldSpec;
  field: ProfileField | null; // null when key is unset in the profile
}

// Resolve a detected form-field label to a profile field. Returns the matched
// spec (so callers know category/compliance) and the stored value if present.
export function resolveField(label: string, profile: Profile): FieldResolution | null {
  const l = NORM(label);
  if (!l) return null;
  for (const spec of FIELD_SPECS) {
    if (spec.match.test(l)) {
      return { spec, field: profile[spec.key] ?? null };
    }
  }
  return null;
}

// Build a default profile from a parsed résumé's contactInfo (best-effort,
// lower confidence than user-entered). Existing locked values are preserved.
export function seedProfileFromResume(
  existing: Profile,
  resume: {
    contactInfo?: Record<string, string>;
    yearsOfExperience?: number;
    education?: unknown[];
    experience?: unknown[];
    skills?: unknown[];
  }
): Profile {
  const out: Profile = { ...existing };
  const set = (key: string, value: string | undefined, kind: ProfileField["kind"], category: ProfileCategory) => {
    if (!value) return;
    const cur = out[key];
    if (cur?.locked) return; // never overwrite a locked field
    out[key] = { value, category, confidence: 0.7, locked: false, kind };
  };

  const c = resume.contactInfo || {};
  const nameParts = (c.name || "").trim().split(/\s+/);
  if (nameParts.length) {
    set("firstName", nameParts[0], "text", "identity");
    if (nameParts.length > 1) set("lastName", nameParts.slice(1).join(" "), "text", "identity");
    set("fullName", c.name, "text", "identity");
  }
  set("email", c.email, "email", "contact");
  set("phone", c.phone, "phone", "contact");
  set("linkedin", c.linkedin, "url", "professional");
  set("github", c.github, "url", "professional");
  set("portfolio", c.portfolio, "url", "professional");
  set("city", c.location, "text", "contact");
  if (typeof resume.yearsOfExperience === "number" && resume.yearsOfExperience > 0) {
    set("yearsExperience", String(resume.yearsOfExperience), "text", "professional");
  }

  // Education from the first education entry.
  const edu = Array.isArray(resume.education) ? (resume.education[0] as Record<string, string>) : null;
  if (edu) {
    set("degreeName", edu.degree, "degree", "education");
    set("major", edu.field, "text", "education");
    set("university", edu.institution, "text", "education");
    set("graduationDate", edu.endDate, "date", "education");
    if (edu.gpa) set("gpa", edu.gpa, "text", "education");
  }

  // Current role from the most recent / current experience entry.
  const exp = Array.isArray(resume.experience) ? (resume.experience as Record<string, unknown>[]) : [];
  const current = exp.find((e) => e && (e as { current?: boolean }).current) || exp[0];
  if (current) {
    set("currentTitle", (current.title as string) || undefined, "text", "professional");
    set("currentCompany", (current.company as string) || undefined, "text", "professional");
  }

  // Skills — join the parsed list into a comma-separated string.
  const skills = Array.isArray(resume.skills)
    ? (resume.skills as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  if (skills.length) set("skills", skills.slice(0, 20).join(", "), "text", "professional");

  return out;
}
