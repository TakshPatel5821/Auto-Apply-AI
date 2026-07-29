import { writeFileSync } from "fs";
import { join } from "path";
import { prisma } from "@/lib/db/prisma";
import { scrapingOrchestrator } from "@/lib/scraping/scraping-orchestrator";
import { tailorJob, EligibilityError } from "@/lib/tailoring";
import { claudeMatchJobToResume } from "@/lib/ai/claude";
import { atsKeywordPct } from "@/lib/ai/ats-analyzer";
import { extractRequiredYears } from "@/lib/matching/fast-filter";
import { ApplyEngine } from "./apply-engine";
import { Logger } from "@/lib/logging/logger";
import { AutomationState, SearchConfig } from "@/types";
import { getApplicationFolder, ensureDir } from "@/lib/storage/file-manager";
import { scraperStatus } from "./scraper-status";
import { generateJobsExcel } from "@/lib/export/excel";
import { syncInbox } from "@/lib/gmail/sync";

const EXCEL_PATH = join(process.cwd(), "applications", "jobs_tracker.xlsx");

async function saveExcelTracker(): Promise<void> {
  try {
    ensureDir(join(process.cwd(), "applications"));
    const buffer = await generateJobsExcel();
    writeFileSync(EXCEL_PATH, buffer);
    await Logger.info("ENGINE", `Excel tracker saved: ${EXCEL_PATH}`);
  } catch (e) {
    await Logger.warn("ENGINE", `Excel save failed: ${e}`);
  }
}

class AutomationEngine {
  private state: AutomationState = {
    isRunning: false,
    isPaused: false,
    mode: "manual",
    jobsScraped: 0,
    jobsAnalyzed: 0,
    applicationsSubmitted: 0,
    applicationsToday: 0,
    waitingForUser: false,
    waitingReason: "",
  };

  private applyEngine = new ApplyEngine();
  private stopRequested = false;

  // ─── Per-job streaming pipeline state ─────────────────────────────────────
  private queue: string[] = [];
  private queueWorking = false;
  private tailoredCount = 0;
  private runResumeId = "";
  private runMode: "auto" | "manual" = "manual";
  private runMaxApps = 20;
  private runResumeData: Record<string, unknown> = {};

  getState(): AutomationState {
    return {
      ...this.state,
      waitingForUser: scraperStatus.waitingForUser,
      waitingReason: scraperStatus.reason,
    };
  }

  async start(config: {
    searchConfig: SearchConfig;
    resumeId: string;
    mode: "auto" | "manual";
    maxApplicationsPerDay?: number;
    maxJobsToScrape?: number;
  }): Promise<void> {
    if (this.state.isRunning) {
      await Logger.warn("ENGINE", "Automation already running — ignoring duplicate start");
      return;
    }

    this.stopRequested = false;
    this.queue = [];
    this.queueWorking = false;
    this.tailoredCount = 0;
    this.state = {
      isRunning: true,
      isPaused: false,
      mode: config.mode,
      jobsScraped: 0,
      jobsAnalyzed: 0,
      applicationsSubmitted: 0,
      applicationsToday: 0,
      startedAt: new Date(),
      lastActivity: new Date(),
    };

    // Inject maxJobs limit into search config
    const searchConfig: SearchConfig = {
      ...config.searchConfig,
      maxJobs: config.maxJobsToScrape ?? config.searchConfig.maxJobs ?? 20,
    };

    this.runResumeId = config.resumeId;
    this.runMode = config.mode;
    this.runMaxApps = config.maxApplicationsPerDay ?? 20;

    // Load the resume once — every per-job analyze/tailor reuses this.
    const resume = await prisma.resume.findUnique({ where: { id: config.resumeId } });
    this.runResumeData = (resume?.parsedData as Record<string, unknown>) || {};

    await Logger.info("ENGINE", `╔══════════════════════════════════════════╗`);
    await Logger.info("ENGINE", `║  Automation started — mode: ${config.mode.toUpperCase().padEnd(13)}║`);
    await Logger.info("ENGINE", `╚══════════════════════════════════════════╝`);
    await Logger.info("ENGINE", `Platforms: ${searchConfig.platforms.join(", ")}`);
    await Logger.info("ENGINE", `Keywords: ${searchConfig.keywords.join(", ")}`);
    await Logger.info("ENGINE", `Locations: ${searchConfig.locations.join(", ")}`);
    await Logger.info("ENGINE", `Max jobs to scrape: ${searchConfig.maxJobs}`);

    try {
      // Pre-warm account-gated ATS logins ONCE (auto mode only) so every
      // Greenhouse-portal apply in this batch is already authenticated.
      if (this.runMode === "auto" && !this.stopRequested) {
        this.state.currentAction = "Pre-warming ATS logins…";
        await this.applyEngine.prewarmLogins().catch(() => {});
      }

      // Scan Gmail for status-changing mail (interview/offer/rejection) at the
      // start of each batch — auto-updates matching applications. No-op if Gmail
      // isn't connected. Non-fatal.
      syncInbox()
        .then((r) => {
          if (r.scanned) Logger.info("ENGINE", `Gmail sync: ${r.scanned} new mail, ${r.updated.length} status update(s)`);
        })
        .catch(() => {});

      // Streaming pipeline: scraping uses the cheap local filter; each fit job is
      // handed off to the Claude pipeline (analyze → tailor → Overleaf CV → apply)
      // the moment it's found, running concurrently with continued scraping.
      this.state.currentAction = `Scraping & processing up to ${searchConfig.maxJobs} jobs...`;
      await Logger.info("ENGINE", "─── Streaming pipeline: scrape → analyze → tailor → CV per job ───");

      const result = await scrapingOrchestrator.startScraping(
        searchConfig,
        config.resumeId,
        (jobId) => this.enqueueJob(jobId)
      );
      this.state.jobsScraped = result.newCount;
      await Logger.success(
        "ENGINE",
        `Scraping done: ${result.newCount} new (${result.fitCount} fit) — finishing ${this.queue.length} queued job(s)...`
      );

      // Also process the existing fit backlog: jobs already scraped/analyzed
      // (via Scrape Only or earlier runs, incl. ones stuck mid-tailor) that
      // never produced an application. Without this they're stranded forever,
      // since duplicates are never re-scraped.
      if (!this.stopRequested) {
        const backlog = await prisma.job.findMany({
          where: {
            status: { in: ["FOUND", "ANALYZED", "TAILORING"] },
            matchScore: { lte: 6 },
            isBlacklisted: false,
            isSpam: false,
            isDuplicate: false,
            application: null,
          },
          orderBy: { matchScore: "asc" },
          select: { id: true },
          take: 50,
        });
        if (backlog.length) {
          await Logger.info("ENGINE", `Queuing ${backlog.length} existing fit job(s) for tailoring`);
          for (const j of backlog) this.enqueueJob(j.id);
        }
      }

      // Wait for the per-job pipeline to drain everything queued.
      await this.waitForQueue();

      if (!this.stopRequested) {
        // Mark leftover non-fit jobs as analyzed so the dashboard isn't cluttered
        // with permanently-"FOUND" rows.
        await prisma.job.updateMany({
          where: { status: "FOUND", isBlacklisted: false, isSpam: false, isDuplicate: false },
          data: { status: "ANALYZED" },
        });
      }

      await saveExcelTracker();

      await Logger.success("ENGINE", `╔══════════════════════════════════════════╗`);
      await Logger.success("ENGINE", `║  Automation cycle COMPLETE               ║`);
      await Logger.success("ENGINE", `║  Scraped:  ${String(this.state.jobsScraped).padEnd(31)}║`);
      await Logger.success("ENGINE", `║  Tailored: ${String(this.tailoredCount).padEnd(31)}║`);
      await Logger.success("ENGINE", `║  Applied:  ${String(this.state.applicationsSubmitted).padEnd(31)}║`);
      await Logger.success("ENGINE", `╚══════════════════════════════════════════╝`);
    } catch (e) {
      await Logger.error("ENGINE", `Automation failed: ${e}`);
    } finally {
      this.state.isRunning = false;
      this.state.currentJob = undefined;
      this.state.currentAction = undefined;
      await saveExcelTracker();
    }
  }

  // ─── Per-job pipeline ───────────────────────────────────────────────────────

  /** Called by the scraper for each fit job. Enqueues and kicks the worker. */
  private enqueueJob(jobId: string): void {
    if (this.stopRequested) return;
    if (this.queue.includes(jobId)) return;
    this.queue.push(jobId);
    void this.runQueue();
  }

  /** Serial worker — one job end-to-end at a time (Overleaf can't run in parallel). */
  private async runQueue(): Promise<void> {
    if (this.queueWorking) return;
    this.queueWorking = true;
    try {
      while (this.queue.length > 0) {
        if (this.stopRequested) {
          this.queue = [];
          break;
        }
        // Honor pause without dropping queued work.
        while (this.state.isPaused && !this.stopRequested) {
          await new Promise((r) => setTimeout(r, 1000));
        }
        if (this.stopRequested) break;

        const jobId = this.queue.shift()!;
        await this.processJob(jobId);
      }
    } finally {
      this.queueWorking = false;
    }
  }

  /** Block until the scraper-fed queue is fully drained. */
  private async waitForQueue(): Promise<void> {
    while ((this.queue.length > 0 || this.queueWorking) && !this.stopRequested) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  /** Analyze → tailor → CV → (auto) apply for a single job. */
  private async processJob(jobId: string): Promise<void> {
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) return;

    // Skip if we've already produced an application for this job.
    const existing = await prisma.application.findFirst({ where: { jobId } });
    if (existing) return;

    // Skip jobs whose description never loaded (e.g. LinkedIn detail panel
    // failed). Tailoring a résumé against a stub is wasted work + bad output.
    if ((job.description || "").trim().length < 120) {
      await Logger.warn("ENGINE", `Skipping ${job.companyName} — description too short (${(job.description || "").trim().length} chars); likely failed to load`);
      await prisma.job.update({ where: { id: jobId }, data: { status: "SKIPPED" } }).catch(() => {});
      return;
    }

    // Experience re-check: backlog jobs scraped BEFORE the experience filter
    // existed can still be marked "fit" in the DB. Re-gate here so a senior role
    // (e.g. "4 years experience") is never tailored for an entry-level candidate.
    const candidateYears = Number(this.runResumeData.yearsOfExperience) || 0;
    const requiredYears = extractRequiredYears(job.description || "");
    const isIntern = /\b(intern|internship|co-?op|new\s*grad|entry[ -]?level|junior)\b/i.test(
      `${job.jobTitle} ${job.description}`
    );
    if (!isIntern && requiredYears > 0 && requiredYears > candidateYears + 1) {
      await Logger.warn("ENGINE", `Skipping ${job.jobTitle} @ ${job.companyName} — needs ~${requiredYears} yrs (you have ${candidateYears})`);
      await prisma.job.update({ where: { id: jobId }, data: { status: "SKIPPED" } }).catch(() => {});
      return;
    }

    this.state.currentJob = `${job.jobTitle} @ ${job.companyName}`;
    this.state.lastActivity = new Date();

    // ─── Analyze (Claude, single job) ─────────────────────────────────────────
    // Coerce null to a borderline-fit value; jobs only reach the queue when the
    // fast filter already marked them a fit, so this is just for type-safety.
    let matchScore: number = job.matchScore ?? 6;
    this.state.currentAction = `Analyzing: ${job.jobTitle} @ ${job.companyName}`;
    try {
      // Analyze only REFINES the already-decided filter score, so cap it: if the
      // local model stalls, fall back to the filter score in ~90s instead of
      // blocking the whole pipeline for minutes.
      const analyzeMs = Number(process.env.ANALYZE_TIMEOUT_MS) || 90000;
      const scored = (await Promise.race([
        claudeMatchJobToResume(job.description, this.runResumeData),
        new Promise((_, rej) => setTimeout(() => rej(new Error("analyze timeout")), analyzeMs)),
      ])) as {
        matchScore?: number;
        atsScore?: number;
        matchingSkills?: string[];
        missingSkills?: string[];
        matchReason?: string;
        confidenceLevel?: number;
      };
      matchScore = scored.matchScore ?? matchScore;
      const matching = scored.matchingSkills ?? job.matchingSkills ?? [];
      const missing = scored.missingSkills ?? job.missingSkills ?? [];
      await prisma.job.update({
        where: { id: jobId },
        data: {
          matchScore,
          atsScore: scored.atsScore ?? job.atsScore,
          atsKeywordScore: atsKeywordPct(matching, missing),
          matchingSkills: matching,
          missingSkills: missing,
          matchReason: scored.matchReason ?? job.matchReason,
          confidenceLevel: scored.confidenceLevel ?? 0.8,
          status: "ANALYZED",
        },
      });
      this.state.jobsAnalyzed++;
      await Logger.info(
        "ENGINE",
        `Analyzed ${job.companyName}: ${matchScore}/10 — ${(scored.matchReason || "").slice(0, 80)}`
      );
    } catch (e) {
      await Logger.warn("ENGINE", `Analyze failed for ${job.companyName} — tailoring on filter score: ${e}`);
      await prisma.job.update({ where: { id: jobId }, data: { status: "ANALYZED" } }).catch(() => {});
    }

    // The fast filter already decided this job is a fit; the Claude re-score
    // above only refines the displayed number. Tailor it unless Claude rates it
    // a clear no-go (9-10), so genuine fits are never silently dropped.
    if (matchScore >= 9) {
      await Logger.info("ENGINE", `Skipping tailor for ${job.companyName} — Claude rated it a poor fit (${matchScore}/10)`);
      return;
    }
    if (this.stopRequested) return;

    // ─── Tailor résumé + cover letter + Overleaf CV ───────────────────────────
    this.state.currentAction = `Tailoring: ${job.jobTitle} @ ${job.companyName}`;
    try {
      // Cap the tailor AI call so a wedged/stuck Ollama can't hang the whole
      // pipeline indefinitely (default 4 min; configurable). On timeout the job
      // is left for a later run rather than blocking everything behind it.
      const tailorMs = Number(process.env.TAILOR_TIMEOUT_MS) || 240000;
      const { tailoredResumeId, coverLetterId } = (await Promise.race([
        tailorJob(this.runResumeId, jobId),
        new Promise((_, rej) => setTimeout(() => rej(new Error("tailor timeout — AI not responding")), tailorMs)),
      ])) as { tailoredResumeId: string; coverLetterId: string };
      const folderPath = getApplicationFolder(job.companyName, job.jobTitle);

      const application = await prisma.application.create({
        data: {
          userId: "local",
          jobId,
          resumeId: this.runResumeId,
          tailoredResumeId,
          coverLetterId,
          status: this.runMode === "auto" ? "APPROVED" : "PENDING",
          folderPath,
        },
      });

      this.tailoredCount++;
      this.state.lastActivity = new Date();
      await Logger.success("ENGINE", `Tailored ${job.companyName} (${this.tailoredCount} done)`);

      // ─── Auto-apply (auto mode only, within the daily limit) ────────────────
      if (this.runMode === "auto" && !this.stopRequested) {
        const todayCount = await this.getApplicationsToday();
        if (todayCount >= this.runMaxApps) {
          await Logger.warn("ENGINE", `Daily limit (${this.runMaxApps}) reached — not applying to ${job.companyName}`);
        } else {
          this.state.currentAction = `Applying: ${job.jobTitle} @ ${job.companyName}`;
          const ok = await this.applyEngine.applyToJob(application.id);
          if (ok) {
            this.state.applicationsSubmitted++;
            this.state.applicationsToday++;
            await Logger.success("ENGINE", `Applied: ${job.companyName} (${this.state.applicationsSubmitted} total)`);
          }
        }
      }

      await saveExcelTracker();
    } catch (e) {
      if (e instanceof EligibilityError) {
        await prisma.job.update({ where: { id: jobId }, data: { status: "SKIPPED" } }).catch(() => {});
        await Logger.info("ENGINE", `Skipped ${job.companyName}: ${e.reason}`);
        return;
      }
      await Logger.error("ENGINE", `Tailoring failed for ${job.companyName}: ${e}`);
    }
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.state.isRunning = false;
    await Logger.info("ENGINE", "Automation stopped by user");
  }

  async pause(): Promise<void> {
    this.state.isPaused = true;
    await Logger.info("ENGINE", "Automation paused");
  }

  async resume(): Promise<void> {
    this.state.isPaused = false;
    scraperStatus.waitingForUser = false;
    await Logger.info("ENGINE", "Automation resumed — clearing human-wait flag");
  }

  // User asserts they finished the application during a takeover. Trusted so a
  // genuinely-submitted app we can't auto-detect isn't marked FAILED.
  async confirmSubmitted(): Promise<void> {
    scraperStatus.userConfirmedSubmit = true;
    scraperStatus.waitingForUser = false;
    await Logger.success("ENGINE", "You confirmed the application was submitted");
  }

  private async getApplicationsToday(): Promise<number> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return prisma.application.count({
      where: {
        userId: "local",
        appliedAt: { gte: today },
        status: { in: ["SUBMITTED", "CONFIRMED"] },
      },
    });
  }
}

export const automationEngine = new AutomationEngine();
