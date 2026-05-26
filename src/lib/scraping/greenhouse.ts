import axios from "axios";
import * as cheerio from "cheerio";
import { ScrapedJob } from "@/types";
import { Logger } from "@/lib/logging/logger";

export class GreenhouseScraper {
  async scrapeJobs(
    companies: string[],
    keywords: string[]
  ): Promise<ScrapedJob[]> {
    const jobs: ScrapedJob[] = [];

    for (const company of companies) {
      try {
        const scraped = await this.scrapeCompany(company, keywords);
        jobs.push(...scraped);
        await new Promise((r) => setTimeout(r, 2000));
      } catch (e) {
        await Logger.warn("GREENHOUSE", `Failed to scrape ${company}`, { error: String(e) });
      }
    }

    return jobs;
  }

  private async scrapeCompany(
    company: string,
    keywords: string[]
  ): Promise<ScrapedJob[]> {
    const jobs: ScrapedJob[] = [];
    const url = `https://boards.greenhouse.io/${company.toLowerCase().replace(/\s+/g, "")}`;

    const response = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; JobAgent/1.0)" },
      timeout: 15000,
    });

    const $ = cheerio.load(response.data);

    $(".opening").each((_, el) => {
      const titleEl = $(el).find("a");
      const title = titleEl.text().trim();
      const href = titleEl.attr("href");
      const department = $(el).closest(".department").find("h3").text().trim();
      const location = $(el).find(".location").text().trim();

      if (!title || !href) return;

      const keywordMatch = keywords.some(
        (kw) =>
          title.toLowerCase().includes(kw.toLowerCase()) ||
          department.toLowerCase().includes(kw.toLowerCase())
      );

      if (!keywordMatch && keywords.length > 0) return;

      const fullUrl = href.startsWith("http") ? href : `https://boards.greenhouse.io${href}`;

      jobs.push({
        platform: "greenhouse",
        platformJobId: href.split("/").pop(),
        url: fullUrl,
        applyUrl: fullUrl,
        isEasyApply: false,
        companyName: company,
        jobTitle: title,
        location,
        isRemote: location.toLowerCase().includes("remote"),
        isHybrid: location.toLowerCase().includes("hybrid"),
        requiresSponsorship: false,
        description: `${department} - ${title}`,
        requirements: [],
        responsibilities: [],
        niceToHave: [],
        benefits: [],
        scrapedAt: new Date(),
      });
    });

    return jobs;
  }
}
