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

    try {
      await this.init();

      if (this.cookie) {
        await this.context!.addCookies([
          {
            name: "li_at",
            value: this.cookie,
            domain: ".linkedin.com",
            path: "/",
          },
        ]);
      }

      for (const keyword of keywords.slice(0, 3)) {
        for (const location of locations.slice(0, 2)) {
          const scraped = await this.scrapeKeyword(keyword, location, options);
          jobs.push(...scraped);
          await this.delay(3000, 7000);
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
    const remote = options.remote ? "&f_WT=2" : "";
    const experienceFilters = options.experienceLevels
      ? `&f_E=${(options.experienceLevels as string[]).map(this.mapExperienceLevel).join("%2C")}`
      : "";

    const searchUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(keyword)}&location=${encodeURIComponent(location)}&sortBy=DD${remote}${experienceFilters}`;

    await Logger.info("LINKEDIN", `Scraping: ${keyword} in ${location}`);

    const ok = await this.safeNavigate(searchUrl);
    if (!ok) return jobs;

    await this.delay(2000, 4000);

    // Scroll to load more jobs
    for (let i = 0; i < 3; i++) {
      await this.page!.evaluate(() => window.scrollBy(0, 800));
      await this.delay(1000, 2000);
    }

    const jobCards = await this.page!.$$(".job-search-card, .jobs-search-results__list-item");

    for (const card of jobCards.slice(0, 20)) {
      try {
        const job = await this.extractJobFromCard(card);
        if (job) {
          // Navigate to job page for full details
          const fullJob = await this.getJobDetails(job);
          jobs.push(fullJob);
          await this.delay(1500, 3000);
        }
      } catch (e) {
        await Logger.warn("LINKEDIN", "Failed to extract job card", { error: String(e) });
      }
    }

    return jobs;
  }

  private async extractJobFromCard(
    card: Awaited<ReturnType<NonNullable<typeof this.page>["$$"]>>[0]
  ): Promise<Partial<ScrapedJob> | null> {
    try {
      const title = await card.$eval(
        ".job-card-list__title, .base-search-card__title",
        (el) => el.textContent?.trim() || ""
      ).catch(() => "");

      const company = await card.$eval(
        ".job-card-container__primary-description, .base-search-card__subtitle",
        (el) => el.textContent?.trim() || ""
      ).catch(() => "");

      const location = await card.$eval(
        ".job-card-container__metadata-item, .job-search-card__location",
        (el) => el.textContent?.trim() || ""
      ).catch(() => "");

      const link = await card.$eval(
        "a.job-card-list__title, a.base-card__full-link",
        (el) => (el as HTMLAnchorElement).href
      ).catch(() => "");

      if (!title || !company || !link) return null;

      return {
        jobTitle: title,
        companyName: company,
        location,
        url: link,
        platform: "linkedin",
      };
    } catch {
      return null;
    }
  }

  private async getJobDetails(partial: Partial<ScrapedJob>): Promise<ScrapedJob> {
    const job: ScrapedJob = {
      platform: "linkedin",
      url: partial.url || "",
      companyName: partial.companyName || "",
      jobTitle: partial.jobTitle || "",
      location: partial.location,
      isEasyApply: false,
      isRemote: false,
      isHybrid: false,
      requiresSponsorship: false,
      description: "",
      requirements: [],
      responsibilities: [],
      niceToHave: [],
      benefits: [],
      scrapedAt: new Date(),
    };

    try {
      await this.safeNavigate(partial.url || "");
      await this.delay(2000, 3000);

      const platformJobId = partial.url?.match(/\/jobs\/view\/(\d+)/)?.[1];
      if (platformJobId) job.platformJobId = platformJobId;

      // Check for Easy Apply
      const easyApplyBtn = await this.page!.$(".jobs-apply-button--top-card .artdeco-button--primary");
      if (easyApplyBtn) {
        const btnText = await easyApplyBtn.textContent();
        job.isEasyApply = btnText?.includes("Easy Apply") || false;
        job.easyApplyUrl = job.isEasyApply ? partial.url : undefined;
      }

      // Check for external apply
      const applyBtn = await this.page!.$(".jobs-apply-button a");
      if (applyBtn) {
        job.applyUrl = await applyBtn.getAttribute("href") || partial.url;
      } else {
        job.applyUrl = partial.url;
      }

      // Get full description
      job.description = await this.page!.$eval(
        ".jobs-description-content__text, .job-description",
        (el) => el.textContent?.trim() || ""
      ).catch(() => "");

      // Get salary
      const salaryEl = await this.page!.$(".compensation__salary, .salary-main-rail__formatted-salary");
      if (salaryEl) {
        const salaryText = await salaryEl.textContent() || "";
        const salaryData = this.extractSalary(salaryText);
        job.salary = salaryText.trim();
        job.salaryMin = salaryData.min;
        job.salaryMax = salaryData.max;
      }

      // Check remote/hybrid
      const workType = await this.page!.$eval(
        ".jobs-unified-top-card__workplace-type, .ui-label",
        (el) => el.textContent?.trim() || ""
      ).catch(() => "");

      job.isRemote = workType.toLowerCase().includes("remote");
      job.isHybrid = workType.toLowerCase().includes("hybrid");

      // Extract job type
      job.jobType = await this.page!.$eval(
        ".jobs-unified-top-card__job-insight",
        (el) => el.textContent?.trim() || ""
      ).catch(() => undefined);

      if (job.description) {
        const desc = job.description.toLowerCase();
        job.requiresSponsorship = !desc.includes("no sponsorship") &&
          (desc.includes("h1b") || desc.includes("visa sponsorship"));
      }
    } catch (e) {
      await Logger.warn("LINKEDIN", `Failed to get job details for ${partial.url}`, { error: String(e) });
    }

    return job;
  }

  private mapExperienceLevel(level: string): string {
    const map: Record<string, string> = {
      internship: "1",
      entry: "2",
      associate: "3",
      mid: "4",
      senior: "5",
      director: "6",
      executive: "7",
    };
    return map[level.toLowerCase()] || "2";
  }
}
