import { writeFileSync } from "fs";
import { join } from "path";
import { prisma } from "@/lib/db/prisma";
import { LinkedInScraper } from "./linkedin";
import { IndeedScraper } from "./indeed";
import { CustomScraper } from "./custom-scraper";
import { searchAllSources, listSources, parseUrl } from "./registry";
import { Logger } from "@/lib/logging/logger";
import { ScrapedJob, SearchConfig, CustomSite } from "@/types";
import { fastFilter } from "@/lib/matching/fast-filter";
import { atsKeywordPct } from "@/lib/ai/ats-analyzer";
import { detectVisaInfo } from "@/lib/matching/visa-detector";
import { generateJobsExcel } from "@/lib/export/excel";
import { ensureDir } from "@/lib/storage/file-manager";

const EXCEL_PATH = join(process.cwd(), "applications", "jobs_tracker.xlsx");

// Ollama embeddings are slow (minutes for a handful of jobs). With Claude doing
// the real scoring, the semantic pre-filter is redundant — keep it off unless
// explicitly enabled via env.
const USE_SEMANTIC_FILTER = process.env.USE_SEMANTIC_FILTER === "true";

// Throttle Excel writes — file IO during scraping shouldn't be per-job if writes overlap.
// We use a sequential queue so writes never race.
let excelWritePending: Promise<void> = Promise.resolve();
function queueExcelWrite(): Promise<void> {
  excelWritePending = excelWritePending.then(async () => {
    try {
      ensureDir(join(process.cwd(), "applications"));
      const buffer = await generateJobsExcel();
      writeFileSync(EXCEL_PATH, buffer);
    } catch (e) {
      await Logger.warn("SCRAPER", `Excel update failed: ${e}`);
    }
  });
  return excelWritePending;
}

// Convert fast-filter score (0-100, higher = better) to matchScore (1-10, lower = better)
function filterScoreToMatchScore(score: number): number {
  if (score >= 80) return 2;
  if (score >= 60) return 4;
  if (score >= 40) return 6;
  if (score >= 20) return 8;
  return 10;
}

// Inputs the per-job fast filter needs. Built once per session (or per URL
// ingest) from the active résumé + the user's search intent.
interface ScoringContext {
  candidateSkills: string[];
  candidateTech: string[];
  candidateYears: number;
  searchKeywords: string[];
  entryLevelTarget: boolean;
}

export class ScrapingOrchestrator {
  private isRunning = false;

  async startScraping(
    config: SearchConfig,
    resumeId?: string,
    onFitJob?: (jobId: string) => void
  ): Promise<{ newCount: number; fitCount: number; notFitCount: number }> {
    if (this.isRunning) {
      await Logger.warn("SCRAPER", "Already running");
      return { newCount: 0, fitCount: 0, notFitCount: 0 };
    }

    this.isRunning = true;
    await Logger.info("SCRAPER", "Starting scraping session", {
      platforms: config.platforms.join(","),
      maxJobs: config.maxJobs,
    });

    const session = await prisma.scrapingSession.create({
      data: {
        platform: config.platforms.join(","),
        searchQuery: config.keywords.join(", "),
      },
    });

    let newCount = 0;
    let fitCount = 0;
    let notFitCount = 0;
    let duplicateCount = 0;

    // Scoring context (candidate skills/years + entry-level intent) for the
    // per-job fast filter. Extracted so URL ingestion reuses it identically.
    const ctx = await this.buildScoringContext(resumeId, config.keywords, config.experienceLevels);

    // Per-job callback: persist (dedup + fast-filter score) → counts → Excel →
    // stream fit jobs into the analyze/tailor pipeline.
    const onJob = async (job: ScrapedJob): Promise<void> => {
      const res = await this.persistJob(job, ctx);
      if (res === "duplicate") { duplicateCount++; return; }
      if (!res) return;
      newCount++;
      if (res.isFit) fitCount++; else notFitCount++;
      await Logger.success(
        "SCRAPER",
        `[+${newCount}] ${res.jobTitle} @ ${res.companyName} — Fit: ${res.isFit ? "YES" : "NO"} (score: ${res.matchScore}/10) | ${res.reason}`
      );
      queueExcelWrite();
      if (res.isFit && onFitJob) {
        try { onFitJob(res.jobId); } catch (e) { await Logger.warn("SCRAPER", `onFitJob handoff failed: ${e}`); }
      }
    };

    try {
      const allKeywords = config.keywords;
      const allLocations = config.locations;
      const maxJobs = config.maxJobs ?? 50;

      // Split limit across platforms (if user wants 10 total, ~5 from each)
      const platformCount = config.platforms.length + 1; // +1 for custom sites buffer
      const perPlatformLimit = Math.max(3, Math.ceil(maxJobs / Math.max(1, platformCount)));

      if (config.platforms.includes("linkedin") && newCount < maxJobs) {
        const remaining = maxJobs - newCount;
        const limit = Math.min(perPlatformLimit, remaining);
        await Logger.info("SCRAPER", `── LinkedIn (target: ${limit} jobs) ──`);
        const scraper = new LinkedInScraper();
        await scraper.scrapeJobs(allKeywords, allLocations, {
          maxJobs: limit,
          remote: config.remote,
          experienceLevels: config.experienceLevels,
          onJob,
        });
      }

      if (config.platforms.includes("indeed") && newCount < maxJobs) {
        const remaining = maxJobs - newCount;
        const limit = Math.min(perPlatformLimit, remaining);
        await Logger.info("SCRAPER", `── Indeed (target: ${limit} jobs) ──`);
        const scraper = new IndeedScraper();
        await scraper.scrapeJobs(allKeywords, allLocations, {
          maxJobs: limit,
          remote: config.remote,
          onJob,
        });
      }

      // Settings (preferred companies for ATS boards, custom sites).
      const settings = await prisma.userSettings.findUnique({ where: { userId: "local" } });

      // Registry sources: Greenhouse + Lever/Ashby/SmartRecruiters/Workable/
      // Recruitee (ATS boards) and RemoteOK/Remotive/WeWorkRemotely/HackerNews
      // (remote feeds). These run via the unified registry — in parallel, with
      // per-domain rate limiting. Select them by id in `platforms`, or use the
      // meta token "all"/"web" to run every source.
      const registryIds = new Set(listSources().map((s) => s.id));
      const wantsAll = config.platforms.some((p) => /^(all|web|everywhere)$/i.test(p));
      const selectedSources = wantsAll
        ? [...registryIds]
        : config.platforms.filter((p) => registryIds.has(p));
      if (selectedSources.length && newCount < maxJobs) {
        const userCompanies = (settings?.preferredCompanies || []).filter(Boolean);
        await Logger.info("SCRAPER", `── Web sources (${wantsAll ? "all" : selectedSources.join(", ")}) ──`);
        await searchAllSources(
          {
            keywords: allKeywords,
            locations: allLocations,
            remote: config.remote,
            maxJobs: Math.max(perPlatformLimit, maxJobs - newCount),
            companies: userCompanies.length ? userCompanies : undefined,
            onJob: async (job) => {
              if (newCount >= maxJobs) return;
              await onJob(job);
            },
          },
          { sources: wantsAll ? undefined : selectedSources, concurrency: 4 }
        );
      }

      const customSites = ((settings?.customSites as unknown as CustomSite[]) || []).filter((s) => s.enabled);
      for (const site of customSites) {
        if (newCount >= maxJobs) break;
        await Logger.info("SCRAPER", `── Custom: ${site.name} ──`);
        const scraper = new CustomScraper();
        const jobs = await scraper.scrapeJobs(site);
        for (const job of jobs) {
          if (newCount >= maxJobs) break;
          await onJob(job);
        }
      }

      // Ensure final Excel write completes
      await queueExcelWrite();

      await prisma.scrapingSession.update({
        where: { id: session.id },
        data: {
          status: "completed",
          jobsFound: newCount + duplicateCount,
          jobsNew: newCount,
          jobsDuplicate: duplicateCount,
          completedAt: new Date(),
        },
      });

      await Logger.success(
        "SCRAPER",
        `Session done: ${newCount} new | ${fitCount} fit | ${notFitCount} not fit | ${duplicateCount} duplicates`
      );
    } catch (e) {
      await prisma.scrapingSession.update({
        where: { id: session.id },
        data: { status: "failed", error: String(e), completedAt: new Date() },
      });
      await Logger.error("SCRAPER", "Scraping session failed", { error: String(e) });
    } finally {
      this.isRunning = false;
    }

    return { newCount, fitCount, notFitCount };
  }

  // Build the fast-filter scoring context from the active résumé + search intent.
  private async buildScoringContext(
    resumeId: string | undefined,
    keywords: string[],
    experienceLevels?: string[]
  ): Promise<ScoringContext> {
    let candidateSkills: string[] = [];
    let candidateTech: string[] = [];
    let candidateYears = 0;
    if (resumeId) {
      const resume = await prisma.resume.findUnique({ where: { id: resumeId } });
      if (resume) {
        candidateSkills = resume.skills || [];
        candidateTech = resume.technologies || [];
        candidateYears = resume.yearsOfExperience || 0;
      }
    }
    const entryLevelTarget =
      (experienceLevels || []).some((l) => /intern|entry|junior|new\s*grad/i.test(l)) ||
      keywords.some((k) => /intern|entry|junior|new\s*grad/i.test(k));
    return { candidateSkills, candidateTech, candidateYears, searchKeywords: keywords, entryLevelTarget };
  }

  // Persist one scraped job: dedup → fast-filter score → create. Returns the
  // created job's id + fit flag (for the caller to count/stream), the sentinel
  // "duplicate", or null on error. Shared by the scrape session and URL ingest.
  private async persistJob(
    job: ScrapedJob,
    ctx: ScoringContext
  ): Promise<{ jobId: string; isFit: boolean; jobTitle: string; companyName: string; matchScore: number; reason: string } | "duplicate" | null> {
    try {
      const exists = job.platformJobId
        ? await prisma.job.findUnique({
            where: { platform_platformJobId: { platform: job.platform, platformJobId: job.platformJobId } },
          })
        : await prisma.job.findFirst({ where: { url: job.url } });
      if (exists) return "duplicate";

      const isBlacklisted = this.isCompanyBlacklisted(job.companyName);
      const isSpam = this.isSpamJob(job);
      const filter = fastFilter(
        job.jobTitle,
        job.description,
        ctx.candidateSkills,
        ctx.candidateTech,
        ctx.searchKeywords,
        { candidateYears: ctx.candidateYears, entryLevelTarget: ctx.entryLevelTarget }
      );
      const matchScore = filterScoreToMatchScore(filter.score);
      const isFit = !filter.skip && matchScore <= 6;
      const visa = detectVisaInfo(job.description || "");

      const created = await prisma.job.create({
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
          matchScore,
          atsScore: filter.score / 10,
          atsKeywordScore: atsKeywordPct(filter.matchedKeywords, filter.missingKeywords),
          matchingSkills: filter.matchedKeywords,
          missingSkills: filter.missingKeywords,
          matchReason: filter.reason,
          sponsorshipStatus: visa.sponsorshipStatus,
          acceptsCpt: visa.acceptsCpt,
          acceptsOpt: visa.acceptsOpt,
          intlFriendlyScore: visa.intlFriendlyScore,
          isBlacklisted,
          isSpam,
          status: "FOUND",
        },
      });
      return { jobId: created.id, isFit, jobTitle: job.jobTitle, companyName: job.companyName, matchScore, reason: filter.reason };
    } catch (e) {
      await Logger.warn("SCRAPER", `Per-job save failed for ${job.jobTitle}: ${e}`);
      return null;
    }
  }

  // Ingest one or more pasted URLs (board or individual posting). The registry
  // picks the right source (or the generic JSON-LD parser) per URL. Returns
  // counts so the API can report what landed.
  async scrapeUrls(urls: string[], resumeId?: string): Promise<{ newCount: number; fitCount: number; duplicateCount: number; jobIds: string[] }> {
    const ctx = await this.buildScoringContext(resumeId, [], []);
    let newCount = 0, fitCount = 0, duplicateCount = 0;
    const jobIds: string[] = [];
    for (const url of urls) {
      const clean = (url || "").trim();
      if (!/^https?:\/\//i.test(clean)) continue;
      await Logger.info("SCRAPER", `── URL: ${clean} ──`);
      let jobs: ScrapedJob[] = [];
      try {
        jobs = await parseUrl(clean);
      } catch (e) {
        await Logger.warn("SCRAPER", `URL parse failed (${clean}): ${e}`);
      }
      if (!jobs.length) {
        await Logger.warn("SCRAPER", `No job posting found at ${clean}`);
        continue;
      }
      for (const job of jobs) {
        const res = await this.persistJob(job, ctx);
        if (res === "duplicate") { duplicateCount++; continue; }
        if (!res) continue;
        newCount++;
        if (res.isFit) fitCount++;
        jobIds.push(res.jobId);
        await Logger.success("SCRAPER", `[+${newCount}] ${res.jobTitle} @ ${res.companyName} (${res.matchScore}/10)`);
      }
      queueExcelWrite();
    }
    await queueExcelWrite();
    return { newCount, fitCount, duplicateCount, jobIds };
  }

  async analyzeAndScoreJobs(resumeId: string): Promise<void> {
    const resume = await prisma.resume.findUnique({ where: { id: resumeId } });
    if (!resume) throw new Error("Resume not found");

    // Only analyze jobs that the fast filter marked as Fit (matchScore <= 6) and that haven't been AI-scored yet.
    // We track AI-scored state via confidenceLevel — fast filter sets it to null/low, AI sets it higher.
    const unanalyzedJobs = await prisma.job.findMany({
      where: {
        status: "FOUND",
        isBlacklisted: false,
        isSpam: false,
        isDuplicate: false,
        matchScore: { lte: 6 }, // only fit jobs
      },
      orderBy: { matchScore: "asc" },
      take: 100,
    });

    if (unanalyzedJobs.length === 0) {
      await Logger.info("ANALYZER", "No fit jobs to analyze deeply");
      // Mark non-fit jobs as ANALYZED too so they don't keep being picked up
      await prisma.job.updateMany({
        where: { status: "FOUND", isBlacklisted: false, isSpam: false, isDuplicate: false },
        data: { status: "ANALYZED" },
      });
      return;
    }
    await Logger.info("ANALYZER", `AI-scoring ${unanalyzedJobs.length} fit jobs`);

    const { claudeBatchMatchJobs } = await import("@/lib/ai/claude");
    const { generateEmbedding, cosineSimilarity } = await import("@/lib/ai/ollama");
    const resumeData = resume.parsedData as Record<string, unknown>;
    const candidateSkills = resume.skills || [];
    const candidateTech = resume.technologies || [];

    // Semantic scoring with nomic-embed-text
    const resumeText = [
      (resumeData.summary as string) || "",
      candidateSkills.slice(0, 20).join(" "),
      candidateTech.slice(0, 20).join(" "),
      ((resumeData.experience as Array<{ title: string; bullets: string[] }>) || [])
        .slice(0, 2).map((e) => `${e.title} ${e.bullets?.slice(0, 3).join(" ")}`).join(" "),
    ].join(" ").trim();

    const semanticScores = new Map<string, number>();
    const toAiScore: typeof unanalyzedJobs = [];

    if (USE_SEMANTIC_FILTER && resumeText.length > 50) {
      try {
        const resumeEmbedding = await generateEmbedding(resumeText);
        let semanticSkipped = 0;

        for (const job of unanalyzedJobs) {
          try {
            const jobText = `${job.jobTitle} ${job.companyName} ${job.description}`.slice(0, 4000);
            const jobEmbedding = await generateEmbedding(jobText);
            const sim = cosineSimilarity(resumeEmbedding, jobEmbedding);
            semanticScores.set(job.id, sim);

            if (sim < 0.3) {
              semanticSkipped++;
              await prisma.job.update({
                where: { id: job.id },
                data: {
                  matchScore: 9,
                  atsScore: 2,
                  confidenceLevel: 0.85,
                  matchReason: `Low semantic similarity (${(sim * 100).toFixed(0)}%)`,
                  status: "ANALYZED",
                },
              });
            } else {
              toAiScore.push(job);
            }
          } catch {
            semanticScores.set(job.id, 0.5);
            toAiScore.push(job);
          }
        }
        await Logger.info("ANALYZER", `Semantic filter: ${semanticSkipped} demoted`);
      } catch (e) {
        await Logger.warn("ANALYZER", `Semantic scoring unavailable: ${e}`);
        toAiScore.push(...unanalyzedJobs);
      }
    } else {
      toAiScore.push(...unanalyzedJobs);
    }

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
          // Claude occasionally echoes an id that wasn't in the batch — skip it
          // so prisma.update doesn't throw "Record to update not found".
          if (!batch.some((j) => j.id === scored.id)) continue;
          const semSim = semanticScores.get(scored.id) ?? 0.5;
          const confidence = Math.min(0.95, 0.6 + semSim * 0.35);
          await prisma.job.update({
            where: { id: scored.id },
            data: {
              matchScore: scored.matchScore,
              atsScore: scored.atsScore,
              atsKeywordScore: atsKeywordPct(scored.matchingSkills || [], scored.missingSkills || []),
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

    // Mark all remaining FOUND jobs (not-fit ones we didn't analyze) as ANALYZED
    await prisma.job.updateMany({
      where: { status: "FOUND", isBlacklisted: false, isSpam: false, isDuplicate: false },
      data: { status: "ANALYZED" },
    });

    // Refresh Excel after full analysis
    queueExcelWrite();

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
      "work from home opportunity - earn",
      "make money from home",
      "unlimited earning",
      "pyramid",
      "mlm",
    ];
    const text = `${job.jobTitle} ${job.description}`.toLowerCase();
    return spamKeywords.some((kw) => text.includes(kw));
  }
}

export const scrapingOrchestrator = new ScrapingOrchestrator();
