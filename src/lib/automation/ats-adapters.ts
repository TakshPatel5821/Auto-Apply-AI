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
  // Confirmation that the application went through (Phase 8 trusts these).
  successSelectors?: string[];
  successText?: string[];
  // Phase 4: per-platform validation-error markers. When a step won't advance,
  // the engine reads these to explain WHY (which field the ATS rejected) instead
  // of a generic "form didn't advance".
  validationErrorSelectors?: string[];
  // Phase 4: known weird fields / behaviors — surfaced in logs so a human pause
  // makes sense (e.g. "phone needs a country-code dropdown first").
  quirks?: string[];
  // Free-text note surfaced in logs to explain quirks.
  notes?: string;
}

// Generic validation-error selectors tried when an adapter doesn't define its
// own. Covers the common ARIA / class conventions across ATS form libraries.
export const GENERIC_VALIDATION_ERROR_SELECTORS = [
  '[aria-invalid="true"]',
  '[role="alert"]',
  '.error:not(:empty)',
  '.field-error',
  '.field_error',
  '.input-error',
  '.invalid-feedback',
  '.help-block.error',
  '[class*="error" i]:not(:empty)',
  '[data-automation-id*="error" i]',
];

export const ATS_ADAPTERS: AtsAdapter[] = [
  {
    id: "greenhouse",
    label: "Greenhouse",
    hosts: ["greenhouse.io", "boards.greenhouse", "job-boards.greenhouse", "my.greenhouse", "grnh.se"],
    fileInput: ['input#resume', 'input[name="resume"]', 'input[type="file"][id*="resume" i]', 'input[type="file"]'],
    submitButtons: [
      'button#submit_app',
      'input#submit_app',
      'button:has-text("Submit Application")',
      'button:has-text("Submit application")',
      'button[type="submit"]',
    ],
    advanceButtons: ['button:has-text("Continue")', 'button:has-text("Next")', 'button:has-text("Review")'],
    successSelectors: ['#application_confirmation', '.application-confirmation', 'div:has-text("Thank you for applying")'],
    successText: ["thank you for applying", "application has been submitted", "your application has been submitted"],
    validationErrorSelectors: ['.field_with_errors', 'label.error', '.error:not(:empty)', '[aria-invalid="true"]'],
    quirks: ['Custom EEO/demographic questions render as native <select> dropdowns.', 'Phone field may require a country-code prefix.'],
    notes: "Greenhouse boards are single-page; my.greenhouse.io is the login-gated candidate portal.",
  },
  {
    id: "lever",
    label: "Lever",
    hosts: ["lever.co", "jobs.lever"],
    fileInput: ['input[name="resume"]', 'input[type="file"][name="resume"]'],
    submitButtons: ['button:has-text("Submit application")', 'button[type="submit"]'],
    successSelectors: ['.application-confirmation', 'div:has-text("Thank you for applying")'],
    successText: ["thank you", "application submitted", "we received your application"],
    validationErrorSelectors: ['.application-error', '.error-list li', '[aria-invalid="true"]', '.invalid'],
    quirks: ['Some custom cards are required <textarea> questions appended after the standard fields.'],
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
    successSelectors: ['[data-automation-id="confirmationPage"]', '[data-automation-id="successMessage"]'],
    successText: ["you have submitted", "application submitted", "thank you for applying"],
    validationErrorSelectors: ['[data-automation-id="errorMessage"]', '[data-automation-id="errorField"]', '[aria-invalid="true"]', '.css-error'],
    quirks: [
      'Multi-step wizard; each step must validate before "Save and Continue" works.',
      'Date fields are 3 separate MM / DD / YYYY spinners.',
      'Dropdowns are custom listboxes (not native <select>) — open then click an option.',
    ],
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
    validationErrorSelectors: ['.iCIMS_Error', '.error_message', '[aria-invalid="true"]'],
    quirks: ['Form is usually inside an <iframe> — fields live in the iframe, not the top document.'],
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
    successSelectors: ['.thank-you', 'div:has-text("Thank you for applying")'],
    successText: ["thank you for applying", "application received"],
    validationErrorSelectors: ['.error-message', '[aria-invalid="true"]', '.has-error'],
    notes: "SmartRecruiters single-page; clean field labels.",
  },
  {
    id: "ashby",
    label: "Ashby",
    hosts: ["jobs.ashbyhq.com", "ashbyhq.com"],
    fileInput: ['input[type="file"]'],
    submitButtons: ['button:has-text("Submit Application")', 'button[type="submit"]'],
    successSelectors: ['div:has-text("Thank you for applying")', '[class*="Confirmation"]'],
    successText: ["thank you", "application submitted"],
    validationErrorSelectors: ['[aria-invalid="true"]', '[class*="error" i]:not(:empty)', '[role="alert"]'],
    quirks: ['Dropdowns are custom comboboxes — type to filter, then pick an option.'],
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
    validationErrorSelectors: ['[aria-invalid="true"]', '.error:not(:empty)', '[data-role="error"]'],
    quirks: ['Resume upload triggers an auto-parse that pre-fills fields — verify before advancing.'],
  },
  {
    id: "indeed",
    label: "Indeed Apply",
    hosts: ["indeed.com", "smartapply.indeed.com", "apply.indeed"],
    requiresLogin: true,
    fileInput: ['input[type="file"]', 'input[data-testid="ResumeFileUpload-input"]'],
    advanceButtons: [
      'button:has-text("Continue")',
      'button[data-testid="continue-button"]',
      'button:has-text("Next")',
    ],
    submitButtons: [
      'button:has-text("Submit your application")',
      'button:has-text("Submit application")',
      'button[data-testid="submit-application"]',
      'button:has-text("Submit")',
    ],
    successSelectors: ['[data-testid="post-apply"]', 'div:has-text("Application submitted")'],
    successText: ["application submitted", "your application has been submitted", "applied"],
    validationErrorSelectors: ['[aria-invalid="true"]', '[role="alert"]', '[id$="-error"]', '.error-text'],
    quirks: [
      'Indeed Apply is a multi-step modal/SPA; usually requires an Indeed login.',
      'Screener questions are radios/dropdowns rendered one step at a time.',
    ],
    notes: "Indeed Apply (smartapply.indeed.com) is a multi-step SPA gated behind an Indeed account.",
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
