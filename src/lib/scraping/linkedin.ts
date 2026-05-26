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

    await Logger.info("LINKEDIN", "Launching browser with persistent profile...");
    await this.init("linkedin");

    try {
      for (const keyword of keywords.slice(0, 3)) {
        for (const location of locations.slice(0, 2)) {
          await Logger.info("LINKEDIN", `=== Searching: "${keyword}" in "${location}" ===`);
          const jobs = await this.scrapeSearch(keyword, location);
          allJobs.push(...jobs);
          await this.delay(3000, 6000);
        }
      }
      await Logger.success("LINKEDIN", `Session done — ${allJobs.length} new jobs collected`);
    } finally {
      await this.cleanup();
    }

    return allJobs;
  }

  private async scrapeSearch(keyword: string, location: string): Promise<ScrapedJob[]> {
    const jobs: ScrapedJob[] = [];

    // Step 1: Open LinkedIn jobs homepage first (user sees the page)
    await Logger.info("LINKEDIN", "Opening linkedin.com/jobs ...");
    let onResultsPage = false;

    try {
      await this.page!.goto("https://www.linkedin.com/jobs/", {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });
      await this.delay(2000, 3000);

      // Dismiss sign-in modal if present
      await this.dismissModal();

      // Check for bot wall
      if (await this.detectBotWall()) {
        const cleared = await this.waitForUserIntervention("LINKEDIN");
        if (!cleared) return jobs;
      }

      // Try to type in the search bar (shows human-like behavior)
      await Logger.info("LINKEDIN", `Typing keyword "${keyword}" in search bar...`);
      const kwTyped = await this.typeHumanLike(
        [
          'input[id="job-search-bar-keywords"]',
          'input[placeholder*="Search jobs"]',
          'input[aria-label*="Search by title"]',
          'input[class*="keywords"]',
          ".jobs-search-box__text-input",
        ],
        keyword
      );

      if (kwTyped) {
        await this.delay(500, 900);
        await Logger.info("LINKEDIN", `Typing location "${location}"...`);
        await this.typeHumanLike(
          [
            'input[id="job-search-bar-location"]',
            'input[placeholder*="City, state"]',
            'input[aria-label*="City"]',
            'input[class*="location"]',
          ],
          location
        );
        await this.delay(600, 1000);
        await Logger.info("LINKEDIN", "Pressing Enter to search...");
        await this.page!.keyboard.press("Enter");
        await this.page!.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
        await this.delay(2500, 4000);
        onResultsPage = true;
      }
    } catch (e) {
      await Logger.warn("LINKEDIN", `Homepage navigation issue: ${e} — using direct search URL`);
    }

    // Fallback: navigate directly to search URL (works without login)
    if (!onResultsPage) {
      const searchUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(keyword)}&location=${encodeURIComponent(location)}&sortBy=DD&f_TPR=r604800`;
      await Logger.info("LINKEDIN", `Navigating to search URL directly: ${searchUrl}`);
      try {
        await this.page!.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
        await this.delay(2500, 4000);
      } catch {
        await Logger.error("LINKEDIN", "Cannot reach LinkedIn search — skipping");
        return jobs;
      }
    }

    // Check bot wall after landing on results
    if (await this.detectBotWall()) {
      const cleared = await this.waitForUserIntervention("LINKEDIN");
      if (!cleared) return jobs;
    }

    await Logger.info("LINKEDIN", "Results page loaded — collecting job cards...");
    const jobIds = await this.collectJobIds();
    if (jobIds.length === 0) {
      await Logger.warn("LINKEDIN", "No job cards found on results page");
      return jobs;
    }
    await Logger.info("LINKEDIN", `Found ${jobIds.length} job cards`);

    // Process each job
    for (let i = 0; i < jobIds.length; i++) {
      const { jobId, titleHint, companyHint, locationHint } = jobIds[i];

      // Deduplication check
      const existing = await prisma.job.findFirst({
        where: { platform: "linkedin", platformJobId: jobId },
        select: { jobTitle: true, companyName: true },
      });
      if (existing) {
        await Logger.info("LINKEDIN", `[${i + 1}/${jobIds.length}] Already in DB: "${existing.jobTitle}" @ ${existing.companyName} — skipping`);
        continue;
      }

      await Logger.info("LINKEDIN", `[${i + 1}/${jobIds.length}] Opening job ${jobId} (${titleHint} @ ${companyHint})...`);

      // Navigate directly to the job's detail page (avoids sign-in modal on click)
      const jobUrl = `https://www.linkedin.com/jobs/view/${jobId}/`;
      try {
        await this.page!.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
        await this.delay(1500, 2500);
      } catch {
        await Logger.warn("LINKEDIN", `Could not open ${jobUrl} — skipping`);
        continue;
      }

      const job = await this.extractJobDetails(jobId, titleHint, companyHint, locationHint);
      if (job) {
        await Logger.success("LINKEDIN", `Scraped: "${job.jobTitle}" @ ${job.companyName} [${job.location}]`);
        jobs.push(job);
      }

      // Random scroll to look human
      await this.page!.evaluate(() => window.scrollBy(0, Math.floor(Math.random() * 300 + 100)));
      await this.delay(800, 2000);

      // Go back to results for next job
      if (i < jobIds.length - 1) {
        await this.page!.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
        await this.delay(1200, 2200);
      }
    }

    return jobs;
  }

  private async collectJobIds(): Promise<Array<{ jobId: string; titleHint: string; companyHint: string; locationHint: string }>> {
    const results: Array<{ jobId: string; titleHint: string; companyHint: string; locationHint: string }> = [];

    // Wait for cards to load — try both public and authenticated selectors
    const cardSelectors = [
      ".base-card[data-entity-urn]",
      ".base-card",
      "[data-entity-urn*='jobPosting']",
      "li[data-occludable-job-id]",
      ".jobs-search-results__list-item",
    ];

    let cards: import("playwright").ElementHandle<SVGElement | HTMLElement>[] = [];
    for (const sel of cardSelectors) {
      try {
        await this.page!.waitForSelector(sel, { timeout: 6000 });
        cards = await this.page!.$$(sel);
        if (cards.length > 0) {
          await Logger.info("LINKEDIN", `Using card selector: ${sel} (${cards.length} found)`);
          break;
        }
      } catch { /* try next */ }
    }

    for (const card of cards) {
      try {
        const data = await card.evaluate((el) => {
          // Public page: job ID from data-entity-urn="urn:li:jobPosting:1234567"
          const urn = el.getAttribute("data-entity-urn") || "";
          const urnId = urn.match(/(\d+)$/)?.[1] ?? null;

          // Authenticated page: job ID from data-occludable-job-id
          const authId = el.getAttribute("data-occludable-job-id") ?? null;

          // Also try link href
          const link = el.querySelector('a[href*="/jobs/view/"]');
          const linkId = link?.getAttribute("href")?.match(/\/jobs\/view\/(\d+)/)?.[1] ?? null;

          const jobId = urnId || authId || linkId;
          if (!jobId) return null;

          const title =
            el.querySelector(".base-search-card__title")?.textContent?.trim() ||
            el.querySelector(".job-search-card__title")?.textContent?.trim() ||
            el.querySelector("h3")?.textContent?.trim() ||
            "";

          const company =
            el.querySelector(".base-search-card__subtitle a")?.textContent?.trim() ||
            el.querySelector(".base-search-card__subtitle")?.textContent?.trim() ||
            el.querySelector("h4")?.textContent?.trim() ||
            "";

          const location =
            el.querySelector(".job-search-card__location")?.textContent?.trim() ||
            el.querySelector(".base-search-card__metadata")?.textContent?.trim() ||
            "";

          return { jobId, titleHint: title, companyHint: company, locationHint: location };
        });

        if (data?.jobId) results.push(data);
      } catch { /* skip bad cards */ }
    }

    return results;
  }

  private async extractJobDetails(
    jobId: string,
    titleHint: string,
    companyHint: string,
    locationHint: string
  ): Promise<ScrapedJob | null> {
    try {
      // Wait for title to appear
      await this.page!.waitForSelector("h1, .top-card-layout__title, .topcard__title", { timeout: 8000 });

      const titleSelectors = [
        ".top-card-layout__title",
        ".topcard__title",
        "h1.t-24",
        "h1",
      ];
      let title = titleHint;
      for (const sel of titleSelectors) {
        const t = await this.page!.$eval(sel, (e) => e.textContent?.trim() ?? "").catch(() => "");
        if (t && t.length > 1) { title = t; break; }
      }

      const companySelectors = [
        ".topcard__org-name-link",
        ".top-card-layout__card .topcard__flavor--black-link",
        '[data-tracking-control-name="public_jobs_topcard-org-name"]',
        ".top-card-layout__second-subline a",
      ];
      let company = companyHint;
      for (const sel of companySelectors) {
        const c = await this.page!.$eval(sel, (e) => e.textContent?.trim() ?? "").catch(() => "");
        if (c && c.length > 1) { company = c; break; }
      }

      const locationSelectors = [
        ".top-card-layout__bullet",
        ".topcard__flavor--bullet",
        ".job-details-jobs-unified-top-card__bullet",
      ];
      let location = locationHint;
      for (const sel of locationSelectors) {
        const l = await this.page!.$eval(sel, (e) => e.textContent?.trim() ?? "").catch(() => "");
        if (l && l.length > 1) { location = l; break; }
      }

      const description = await this.page!
        .$eval(
          ".description__text, .show-more-less-html__markup, .decorated-job-posting__details",
          (e) => e.textContent?.trim() ?? ""
        )
        .catch(() => "");

      const salary = await this.page!
        .$eval(".salary.compensation__salary, .salary-main-rail__compensation", (e) => e.textContent?.trim() ?? "")
        .catch(() => "");

      const locLower = (location + description).toLowerCase();
      const isRemote = locLower.includes("remote");
      const isHybrid = locLower.includes("hybrid");
      const salaryInfo = salary ? this.extractSalary(salary) : undefined;

      if (!title) {
        await Logger.warn("LINKEDIN", `Job ${jobId}: no title found — skipping`);
        return null;
      }

      return {
        platform: "linkedin",
        platformJobId: jobId,
        url: `https://www.linkedin.com/jobs/view/${jobId}/`,
        isEasyApply: false,
        companyName: company || "Unknown",
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
      await Logger.warn("LINKEDIN", `extractJobDetails(${jobId}) failed: ${e}`);
      return null;
    }
  }

  private async dismissModal(): Promise<void> {
    const dismissSelectors = [
      'button[aria-label="Dismiss"]',
      'button[data-tracking-control-name="public_jobs_contextual-sign-in-modal_modal_dismiss"]',
      ".modal__dismiss",
      'button.contextual-sign-in-modal__modal-dismiss-icon',
    ];
    for (const sel of dismissSelectors) {
      try {
        const btn = await this.page!.$(sel);
        if (btn) {
          await btn.click();
          await this.delay(500, 800);
          break;
        }
      } catch { /* ignore */ }
    }
    // Also try pressing Escape
    await this.page!.keyboard.press("Escape").catch(() => {});
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
