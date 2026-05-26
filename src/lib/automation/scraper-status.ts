// Shared signal: set to true when scraper detects a bot wall and needs human help.
// automation-engine.resume() sets it back to false so the scraper can continue.
export const scraperStatus = {
  waitingForUser: false,
  reason: "",
};
