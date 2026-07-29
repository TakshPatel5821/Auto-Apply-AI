// Brittle, site-facing selectors + text patterns the apply engine relies on,
// centralized here so that when LinkedIn / an ATS changes its DOM you fix ONE
// file instead of hunting through the engine. The engine still spreads any
// adapter-provided selectors (ats.submitButtons etc.) in FRONT of these
// generic fallbacks.

// Generic FINAL-submit buttons (the control that completes the whole
// application). Deliberately narrow + ordered so a step's "Next" isn't mistaken
// for the real submit; plain "Submit"/"Send" come last.
export const FINAL_SUBMIT_SELECTORS: string[] = [
  'button[aria-label="Submit application"]',
  'button:has-text("Submit application")',
  'button:has-text("Submit Application")',
  'button:has-text("Submit your application")',
  'button:has-text("Submit Your Application")',
  'button:has-text("Send application")',
  'button:has-text("Send Application")',
  'button:has-text("Complete application")',
  'button:has-text("Complete Application")',
  'input[type="submit"][value*="Submit application" i]',
  'a:has-text("Submit application")',
  // Plain "Submit"/"Send" — last, and only as a final action.
  'button:has-text("Submit")',
  'button:has-text("Send")',
  'input[type="submit"][value*="submit" i]',
];

// Buttons that ADVANCE to the next step of a multi-step form.
export const ADVANCE_SELECTORS: string[] = [
  'button:has-text("Save & Go to Next Section")',
  'button:has-text("Save and Go to Next Section")',
  'button:has-text("Save & Continue")',
  'button:has-text("Save and Continue")',
  'button:has-text("Save & Next")',
  'button:has-text("Continue to next step")',
  'button[aria-label*="Continue to next step"]',
  'button:has-text("Review your application")',
  'button[aria-label*="Review"]',
  'button:has-text("Review")',
  'button:has-text("Continue")',
  'button:has-text("Next")',
  'button:has-text("Proceed")',
  'button:has-text("Save and continue")',
  '[data-automation-id="bottom-navigation-next-button"]',
  'a:has-text("Continue")',
  'a:has-text("Next")',
  // Generic form-submit as a last resort (advances single-form steps).
  'button[type="submit"]',
  'input[type="submit"]',
  '.btn-primary[type="submit"]',
];

// Cookie banners / sign-in nags / interstitials we dismiss before reading a page.
export const DISMISS_SELECTORS: string[] = [
  'button[aria-label="Dismiss"]',
  'button[aria-label="Close"]',
  'button.contextual-sign-in-modal__modal-dismiss-icon',
  '.modal__dismiss',
  '#onetrust-accept-btn-handler',
  'button[id*="accept-cookies"]',
  'button:has-text("Accept all")',
  'button:has-text("Accept")',
  'button:has-text("I agree")',
  'button:has-text("Got it")',
  'button:has-text("Continue")',
  '[data-testid="close-button"]',
];

// OTP / email verification-code field detection. LABEL matches code-ish fields;
// EXCLUDE rules out look-alikes (zip/postal/promo/area codes).
export const OTP_LABEL_RE =
  /(?:verification|one[\s-]?time|security|confirmation|passcode|otp|auth(?:entication)?)\s*code|^\s*(?:otp|passcode)\s*$|enter\s+(?:the\s+)?(?:code|otp)|code\s+we\s+(?:sent|emailed)/i;
export const OTP_EXCLUDE_RE =
  /(?:zip|postal|post|area|country|dial|promo|coupon|discount|gift|referral|invite|sort)\s*code|postcode/i;

// Intent → visible-text patterns used by the self-healing button click fallback
// (healClick) when no known selector matches.
export function intentTextPatterns(kind: string): RegExp {
  const k = kind.toLowerCase();
  if (k.includes("submit"))
    return /\b(submit|send) (application|app)\b|submit$|send application|complete application/i;
  if (k.includes("next") || k.includes("continue"))
    return /\b(next|continue|save (and|&) (continue|next)|review|proceed|save (and|&) go)\b/i;
  if (k.includes("sign in") || k.includes("login"))
    return /\bsign in\b|\blog in\b|\blogin\b/i;
  if (k.includes("create account"))
    return /create account|sign up|register/i;
  if (k.includes("apply"))
    return /\bapply\b|easy apply|quick apply/i;
  return new RegExp(kind.replace(/[^a-z0-9]+/gi, "\\s*"), "i");
}
