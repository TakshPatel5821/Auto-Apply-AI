// ─── ATS adapter registry ─────────────────────────────────────────────────────
// "Too many templates" online → instead of training an ML model (impractical),
// we keep a pattern library of the major Applicant Tracking Systems. Each
// adapter augments the generic multi-step form loop with platform-specific
// button text, file-input quirks, success markers, and a "needs login" flag.
//
// Detection is by URL (the ATS host is almost always in the apply URL). When no
// adapter matches, the engine falls back to its generic heuristics, so unknown
// templates still work as well as before — adapters only ADD reliability.
//
// To support a new platform: add an entry below. No other code changes needed.

export interface AtsAdapter {
  id: string;
  label: string;
  // URL substrings that identify this ATS (any match wins).
  hosts: string[];
  // Most of these ATSes force an account/login before you can submit.
  requiresLogin?: boolean;
  // Extra selectors merged BEFORE the generic ones (higher priority).
  fileInput?: string[];
  advanceButtons?: string[];
  submitButtons?: string[];
  successSelectors?: string[];
  successText?: string[];
  // Free-text note surfaced in logs to explain quirks.
  notes?: string;
}

export const ATS_ADAPTERS: AtsAdapter[] = [
  {
    id: "greenhouse",
    label: "Greenhouse",
    hosts: ["greenhouse.io", "boards.greenhouse", "grnh.se"],
    fileInput: ['input#resume', 'input[name="resume"]', 'input[type="file"]'],
    submitButtons: ['button#submit_app', 'input#submit_app', 'button:has-text("Submit Application")'],
    advanceButtons: ['button:has-text("Continue")'],
    successText: ["thank you for applying", "application has been submitted"],
    notes: "Greenhouse is usually single-page; resume input has id=resume.",
  },
  {
    id: "lever",
    label: "Lever",
    hosts: ["lever.co", "jobs.lever"],
    fileInput: ['input[name="resume"]', 'input[type="file"][name="resume"]'],
    submitButtons: ['button:has-text("Submit application")', 'button[type="submit"]'],
    successText: ["thank you", "application submitted", "we received your application"],
    notes: "Lever single-page form; fields use name attributes (name, email, resume).",
  },
  {
    id: "workday",
    label: "Workday",
    hosts: ["myworkdayjobs.com", "workday.com", ".wd1.", ".wd2.", ".wd3.", ".wd5."],
    requiresLogin: true,
    fileInput: ['input[data-automation-id="file-upload-input-ref"]', 'input[type="file"]'],
    advanceButtons: [
      'button[data-automation-id="bottom-navigation-next-button"]',
      'button:has-text("Save and Continue")',
      'button:has-text("Next")',
    ],
    submitButtons: ['button:has-text("Submit")', 'button[data-automation-id="bottom-navigation-next-button"]'],
    successText: ["you have submitted", "application submitted", "thank you for applying"],
    notes: "Workday requires an account; multi-step with data-automation-id selectors.",
  },
  {
    id: "icims",
    label: "iCIMS",
    hosts: ["icims.com"],
    fileInput: ['input[type="file"]'],
    advanceButtons: ['a:has-text("Continue")', 'button:has-text("Continue")', 'button:has-text("Next")'],
    submitButtons: ['button:has-text("Submit")', 'a:has-text("Submit")', 'input[type="submit"]'],
    successText: ["thank you for your interest", "application has been submitted"],
    notes: "iCIMS often renders inside an iframe; multi-step.",
  },
  {
    id: "adp",
    label: "ADP Recruiting",
    hosts: ["myjobs.adp.com", "workforcenow.adp.com"],
    requiresLogin: true,
    fileInput: ['input[type="file"]'],
    advanceButtons: ['button:has-text("Next")', 'button:has-text("Continue")'],
    submitButtons: ['button:has-text("Submit")', 'button:has-text("Apply")'],
    successText: ["thank you", "application submitted"],
    notes: "ADP usually needs account creation; heavy SPA.",
  },
  {
    id: "taleo",
    label: "Oracle Taleo",
    hosts: ["taleo.net"],
    requiresLogin: true,
    advanceButtons: ['a:has-text("Save and Continue")', 'button:has-text("Next")'],
    submitButtons: ['button:has-text("Submit")', 'a:has-text("Submit")'],
    successText: ["application complete", "thank you"],
    notes: "Taleo is legacy, slow, login-gated, multi-step.",
  },
  {
    id: "oraclecloud",
    label: "Oracle Cloud (Recruiting)",
    hosts: ["oraclecloud.com", "fa.us2.oraclecloud", "/hcmUI/CandidateExperience"],
    fileInput: ['input[type="file"]'],
    advanceButtons: ['button:has-text("Continue")', 'button:has-text("Next")'],
    submitButtons: ['button:has-text("Submit")', 'button:has-text("Apply Now")', 'button:has-text("Submit Application")'],
    successText: ["thank you", "application submitted", "you have applied"],
    notes: "Oracle Cloud Recruiting (eeho). Multi-step; may prompt to create profile.",
  },
  {
    id: "smartrecruiters",
    label: "SmartRecruiters",
    hosts: ["smartrecruiters.com", "jobs.smartrecruiters"],
    fileInput: ['input[type="file"]'],
    submitButtons: ['button:has-text("Submit application")', 'button[type="submit"]'],
    successText: ["thank you for applying", "application received"],
    notes: "SmartRecruiters single-page; clean field labels.",
  },
  {
    id: "ashby",
    label: "Ashby",
    hosts: ["jobs.ashbyhq.com", "ashbyhq.com"],
    fileInput: ['input[type="file"]'],
    submitButtons: ['button:has-text("Submit Application")', 'button[type="submit"]'],
    successText: ["thank you", "application submitted"],
    notes: "Ashby modern SPA; single page.",
  },
  {
    id: "bamboohr",
    label: "BambooHR",
    hosts: ["bamboohr.com"],
    fileInput: ['input[type="file"]'],
    submitButtons: ['button:has-text("Submit Application")', 'button[type="submit"]'],
    successText: ["thank you", "application submitted"],
  },
  {
    id: "jobvite",
    label: "Jobvite",
    hosts: ["jobs.jobvite.com", "jobvite.com"],
    fileInput: ['input[type="file"]'],
    advanceButtons: ['button:has-text("Continue")', 'button:has-text("Next")'],
    submitButtons: ['button:has-text("Submit")', 'button[type="submit"]'],
    successText: ["thank you", "application submitted"],
  },
  {
    id: "workable",
    label: "Workable",
    hosts: ["workable.com", "apply.workable"],
    fileInput: ['input[type="file"]'],
    submitButtons: ['button:has-text("Submit application")', 'button[type="submit"]'],
    successText: ["thank you for applying", "application received"],
  },
  {
    id: "dice",
    label: "Dice",
    hosts: ["dice.com"],
    requiresLogin: true,
    submitButtons: ['button:has-text("Apply Now")', 'button:has-text("Easy Apply")', 'button:has-text("Submit")'],
    successText: ["application submitted", "you have applied"],
    notes: "Dice usually needs a Dice account to apply.",
  },
];

// Find the adapter whose hosts match the current URL, if any.
export function detectAts(url: string): AtsAdapter | null {
  const u = url.toLowerCase();
  for (const a of ATS_ADAPTERS) {
    if (a.hosts.some((h) => u.includes(h.toLowerCase()))) return a;
  }
  return null;
}
