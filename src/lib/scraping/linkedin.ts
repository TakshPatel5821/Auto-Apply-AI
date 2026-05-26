import { BaseScraper } from "./base-scraper";
import { ScrapedJob } from "@/types";
import { Logger } from "@/lib/logging/logger";

export class LinkedInScraper extends BaseScraper {
  private cookie?: string;

  constructor(cookie?: string) {
    super();
    this.cookie = cookie || process.env.LINKEDIN_COOKIE;
  }

  async scrapeJobs(
    keywords: string[],
    locations: string[],
    options: Record<string, unknown> = {}
  ): Promise<ScrapedJob[]> {
    const jobs: ScrapedJob[] = [];

    if (!this.cookie) {
      await Logger.warn(
        "LINKEDIN",
        "No li_at cookie — LinkedIn skipped. F12 → Application → Cookies → copy li_at → paste into LINKEDIN_COOKIE in .env"
      );
      return jobs;
    }

    try {
      await this.init();

      // Navigate to blank page first, then set cookie to avoid redirect loops
      await this.page!.goto("about:blank");
      await this.context!.addCookies([{
        name: "li_at",
        value: this.cookie,
        domain: ".linkedin.com",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "None",
      }]);

      // Go directly to the feed (logged-in landing page) — avoids homepage redirect loop
      await Logger.info("LINKEDIN", "Opening LinkedIn feed...");
      try {
        await this.page!.goto("https://www.linkedin.com/feed/", {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
      } catch {
        // Feed redirect may still happen — wait for it to settle
        await this.humanDelay(3000, 5000);
      }

      await this.humanDelay(2000, 3500);
      await this.randomScroll(1, 2);

      for (const keyword of keywords.slice(0, 3)) {
        for (const location of locations.slice(0, 2)) {
          if (jobs.length >= 60) break;
          const scraped = await this.scrapeKeyword(keyword, location, options);
          jobs.push(...scraped);
          await this.humanDelay(4000, 8000);
        }
      }
    } catch (e) {
      await Logger.error("LINKEDIN", "Scraping failed", { error: String(e) });
    } finally {
      await this.cleanup();
    }

    return jobs;
  }

  private async scrapeKeyword(
    keyword: string,
    location: string,
    options: Record<string, unknown>
  ): Promise<ScrapedJob[]> {
    const jobs: ScrapedJob[] = [];

    try {
      await Logger.info("LINKEDIN", `Searching: "${keyword}" in ${location}`);

      // Navigate to jobs page naturally
      await this.safeNavigate("https://www.linkedin.com/jobs/", 30000);
      await this.humanDelay(2000, 4000);

      // Type in the keyword search box
      const keywordInput = await this.page!.$(
        'input[aria-label*="title"], input[aria-label*="Search"], input.jobs-search-box__text-input'
      );
      if (!keywordInput) {
        await Logger.warn("LINKEDIN", "Could not find job search input");
        return jobs;
      }

      await keywordInput.click({ delay: 80 });
      await this.humanDelay(300, 700);
      // Clear any existing text
      await this.page!.keyboard.press("Control+a");
      await this.humanDelay(100, 200);
      await this.humanType(keyword);
      await this.humanDelay(500, 1000);

      // Tab to location box and fill it
      const locationInput = await this.page!.$(
        'input[aria-label*="location"], input[aria-label*="City"]'
      );
      if (locationInput) {
        await locationInput.click({ delay: 80 });
        await this.humanDelay(300, 600);
        await this.page!.keyboard.press("Control+a");
        await this.humanDelay(100, 200);
        await this.humanType(location);
        await this.humanDelay(600, 1200);
      }

      // Press Enter to search
      await this.page!.keyboard.press("Enter");
      await this.humanDelay(3000, 5000);

      // Apply experience level filter if specified
      if (options.experienceLevels) {
        await this.applyExperienceFilter(options.experienceLevels as string[]);
        await this.humanDelay(2000, 3500);
      }

      // Scroll through results naturally
      await this.randomScroll();
      await this.humanDelay(1500, 3000);

      // Extract job cards visible on page
      const cards = await this.page!.$$(
        ".job-card-container, .jobs-search-results__list-item, li.ember-view"
      );

      await Logger.info("LINKEDIN", `Found ${cards.length} job cards`);

      for (const card of cards.slice(0, 15)) {
        try {
          // Click each card to load details in sidebar
          await card.click();
          await this.humanDelay(1500, 2500);
          await this.randomScroll(1, 2);

          const job = await this.extractJob();
          if (job) jobs.push(job);
        } catch (e) {
          await Logger.warn("LINKEDIN", "Card extraction failed", { error: String(e) });
        }
      }
    } catch (e) {
      await Logger.warn("LINKEDIN", `Search failed for "${keyword}"`, { error: String(e) });
    }

    return jobs;
  }

  private async extractJob(): Promise<ScrapedJob | null> {
    try {
      const titleEl = await this.page!.$(
        ".job-details-jobs-unified-top-card__job-title, .jobs-unified-top-card__job-title h1"
      );
      const companyEl = await this.page!.$(
        ".job-details-jobs-unified-top-card__company-name a, .jobs-unified-top-card__company-name"
      );
      const locationEl = await this.page!.$(
        ".job-details-jobs-unified-top-card__primary-description-without-tagline .tvm__text, .jobs-unified-top-card__bullet"
      );

      const jobTitle = (await titleEl?.textContent())?.trim() || "";
      const companyName = (await companyEl?.textContent())?.trim() || "";
      const location = (await locationEl?.textContent())?.trim() || "";

      if (!jobTitle || !companyName) return null;

      const url = this.page!.url();
      const platformJobId = url.match(/\/jobs\/view\/(\d+)/)?.[1];

      // Is Easy Apply?
      const easyApplyBtn = await this.page!.$(
        ".jobs-apply-button .artdeco-button__text"
      );
      const btnText = (await easyApplyBtn?.textContent()) || "";
      const isEasyApply = btnText.toLowerCase().includes("easy apply");

      // Get description
      const descEl = await this.page!.$(
        ".jobs-description-content__text, #job-details"
      );
      const description = (await descEl?.textContent())?.trim() || "";

      // Salary
      const salaryEl = await this.page!.$(
        ".compensation__salary, .jobs-unified-top-card__job-insight--highlight"
      );
      const salaryText = (await salaryEl?.textContent())?.trim() || "";
      const salaryData = salaryText ? this.extractSalary(salaryText) : {};

      const descLower = description.toLowerCase();

      return {
        platform: "linkedin",
        platformJobId,
        url,
        applyUrl: url,
        easyApplyUrl: isEasyApply ? url : undefined,
        isEasyApply,
        companyName,
        jobTitle,
        location,
        salary: salaryText || undefined,
        salaryMin: (salaryData as { min?: number }).min,
        salaryMax: (salaryData as { max?: number }).max,
        isRemote: descLower.includes("remote") || location.toLowerCase().includes("remote"),
        isHybrid: descLower.includes("hybrid") || location.toLowerCase().includes("hybrid"),
        requiresSponsorship: descLower.includes("h1b") && !descLower.includes("no sponsorship"),
        description,
        requirements: [],
        responsibilities: [],
        niceToHave: [],
        benefits: [],
        scrapedAt: new Date(),
      };
    } catch {
      return null;
    }
  }

  private async applyExperienceFilter(levels: string[]): Promise<void> {
    try {
      // Click "All filters" or experience filter button
      const filterBtn = await this.page!.$(
        'button[aria-label*="Experience level"], button[aria-label*="All filters"]'
      );
      if (!filterBtn) return;
      await filterBtn.click();
      await this.humanDelay(1000, 2000);

      for (const level of levels) {
        const label = this.mapExperienceLabel(level);
        const checkbox = await this.page!.$(`label:has-text("${label}")`);
        if (checkbox) {
          await checkbox.click();
          await this.humanDelay(300, 600);
        }
      }

      // Apply
      const applyBtn = await this.page!.$('button:has-text("Show results"), button:has-text("Apply")');
      if (applyBtn) {
        await applyBtn.click();
        await this.humanDelay(1500, 2500);
      }
    } catch {
      // Filter UI changes often — skip gracefully
    }
  }

  // Types text character by character with random delays (human-like)
  private async humanType(text: string): Promise<void> {
    for (const char of text) {
      await this.page!.keyboard.type(char, { delay: 60 + Math.random() * 120 });
    }
  }

  // Human-like delay
  private async humanDelay(min: number, max: number): Promise<void> {
    await this.delay(min, max);
  }

  // Random scrolling to simulate reading
  private async randomScroll(minScrolls = 2, maxScrolls = 5): Promise<void> {
    const scrolls = Math.floor(Math.random() * (maxScrolls - minScrolls + 1)) + minScrolls;
    for (let i = 0; i < scrolls; i++) {
      const amount = 300 + Math.floor(Math.random() * 500);
      await this.page!.evaluate((y) => window.scrollBy(0, y), amount);
      await this.delay(600, 1500);
    }
    // Occasionally scroll back up a bit
    if (Math.random() > 0.6) {
      await this.page!.evaluate(() => window.scrollBy(0, -(150 + Math.random() * 200)));
      await this.delay(400, 900);
    }
  }

  private mapExperienceLabel(level: string): string {
    const map: Record<string, string> = {
      internship: "Internship",
      entry: "Entry level",
      associate: "Associate",
      mid: "Mid-Senior level",
      senior: "Senior level",
    };
    return map[level.toLowerCase()] || "Entry level";
  }
}
