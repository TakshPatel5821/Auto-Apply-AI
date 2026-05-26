import type { ElementHandle } from "playwright";
import { BaseScraper } from "./base-scraper";
import { ScrapedJob } from "@/types";
import { Logger } from "@/lib/logging/logger";
import { prisma } from "@/lib/db/prisma";

export class LinkedInScraper extends BaseScraper {
  async scrapeJobs(
    keywords: string[],
    locations: string[],
    _options?: Record<string, unknown>
  ): Promise<ScrapedJob[]> {
    const allJobs: ScrapedJob[] = [];

    await Logger.info("LINKEDIN", "Launching Edge with persistent profile (saves cookies between runs)...");
    await this.init("linkedin");

    try {
      const kwList = keywords.slice(0, 3);
      const locList = locations.slice(0, 2);

      for (const keyword of kwList) {
        for (const location of locList) {
          await Logger.info("LINKEDIN", `=== Search: "${keyword}" | "${location}" ===`);
          const jobs = await this.scrapeSearch(keyword, location);
          allJobs.push(...jobs);
          if (allJobs.length > 0 || kwList.indexOf(keyword) < kwList.length - 1) {
            await this.delay(4000, 7000);
          }
        }
      }

      await Logger.success("LINKEDIN", `Session complete — ${allJobs.length} new jobs collected`);
    } finally {
      await this.cleanup();
    }

    return allJobs;
  }

  private async scrapeSearch(keyword: string, location: string): Promise<ScrapedJob[]> {
    const jobs: ScrapedJob[] = [];

    // Step 1: Open LinkedIn Jobs (no cookie injection — let persistent profile handle auth)
    await Logger.info("LINKEDIN", "Opening linkedin.com/jobs/ ...");

    let navOk = false;
    try {
      await this.page!.goto("https://www.linkedin.com/jobs/", {
        waitUntil: "domcontentloaded",
        timeout: 25000,
      });
      navOk = true;
    } catch (e) {
      const msg = String(e);
      if (msg.includes("ERR_TOO_MANY_REDIRECTS")) {
        await Logger.warn("LINKEDIN", "Redirect loop — clearing cookies and retrying as guest...");
        try { await this.context!.clearCookies(); } catch { /* ignore */ }
        // Short wait, then try public guest URL
        await this.delay(1500, 2500);
        try {
          const guestUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(keyword)}&location=${encodeURIComponent(location)}`;
          await this.page!.goto(guestUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
          navOk = true;
          await Logger.info("LINKEDIN", "Loaded as guest — will proceed without login");
        } catch {
          navOk = false;
        }
      } else {
        await Logger.warn("LINKEDIN", `Navigation error: ${msg}`);
      }
    }

    if (!navOk) {
      await Logger.error("LINKEDIN", "Cannot reach LinkedIn — check network connection");
      return jobs;
    }

    await this.delay(2000, 3500);

    // Step 2: Detect bot/auth wall
    const isBotWall = await this.detectBotWall();
    if (isBotWall) {
      const userCleared = await this.waitForUserIntervention("LINKEDIN");
      if (!userCleared) return jobs;
    }

    // Step 3: Check if we're already on a results page (from guest URL fallback above)
    const currentUrl = this.page!.url();
    const alreadyOnResults = currentUrl.includes("/jobs/search/") && currentUrl.includes("keywords=");

    if (!alreadyOnResults) {
      // Step 3a: Type keyword in search bar (human-like)
      await Logger.info("LINKEDIN", `Typing keyword "${keyword}" into search bar...`);
      const kwTyped = await this.typeHumanLike(
        [
          'input[aria-label="Search by title, skill, or company"]',
          'input[id*="jobs-search-box-keyword"]',
          ".jobs-search-box__text-input",
          'input[placeholder*="title, skill"]',
        ],
        keyword
      );

      if (!kwTyped) {
        await Logger.error("LINKEDIN", "Could not find keyword input — LinkedIn layout may have changed");
        return jobs;
      }
      await this.delay(600, 1200);

      // Step 3b: Type location
      await Logger.info("LINKEDIN", `Typing location "${location}"...`);
      await this.typeHumanLike(
        [
          'input[aria-label="City, state, or zip code"]',
          'input[id*="jobs-search-box-location"]',
          'input[placeholder*="City, state"]',
        ],
        location
      );
      await this.delay(700, 1300);

      // Step 3c: Hit Enter
      await Logger.info("LINKEDIN", "Pressing Enter to search...");
      await this.page!.keyboard.press("Enter");
      await this.page!.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
      await this.delay(3000, 5000);

      // Re-check for bot wall after search
      if (await this.detectBotWall()) {
        const cleared = await this.waitForUserIntervention("LINKEDIN");
        if (!cleared) return jobs;
      }
    }

    await Logger.info("LINKEDIN", "Results page ready — scanning job cards...");
    const found = await this.processJobCards();
    jobs.push(...found);

    return jobs;
  }

  private async processJobCards(): Promise<ScrapedJob[]> {
    const jobs: ScrapedJob[] = [];

    const cardSelectors = [
      "li[data-occludable-job-id]",
      ".jobs-search-results__list-item",
      ".scaffold-layout__list-item",
    ];

    let cards: ElementHandle<SVGElement | HTMLElement>[] = [];
    let usedSelector = "";
    for (const sel of cardSelectors) {
      try {
        await this.page!.waitForSelector(sel, { timeout: 8000 });
        cards = await this.page!.$$(sel);
        if (cards.length > 0) { usedSelector = sel; break; }
      } catch { /* try next */ }
    }

    if (cards.length === 0) {
      await Logger.warn("LINKEDIN", "No job cards found on results page");
      return jobs;
    }

    await Logger.info("LINKEDIN", `Found ${cards.length} job cards [${usedSelector}]`);

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];

      const jobId: string | null = await card
        .evaluate((el) => {
          const direct = el.getAttribute("data-job-id") || el.getAttribute("data-occludable-job-id");
          if (direct) return direct;
          const link = el.querySelector('a[href*="/jobs/view/"]');
          const m = link?.getAttribute("href")?.match(/\/jobs\/view\/(\d+)/);
          return m?.[1] ?? null;
        })
        .catch(() => null);

      if (!jobId) {
        await Logger.warn("LINKEDIN", `Card ${i + 1}: no job ID — skipping`);
        continue;
      }

      // Deduplication check
      const existing = await prisma.job.findFirst({
        where: { platform: "linkedin", platformJobId: jobId },
        select: { jobTitle: true, companyName: true },
      });
      if (existing) {
        await Logger.info("LINKEDIN", `[${i + 1}/${cards.length}] Already scraped: "${existing.jobTitle}" @ ${existing.companyName} — skipping`);
        continue;
      }

      // Click card
      await Logger.info("LINKEDIN", `[${i + 1}/${cards.length}] Clicking job card (ID: ${jobId})...`);
      try {
        await card.scrollIntoViewIfNeeded();
        await this.delay(400, 900);
        await card.click();
        await this.delay(2000, 3500);
      } catch (e) {
        await Logger.warn("LINKEDIN", `Click failed for card ${i + 1}: ${e}`);
        continue;
      }

      // Extract details
      const job = await this.extractJobDetails(jobId);
      if (job) {
        await Logger.success("LINKEDIN", `Scraped: "${job.jobTitle}" @ ${job.companyName} [${job.location}]`);
        jobs.push(job);
      }

      // Random scroll every few cards (looks human)
      if (i % 4 === 0) {
        await this.page!.evaluate(() => window.scrollBy(0, Math.floor(Math.random() * 250 + 80)));
        await this.delay(300, 800);
      }
    }

    return jobs;
  }

  private async extractJobDetails(jobId: string): Promise<ScrapedJob | null> {
    try {
      await this.page!.waitForSelector(
        ".jobs-search__job-details, .jobs-details, .job-view-layout, .jobs-details__main-content",
        { timeout: 8000 }
      );

      const titleSelectors = [
        ".job-details-jobs-unified-top-card__job-title h1",
        ".jobs-unified-top-card__job-title h1",
        "h1.t-24",
        "h1.topcard__title",
      ];
      let title = "";
      for (const sel of titleSelectors) {
        title = await this.page!.$eval(sel, (el) => el.textContent?.trim() ?? "").catch(() => "");
        if (title) break;
      }

      const companySelectors = [
        ".job-details-jobs-unified-top-card__company-name a",
        ".jobs-unified-top-card__company-name a",
        ".topcard__org-name-link",
        ".job-details-jobs-unified-top-card__company-name",
      ];
      let company = "";
      for (const sel of companySelectors) {
        company = await this.page!.$eval(sel, (el) => el.textContent?.trim() ?? "").catch(() => "");
        if (company) break;
      }

      const locationSelectors = [
        ".job-details-jobs-unified-top-card__bullet",
        ".jobs-unified-top-card__workplace-type",
        ".topcard__flavor--bullet",
      ];
      let location = "";
      for (const sel of locationSelectors) {
        location = await this.page!.$eval(sel, (el) => el.textContent?.trim() ?? "").catch(() => "");
        if (location) break;
      }

      const description = await this.page!
        .$eval(
          ".jobs-description__content, .jobs-description-content__text, #job-details, .jobs-box__html-content",
          (el) => el.textContent?.trim() ?? ""
        )
        .catch(() => "");

      const easyApplyText = await this.page!
        .$eval(".jobs-apply-button--top-card .artdeco-button__text", (el) => el.textContent ?? "")
        .catch(() => "");
      const isEasyApply = easyApplyText.toLowerCase().includes("easy apply");

      const locLower = location.toLowerCase();
      const descLower = description.toLowerCase();
      const isRemote = locLower.includes("remote") || descLower.includes("fully remote");
      const isHybrid = locLower.includes("hybrid");

      if (!title || !company) {
        await Logger.warn("LINKEDIN", `Job ${jobId}: title="${title}" company="${company}" — skipping incomplete`);
        return null;
      }

      return {
        platform: "linkedin",
        platformJobId: jobId,
        url: `https://www.linkedin.com/jobs/view/${jobId}/`,
        easyApplyUrl: isEasyApply ? `https://www.linkedin.com/jobs/view/${jobId}/` : undefined,
        isEasyApply,
        companyName: company,
        jobTitle: title,
        location,
        isRemote,
        isHybrid,
        requiresSponsorship: false,
        description,
        requirements: [],
        responsibilities: [],
        niceToHave: [],
        benefits: [],
        scrapedAt: new Date(),
      };
    } catch (e) {
      await Logger.warn("LINKEDIN", `extractJobDetails(${jobId}) failed: ${e}`);
      return null;
    }
  }

  private async typeHumanLike(selectors: string[], text: string): Promise<boolean> {
    for (const selector of selectors) {
      try {
        const locator = this.page!.locator(selector).first();
        if ((await locator.count()) === 0) continue;
        await locator.click({ clickCount: 3 });
        await this.page!.keyboard.press("Backspace");
        for (const char of text) {
          await this.page!.keyboard.type(char, { delay: Math.floor(Math.random() * 90 + 45) });
        }
        return true;
      } catch { /* try next */ }
    }
    return false;
  }
}
