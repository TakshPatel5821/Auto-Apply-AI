import { writeFileSync } from "fs";
import { join } from "path";
import { prisma } from "@/lib/db/prisma";
import { scrapingOrchestrator } from "@/lib/scraping/scraping-orchestrator";
import { tailorResumeForJob } from "./resume-tailor";
import { ApplyEngine } from "./apply-engine";
import { Logger } from "@/lib/logging/logger";
import { AutomationState, SearchConfig } from "@/types";
import { getApplicationFolder, ensureDir } from "@/lib/storage/file-manager";
import { scraperStatus } from "./scraper-status";
import { generateJobsExcel } from "@/lib/export/excel";

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
  };

  private applyEngine = new ApplyEngine();
  private stopRequested = false;

  getState(): AutomationState {
    return { ...this.state };
  }

  async start(config: {
    searchConfig: SearchConfig;
    resumeId: string;
    mode: "auto" | "manual";
    maxApplicationsPerDay?: number;
  }): Promise<void> {
    if (this.state.isRunning) {
      throw new Error("Automation already running");
    }

    this.stopRequested = false;
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

    await Logger.info("ENGINE", `╔══════════════════════════════════════════╗`);
    await Logger.info("ENGINE", `║  Automation started — mode: ${config.mode.toUpperCase().padEnd(13)}║`);
    await Logger.info("ENGINE", `╚══════════════════════════════════════════╝`);
    await Logger.info("ENGINE", `Platforms: ${config.searchConfig.platforms.join(", ")}`);
    await Logger.info("ENGINE", `Keywords: ${config.searchConfig.keywords.join(", ")}`);
    await Logger.info("ENGINE", `Locations: ${config.searchConfig.locations.join(", ")}`);

    try {
      // ─── Step 1: Scrape jobs ─────────────────────────────────────────────────
      this.state.currentAction = "Step 1/4: Scraping jobs...";
      await Logger.info("ENGINE", "─── Step 1: Scraping jobs ───");

      const beforeScrape = await prisma.job.count();
      await scrapingOrchestrator.startScraping(config.searchConfig);
      const afterScrape = await prisma.job.count();
      this.state.jobsScraped = afterScrape - beforeScrape;

      await Logger.success("ENGINE", `Scraping done — ${this.state.jobsScraped} new jobs added`);
      await saveExcelTracker();

      if (this.stopRequested) return;

      // ─── Step 2: Analyze & score ──────────────────────────────────────────────
      this.state.currentAction = `Step 2/4: Analyzing ${this.state.jobsScraped} new jobs...`;
      await Logger.info("ENGINE", "─── Step 2: Analyzing & scoring jobs ───");

      await scrapingOrchestrator.analyzeAndScoreJobs(config.resumeId);
      this.state.jobsAnalyzed = this.state.jobsScraped;

      await Logger.success("ENGINE", "Analysis done");
      await saveExcelTracker();

      if (this.stopRequested) return;

      // ─── Step 3: Tailor resumes for top matches ───────────────────────────────
      this.state.currentAction = "Step 3/4: Tailoring resumes...";
      await Logger.info("ENGINE", "─── Step 3: Tailoring resumes & cover letters ───");

      const topJobs = await prisma.job.findMany({
        where: {
          status: "ANALYZED",
          matchScore: { lte: 6 },
          isBlacklisted: false,
          isSpam: false,
          isDuplicate: false,
          application: null, // no application yet
        },
        orderBy: { matchScore: "asc" },
        take: 20,
      });

      await Logger.info("ENGINE", `Found ${topJobs.length} top-match jobs to tailor for`);

      let tailored = 0;
      for (const job of topJobs) {
        if (this.stopRequested) break;

        await Logger.info("ENGINE", `Tailoring [${tailored + 1}/${topJobs.length}]: ${job.jobTitle} @ ${job.companyName}`);

        try {
          const { tailoredResumeId, coverLetterId } = await tailorResumeForJob(config.resumeId, job.id);

          const folderPath = getApplicationFolder(job.companyName, job.jobTitle);

          await prisma.application.create({
            data: {
              userId: "local",
              jobId: job.id,
              resumeId: config.resumeId,
              tailoredResumeId,
              coverLetterId,
              status: config.mode === "auto" ? "APPROVED" : "PENDING",
              folderPath,
            },
          });

          tailored++;
          this.state.jobsAnalyzed = tailored;
          this.state.currentAction = `Step 3/4: Tailoring resumes... (${tailored}/${topJobs.length})`;
          this.state.lastActivity = new Date();

          await Logger.success("ENGINE", `Tailored ${tailored}/${topJobs.length}: ${job.companyName}`);
        } catch (e) {
          await Logger.error("ENGINE", `Tailoring failed for ${job.companyName}: ${e}`);
        }
      }

      await saveExcelTracker();
      await Logger.success("ENGINE", `Tailoring done — ${tailored} resumes tailored`);

      if (this.stopRequested) return;

      // ─── Step 4: Auto-apply (auto mode only) ─────────────────────────────────
      if (config.mode === "auto") {
        this.state.currentAction = "Step 4/4: Applying to jobs...";
        await Logger.info("ENGINE", "─── Step 4: Applying to jobs ───");

        const maxApps = config.maxApplicationsPerDay || 20;
        const todayCount = await this.getApplicationsToday();
        const remaining = Math.max(0, maxApps - todayCount);

        await Logger.info("ENGINE", `Today's limit: ${maxApps} | Already applied today: ${todayCount} | Can apply: ${remaining}`);

        if (remaining === 0) {
          await Logger.warn("ENGINE", "Daily application limit reached — skipping apply step");
        } else {
          const pendingApplications = await prisma.application.findMany({
            where: { status: "APPROVED", userId: "local" },
            take: remaining,
            include: { job: true },
            orderBy: { createdAt: "asc" },
          });

          await Logger.info("ENGINE", `${pendingApplications.length} applications queued`);

          for (const app of pendingApplications) {
            if (this.stopRequested) break;

            this.state.currentJob = `${app.job.jobTitle} @ ${app.job.companyName}`;
            this.state.currentAction = `Step 4/4: Applying... (${this.state.applicationsSubmitted}/${pendingApplications.length})`;

            await Logger.info("ENGINE", `Applying [${this.state.applicationsSubmitted + 1}/${pendingApplications.length}]: ${app.job.jobTitle} @ ${app.job.companyName}`);

            const success = await this.applyEngine.applyToJob(app.id);
            if (success) {
              this.state.applicationsSubmitted++;
              this.state.applicationsToday++;
              await Logger.success("ENGINE", `Applied: ${app.job.companyName} (${this.state.applicationsSubmitted} total today)`);
            }

            this.state.lastActivity = new Date();
            await saveExcelTracker();

            // Polite delay between applications
            if (this.state.applicationsSubmitted < pendingApplications.length) {
              const waitSec = 10 + Math.floor(Math.random() * 15);
              await Logger.info("ENGINE", `Waiting ${waitSec}s before next application...`);
              await new Promise((r) => setTimeout(r, waitSec * 1000));
            }
          }
        }
      } else {
        await Logger.info("ENGINE", "Manual mode — applications created with PENDING status, awaiting approval in dashboard");
      }

      await Logger.success("ENGINE", `╔══════════════════════════════════════════╗`);
      await Logger.success("ENGINE", `║  Automation cycle COMPLETE               ║`);
      await Logger.success("ENGINE", `║  Scraped:  ${String(this.state.jobsScraped).padEnd(31)}║`);
      await Logger.success("ENGINE", `║  Tailored: ${String(tailored).padEnd(31)}║`);
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
