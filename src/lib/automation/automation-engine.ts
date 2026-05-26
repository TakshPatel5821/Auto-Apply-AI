import { prisma } from "@/lib/db/prisma";
import { scrapingOrchestrator } from "@/lib/scraping/scraping-orchestrator";
import { tailorResumeForJob } from "./resume-tailor";
import { ApplyEngine } from "./apply-engine";
import { Logger } from "@/lib/logging/logger";
import { AutomationState, SearchConfig } from "@/types";
import { getApplicationFolder } from "@/lib/storage/file-manager";

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

    await Logger.info("ENGINE", "Automation started", { mode: config.mode });

    try {
      // Step 1: Scrape jobs
      this.state.currentAction = "Scraping jobs...";
      await scrapingOrchestrator.startScraping(config.searchConfig);

      if (this.stopRequested) return;

      // Step 2: Analyze & score jobs
      this.state.currentAction = "Analyzing jobs...";
      await scrapingOrchestrator.analyzeAndScoreJobs(config.resumeId);

      if (this.stopRequested) return;

      // Step 3: Tailor resumes for best matches
      this.state.currentAction = "Tailoring resumes...";
      const topJobs = await prisma.job.findMany({
        where: {
          status: "ANALYZED",
          matchScore: { lte: 6 },
          isBlacklisted: false,
          isSpam: false,
          isDuplicate: false,
        },
        orderBy: { matchScore: "asc" },
        take: 20,
      });

      for (const job of topJobs) {
        if (this.stopRequested) break;
        try {
          const { tailoredResumeId, coverLetterId } = await tailorResumeForJob(
            config.resumeId,
            job.id
          );

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

          this.state.jobsAnalyzed++;
          this.state.lastActivity = new Date();
        } catch (e) {
          await Logger.error("ENGINE", `Tailoring failed for ${job.companyName}`, { error: String(e) });
        }
      }

      // Step 4: Auto-apply if in auto mode
      if (config.mode === "auto") {
        this.state.currentAction = "Applying to jobs...";
        const maxApps = config.maxApplicationsPerDay || 20;
        const todayCount = await this.getApplicationsToday();

        const pendingApplications = await prisma.application.findMany({
          where: { status: "APPROVED" },
          take: Math.max(0, maxApps - todayCount),
          include: { job: true },
        });

        for (const app of pendingApplications) {
          if (this.stopRequested) break;

          this.state.currentJob = `${app.job.jobTitle} @ ${app.job.companyName}`;
          this.state.currentAction = "Applying...";

          const success = await this.applyEngine.applyToJob(app.id);
          if (success) {
            this.state.applicationsSubmitted++;
            this.state.applicationsToday++;
          }

          this.state.lastActivity = new Date();
          await new Promise((r) => setTimeout(r, 5000 + Math.random() * 10000));
        }
      }

      await Logger.success("ENGINE", "Automation cycle complete", {
        scraped: this.state.jobsScraped,
        analyzed: this.state.jobsAnalyzed,
        applied: this.state.applicationsSubmitted,
      });
    } catch (e) {
      await Logger.error("ENGINE", "Automation failed", { error: String(e) });
    } finally {
      this.state.isRunning = false;
      this.state.currentJob = undefined;
      this.state.currentAction = undefined;
    }
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.state.isRunning = false;
    await Logger.info("ENGINE", "Automation stopped");
  }

  async pause(): Promise<void> {
    this.state.isPaused = true;
    await Logger.info("ENGINE", "Automation paused");
  }

  async resume(): Promise<void> {
    this.state.isPaused = false;
    await Logger.info("ENGINE", "Automation resumed");
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
