// Shared signal: set to true when scraper detects a bot wall and needs human help.
// automation-engine.resume() sets it back to false so the scraper can continue.
//
// userConfirmedSubmit: during a human takeover the user can explicitly assert
// "I actually submitted this" (vs. just resuming) — so a genuinely-completed
// application that we can't auto-detect isn't wrongly marked FAILED. Reset on
// each new wait.
export const scraperStatus = {
  waitingForUser: false,
  reason: "",
  userConfirmedSubmit: false,
};
