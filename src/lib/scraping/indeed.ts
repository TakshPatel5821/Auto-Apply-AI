import { BaseScraper } from "./base-scraper";
import { ScrapedJob } from "@/types";
import { Logger } from "@/lib/logging/logger";

export class IndeedScraper extends BaseScraper {
  async scrapeJobs(
    keywords: string[],
    locations: string[],
    options: Record<string, unknown> = {}
  ): Promise<ScrapedJob[]> {
    const jobs: ScrapedJob[] = [];

    try {
      await this.init();

      for (const keyword of keywords.slice(0, 3)) {
        for (const location of locations.slice(0, 2)) {
          const scraped = await this.scrapeKeyword(keyword, location, options);
          jobs.push(...scraped);
          await this.delay(4000, 8000);
        }
      }
    } catch (e) {
      await Logger.error("INDEED", "Scraping failed", { error: String(e) });
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
    const remote = options.remote ? "&remotejob=032b3046-06a3-4876-8dfd-474eb5e7ed11" : "";
    const searchUrl = `https://www.indeed.com/jobs?q=${encodeURIComponent(keyword)}&l=${encodeURIComponent(location)}&sort=date${remote}`;

    await Logger.info("INDEED", `Scraping: ${keyword} in ${location}`);

    const ok = await this.safeNavigate(searchUrl);
    if (!ok) return jobs;

    await this.delay(3000, 5000);

    const jobCards = await this.page!.$$('[data-jk], .job_seen_beacon, .resultContent');

    for (const card of jobCards.slice(0, 15)) {
      try {
        const job = await this.extractJobData(card);
        if (job) jobs.push(job);
        await this.delay(1000, 2000);
      } catch (e) {
        await Logger.warn("INDEED", "Failed to extract job", { error: String(e) });
      }
    }

    return jobs;
  }

  private async extractJobData(
    card: Awaited<ReturnType<NonNullable<typeof this.page>["$$"]>>[0]
  ): Promise<ScrapedJob | null> {
    try {
      const title = await card.$eval(
        ".jobTitle span, h2.jobTitle a span",
        (el) => el.textContent?.trim() || ""
      ).catch(() => "");

      const company = await card.$eval(
        "[data-testid='company-name'], .companyName",
        (el) => el.textContent?.trim() || ""
      ).catch(() => "");

      const location = await card.$eval(
        "[data-testid='text-location'], .companyLocation",
        (el) => el.textContent?.trim() || ""
      ).catch(() => "");

      const salary = await card.$eval(
        "[data-testid='attribute_snippet_testid'], .salary-snippet",
        (el) => el.textContent?.trim() || ""
      ).catch(() => "");

      const jobKey = await card.getAttribute("data-jk").catch(() => null);
      const url = jobKey
        ? `https://www.indeed.com/viewjob?jk=${jobKey}`
        : "";

      if (!title || !company) return null;

      const salaryData = salary ? this.extractSalary(salary) : {};

      const fullDescription = await this.getJobDescription(url);

      return {
        platform: "indeed",
        platformJobId: jobKey || undefined,
        url,
        applyUrl: url,
        isEasyApply: false,
        companyName: company,
        jobTitle: title,
        location,
        salary: salary || undefined,
        salaryMin: (salaryData as { min?: number }).min,
        salaryMax: (salaryData as { max?: number }).max,
        isRemote: location.toLowerCase().includes("remote"),
        isHybrid: location.toLowerCase().includes("hybrid"),
        requiresSponsorship: false,
        description: fullDescription,
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

  private async getJobDescription(url: string): Promise<string> {
    if (!url) return "";
    try {
      await this.safeNavigate(url);
      await this.delay(2000, 3000);
      return await this.page!.$eval(
        "#jobDescriptionText, .jobsearch-jobDescriptionText",
        (el) => el.textContent?.trim() || ""
      ).catch(() => "");
    } catch {
      return "";
    }
  }
}
