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

    await Logger.info("INDEED", "Launching browser with persistent profile...");
    await this.init("indeed");

    try {
      for (const keyword of keywords.slice(0, 3)) {
        for (const location of locations.slice(0, 2)) {
          await Logger.info("INDEED", `=== Searching: "${keyword}" in "${location}" ===`);
          const jobs = await this.scrapeSearch(keyword, location);
          allJobs.push(...jobs);
          await this.delay(3000, 6000);
        }
      }
      await Logger.success("INDEED", `Session done — ${allJobs.length} new jobs collected`);
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

      // Type keyword in search bar
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
      await Logger.warn("INDEED", `Homepage navigation issue: ${e} — using direct search URL`);
    }

    if (!onResultsPage) {
      const searchUrl = `https://www.indeed.com/jobs?q=${encodeURIComponent(keyword)}&l=${encodeURIComponent(location)}&sort=date`;
      await Logger.info("INDEED", `Navigating to search URL directly...`);
      try {
        await this.page!.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
        await this.delay(2500, 4000);
      } catch {
        await Logger.error("INDEED", "Cannot reach Indeed search — skipping");
        return jobs;
      }
    }

    if (await this.detectBotWall()) {
      const cleared = await this.waitForUserIntervention("INDEED");
      if (!cleared) return jobs;
    }

    // Collect job IDs from results page
    await Logger.info("INDEED", "Collecting job cards...");
    const jobCards = await this.collectJobCards();
    if (jobCards.length === 0) {
      await Logger.warn("INDEED", "No job cards found on results page");
      return jobs;
    }
    await Logger.info("INDEED", `Found ${jobCards.length} job cards`);

    for (let i = 0; i < jobCards.length; i++) {
      const { jobId, titleHint, companyHint, locationHint } = jobCards[i];

      // Deduplication
      const existing = await prisma.job.findFirst({
        where: { platform: "indeed", platformJobId: jobId },
        select: { jobTitle: true, companyName: true },
      });
      if (existing) {
        await Logger.info("INDEED", `[${i + 1}/${jobCards.length}] Already in DB: "${existing.jobTitle}" @ ${existing.companyName} — skipping`);
        continue;
      }

      await Logger.info("INDEED", `[${i + 1}/${jobCards.length}] Opening job ${jobId} (${titleHint} @ ${companyHint})...`);

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
        await Logger.success("INDEED", `Scraped: "${job.jobTitle}" @ ${job.companyName} [${job.location}]`);
        jobs.push(job);
      }

      await this.page!.evaluate(() => window.scrollBy(0, Math.floor(Math.random() * 300 + 100)));
      await this.delay(800, 2000);

      // Go back to results for next job
      if (i < jobCards.length - 1) {
        await this.page!.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
        await this.delay(1200, 2200);
      }
    }

    return jobs;
  }

  private async collectJobCards(): Promise<Array<{ jobId: string; titleHint: string; companyHint: string; locationHint: string }>> {
    const results: Array<{ jobId: string; titleHint: string; companyHint: string; locationHint: string }> = [];

    const cardSelectors = [".job_seen_beacon", ".resultContent", ".tapItem"];
    let cards: import("playwright").ElementHandle<SVGElement | HTMLElement>[] = [];
    for (const sel of cardSelectors) {
      try {
        await this.page!.waitForSelector(sel, { timeout: 8000 });
        cards = await this.page!.$$(sel);
        if (cards.length > 0) {
          await Logger.info("INDEED", `Using card selector: ${sel} (${cards.length} found)`);
          break;
        }
      } catch { /* try next */ }
    }

    for (const card of cards) {
      try {
        const data = await card.evaluate((el) => {
          // Job ID from the link's data-jk attribute
          const link = el.querySelector("h2 a[data-jk], a[data-jk]") as HTMLAnchorElement | null;
          const jobId = link?.getAttribute("data-jk") ?? null;
          if (!jobId) return null;

          const rawTitle =
            el.querySelector("h2 a span[title]")?.getAttribute("title") ||
            el.querySelector("h2 a span")?.textContent?.trim() ||
            link?.getAttribute("aria-label") ||
            el.querySelector("h2")?.textContent?.trim() ||
            "";
          // Strip "full details of " aria-label prefix
          const title = rawTitle.replace(/^full details of\s+/i, "").trim();

          const company =
            el.querySelector('[data-testid="company-name"]')?.textContent?.trim() ||
            el.querySelector(".companyName")?.textContent?.trim() ||
            "";

          const location =
            el.querySelector('[data-testid="text-location"]')?.textContent?.trim() ||
            el.querySelector(".companyLocation")?.textContent?.trim() ||
            "";

          return { jobId, titleHint: title, companyHint: company, locationHint: location };
        });

        if (data?.jobId) results.push(data);
      } catch { /* skip bad card */ }
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
        .$eval("#jobDescriptionText, .jobsearch-jobDescriptionText", (e) => e.textContent?.trim() ?? "")
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
