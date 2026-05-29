import { BaseScraper } from "./base-scraper";
import { ScrapedJob, ScraperOptions } from "@/types";
import { Logger } from "@/lib/logging/logger";
import { prisma } from "@/lib/db/prisma";

export class IndeedScraper extends BaseScraper {
  private maxJobs = 50;
  private collected = 0;
  private onJob?: (job: ScrapedJob) => Promise<void>;

  async scrapeJobs(
    keywords: string[],
    locations: string[],
    options?: ScraperOptions
  ): Promise<ScrapedJob[]> {
    this.maxJobs = options?.maxJobs ?? 50;
    this.onJob = options?.onJob;
    this.collected = 0;

    const allJobs: ScrapedJob[] = [];

    await Logger.info("INDEED", `Launching browser — target: ${this.maxJobs} jobs`);
    await this.init("indeed");

    try {
      outer: for (const keyword of keywords) {
        for (const location of locations) {
          if (this.collected >= this.maxJobs) break outer;

          await Logger.info("INDEED", `═══ Searching "${keyword}" in "${location}" (${this.collected}/${this.maxJobs} so far) ═══`);
          const jobs = await this.scrapeSearch(keyword, location);
          allJobs.push(...jobs);
          await this.delay(3000, 6000);
        }
      }
      await Logger.success("INDEED", `Session done — ${allJobs.length} jobs collected`);
    } finally {
      await this.cleanup();
    }

    return allJobs;
  }

  private async scrapeSearch(keyword: string, location: string): Promise<ScrapedJob[]> {
    const jobs: ScrapedJob[] = [];

    await Logger.info("INDEED", "Opening indeed.com ...");
    let onResultsPage = false;

    try {
      await this.page!.goto("https://www.indeed.com", { waitUntil: "domcontentloaded", timeout: 20000 });
      await this.delay(2000, 3000);

      if (await this.detectBotWall()) {
        const cleared = await this.waitForUserIntervention("INDEED");
        if (!cleared) return jobs;
      }

      await Logger.info("INDEED", `Typing keyword "${keyword}"...`);
      const kwTyped = await this.typeHumanLike(
        ["#text-input-what", 'input[name="q"]', 'input[aria-label*="job title"]'],
        keyword
      );

      if (kwTyped) {
        await this.delay(500, 900);
        await Logger.info("INDEED", `Typing location "${location}"...`);
        await this.typeHumanLike(
          ["#text-input-where", 'input[name="l"]', 'input[aria-label*="location"]'],
          location
        );
        await this.delay(600, 1000);
        await Logger.info("INDEED", "Pressing Enter to search...");
        await this.page!.keyboard.press("Enter");
        await this.page!.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
        await this.delay(2500, 4000);
        onResultsPage = true;
      }
    } catch (e) {
      await Logger.warn("INDEED", `Homepage navigation issue: ${e} — using direct URL`);
    }

    if (!onResultsPage) {
      const searchUrl = `https://www.indeed.com/jobs?q=${encodeURIComponent(keyword)}&l=${encodeURIComponent(location)}&sort=date`;
      await Logger.info("INDEED", `Direct URL: ${searchUrl}`);
      try {
        await this.page!.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
        await this.delay(2500, 4000);
      } catch {
        await Logger.error("INDEED", "Cannot reach Indeed search — skipping");
        return jobs;
      }
    }

    if (await this.detectBotWall() || await this.detectIndeedBlock()) {
      const cleared = await this.waitForUserIntervention("INDEED");
      if (!cleared) return jobs;
    }

    // Dismiss cookie/popup banners before collecting
    await this.dismissPopups();

    // Scroll to trigger lazy-loaded cards
    await this.scrollResultsPage();

    await Logger.info("INDEED", "Collecting job cards...");
    const jobCards = await this.collectJobCards();
    if (jobCards.length === 0) {
      await Logger.warn("INDEED", "No job cards found — taking debug screenshot");
      await this.debugScreenshot("indeed-no-cards");

      // Re-check for bot wall now that we've waited longer
      if (await this.detectBotWall() || await this.detectIndeedBlock()) {
        const cleared = await this.waitForUserIntervention("INDEED");
        if (cleared) {
          // User cleared the block — try again
          const retryCards = await this.collectJobCards();
          if (retryCards.length === 0) return jobs;
          jobCards.push(...retryCards);
        } else {
          return jobs;
        }
      } else {
        return jobs;
      }
    }
    await Logger.info("INDEED", `Found ${jobCards.length} job cards`);

    for (let i = 0; i < jobCards.length; i++) {
      if (this.collected >= this.maxJobs) {
        await Logger.info("INDEED", `Reached limit (${this.maxJobs}) — stopping`);
        break;
      }

      const { jobId, titleHint, companyHint, locationHint } = jobCards[i];

      const existing = await prisma.job.findFirst({
        where: { platform: "indeed", platformJobId: jobId },
        select: { jobTitle: true, companyName: true },
      });
      if (existing) {
        await Logger.info("INDEED", `[${i + 1}/${jobCards.length}] Already in DB: "${existing.jobTitle}" @ ${existing.companyName} — skipping`);
        continue;
      }

      await Logger.info("INDEED", `[${i + 1}/${jobCards.length}] Opening: ${titleHint} @ ${companyHint}`);

      const jobUrl = `https://www.indeed.com/viewjob?jk=${jobId}`;
      try {
        await this.page!.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
        await this.delay(1500, 2500);
      } catch {
        await Logger.warn("INDEED", `Could not open ${jobUrl} — skipping`);
        continue;
      }

      const job = await this.extractJobDetails(jobId, titleHint, companyHint, locationHint);
      if (job) {
        jobs.push(job);
        this.collected++;
        await Logger.success("INDEED", `[${this.collected}/${this.maxJobs}] Scraped: "${job.jobTitle}" @ ${job.companyName} [${job.location}] — desc: ${job.description.length} chars`);

        if (this.onJob) {
          try {
            await this.onJob(job);
          } catch (e) {
            await Logger.warn("INDEED", `onJob callback failed: ${e}`);
          }
        }
      }

      await this.page!.evaluate(() => window.scrollBy(0, Math.floor(Math.random() * 300 + 100)));
      await this.delay(800, 2000);

      if (i < jobCards.length - 1 && this.collected < this.maxJobs) {
        await this.page!.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
        await this.delay(1200, 2200);
      }
    }

    return jobs;
  }

  // Detect Indeed's specific block pages — they don't always trigger the generic bot wall.
  private async detectIndeedBlock(): Promise<boolean> {
    try {
      const url = this.page?.url() ?? "";
      if (url.includes("/blocked") || url.includes("hcaptcha") || url.includes("/_403")) return true;

      const bodyText = (await this.page!.evaluate(
        () => (document.body?.innerText ?? "").slice(0, 4000).toLowerCase()
      )) as string;

      return (
        bodyText.includes("additional verification") ||
        bodyText.includes("please prove") ||
        bodyText.includes("cloudflare") ||
        bodyText.includes("checking your browser") ||
        bodyText.includes("attention required") ||
        // Empty results page sometimes signals soft block
        (bodyText.includes("0 jobs") && bodyText.length < 500)
      );
    } catch {
      return false;
    }
  }

  // Dismiss cookie consent / popup overlays that block scraping
  private async dismissPopups(): Promise<void> {
    const dismissSelectors = [
      '#onetrust-accept-btn-handler',
      'button[id*="accept"]',
      'button[aria-label*="close"]',
      'button[aria-label*="Close"]',
      '.icl-CloseButton',
      '[data-testid="close-button"]',
      'button:has-text("Accept")',
      'button:has-text("Got it")',
      'button:has-text("Continue")',
    ];
    for (const sel of dismissSelectors) {
      try {
        const btn = await this.page!.$(sel);
        if (btn) {
          const visible = await btn.isVisible().catch(() => false);
          if (visible) {
            await btn.click({ timeout: 2000 }).catch(() => {});
            await this.delay(300, 600);
          }
        }
      } catch { /* ignore */ }
    }
  }

  private async scrollResultsPage(): Promise<void> {
    try {
      for (let i = 0; i < 3; i++) {
        await this.page!.evaluate(() => window.scrollBy(0, 1500));
        await this.delay(700, 1100);
      }
      await this.page!.evaluate(() => window.scrollTo(0, 0));
      await this.delay(300, 600);
    } catch { /* ignore */ }
  }

  private async debugScreenshot(label: string): Promise<void> {
    try {
      const { homedir } = await import("os");
      const { join } = await import("path");
      const { mkdirSync } = await import("fs");
      const dir = join(homedir(), ".job-agent-profiles", "debug");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${label}-${Date.now()}.png`);
      await this.page!.screenshot({ path, fullPage: false });
      await Logger.info("INDEED", `Debug screenshot saved: ${path}`);
    } catch { /* ignore */ }
  }

  private async collectJobCards(): Promise<Array<{ jobId: string; titleHint: string; companyHint: string; locationHint: string }>> {
    // Wait for ANY signal that results have loaded (new or old Indeed UI)
    const anyResultSelectors = [
      "[data-jk]",
      "div[data-testid='slider_item']",
      ".job_seen_beacon",
      ".resultContent",
      "#mosaic-jobResults",
      ".jobsearch-ResultsList",
    ];

    for (const sel of anyResultSelectors) {
      try {
        await this.page!.waitForSelector(sel, { timeout: 10000 });
        await Logger.info("INDEED", `Results signal found: ${sel}`);
        break;
      } catch { /* try next */ }
    }

    // Wait briefly for cards to fully render
    await this.delay(1500, 2500);

    // Collect via [data-jk] attribute — works for both old and new Indeed UI
    const results = await this.page!.evaluate(() => {
      const out: Array<{ jobId: string; titleHint: string; companyHint: string; locationHint: string }> = [];
      const seen = new Set<string>();

      // Strategy: find every element that has [data-jk], walk up to its card container
      const jkElements = document.querySelectorAll("[data-jk]");
      for (const link of Array.from(jkElements)) {
        const jobId = link.getAttribute("data-jk");
        if (!jobId || seen.has(jobId)) continue;
        seen.add(jobId);

        // Walk up to find the card container
        const card = link.closest(
          ".job_seen_beacon, .resultContent, div[data-testid='slider_item'], .tapItem, li, td"
        ) || (link.parentElement as HTMLElement | null) || link;

        const rawTitle =
          (link as HTMLElement).getAttribute("aria-label") ||
          card.querySelector("h2 a span[title]")?.getAttribute("title") ||
          card.querySelector("h2 a span")?.textContent?.trim() ||
          card.querySelector("h2")?.textContent?.trim() ||
          (link as HTMLElement).textContent?.trim() ||
          "";

        const title = rawTitle.replace(/^full details of\s+/i, "").trim();

        const company =
          card.querySelector('[data-testid="company-name"]')?.textContent?.trim() ||
          card.querySelector('[data-testid="inlineHeader-companyName"]')?.textContent?.trim() ||
          card.querySelector(".companyName")?.textContent?.trim() ||
          card.querySelector('a[data-testid="company-name"]')?.textContent?.trim() ||
          "";

        const location =
          card.querySelector('[data-testid="text-location"]')?.textContent?.trim() ||
          card.querySelector('[data-testid="job-location"]')?.textContent?.trim() ||
          card.querySelector(".companyLocation")?.textContent?.trim() ||
          "";

        if (title) {
          out.push({ jobId, titleHint: title, companyHint: company, locationHint: location });
        }
      }

      return out;
    });

    if (results.length > 0) {
      await Logger.info("INDEED", `Collected ${results.length} cards via [data-jk] walker`);
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
      await this.page!.waitForSelector("h1, #jobDescriptionText", { timeout: 8000 });

      // Expand description if there's a "show more" / "view full description" button
      await this.expandJobDescription();
      await this.delay(300, 600);

      const titleSelectors = [
        "h1[data-testid='jobsearch-JobInfoHeader-title']",
        "h1.jobsearch-JobInfoHeader-title",
        ".jobsearch-JobInfoHeader-title",
        "h1",
      ];
      let title = titleHint;
      for (const sel of titleSelectors) {
        const t = await this.page!.$eval(sel, (e) => e.textContent?.trim() ?? "").catch(() => "");
        if (t && t.length > 1) { title = t; break; }
      }

      const companySelectors = [
        "[data-testid='inlineHeader-companyName'] a",
        "[data-testid='inlineHeader-companyName']",
        "[data-company-name]",
        ".jobsearch-InlineCompanyRating-companyName",
        ".icl-u-lg-mr--sm",
      ];
      let company = companyHint;
      for (const sel of companySelectors) {
        const c = await this.page!.$eval(sel, (e) => e.textContent?.trim() ?? "").catch(() => "");
        if (c && c.length > 1) { company = c; break; }
      }

      const locationSelectors = [
        "[data-testid='job-location']",
        "[data-testid='inlineHeader-companyLocation']",
        ".companyLocation",
        ".icl-u-xs-mt--xs.icl-u-textColor--secondary",
      ];
      let location = locationHint;
      for (const sel of locationSelectors) {
        const l = await this.page!.$eval(sel, (e) => e.textContent?.trim() ?? "").catch(() => "");
        if (l && l.length > 1) { location = l; break; }
      }

      const description = await this.page!
        .$eval("#jobDescriptionText, .jobsearch-jobDescriptionText", (e) => (e as HTMLElement).innerText?.trim() ?? "")
        .catch(() => "");

      const salary = await this.page!
        .$eval("[data-testid='attribute_snippet_testid'], .salary-snippet, .jobMetaDataGroup span", (e) => e.textContent?.trim() ?? "")
        .catch(() => "");

      const locLower = (location + description).toLowerCase();
      const isRemote = locLower.includes("remote");
      const isHybrid = locLower.includes("hybrid");
      const salaryInfo = salary ? this.extractSalary(salary) : undefined;

      if (!title) {
        await Logger.warn("INDEED", `Job ${jobId}: no title found — skipping`);
        return null;
      }

      return {
        platform: "indeed",
        platformJobId: jobId,
        url: `https://www.indeed.com/viewjob?jk=${jobId}`,
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
