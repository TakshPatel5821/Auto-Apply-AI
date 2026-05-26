import { prisma } from "@/lib/db/prisma";
import { LinkedInScraper } from "./linkedin";
import { IndeedScraper } from "./indeed";
import { GreenhouseScraper } from "./greenhouse";
import { CustomScraper } from "./custom-scraper";
import { claudeAnalyzeJob } from "@/lib/ai/claude";
import { Logger } from "@/lib/logging/logger";
import { ScrapedJob, SearchConfig, CustomSite } from "@/types";

export class ScrapingOrchestrator {
  private isRunning = false;

  async startScraping(config: SearchConfig): Promise<void> {
    if (this.isRunning) {
      await Logger.warn("SCRAPER", "Already running");
      return;
    }

    this.isRunning = true;
    await Logger.info("SCRAPER", "Starting job scraping session", { config });

    const session = await prisma.scrapingSession.create({
      data: {
        platform: config.platforms.join(","),
        searchQuery: config.keywords.join(", "),
      },
    });

    try {
      const allJobs: ScrapedJob[] = [];

      if (config.platforms.includes("linkedin")) {
        await Logger.info("SCRAPER", "Scraping LinkedIn...");
        const scraper = new LinkedInScraper();
        const jobs = await scraper.scrapeJobs(config.keywords, config.locations, {
          remote: config.remote,
          experienceLevels: config.experienceLevels,
        });
        allJobs.push(...jobs);
        await Logger.success("SCRAPER", `LinkedIn: found ${jobs.length} jobs`);
      }

      if (config.platforms.includes("indeed")) {
        await Logger.info("SCRAPER", "Scraping Indeed...");
        const scraper = new IndeedScraper();
        const jobs = await scraper.scrapeJobs(config.keywords, config.locations, {
          remote: config.remote,
        });
        allJobs.push(...jobs);
        await Logger.success("SCRAPER", `Indeed: found ${jobs.length} jobs`);
      }

      // Custom sites
      const settings = await prisma.userSettings.findUnique({ where: { userId: "local" } });
      const customSites = ((settings?.customSites as unknown as CustomSite[]) || []).filter((s) => s.enabled);
      for (const site of customSites) {
        await Logger.info("SCRAPER", `Scraping custom site: ${site.name}...`);
        const scraper = new CustomScraper();
        const jobs = await scraper.scrapeJobs(site);
        allJobs.push(...jobs);
        await Logger.success("SCRAPER", `${site.name}: found ${jobs.length} jobs`);
      }

      const saved = await this.saveJobs(allJobs);

      await prisma.scrapingSession.update({
        where: { id: session.id },
        data: {
          status: "completed",
          jobsFound: allJobs.length,
          jobsNew: saved.newCount,
          jobsDuplicate: saved.duplicateCount,
          completedAt: new Date(),
        },
      });

      await Logger.success("SCRAPER", `Session complete: ${saved.newCount} new jobs`, {
        total: allJobs.length,
        new: saved.newCount,
        duplicate: saved.duplicateCount,
      });
    } catch (e) {
      await prisma.scrapingSession.update({
        where: { id: session.id },
        data: { status: "failed", error: String(e), completedAt: new Date() },
      });
      await Logger.error("SCRAPER", "Scraping session failed", { error: String(e) });
    } finally {
      this.isRunning = false;
    }
  }

  private async saveJobs(
    jobs: ScrapedJob[]
  ): Promise<{ newCount: number; duplicateCount: number }> {
    let newCount = 0;
    let duplicateCount = 0;

    for (const job of jobs) {
      try {
        const exists = job.platformJobId
          ? await prisma.job.findUnique({
              where: {
                platform_platformJobId: {
                  platform: job.platform,
                  platformJobId: job.platformJobId,
                },
              },
            })
          : await prisma.job.findFirst({
              where: { url: job.url },
            });

        if (exists) {
          duplicateCount++;
          continue;
        }

        const isBlacklisted = this.isCompanyBlacklisted(job.companyName);
        const isSpam = this.isSpamJob(job);

        await prisma.job.create({
          data: {
            platform: job.platform,
            platformJobId: job.platformJobId || null,
            url: job.url,
            applyUrl: job.applyUrl || null,
            easyApplyUrl: job.easyApplyUrl || null,
            isEasyApply: job.isEasyApply,
            companyName: job.companyName,
            jobTitle: job.jobTitle,
            location: job.location || null,
            salary: job.salary || null,
            salaryMin: job.salaryMin || null,
            salaryMax: job.salaryMax || null,
            jobType: job.jobType || null,
            isRemote: job.isRemote,
            isHybrid: job.isHybrid,
            requiresSponsorship: job.requiresSponsorship,
            experienceLevel: job.experienceLevel || null,
            description: job.description || "",
            requirements: job.requirements || [],
            responsibilities: job.responsibilities || [],
            niceToHave: job.niceToHave || [],
            benefits: job.benefits || [],
            isBlacklisted,
            isSpam,
            status: "FOUND",
          },
        });

        newCount++;
      } catch (e) {
        await Logger.warn("SCRAPER", `Failed to save job: ${job.jobTitle}`, {
          error: String(e),
        });
      }
    }

    return { newCount, duplicateCount };
  }

  async analyzeAndScoreJobs(resumeId: string): Promise<void> {
    const resume = await prisma.resume.findUnique({ where: { id: resumeId } });
    if (!resume) throw new Error("Resume not found");

    const unanalyzedJobs = await prisma.job.findMany({
      where: { status: "FOUND", isBlacklisted: false, isSpam: false, isDuplicate: false },
      take: 100,
    });

    if (unanalyzedJobs.length === 0) return;
    await Logger.info("ANALYZER", `Analyzing ${unanalyzedJobs.length} jobs (batch mode)`);

    const { fastFilter } = await import("@/lib/matching/fast-filter");
    const { claudeBatchMatchJobs } = await import("@/lib/ai/claude");
    const resumeData = resume.parsedData as Record<string, unknown>;
    const candidateSkills = resume.skills || [];
    const candidateTech = resume.technologies || [];
    const searchKeywords = (process.env.JOB_SEARCH_KEYWORDS || "Software Engineer")
      .split(",").map((k) => k.trim());

    // Step 1: instant pre-filter (no AI)
    const toAiScore: typeof unanalyzedJobs = [];

    for (const job of unanalyzedJobs) {
      const filter = fastFilter(job.jobTitle, job.description, candidateSkills, candidateTech, searchKeywords);

      if (filter.skip) {
        await prisma.job.update({
          where: { id: job.id },
          data: {
            matchScore: 10,
            atsScore: 1,
            confidenceLevel: 0.9,
            requiredSkills: [],
            missingSkills: filter.missingKeywords,
            matchingSkills: filter.matchedKeywords,
            matchReason: filter.reason,
            status: "ANALYZED",
          },
        });
      } else {
        toAiScore.push(job);
      }
    }

    await Logger.info("ANALYZER", `Pre-filter: ${unanalyzedJobs.length - toAiScore.length} skipped, ${toAiScore.length} going to AI`);

    // Step 2: batch AI scoring (5 jobs per call)
    const BATCH = 5;
    for (let i = 0; i < toAiScore.length; i += BATCH) {
      const batch = toAiScore.slice(i, i + BATCH);

      try {
        const result = await claudeBatchMatchJobs(
          batch.map((j) => ({ id: j.id, title: j.jobTitle, company: j.companyName, description: j.description })),
          resumeData
        );

        for (const scored of result.results || []) {
          await prisma.job.update({
            where: { id: scored.id },
            data: {
              matchScore: scored.matchScore,
              atsScore: scored.atsScore,
              confidenceLevel: 0.75,
              requiredSkills: [],
              missingSkills: scored.missingSkills || [],
              matchingSkills: scored.matchingSkills || [],
              matchReason: scored.matchReason,
              status: "ANALYZED",
            },
          });
          await Logger.info("ANALYZER", `Scored: ${scored.matchReason} → ${scored.matchScore}/10`);
        }
      } catch (e) {
        // Fallback: mark batch as analyzed with neutral score
        for (const job of batch) {
          await prisma.job.update({
            where: { id: job.id },
            data: { matchScore: 5, atsScore: 5, status: "ANALYZED", matchReason: "Scoring failed, manual review needed" },
          });
        }
        await Logger.warn("ANALYZER", `Batch ${i / BATCH + 1} failed: ${e}`);
      }
    }
  }

  private isCompanyBlacklisted(company: string): boolean {
    const blacklist = (process.env.BLACKLIST_COMPANIES || "")
      .split(",")
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean);
    return blacklist.some((b) => company.toLowerCase().includes(b));
  }

  private isSpamJob(job: ScrapedJob): boolean {
    const spamKeywords = [
      "work from home",
      "make money",
      "no experience needed",
      "unlimited earning",
      "pyramid",
      "mlm",
    ];
    const text = `${job.jobTitle} ${job.description}`.toLowerCase();
    return spamKeywords.some((kw) => text.includes(kw));
  }
}

export const scrapingOrchestrator = new ScrapingOrchestrator();
