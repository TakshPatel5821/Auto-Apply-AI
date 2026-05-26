import type { ElementHandle } from "playwright";
import { BaseScraper } from "./base-scraper";
import { ScrapedJob } from "@/types";
import { Logger } from "@/lib/logging/logger";
import { prisma } from "@/lib/db/prisma";

export class IndeedScraper extends BaseScraper {
  async scrapeJobs(
    keywords: string[],
    locations: string[],
    _options?: Record<string, unknown>
  ): Promise<ScrapedJob[]> {
    const allJobs: ScrapedJob[] = [];

    await Logger.info("INDEED", "Launching Edge with persistent profile...");
    await this.init("indeed");

    try {
      const kwList = keywords.slice(0, 3);
      const locList = locations.slice(0, 2);

      for (const keyword of kwList) {
        for (const location of locList) {
          await Logger.info("INDEED", `=== Search: "${keyword}" | "${location}" ===`);
          const jobs = await this.scrapeSearch(keyword, location);
          allJobs.push(...jobs);
          if (kwList.indexOf(keyword) < kwList.length - 1 || locList.indexOf(location) < locList.length - 1) {
            await this.delay(5000, 9000);
          }
        }
      }

      await Logger.success("INDEED", `Session complete — ${allJobs.length} new jobs collected`);
    } finally {
      await this.cleanup();
    }

    return allJobs;
  }

  private async scrapeSearch(keyword: string, location: string): Promise<ScrapedJob[]> {
    const jobs: ScrapedJob[] = [];

    await Logger.info("INDEED", "Opening indeed.com ...");
    const ok = await this.safeNavigate("https://www.indeed.com", 30000);
    if (!ok) {
      await Logger.error("INDEED", "Failed to open Indeed homepage");
      return jobs;
    }
    await this.delay(2000, 3500);

    // Detect bot wall / CAPTCHA
    if (await this.detectBotWall()) {
      const cleared = await this.waitForUserIntervention("INDEED");
      if (!cleared) return jobs;
    }

    // Type keyword
    await Logger.info("INDEED", `Typing keyword "${keyword}"...`);
    const kwTyped = await this.typeHumanLike(
      [
        "#text-input-what",
        'input[name="q"]',
        'input[aria-label*="job title"]',
        'input[placeholder*="Job title"]',
      ],
      keyword
    );
    if (!kwTyped) {
      await Logger.error("INDEED", "Could not find keyword input on Indeed");
      return jobs;
    }
    await this.delay(600, 1200);

    // Type location
    await Logger.info("INDEED", `Typing location "${location}"...`);
    await this.typeHumanLike(
      [
        "#text-input-where",
        'input[name="l"]',
        'input[aria-label*="location"]',
        'input[placeholder*="City, state"]',
      ],
      location
    );
    await this.delay(700, 1300);

    // Search
    await Logger.info("INDEED", "Pressing Enter to search...");
    await this.page!.keyboard.press("Enter");
    await this.page!.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    await this.delay(3000, 5000);

    // Re-check for bot wall after search
    if (await this.detectBotWall()) {
      const cleared = await this.waitForUserIntervention("INDEED");
      if (!cleared) return jobs;
    }

    await Logger.info("INDEED", "Results loaded — scanning job cards...");
    const found = await this.processJobCards();
    jobs.push(...found);

    return jobs;
  }

  private async processJobCards(): Promise<ScrapedJob[]> {
    const jobs: ScrapedJob[] = [];

    const cardSelectors = [
      "div[data-jk]",
      ".job_seen_beacon",
      ".resultContent",
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
      await Logger.warn("INDEED", "No job cards found — Indeed may have blocked the scraper");
      return jobs;
    }

    await Logger.info("INDEED", `Found ${cards.length} job cards [${usedSelector}]`);
    const resultsUrl = this.page!.url();

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];

      const jobId: string | null = await card
        .evaluate((el) => {
          const id = el.getAttribute("data-jk");
          if (id) return id;
          const link = el.querySelector("a[data-jk]");
          return link?.getAttribute("data-jk") ?? null;
        })
        .catch(() => null);

      if (!jobId) {
        await Logger.warn("INDEED", `Card ${i + 1}: no job ID — skipping`);
        continue;
      }

      // Deduplication check
      const existing = await prisma.job.findFirst({
        where: { platform: "indeed", platformJobId: jobId },
        select: { jobTitle: true, companyName: true },
      });
      if (existing) {
        await Logger.info("INDEED", `[${i + 1}/${cards.length}] Already scraped: "${existing.jobTitle}" @ ${existing.companyName} — skipping`);
        continue;
      }

      // Click the card
      await Logger.info("INDEED", `[${i + 1}/${cards.length}] Clicking card (ID: ${jobId})...`);
      try {
        await card.scrollIntoViewIfNeeded();
        await this.delay(400, 900);
        const titleLink = await card.$("h2 a, a[data-jk]");
        if (titleLink) {
          await titleLink.click();
        } else {
          await card.click();
        }
        await this.delay(2000, 3500);
      } catch (e) {
        await Logger.warn("INDEED", `Click failed for card ${i + 1}: ${e}`);
        continue;
      }

      // Check if navigated to a new full page
      const currentUrl = this.page!.url();
      const openedNewPage = currentUrl !== resultsUrl && currentUrl.includes("indeed.com");

      const job = await this.extractJobDetails(jobId);
      if (job) {
        await Logger.success("INDEED", `Scraped: "${job.jobTitle}" @ ${job.companyName} [${job.location}]`);
        jobs.push(job);
      }

      // Go back to results if navigated away
      if (openedNewPage && (currentUrl.includes("/viewjob") || currentUrl.includes("/pagead"))) {
        await Logger.info("INDEED", "Navigating back to results...");
        await this.page!.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
        await this.delay(1500, 2500);
        const refreshed = await this.page!.$$(usedSelector).catch(() => []);
        if (refreshed.length > 0) cards = refreshed;
      }

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
        "h1, #jobDescriptionText, .jobsearch-ViewJobLayout",
        { timeout: 8000 }
      );

      const titleSelectors = [
        "h1.jobsearch-JobInfoHeader-title",
        "h1[data-testid='jobsearch-JobInfoHeader-title']",
        ".jobsearch-JobInfoHeader-title",
        ".jcs-JobTitle",
        "h1",
      ];
      let title = "";
      for (const sel of titleSelectors) {
        title = await this.page!.$eval(sel, (el) => el.textContent?.trim() ?? "").catch(() => "");
        if (title) break;
      }

      const companySelectors = [
        "[data-testid='inlineHeader-companyName'] a",
        "[data-testid='inlineHeader-companyName']",
        "[data-company-name]",
        ".jobsearch-InlineCompanyRating-companyName a",
        ".icl-u-lg-mr--sm",
      ];
      let company = "";
      for (const sel of companySelectors) {
        company = await this.page!.$eval(sel, (el) => el.textContent?.trim() ?? "").catch(() => "");
        if (company) break;
      }

      const locationSelectors = [
        "[data-testid='job-location']",
        "[data-testid='inlineHeader-companyLocation']",
        ".companyLocation",
      ];
      let location = "";
      for (const sel of locationSelectors) {
        location = await this.page!.$eval(sel, (el) => el.textContent?.trim() ?? "").catch(() => "");
        if (location) break;
      }

      const description = await this.page!
        .$eval("#jobDescriptionText, .jobsearch-jobDescriptionText", (el) => el.textContent?.trim() ?? "")
        .catch(() => "");

      const salary = await this.page!
        .$eval("[data-testid='attribute_snippet_testid'], .salary-snippet", (el) => el.textContent?.trim() ?? "")
        .catch(() => "");

      const locLower = location.toLowerCase();
      const descLower = description.toLowerCase();
      const isRemote = locLower.includes("remote") || descLower.includes("fully remote");
      const isHybrid = locLower.includes("hybrid");
      const salaryInfo = salary ? this.extractSalary(salary) : undefined;

      if (!title || !company) {
        await Logger.warn("INDEED", `Job ${jobId}: incomplete title/company — skipping`);
        return null;
      }

      return {
        platform: "indeed",
        platformJobId: jobId,
        url: `https://www.indeed.com/viewjob?jk=${jobId}`,
        isEasyApply: false,
        companyName: company,
        jobTitle: title,
        location,
        salary: salaryInfo?.raw,
        salaryMin: salaryInfo?.min,
        salaryMax: salaryInfo?.max,
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
      await Logger.warn("INDEED", `extractJobDetails(${jobId}) failed: ${e}`);
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
