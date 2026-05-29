import { BaseScraper } from "./base-scraper";
import { ScrapedJob, ScraperOptions } from "@/types";
import { Logger } from "@/lib/logging/logger";
import { prisma } from "@/lib/db/prisma";

export class LinkedInScraper extends BaseScraper {
  private maxJobs = 50;
  private collected = 0;
  private onJob?: (job: ScrapedJob) => Promise<void>;
  private consecutiveFailures = 0;

  async scrapeJobs(
    keywords: string[],
    locations: string[],
    options?: ScraperOptions
  ): Promise<ScrapedJob[]> {
    this.maxJobs = options?.maxJobs ?? 50;
    this.onJob = options?.onJob;
    this.collected = 0;
    this.consecutiveFailures = 0;

    const allJobs: ScrapedJob[] = [];

    await Logger.info("LINKEDIN", `Launching browser — target: ${this.maxJobs} jobs`);
    await this.init("linkedin");

    try {
      outer: for (const keyword of keywords) {
        for (const location of locations) {
          if (this.collected >= this.maxJobs) break outer;

          await Logger.info("LINKEDIN", `═══ Searching "${keyword}" in "${location}" (${this.collected}/${this.maxJobs} so far) ═══`);
          const jobs = await this.scrapeSearch(keyword, location);
          allJobs.push(...jobs);
          await this.delay(3000, 6000);
        }
      }
      await Logger.success("LINKEDIN", `Session done — ${allJobs.length} jobs collected`);
    } finally {
      await this.cleanup();
    }

    return allJobs;
  }

  private async scrapeSearch(keyword: string, location: string): Promise<ScrapedJob[]> {
    const jobs: ScrapedJob[] = [];

    await Logger.info("LINKEDIN", "Opening linkedin.com/jobs ...");
    let onResultsPage = false;

    try {
      await this.page!.goto("https://www.linkedin.com/jobs/", {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });
      await this.delay(2000, 3000);
      await this.dismissModal();

      if (await this.detectBotWall()) {
        const cleared = await this.waitForUserIntervention("LINKEDIN");
        if (!cleared) return jobs;
      }

      await Logger.info("LINKEDIN", `Typing keyword "${keyword}" in search bar...`);
      const kwTyped = await this.typeHumanLike(
        [
          'input[id="job-search-bar-keywords"]',
          'input[placeholder*="Search jobs"]',
          'input[aria-label*="Search by title"]',
          '.jobs-search-box__text-input',
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
          ],
          location
        );
        await this.delay(600, 1000);
        await Logger.info("LINKEDIN", "Pressing Enter to search...");
        await this.page!.keyboard.press("Enter");
        await this.page!.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
        await this.delay(3000, 5000);
        onResultsPage = true;
      }
    } catch (e) {
      await Logger.warn("LINKEDIN", `Homepage navigation issue: ${e} — using direct URL`);
    }

    if (!onResultsPage) {
      const searchUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(keyword)}&location=${encodeURIComponent(location)}&sortBy=DD&f_TPR=r604800`;
      await Logger.info("LINKEDIN", `Direct URL: ${searchUrl}`);
      try {
        await this.page!.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
        await this.delay(3500, 5000);
      } catch {
        await Logger.error("LINKEDIN", "Cannot reach LinkedIn search — skipping");
        return jobs;
      }
    }

    if (await this.detectBotWall()) {
      const cleared = await this.waitForUserIntervention("LINKEDIN");
      if (!cleared) return jobs;
    }

    // Detect which layout we're seeing
    const isAuthLayout = await this.detectAuthLayout();
    await Logger.info("LINKEDIN", `Layout: ${isAuthLayout ? "AUTHENTICATED" : "PUBLIC (guest)"}`);

    // Scroll to load lazy cards
    await this.scrollToLoadMore(isAuthLayout);

    await Logger.info("LINKEDIN", "Collecting job cards...");
    const jobIds = await this.collectJobIds(isAuthLayout);
    if (jobIds.length === 0) {
      await Logger.warn("LINKEDIN", "No job cards found on results page");
      return jobs;
    }
    await Logger.info("LINKEDIN", `Found ${jobIds.length} job cards on this page`);

    // For authenticated layout, click cards in sidebar instead of navigating to URL.
    // This avoids rate limiting because LinkedIn loads details via internal XHR.
    if (isAuthLayout) {
      return this.processCardsInSidebar(jobIds, jobs);
    }

    return this.processCardsByUrl(jobIds, jobs);
  }

  // ─── Sidebar click flow (authenticated) ────────────────────────────────────

  private async processCardsInSidebar(
    jobIds: Array<{ jobId: string; titleHint: string; companyHint: string; locationHint: string }>,
    jobs: ScrapedJob[]
  ): Promise<ScrapedJob[]> {
    for (let i = 0; i < jobIds.length; i++) {
      if (this.collected >= this.maxJobs) {
        await Logger.info("LINKEDIN", `Reached limit (${this.maxJobs}) — stopping`);
        break;
      }
      if (this.consecutiveFailures >= 4) {
        await Logger.warn("LINKEDIN", "4 consecutive failures — likely rate-limited. Pausing for user intervention.");
        const cleared = await this.waitForUserIntervention("LINKEDIN");
        if (!cleared) break;
        this.consecutiveFailures = 0;
      }

      const { jobId, titleHint, companyHint, locationHint } = jobIds[i];

      const existing = await prisma.job.findFirst({
        where: { platform: "linkedin", platformJobId: jobId },
        select: { jobTitle: true, companyName: true },
      });
      if (existing) {
        await Logger.info("LINKEDIN", `[${i + 1}/${jobIds.length}] Already in DB: "${existing.jobTitle}" @ ${existing.companyName} — skipping`);
        continue;
      }

      await Logger.info("LINKEDIN", `[${i + 1}/${jobIds.length}] Clicking card: ${titleHint || "(no hint)"} @ ${companyHint || "(no hint)"}`);

      // Click the card in the sidebar
      const cardSelector = `li[data-occludable-job-id="${jobId}"]`;
      const clicked = await this.clickSidebarCard(cardSelector);

      if (!clicked) {
        await Logger.warn("LINKEDIN", `Could not click card for ${jobId} — skipping`);
        this.consecutiveFailures++;
        continue;
      }

      // Wait for detail panel to load
      await this.delay(2000, 3500);
      await this.waitForDetailPanel();

      const job = await this.extractJobDetailsFromPanel(jobId, titleHint, companyHint, locationHint);
      if (job) {
        jobs.push(job);
        this.collected++;
        this.consecutiveFailures = 0;
        await Logger.success(
          "LINKEDIN",
          `[${this.collected}/${this.maxJobs}] Scraped: "${job.jobTitle}" @ ${job.companyName} [${job.location}] — desc: ${job.description.length} chars${job.isEasyApply ? " | EASY APPLY" : ""}`
        );

        if (this.onJob) {
          try {
            await this.onJob(job);
          } catch (e) {
            await Logger.warn("LINKEDIN", `onJob callback failed: ${e}`);
          }
        }
      } else {
        this.consecutiveFailures++;
      }

      // Throttle between cards
      await this.delay(2500, 5000);
    }

    return jobs;
  }

  private async clickSidebarCard(cardSelector: string): Promise<boolean> {
    try {
      const card = await this.page!.$(cardSelector);
      if (!card) return false;

      // Scroll the card into view in the sidebar
      await card.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      await this.delay(300, 600);

      // Click the card itself or the link inside it
      const link = await card.$('a[href*="/jobs/view/"], .job-card-container__link, .job-card-list__title-link');
      if (link) {
        await link.click({ timeout: 5000 });
      } else {
        await card.click({ timeout: 5000 });
      }
      return true;
    } catch {
      return false;
    }
  }

  private async waitForDetailPanel(): Promise<void> {
    const panelSelectors = [
      ".jobs-details__main-content",
      ".jobs-search__job-details",
      ".job-details-jobs-unified-top-card__job-title",
      ".jobs-unified-top-card__job-title",
      ".jobs-details",
    ];

    for (const sel of panelSelectors) {
      try {
        await this.page!.waitForSelector(sel, { timeout: 8000 });
        return;
      } catch { /* try next */ }
    }
  }

  // ─── URL navigation flow (public) ──────────────────────────────────────────

  private async processCardsByUrl(
    jobIds: Array<{ jobId: string; titleHint: string; companyHint: string; locationHint: string }>,
    jobs: ScrapedJob[]
  ): Promise<ScrapedJob[]> {
    for (let i = 0; i < jobIds.length; i++) {
      if (this.collected >= this.maxJobs) break;

      const { jobId, titleHint, companyHint, locationHint } = jobIds[i];

      const existing = await prisma.job.findFirst({
        where: { platform: "linkedin", platformJobId: jobId },
        select: { jobTitle: true, companyName: true },
      });
      if (existing) {
        await Logger.info("LINKEDIN", `[${i + 1}/${jobIds.length}] Already in DB — skipping`);
        continue;
      }

      await Logger.info("LINKEDIN", `[${i + 1}/${jobIds.length}] Opening: ${titleHint || "(no hint)"} @ ${companyHint || "(no hint)"}`);

      const jobUrl = `https://www.linkedin.com/jobs/view/${jobId}/`;
      try {
        await this.page!.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
        await this.delay(2500, 4000);
      } catch {
        await Logger.warn("LINKEDIN", `Could not open ${jobUrl} — skipping`);
        continue;
      }

      const job = await this.extractJobDetailsFromPanel(jobId, titleHint, companyHint, locationHint);
      if (job) {
        jobs.push(job);
        this.collected++;
        await Logger.success("LINKEDIN", `[${this.collected}/${this.maxJobs}] Scraped: "${job.jobTitle}" @ ${job.companyName}`);

        if (this.onJob) {
          try { await this.onJob(job); } catch (e) {
            await Logger.warn("LINKEDIN", `onJob callback failed: ${e}`);
          }
        }
      }

      await this.delay(2000, 4000);
    }

    return jobs;
  }

  // ─── Layout detection ───────────────────────────────────────────────────────

  private async detectAuthLayout(): Promise<boolean> {
    try {
      return await this.page!.evaluate(() => {
        return (
          document.querySelector("li[data-occludable-job-id]") !== null ||
          document.querySelector(".scaffold-layout__list") !== null ||
          document.querySelector(".jobs-search-results-list") !== null
        );
      });
    } catch {
      return false;
    }
  }

  // ─── Scrolling to load more cards ──────────────────────────────────────────

  private async scrollToLoadMore(isAuth: boolean): Promise<void> {
    try {
      const targetSelectors = isAuth
        ? [
            ".scaffold-layout__list",
            ".jobs-search-results-list",
            ".jobs-search-results__list",
          ]
        : [".jobs-search__results-list"];

      for (let i = 0; i < 5; i++) {
        await this.page!.evaluate((sels) => {
          for (const sel of sels) {
            const el = document.querySelector(sel);
            if (el) el.scrollBy(0, 2000);
          }
          window.scrollBy(0, 1000);
        }, targetSelectors);
        await this.delay(900, 1400);
      }
    } catch { /* ignore */ }
  }

  // ─── Card collection (both layouts) ────────────────────────────────────────

  private async collectJobIds(
    isAuth: boolean
  ): Promise<Array<{ jobId: string; titleHint: string; companyHint: string; locationHint: string }>> {
    const cardSelectors = isAuth
      ? ["li[data-occludable-job-id]", ".scaffold-layout__list-item", ".jobs-search-results__list-item"]
      : [".base-card[data-entity-urn]", ".base-card", "[data-entity-urn*='jobPosting']"];

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

    const results: Array<{ jobId: string; titleHint: string; companyHint: string; locationHint: string }> = [];

    for (const card of cards) {
      try {
        const data = await card.evaluate((el) => {
          // Job ID — try multiple sources
          const urn = el.getAttribute("data-entity-urn") || "";
          const urnId = urn.match(/(\d+)$/)?.[1] ?? null;
          const authId = el.getAttribute("data-occludable-job-id") ?? null;
          const link = el.querySelector('a[href*="/jobs/view/"]');
          const linkId = link?.getAttribute("href")?.match(/\/jobs\/view\/(\d+)/)?.[1] ?? null;
          const jobId = urnId || authId || linkId;
          if (!jobId) return null;

          // Title — try ALL selectors (auth + public)
          const title =
            el.querySelector(".job-card-list__title")?.textContent?.trim() ||
            el.querySelector(".artdeco-entity-lockup__title")?.textContent?.trim() ||
            el.querySelector(".job-card-container__link strong")?.textContent?.trim() ||
            el.querySelector(".job-card-list__title-link")?.textContent?.trim() ||
            el.querySelector(".job-card-container__link")?.textContent?.trim() ||
            el.querySelector("a[aria-label]")?.getAttribute("aria-label")?.trim() ||
            el.querySelector(".base-search-card__title")?.textContent?.trim() ||
            el.querySelector(".job-search-card__title")?.textContent?.trim() ||
            el.querySelector("h3")?.textContent?.trim() ||
            "";

          // Company
          const company =
            el.querySelector(".artdeco-entity-lockup__subtitle")?.textContent?.trim() ||
            el.querySelector(".job-card-container__company-name")?.textContent?.trim() ||
            el.querySelector(".job-card-container__primary-description")?.textContent?.trim() ||
            el.querySelector(".base-search-card__subtitle a")?.textContent?.trim() ||
            el.querySelector(".base-search-card__subtitle")?.textContent?.trim() ||
            el.querySelector("h4")?.textContent?.trim() ||
            "";

          // Location
          const location =
            el.querySelector(".artdeco-entity-lockup__caption")?.textContent?.trim() ||
            el.querySelector(".job-card-container__metadata-item")?.textContent?.trim() ||
            el.querySelector(".job-card-container__metadata")?.textContent?.trim() ||
            el.querySelector(".job-search-card__location")?.textContent?.trim() ||
            el.querySelector(".base-search-card__metadata")?.textContent?.trim() ||
            "";

          return {
            jobId,
            titleHint: title.replace(/\s+/g, " ").trim(),
            companyHint: company.replace(/\s+/g, " ").trim(),
            locationHint: location.replace(/\s+/g, " ").trim(),
          };
        });

        if (data?.jobId) results.push(data);
      } catch { /* skip bad cards */ }
    }

    return results;
  }

  // ─── Detail extraction — supports both layouts and panel view ──────────────

  private async extractJobDetailsFromPanel(
    jobId: string,
    titleHint: string,
    companyHint: string,
    locationHint: string
  ): Promise<ScrapedJob | null> {
    try {
      // Wait for ANY title-like element with a generous timeout
      const titleSelectors = [
        ".job-details-jobs-unified-top-card__job-title",
        ".jobs-unified-top-card__job-title",
        ".top-card-layout__title",
        ".topcard__title",
        "h1.t-24",
        "h1",
      ];

      // Race-wait for any title selector to appear
      const found = await Promise.race(
        titleSelectors.map((sel) =>
          this.page!.waitForSelector(sel, { timeout: 12000 }).then(() => sel).catch(() => null)
        )
      );

      if (!found) {
        const url = this.page!.url();
        const pageTitle = await this.page!.title().catch(() => "");
        await Logger.warn("LINKEDIN", `Job ${jobId}: no title element on page (url=${url.slice(0, 80)}, pageTitle=${pageTitle.slice(0, 40)})`);
        return null;
      }

      // Expand the description if there's a "Show more" button
      await this.expandJobDescription();
      await this.delay(400, 800);

      // Extract title
      let title = titleHint;
      for (const sel of titleSelectors) {
        const t = await this.page!.$eval(sel, (e) => e.textContent?.trim() ?? "").catch(() => "");
        if (t && t.length > 1) { title = t; break; }
      }

      // Company
      const companySelectors = [
        ".job-details-jobs-unified-top-card__company-name a",
        ".job-details-jobs-unified-top-card__company-name",
        ".jobs-unified-top-card__company-name a",
        ".jobs-unified-top-card__company-name",
        ".topcard__org-name-link",
        ".top-card-layout__second-subline a",
        ".jobs-details-top-card__company-url",
      ];
      let company = companyHint;
      for (const sel of companySelectors) {
        const c = await this.page!.$eval(sel, (e) => e.textContent?.trim() ?? "").catch(() => "");
        if (c && c.length > 1) { company = c; break; }
      }

      // Location
      const locationSelectors = [
        ".job-details-jobs-unified-top-card__tertiary-description-container span:first-child",
        ".job-details-jobs-unified-top-card__primary-description-container span:first-child",
        ".jobs-unified-top-card__bullet",
        ".top-card-layout__bullet",
        ".topcard__flavor--bullet",
        ".jobs-details-top-card__job-info",
      ];
      let location = locationHint;
      for (const sel of locationSelectors) {
        const l = await this.page!.$eval(sel, (e) => e.textContent?.trim() ?? "").catch(() => "");
        if (l && l.length > 1) { location = l; break; }
      }

      // Description — auth + public selectors
      const descSelectors = [
        ".jobs-description__container .jobs-box__html-content",
        ".jobs-description-content__text",
        ".jobs-description__content",
        ".jobs-box__html-content",
        ".show-more-less-html__markup",
        ".description__text .show-more-less-html__markup",
        ".description__text",
        ".decorated-job-posting__details",
      ];
      let description = "";
      for (const sel of descSelectors) {
        const d = await this.page!.$eval(sel, (e) => (e as HTMLElement).innerText?.trim() ?? "").catch(() => "");
        if (d && d.length > description.length) description = d;
      }

      const salary = await this.page!
        .$eval(
          ".salary.compensation__salary, .salary-main-rail__compensation, .jobs-details__salary-main-rail-card",
          (e) => e.textContent?.trim() ?? ""
        )
        .catch(() => "");

      const locLower = (location + description).toLowerCase();
      const isRemote = locLower.includes("remote");
      const isHybrid = locLower.includes("hybrid");
      const salaryInfo = salary ? this.extractSalary(salary) : undefined;

      // Easy Apply detection — only true if button explicitly says "Easy Apply"
      const isEasyApply = await this.page!.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, a')) as HTMLElement[];
        return btns.some((b) => {
          const text = ((b.innerText || "") + " " + (b.getAttribute("aria-label") || "")).toLowerCase();
          return text.includes("easy apply") && !(b as HTMLButtonElement).disabled;
        });
      }).catch(() => false);

      if (!title) {
        await Logger.warn("LINKEDIN", `Job ${jobId}: title selector matched but text was empty`);
        return null;
      }

      return {
        platform: "linkedin",
        platformJobId: jobId,
        url: `https://www.linkedin.com/jobs/view/${jobId}/`,
        isEasyApply,
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
