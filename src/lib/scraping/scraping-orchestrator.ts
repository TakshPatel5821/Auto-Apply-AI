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
      take: 150,
    });

    if (unanalyzedJobs.length === 0) {
      await Logger.info("ANALYZER", "No new jobs to analyze");
      return;
    }
    await Logger.info("ANALYZER", `Analyzing ${unanalyzedJobs.length} jobs`);

    const { fastFilter } = await import("@/lib/matching/fast-filter");
    const { claudeBatchMatchJobs } = await import("@/lib/ai/claude");
    const { generateEmbedding, cosineSimilarity } = await import("@/lib/ai/ollama");
    const resumeData = resume.parsedData as Record<string, unknown>;
    const candidateSkills = resume.skills || [];
    const candidateTech = resume.technologies || [];
    const searchKeywords = (process.env.JOB_SEARCH_KEYWORDS || "Software Engineer")
      .split(",").map((k) => k.trim());

    // Step 1: Fast keyword filter (instant, no AI)
    const toSemanticScore: typeof unanalyzedJobs = [];

    for (const job of unanalyzedJobs) {
      const filter = fastFilter(job.jobTitle, job.description, candidateSkills, candidateTech, searchKeywords);
      if (filter.skip) {
        await prisma.job.update({
          where: { id: job.id },
          data: {
            matchScore: 10, atsScore: 1, confidenceLevel: 0.9,
            requiredSkills: [], missingSkills: filter.missingKeywords,
            matchingSkills: filter.matchedKeywords, matchReason: filter.reason,
            status: "ANALYZED",
          },
        });
      } else {
        toSemanticScore.push(job);
      }
    }
    await Logger.info("ANALYZER", `Fast-filter: ${unanalyzedJobs.length - toSemanticScore.length} skipped, ${toSemanticScore.length} proceeding`);

    if (toSemanticScore.length === 0) return;

    // Step 2: Semantic scoring with nomic-embed-text (fast, no tokens needed)
    const resumeText = [
      (resumeData.summary as string) || "",
      candidateSkills.slice(0, 20).join(" "),
      candidateTech.slice(0, 20).join(" "),
      ((resumeData.experience as Array<{ title: string; bullets: string[] }>) || [])
        .slice(0, 2).map((e) => `${e.title} ${e.bullets?.slice(0, 3).join(" ")}`).join(" "),
    ].join(" ").trim();

    const semanticScores = new Map<string, number>();

    if (resumeText.length > 50) {
      await Logger.info("ANALYZER", "Computing semantic similarity scores...");
      try {
        const resumeEmbedding = await generateEmbedding(resumeText);
        let semanticSkipped = 0;

        for (const job of toSemanticScore) {
          try {
            const jobText = `${job.jobTitle} ${job.companyName} ${job.description}`.slice(0, 4000);
            const jobEmbedding = await generateEmbedding(jobText);
            const sim = cosineSimilarity(resumeEmbedding, jobEmbedding);
            semanticScores.set(job.id, sim);

            // Hard skip: semantically unrelated (sim < 0.3 = basically unrelated)
            if (sim < 0.3) {
              semanticSkipped++;
              await prisma.job.update({
                where: { id: job.id },
                data: {
                  matchScore: 9, atsScore: 2, confidenceLevel: 0.85,
                  matchReason: `Low semantic similarity (${(sim * 100).toFixed(0)}%)`,
                  status: "ANALYZED",
                },
              });
            }
          } catch {
            // Embedding failed for this job — still send to AI
            semanticScores.set(job.id, 0.5);
          }
        }
        await Logger.info("ANALYZER", `Semantic filter: ${semanticSkipped} more skipped`);
      } catch (e) {
        await Logger.warn("ANALYZER", `Semantic scoring unavailable: ${e} — falling back to AI scoring only`);
      }
    }

    // Step 3: AI batch scoring — only jobs that passed semantic filter
    const toAiScore = toSemanticScore.filter(
      (j) => !["ANALYZED"].includes(j.status) && (semanticScores.get(j.id) ?? 0.5) >= 0.3
    );

    // Sort by semantic similarity descending (best candidates first)
    toAiScore.sort((a, b) => (semanticScores.get(b.id) ?? 0.5) - (semanticScores.get(a.id) ?? 0.5));

    await Logger.info("ANALYZER", `Sending ${toAiScore.length} jobs to AI for detailed scoring`);

    const BATCH = 5;
    for (let i = 0; i < toAiScore.length; i += BATCH) {
      const batch = toAiScore.slice(i, i + BATCH);
      await Logger.info("ANALYZER", `AI batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(toAiScore.length / BATCH)} (${batch.length} jobs)...`);

      try {
        const result = await claudeBatchMatchJobs(
          batch.map((j) => ({ id: j.id, title: j.jobTitle, company: j.companyName, description: j.description })),
          resumeData
        );

        for (const scored of result.results || []) {
          const semSim = semanticScores.get(scored.id) ?? 0.5;
          // Blend AI score with semantic score for confidence
          const confidence = Math.min(0.95, 0.6 + semSim * 0.35);
          await prisma.job.update({
            where: { id: scored.id },
            data: {
              matchScore: scored.matchScore,
              atsScore: scored.atsScore,
              confidenceLevel: confidence,
              requiredSkills: [],
              missingSkills: scored.missingSkills || [],
              matchingSkills: scored.matchingSkills || [],
              matchReason: scored.matchReason,
              status: "ANALYZED",
            },
          });
          await Logger.info("ANALYZER", `  ${scored.matchScore}/10 — ${scored.matchReason?.slice(0, 80)}`);
        }
      } catch (e) {
        for (const job of batch) {
          await prisma.job.update({
            where: { id: job.id },
            data: { matchScore: 5, atsScore: 5, status: "ANALYZED", matchReason: "AI scoring failed — manual review needed" },
          });
        }
        await Logger.warn("ANALYZER", `Batch ${i / BATCH + 1} AI scoring failed: ${e}`);
      }
    }

    const analyzed = await prisma.job.count({ where: { status: "ANALYZED" } });
    const good = await prisma.job.count({ where: { status: "ANALYZED", matchScore: { lte: 4 } } });
    await Logger.success("ANALYZER", `Analysis complete — ${good} strong matches found out of ${analyzed} total analyzed`);
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
