import { BaseScraper } from "./base-scraper";
import { ScrapedJob } from "@/types";
import { Logger } from "@/lib/logging/logger";

export class IndeedScraper extends BaseScraper {
  async scrapeJobs(
    keywords: string[],
    locations: string[],
    _options: Record<string, unknown> = {}
  ): Promise<ScrapedJob[]> {
    const jobs: ScrapedJob[] = [];

    try {
      await this.init();

      // Warm up — open Indeed homepage like a real user
      await Logger.info("INDEED", "Opening Indeed...");
      const ok = await this.safeNavigate("https://www.indeed.com", 30000);
      if (!ok) throw new Error("Could not load Indeed");

      await this.delay(2000, 4000);
      await this.humanScroll(1, 2);

      for (const keyword of keywords.slice(0, 3)) {
        for (const location of locations.slice(0, 2)) {
          if (jobs.length >= 60) break;
          const scraped = await this.scrapeKeyword(keyword, location);
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

  private async scrapeKeyword(keyword: string, location: string): Promise<ScrapedJob[]> {
    const jobs: ScrapedJob[] = [];

    try {
      await Logger.info("INDEED", `Searching: "${keyword}" in ${location}`);

      // Navigate to fresh search page
      await this.safeNavigate("https://www.indeed.com", 20000);
      await this.delay(1500, 3000);

      // Fill the "What" search box
      const whatInput = await this.page!.$('#text-input-what, input[name="q"], [aria-label*="job title" i]');
      if (!whatInput) {
        await Logger.warn("INDEED", "Could not find job search input");
        return jobs;
      }
      await whatInput.click({ clickCount: 3 });
      await this.delay(200, 400);
      await this.humanType(keyword);
      await this.delay(400, 800);

      // Fill the "Where" location box
      const whereInput = await this.page!.$('#text-input-where, input[name="l"], [aria-label*="location" i], [aria-label*="city" i]');
      if (whereInput) {
        await whereInput.click({ clickCount: 3 });
        await this.delay(200, 400);
        await this.humanType(location);
        await this.delay(400, 800);
      }

      // Click search button
      const searchBtn = await this.page!.$('button[type="submit"], .yosemite-search-button-container button, #jobsearch');
      if (searchBtn) {
        await searchBtn.click();
      } else {
        await this.page!.keyboard.press("Enter");
      }

      await this.delay(3000, 5000);

      // Check for CAPTCHA
      const captcha = await this.page!.$('iframe[title*="challenge"], [id*="captcha"], .g-recaptcha').catch(() => null);
      if (captcha) {
        await Logger.warn("INDEED", "CAPTCHA detected — skipping this search");
        return jobs;
      }

      // Scroll through results
      await this.humanScroll(2, 4);

      // Extract jobs from cards
      const cards = await this.page!.$$('[data-jk], .job_seen_beacon, .slider_item');

      await Logger.info("INDEED", `Found ${cards.length} job cards`);

      for (const card of cards.slice(0, 15)) {
        try {
          const jobKey = await card.getAttribute("data-jk").catch(() => null);

          const title = await card.$eval(
            'h2.jobTitle a span, h2.jobTitle span[id], .jobTitle span',
            (el) => el.textContent?.trim() || ""
          ).catch(() => "");

          const company = await card.$eval(
            '[data-testid="company-name"], .companyName, [class*="companyName"]',
            (el) => el.textContent?.trim() || ""
          ).catch(() => "");

          const location = await card.$eval(
            '[data-testid="text-location"], .companyLocation, [class*="companyLocation"]',
            (el) => el.textContent?.trim() || ""
          ).catch(() => "");

          const salary = await card.$eval(
            '[data-testid="attribute_snippet_testid"], .salary-snippet-container, [class*="salary"]',
            (el) => el.textContent?.trim() || ""
          ).catch(() => "");

          if (!title || !company) continue;

          const url = jobKey
            ? `https://www.indeed.com/viewjob?jk=${jobKey}`
            : this.page!.url();

          const salaryData = salary ? this.extractSalary(salary) : {};

          jobs.push({
            platform: "indeed",
            platformJobId: jobKey || undefined,
            url,
            applyUrl: url,
            isEasyApply: false,
            companyName: company,
            jobTitle: title,
            location: location || undefined,
            salary: salary || undefined,
            salaryMin: (salaryData as { min?: number }).min,
            salaryMax: (salaryData as { max?: number }).max,
            isRemote: location.toLowerCase().includes("remote"),
            isHybrid: location.toLowerCase().includes("hybrid"),
            requiresSponsorship: false,
            description: "",
            requirements: [],
            responsibilities: [],
            niceToHave: [],
            benefits: [],
            scrapedAt: new Date(),
          });

          await this.delay(300, 700);
        } catch {
          // skip bad card
        }
      }
    } catch (e) {
      await Logger.warn("INDEED", `Search failed for "${keyword}"`, { error: String(e) });
    }

    return jobs;
  }

  // Types text character by character with random delays
  private async humanType(text: string): Promise<void> {
    for (const char of text) {
      await this.page!.keyboard.type(char, { delay: 60 + Math.random() * 120 });
    }
  }

  private async humanScroll(minScrolls = 2, maxScrolls = 5): Promise<void> {
    const scrolls = Math.floor(Math.random() * (maxScrolls - minScrolls + 1)) + minScrolls;
    for (let i = 0; i < scrolls; i++) {
      const amount = 300 + Math.floor(Math.random() * 500);
      await this.page!.evaluate((y) => window.scrollBy(0, y), amount);
      await this.delay(600, 1500);
    }
    if (Math.random() > 0.6) {
      await this.page!.evaluate(() => window.scrollBy(0, -(100 + Math.random() * 200)));
      await this.delay(400, 900);
    }
  }
}
