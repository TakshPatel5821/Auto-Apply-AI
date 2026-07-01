// Continuous discovery — Tsenta's "be the first qualified applicant" promise.
// Instead of a one-shot scrape, this runs the existing ScrapingOrchestrator on a
// fixed interval. Because persistJob() already dedupes against everything seen
// before, any job that comes back as *new and fit* on a later cycle is, by
// definition, a freshly-posted role — so we raise an ALERT for it (persisted to
// the automationLog feed the dashboard already streams, tagged with the jobId).
//
// In-memory singleton (one local user); state resets on server restart, which is
// fine — the dedup lives in the DB, so a restart never re-alerts old jobs.

import { prisma } from "@/lib/db/prisma";
import { Logger } from "@/lib/logging/logger";
import { scrapingOrchestrator } from "./scraping-orchestrator";
import { SearchConfig } from "@/types";

export interface JobAlert {
  jobId: string;
  jobTitle: string;
  companyName: string;
  platform: string;
  matchScore: number;
  url: string;
  foundAt: string;
}

export interface MonitorStatus {
  running: boolean;
  intervalMinutes: number;
  platforms: string[];
  startedAt: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  cycles: number;
  totalNewFit: number;
  cycleInProgress: boolean;
  recentAlerts: JobAlert[];
}

const DEFAULT_INTERVAL_MIN = 30;
const MIN_INTERVAL_MIN = 5; // floor so we never hammer boards
const MAX_ALERTS = 50;

class DiscoveryMonitor {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private cycleInProgress = false;
  private intervalMs = DEFAULT_INTERVAL_MIN * 60_000;
  private platforms: string[] = [];
  private startedAt: number | null = null;
  private lastRunAt: number | null = null;
  private nextRunAt: number | null = null;
  private cycles = 0;
  private totalNewFit = 0;
  private recentAlerts: JobAlert[] = [];

  /** Start (or reconfigure) the monitor. Runs one cycle immediately, then loops. */
  async start(opts: { intervalMinutes?: number; platforms?: string[] } = {}): Promise<MonitorStatus> {
    const minutes = Math.max(MIN_INTERVAL_MIN, opts.intervalMinutes ?? DEFAULT_INTERVAL_MIN);
    this.intervalMs = minutes * 60_000;
    if (opts.platforms?.length) this.platforms = opts.platforms;

    if (this.running) {
      // Already running — just apply the new interval going forward.
      this.scheduleNext();
      await Logger.info("MONITOR", `Discovery monitor reconfigured: every ${minutes}m`);
      return this.status();
    }

    this.running = true;
    this.startedAt = Date.now();
    await Logger.success("MONITOR", `Discovery monitor started — checking every ${minutes}m`);
    // Kick the first cycle without blocking the caller, then schedule the loop.
    void this.runCycle();
    this.scheduleNext();
    return this.status();
  }

  stop(): MonitorStatus {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextRunAt = null;
    void Logger.info("MONITOR", "Discovery monitor stopped");
    return this.status();
  }

  status(): MonitorStatus {
    return {
      running: this.running,
      intervalMinutes: Math.round(this.intervalMs / 60_000),
      platforms: this.platforms,
      startedAt: iso(this.startedAt),
      lastRunAt: iso(this.lastRunAt),
      nextRunAt: iso(this.nextRunAt),
      cycles: this.cycles,
      totalNewFit: this.totalNewFit,
      cycleInProgress: this.cycleInProgress,
      recentAlerts: this.recentAlerts,
    };
  }

  private scheduleNext(): void {
    if (this.timer) clearTimeout(this.timer);
    if (!this.running) return;
    this.nextRunAt = Date.now() + this.intervalMs;
    this.timer = setTimeout(() => {
      void this.runCycle().finally(() => this.scheduleNext());
    }, this.intervalMs);
  }

  /** One discovery pass: scrape, collect freshly-found fit jobs, alert on them. */
  private async runCycle(): Promise<void> {
    if (this.cycleInProgress) return; // a long scrape overran its slot — skip
    this.cycleInProgress = true;
    this.lastRunAt = Date.now();
    this.cycles++;

    try {
      const config = await this.buildConfig();
      const activeResume = await prisma.resume.findFirst({
        where: { userId: "local", isActive: true },
        select: { id: true },
      });
      if (!activeResume) {
        await Logger.warn("MONITOR", "No active resume — skipping discovery cycle");
        return;
      }

      const newFitIds: string[] = [];
      await scrapingOrchestrator.startScraping(config, activeResume.id, (jobId) => {
        newFitIds.push(jobId);
      });

      if (newFitIds.length === 0) {
        await Logger.info("MONITOR", `Cycle ${this.cycles}: no new fit roles`);
        return;
      }

      this.totalNewFit += newFitIds.length;
      const jobs = await prisma.job.findMany({
        where: { id: { in: newFitIds } },
        select: { id: true, jobTitle: true, companyName: true, platform: true, matchScore: true, url: true, applyUrl: true },
      });
      for (const j of jobs) {
        const alert: JobAlert = {
          jobId: j.id,
          jobTitle: j.jobTitle,
          companyName: j.companyName,
          platform: j.platform,
          matchScore: j.matchScore ?? 10,
          url: j.applyUrl || j.url,
          foundAt: new Date().toISOString(),
        };
        this.recentAlerts.unshift(alert);
        // ALERT-category log carries the jobId so the dashboard can deep-link it.
        await Logger.success(
          "ALERT",
          `🔔 New match: ${j.jobTitle} @ ${j.companyName} (${j.matchScore}/10)`,
          { platform: j.platform, url: alert.url },
          j.id
        );
      }
      this.recentAlerts = this.recentAlerts.slice(0, MAX_ALERTS);
    } catch (e) {
      await Logger.error("MONITOR", `Discovery cycle failed: ${String(e).slice(0, 200)}`);
    } finally {
      this.cycleInProgress = false;
    }
  }

  /** Build a SearchConfig from saved user settings (mirrors /api/automation/start). */
  private async buildConfig(): Promise<SearchConfig> {
    const settings = await prisma.userSettings.findUnique({ where: { userId: "local" } });
    const platforms = this.platforms.length
      ? this.platforms
      : settings?.enabledPlatforms?.length
        ? settings.enabledPlatforms
        : ["greenhouse", "lever", "ashby", "workday"];
    this.platforms = platforms;
    return {
      keywords: settings?.searchKeywords?.length
        ? settings.searchKeywords
        : process.env.JOB_SEARCH_KEYWORDS?.split(",").map((k) => k.trim()) || ["Software Engineer"],
      locations: settings?.searchLocations?.length
        ? settings.searchLocations
        : process.env.JOB_SEARCH_LOCATIONS?.split(",").map((l) => l.trim()) || ["Remote"],
      remote: settings?.remoteOnly ?? true,
      hybrid: true,
      onsite: false,
      requireSponsorship: settings?.requireSponsorship ?? false,
      experienceLevels: settings?.experienceLevels?.length ? settings.experienceLevels : ["entry", "mid"],
      platforms,
      maxJobs: 40,
    };
  }
}

function iso(ms: number | null): string | null {
  return ms ? new Date(ms).toISOString() : null;
}

export const discoveryMonitor = new DiscoveryMonitor();
