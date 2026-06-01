import { chromium, BrowserContext, Page } from "playwright";
import { mkdirSync, existsSync } from "fs";
import { join, isAbsolute } from "path";
import { homedir } from "os";
import { prisma } from "@/lib/db/prisma";
import { findAnswer, saveAnswer, saveHumanAnswer } from "@/lib/storage/memory";
import { Profile, resolveField } from "@/lib/profile/profile";
import { loadProfile } from "@/lib/profile/profile-store";
import { matchDropdownOption, normalizeDegreeLevel } from "@/lib/profile/dropdown-intelligence";
import { getCredentials, Credentials } from "@/lib/security/credentials";
import { rememberedSelector, learnSelector, forgetSelector } from "./selector-memory";
import { claudeAnswerQuestion } from "@/lib/ai/claude";
import { saveScreenshot } from "@/lib/storage/file-manager";

// Résumé PDF paths are stored relative to the project root ("applications/..").
// existsSync on a relative path is cwd-dependent, so resolve to absolute first.
function resolveResumePath(p?: string | null): string | null {
  if (!p) return null;
  const abs = isAbsolute(p) ? p : join(process.cwd(), p);
  return existsSync(abs) ? abs : null;
}

// Field classification + value validation now live in ./field-classifier
// (Phase 1). The engine consumes classifyField/validateValue/decideFill below.
import { Logger } from "@/lib/logging/logger";
import { scraperStatus } from "./scraper-status";
import { detectAts, AtsAdapter } from "./ats-adapters";
import {
  classifyField,
  validateValue,
  decideFill,
  isSensitive,
  aiMayAnswer,
} from "./field-classifier";

type ApplicationWithRelations = Awaited<ReturnType<typeof getApplicationWithRelations>>;

async function getApplicationWithRelations(id: string) {
  return prisma.application.findUnique({
    where: { id },
    include: {
      job: true,
      tailoredResume: { select: { pdfPath: true, texPath: true } },
      coverLetter: { select: { pdfPath: true, content: true } },
      resume: { select: { parsedData: true } },
    },
  });
}

interface DetectedField {
  type: string;
  label: string;
  name?: string;
  required: boolean;
  options?: string[];
  selector: string;
}

const STEALTH_SCRIPT = () => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  (window as unknown as Record<string, unknown>).chrome = {
    app: { isInstalled: false, InstallState: {}, RunningState: {} },
    runtime: { id: "x", connect: () => ({ onMessage: { addListener: () => {} }, postMessage: () => {}, disconnect: () => {} }), sendMessage: () => {}, onMessage: { addListener: () => {}, removeListener: () => {}, hasListeners: () => false }, onConnect: { addListener: () => {}, removeListener: () => {}, hasListeners: () => false }, lastError: undefined },
    loadTimes: () => ({}), csi: () => ({}),
  };
  const fakePlugins = [
    { name: "Chrome PDF Plugin", filename: "internal-pdf-viewer", description: "Portable Document Format" },
    { name: "Chrome PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai", description: "" },
    { name: "Native Client", filename: "internal-nacl-plugin", description: "" },
  ] as unknown as PluginArray;
  Object.defineProperty(navigator, "plugins", { get: () => fakePlugins });
  Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
  try { Object.defineProperty(navigator, "deviceMemory", { get: () => 8 }); } catch { /* ignore */ }
  Object.defineProperty(navigator, "maxTouchPoints", { get: () => 0 });
  try {
    const origQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (params) =>
      (params as PermissionDescriptor).name === "notifications"
        ? Promise.resolve({ state: Notification.permission, onchange: null } as PermissionStatus)
        : origQuery(params);
  } catch { /* ignore */ }
  try {
    const origGetParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (p: number) {
      if (p === 37445) return "Intel Inc.";
      if (p === 37446) return "Intel Iris OpenGL Engine";
      return origGetParam.call(this, p);
    };
  } catch { /* ignore */ }
  try { Object.defineProperty(screen, "colorDepth", { get: () => 24 }); } catch { /* ignore */ }
  try { Object.defineProperty(screen, "pixelDepth", { get: () => 24 }); } catch { /* ignore */ }
};

export class ApplyEngine {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  // The current form scope being filled — used when capturing human-entered data.
  private currentScope = "body";
  // Structured Profile (V2) — loaded once per apply run; the deterministic,
  // compliance-safe source for identity/contact/visa/education fields.
  private profile: Profile = {};
  // Decrypted credentials for this run (from the encrypted store, .env fallback).
  private creds: Credentials = { linkedinEmail: "", linkedinPassword: "", atsEmail: "", atsPassword: "" };
  // Failure-recovery (#19): current application + in-memory action log for this run.
  private currentApplicationId: string | null = null;
  private actionLog: { t: string; action: string; target?: string; detail?: string }[] = [];
  // True once we've actually clicked a final Submit this run. Success can ONLY be
  // declared after this — prevents false positives from job-page URLs/copy that
  // happen to contain words like "applied" or "thank you for your interest".
  private submitClicked = false;

  // ─── Browser lifecycle ──────────────────────────────────────────────────────

  private async init(platform: string): Promise<void> {
    const profileDir = join(homedir(), ".job-agent-profiles", platform);
    mkdirSync(profileDir, { recursive: true });

    await Logger.info("APPLY", `Launching browser with profile: ${platform}`);

    const baseOpts = {
      headless: false,
      slowMo: 80,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1920, height: 1080 },
      locale: "en-US",
      timezoneId: "America/New_York",
    };

    try {
      this.context = await chromium.launchPersistentContext(profileDir, {
        ...baseOpts,
        channel: "msedge",
        args: [
          "--disable-blink-features=AutomationControlled",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-infobars",
          "--start-maximized",
        ],
      });
    } catch {
      await Logger.warn("APPLY", "Edge launch failed, falling back to Chromium");
      this.context = await chromium.launchPersistentContext(profileDir, {
        ...baseOpts,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-blink-features=AutomationControlled",
          "--no-first-run",
          "--start-maximized",
        ],
      });
    }

    await this.context.addInitScript(STEALTH_SCRIPT);

    // Reuse existing blank page if any, otherwise create one
    const pages = this.context.pages();
    this.page = pages.length > 0 ? pages[0] : await this.context.newPage();
  }

  private async cleanup(): Promise<void> {
    try {
      await this.context?.close();
    } catch { /* ignore */ }
    this.page = null;
    this.context = null;
  }

  private delay(min: number, max: number): Promise<void> {
    return new Promise((r) => setTimeout(r, Math.floor(Math.random() * (max - min) + min)));
  }

  // ─── Failure recovery / replay (#19) ──────────────────────────────────────────

  // Append an action to the in-memory log (persisted on checkpoint/failure).
  private logAction(action: string, target?: string, detail?: string): void {
    this.actionLog.push({ t: new Date().toISOString(), action, target, detail });
    if (this.actionLog.length > 200) this.actionLog.shift(); // bound it
  }

  // Persist a recoverable checkpoint: where we are + the action log so far. On a
  // later retry we can fast-forward to this URL/phase instead of starting over.
  private async checkpoint(phase: string, extra?: Record<string, unknown>): Promise<void> {
    if (!this.currentApplicationId) return;
    const url = (() => { try { return this.page?.url() || ""; } catch { return ""; } })();
    await prisma.application.update({
      where: { id: this.currentApplicationId },
      data: {
        recoveryState: { url, phase, ts: new Date().toISOString(), ...(extra || {}) } as object,
        actionLog: this.actionLog as object,
      },
    }).catch(() => {});
  }

  // ─── Session pre-warm ─────────────────────────────────────────────────────────

  // Log into account-gated ATS portals ONCE at the start of a batch so every
  // later apply in the run is already authenticated (the session persists in the
  // browser profile). Best-effort + non-fatal. Currently warms Greenhouse's
  // candidate portal (my.greenhouse.io). Skips silently if no ATS creds are set.
  async prewarmLogins(): Promise<void> {
    this.creds = await getCredentials().catch(() => this.creds);
    const email = this.creds.atsEmail || this.creds.linkedinEmail;
    const password = this.creds.atsPassword || this.creds.linkedinPassword;
    if (!email || !password) {
      await Logger.info("APPLY", "Skipping login pre-warm — no ATS credentials set");
      return;
    }

    const portals = [
      { id: "greenhouse", label: "Greenhouse", url: "https://my.greenhouse.io/dashboard" },
    ];
    // A scraped Greenhouse job applies in the "linkedin" profile if it came from
    // LinkedIn, or "apply" otherwise. Sessions are per-profile, so warm both.
    const profiles = ["linkedin", "apply"];

    for (const profile of profiles) {
      try {
        await this.init(profile);
        for (const p of portals) {
          try {
            await Logger.info("APPLY", `Pre-warming ${p.label} session (${profile} profile)…`);
            await this.page!.goto(p.url, { waitUntil: "domcontentloaded", timeout: 25000 });
            await this.delay(1500, 2500);
            await this.dismissPopups();
            // Already signed in? No password field → done.
            const gated = await this.page!.$('input[type="password"]').catch(() => null);
            if (!gated || !(await gated.isVisible().catch(() => false))) {
              await Logger.success("APPLY", `${p.label} already signed in (${profile})`);
              continue;
            }
            const ok = await this.handleLoginWallIfPresent({ id: p.id, label: p.label } as AtsAdapter);
            if (!ok) {
              await Logger.warn("APPLY", `${p.label} pre-warm needs manual login (2FA/captcha?) — continuing anyway`);
            }
          } catch (e) {
            await Logger.warn("APPLY", `${p.label} pre-warm error (non-fatal): ${e}`);
          }
        }
      } catch (e) {
        await Logger.warn("APPLY", `Login pre-warm could not start for ${profile} (non-fatal): ${e}`);
      } finally {
        await this.cleanup();
      }
    }
  }

  // ─── Public entry point ──────────────────────────────────────────────────────

  async applyToJob(applicationId: string): Promise<boolean> {
    const application = await getApplicationWithRelations(applicationId);
    if (!application) throw new Error("Application not found");

    // Load the structured profile + decrypted credentials once for this run.
    this.profile = await loadProfile().catch(() => ({}));
    this.creds = await getCredentials().catch(() => this.creds);

    // Recovery (#19): track this application + carry forward prior action log.
    this.currentApplicationId = applicationId;
    this.submitClicked = false;
    this.actionLog = Array.isArray(application.actionLog)
      ? (application.actionLog as { t: string; action: string; target?: string; detail?: string }[])
      : [];
    const recovery = application.recoveryState as { url?: string; phase?: string } | null;
    if (recovery?.phase && application.retryCount > 0) {
      await Logger.info("APPLY", `↻ Retry — last checkpoint: ${recovery.phase}${recovery.url ? ` @ ${recovery.url}` : ""}`);
    }
    this.logAction("run_start", undefined, `retry=${application.retryCount}`);

    const { job } = application;
    await Logger.info("APPLY", `╔═══════════════════════════════════════════════`);
    await Logger.info("APPLY", `║ Applying: ${job.jobTitle}`);
    await Logger.info("APPLY", `║ Company: ${job.companyName}`);
    await Logger.info("APPLY", `║ Platform: ${job.platform}${job.isEasyApply ? " (Easy Apply)" : ""}`);
    await Logger.info("APPLY", `╚═══════════════════════════════════════════════`);

    await prisma.application.update({ where: { id: applicationId }, data: { status: "IN_PROGRESS" } });
    await prisma.job.update({ where: { id: job.id }, data: { status: "APPLYING" } });

    const resumePdfPath = resolveResumePath(application.tailoredResume?.pdfPath);
    if (resumePdfPath) {
      await Logger.info("APPLY", `Resume PDF ready: ${resumePdfPath}`);
    } else {
      await Logger.warn("APPLY", `No PDF resume available (path: ${application.tailoredResume?.pdfPath || "none"}) — apply will try without upload`);
    }

    try {
      await this.init(job.platform === "linkedin" ? "linkedin" : "apply");

      let success: boolean;
      if (job.platform === "linkedin") {
        success = await this.applyLinkedIn(application);
      } else {
        success = await this.applyExternalSite(application);
      }

      if (success) {
        this.logAction("submitted");
        await prisma.application.update({
          where: { id: applicationId },
          data: {
            status: "SUBMITTED",
            appliedAt: new Date(),
            recoveryState: { phase: "submitted", ts: new Date().toISOString() } as object,
            actionLog: this.actionLog as object,
          },
        });
        await prisma.job.update({ where: { id: job.id }, data: { status: "APPLIED" } });
        await Logger.success("APPLY", `✓✓✓ Application submitted: ${job.companyName} — ${job.jobTitle}`);
        return true;
      } else {
        throw new Error("Application submission did not complete");
      }
    } catch (e) {
      this.logAction("failed", undefined, String(e).slice(0, 200));
      const url = (() => { try { return this.page?.url() || ""; } catch { return ""; } })();
      await prisma.application.update({
        where: { id: applicationId },
        data: {
          status: "FAILED",
          error: String(e),
          retryCount: { increment: 1 },
          recoveryState: { phase: "failed", url, ts: new Date().toISOString() } as object,
          actionLog: this.actionLog as object,
        },
      });
      await prisma.job.update({ where: { id: job.id }, data: { status: "FAILED" } });
      await Logger.error("APPLY", `✗ Application failed: ${job.jobTitle} @ ${job.companyName}: ${e}`);
      return false;
    } finally {
      // Pause before closing so user can see the result
      await this.delay(2000, 3000);
      await this.cleanup();
      this.currentApplicationId = null;
    }
  }

  // ─── LinkedIn unified flow ──────────────────────────────────────────────────

  private async applyLinkedIn(application: NonNullable<ApplicationWithRelations>): Promise<boolean> {
    const { job } = application;
    const jobUrl = job.url.includes("linkedin.com")
      ? job.url
      : `https://www.linkedin.com/jobs/view/${job.platformJobId}/`;

    // Step 1: Navigate
    await Logger.info("APPLY", `Step 1/6: Opening LinkedIn job page`);
    await this.page!.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
    await this.delay(3000, 5000);
    await this.dismissPopups();
    await this.takeStepScreenshot(application.folderPath, "1-job-page");

    // Step 2: Check if already applied
    const alreadyApplied = await this.page!.evaluate(() => {
      const txt = document.body.innerText.toLowerCase();
      return txt.includes("application submitted") ||
             txt.includes("you've applied to this") ||
             !!document.querySelector(".jobs-apply-button--applied, .artdeco-inline-feedback--success");
    }).catch(() => false);

    if (alreadyApplied) {
      await Logger.warn("APPLY", "Already applied to this job");
      return false;
    }

    // Step 3: Find the primary apply button and read its text to decide flow
    await Logger.info("APPLY", "Step 2/6: Locating Apply button...");
    const buttonInfo = await this.findLinkedInApplyButton();

    if (!buttonInfo) {
      await Logger.error("APPLY", "No Apply button found on LinkedIn job page");
      await this.takeStepScreenshot(application.folderPath, "2-no-button");
      return false;
    }

    await Logger.info("APPLY", `Step 3/6: Found "${buttonInfo.text}" button — using ${buttonInfo.isEasyApply ? "Easy Apply" : "External Apply"} flow`);
    this.logAction("apply_button", buttonInfo.isEasyApply ? "easy-apply" : "external");
    await this.checkpoint(buttonInfo.isEasyApply ? "linkedin-easy-apply" : "linkedin-external");

    if (buttonInfo.isEasyApply) {
      return this.runEasyApplyFlow(application, buttonInfo.selector);
    } else {
      return this.runExternalApplyFlow(application, buttonInfo.selector);
    }
  }

  // Find the apply button on a LinkedIn page and tell us if it's Easy Apply.
  // NOTE: LinkedIn's external "Apply" control is a plain <a> (external-link icon),
  // often WITHOUT role="button", and the button also renders async — so we wait
  // for it and scan both <button> and <a> elements.
  private async findLinkedInApplyButton(): Promise<{ selector: string; text: string; isEasyApply: boolean } | null> {
    // Wait for any apply control to render before scanning.
    await this.page!.waitForSelector(
      '.jobs-apply-button, button[aria-label*="Apply"], a[aria-label*="Apply"], button[aria-label*="Easy Apply"]',
      { timeout: 12000 }
    ).catch(() => null);

    return this.page!.evaluate(() => {
      const norm = (s: string) => (s || "").replace(/\s+/g, " ").trim();
      const els = Array.from(document.querySelectorAll("button, a")) as HTMLElement[];

      for (const b of els) {
        if ((b as HTMLButtonElement).disabled) continue;
        // Visible only (skip 0-size / hidden controls).
        const rect = b.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;

        const aria = b.getAttribute("aria-label") || "";
        const text = norm(b.innerText + " " + aria);
        const lower = text.toLowerCase();

        const isApplyClass =
          b.classList.contains("jobs-apply-button") || !!b.closest(".jobs-apply-button");
        // Accessible name starts with "apply"/"easy apply", or it's the apply-button widget.
        const looksApply =
          isApplyClass || lower.startsWith("apply") || /\beasy apply\b/.test(lower);
        if (!looksApply) continue;
        // Exclude look-alikes (counts, AI helpers, save/share/alerts).
        if (/(save|share|follow|set alert|clicked apply|tailor|cover letter|match details|stand out|report)/.test(lower)) {
          continue;
        }

        // Build a usable selector.
        const tag = b.tagName.toLowerCase();
        const id = b.id ? `#${CSS.escape(b.id)}` : "";
        let selector = id;
        if (!selector && aria) selector = `${tag}[aria-label="${aria.replace(/"/g, '\\"')}"]`;
        if (!selector && isApplyClass) selector = ".jobs-apply-button";
        if (!selector) {
          const all = Array.from(document.querySelectorAll(tag));
          const idx = all.indexOf(b);
          if (idx >= 0) selector = `${tag}:nth-of-type(${idx + 1})`;
        }
        if (!selector) continue;

        return { selector, text: text.slice(0, 80), isEasyApply: /\beasy apply\b/.test(lower) };
      }
      return null;
    });
  }

  // ─── Easy Apply modal flow ──────────────────────────────────────────────────

  private async runEasyApplyFlow(application: NonNullable<ApplicationWithRelations>, buttonSelector: string): Promise<boolean> {
    await Logger.info("APPLY", "Step 4/6: Clicking Easy Apply button...");
    try {
      await this.page!.click(buttonSelector, { timeout: 8000 });
    } catch (e) {
      await Logger.warn("APPLY", `Click failed (${e}) — retrying with locator`);
      await this.page!.locator(buttonSelector).first().click({ timeout: 8000 });
    }
    await this.delay(2000, 3500);

    // Wait for modal
    const modal = await this.page!.waitForSelector(
      '.jobs-easy-apply-modal, [data-test-modal="jobs-apply-modal"], .artdeco-modal[role="dialog"]',
      { timeout: 15000 }
    ).catch(() => null);

    if (!modal) {
      await Logger.error("APPLY", "Easy Apply modal did not open");
      await this.takeStepScreenshot(application.folderPath, "4-no-modal");
      return false;
    }

    await Logger.success("APPLY", "Step 5/6: Easy Apply modal opened");
    await this.takeStepScreenshot(application.folderPath, "5-modal-open");

    // Loop through multi-step form
    let maxSteps = 15;
    while (maxSteps-- > 0) {
      await this.delay(1000, 1800);

      // Success state?
      const successEl = await this.page!.$('.artdeco-inline-feedback--success, [data-test-modal-id="easy-apply-success-modal"], h2:has-text("Your application was sent")').catch(() => null);
      if (successEl) {
        await Logger.success("APPLY", "Application submitted successfully!");
        await this.takeStepScreenshot(application.folderPath, "6-success");
        return true;
      }

      // Modal closed without success?
      const modalStillOpen = await this.page!.$('.jobs-easy-apply-modal, .artdeco-modal[role="dialog"]').catch(() => null);
      if (!modalStillOpen) {
        await Logger.warn("APPLY", "Modal closed — assuming submitted");
        return true;
      }

      // Handle LinkedIn email field — ensure it's set to the correct email
      await this.setLinkedInEmailField(this.creds.linkedinEmail || this.creds.atsEmail);

      // Upload resume if there's a file input
      await this.uploadResumeIfVisible(application);

      // Attach the job-specific cover letter if this step asks for one
      await this.attachCoverLetterIfRequested(application);

      // Fill all form fields inside the modal
      await this.fillVisibleFields(application, '.jobs-easy-apply-modal, .artdeco-modal');

      await this.delay(700, 1100);

      // Find action button (Submit > Review > Next/Continue)
      const submitBtn = await this.page!.$('button[aria-label="Submit application"], button[aria-label*="Submit application"]').catch(() => null);
      if (submitBtn && await submitBtn.isVisible().catch(() => false)) {
        await Logger.info("APPLY", "Clicking Submit application");
        await this.takeStepScreenshot(application.folderPath, `step-${15 - maxSteps}-pre-submit`);
        await submitBtn.click();
        await this.delay(4000, 6000);
        continue; // Loop will detect success or closed modal
      }

      const reviewBtn = await this.page!.$('button[aria-label="Review your application"], button[aria-label*="Review"]').catch(() => null);
      if (reviewBtn && await reviewBtn.isVisible().catch(() => false)) {
        await Logger.info("APPLY", "Clicking Review your application");
        await reviewBtn.click();
        await this.delay(1500, 2500);
        continue;
      }

      const nextBtn = await this.page!.$(
        'button[aria-label="Continue to next step"], button[aria-label*="Continue"], button[aria-label*="Next"]'
      ).catch(() => null);
      if (nextBtn && await nextBtn.isVisible().catch(() => false)) {
        await Logger.info("APPLY", "Clicking Continue to next step");
        await nextBtn.click();
        await this.delay(1500, 2500);
        continue;
      }

      // No automated path forward — ask the user to nudge it, then auto-resume.
      await Logger.warn("APPLY", "No next/submit button found in modal — asking you to continue");
      await this.takeStepScreenshot(application.folderPath, "stuck");
      const progressed = await this.pauseForHumanThenCapture(
        application,
        ".jobs-easy-apply-modal, .artdeco-modal",
        "Easy Apply is stuck — fill the field or click the button in the browser and I'll continue"
      );
      if (!progressed) return false;
      // Loop continues: re-scan modal for success / next step.
    }

    await Logger.warn("APPLY", "Easy Apply ran too many steps without finishing");
    return false;
  }

  // ─── External Apply flow ────────────────────────────────────────────────────

  private async runExternalApplyFlow(application: NonNullable<ApplicationWithRelations>, buttonSelector: string): Promise<boolean> {
    const startUrl = this.page!.url();

    await Logger.info("APPLY", "Step 4/6: Setting up new-tab listener and clicking Apply...");

    // Listen for a new page being created when we click
    const newPagePromise = this.context!.waitForEvent("page", { timeout: 8000 }).catch(() => null);

    try {
      await this.page!.click(buttonSelector, { timeout: 8000 });
    } catch (e) {
      await Logger.warn("APPLY", `Click failed (${e}) — retrying`);
      await this.page!.locator(buttonSelector).first().click({ timeout: 8000 }).catch(() => {});
    }

    await this.delay(3000, 5000);

    // Did a new tab open?
    const newPage = await newPagePromise;
    if (newPage) {
      await Logger.info("APPLY", `New tab opened: ${newPage.url()}`);
      await newPage.bringToFront();
      try {
        await newPage.waitForLoadState("domcontentloaded", { timeout: 15000 });
      } catch { /* ignore */ }
      this.page = newPage;
      await this.delay(2000, 3000);
      return this.fillExternalForm(application);
    }

    // Did the same page navigate to an external site?
    const nowUrl = this.page!.url();
    if (nowUrl !== startUrl && !nowUrl.includes("linkedin.com/jobs/view")) {
      await Logger.info("APPLY", `Page navigated to: ${nowUrl}`);
      await this.delay(2000, 3000);
      return this.fillExternalForm(application);
    }

    // Did a modal open on the same page?
    const modal = await this.page!.$('[role="dialog"], .modal, .artdeco-modal').catch(() => null);
    if (modal && await modal.isVisible().catch(() => false)) {
      await Logger.info("APPLY", "Modal opened on same page");
      return this.fillExternalForm(application, '[role="dialog"], .modal, .artdeco-modal');
    }

    await Logger.error("APPLY", "Clicked Apply but nothing happened (no new tab, no nav, no modal)");
    await this.takeStepScreenshot(application.folderPath, "no-response");
    return false;
  }

  // ─── Generic external site flow ────────────────────────────────────────────

  private async applyExternalSite(application: NonNullable<ApplicationWithRelations>): Promise<boolean> {
    const url = application.job.easyApplyUrl || application.job.applyUrl || application.job.url;
    await Logger.info("APPLY", `Step 1/4: Navigating to ${url}`);
    await this.page!.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await this.delay(2500, 4000);
    await this.dismissPopups();

    // Some pages need an initial "Apply" button click before the form appears
    const landingApply = await this.page!.$(
      'a:has-text("Apply for this job"), a:has-text("Apply now"), button:has-text("Apply for this job"), button:has-text("Apply Now"), a:has-text("Apply"), button:has-text("Apply")'
    ).catch(() => null);

    if (landingApply && await landingApply.isVisible().catch(() => false)) {
      await Logger.info("APPLY", "Step 2/4: Clicking landing Apply button...");
      const newPagePromise = this.context!.waitForEvent("page", { timeout: 5000 }).catch(() => null);
      await landingApply.click({ timeout: 5000 }).catch(() => {});
      await this.delay(2500, 4000);
      const newPage = await newPagePromise;
      if (newPage) {
        await newPage.bringToFront();
        await newPage.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
        this.page = newPage;
      }
      await this.dismissPopups();
    }

    return this.fillExternalForm(application);
  }

  // ─── Fill any external apply form ──────────────────────────────────────────

  private async fillExternalForm(
    application: NonNullable<ApplicationWithRelations>,
    scope: string = "body"
  ): Promise<boolean> {
    await Logger.info("APPLY", `Step 5/6: Filling external form on ${this.page!.url()}`);
    await this.delay(2000, 3000);

    // Check if we're redirected to LinkedIn login
    const currentUrl = this.page!.url();
    if (currentUrl.includes("linkedin.com/login") || currentUrl.includes("linkedin.com/uas/login")) {
      await Logger.info("APPLY", "Redirected to LinkedIn login — attempting to login");
      const loginSuccess = await this.handleLinkedInLogin();
      if (!loginSuccess) {
        await Logger.error("APPLY", "LinkedIn login failed");
        await this.takeStepScreenshot(application.folderPath, "linkedin-login-failed");
        return false;
      }
      await this.delay(3000, 4000);
    }

    await this.dismissPopups();

    // Wait for content to load (handles iframes, lazy loading, etc.)
    await this.page!.waitForLoadState("networkidle").catch(() => null);
    await this.delay(1500, 2500);

    await this.takeStepScreenshot(application.folderPath, "external-form");

    // Identify the ATS template so we can use platform-specific selectors.
    const url = this.page!.url();
    const ats = detectAts(url);
    if (ats) {
      await Logger.info("APPLY", `Detected ATS: ${ats.label}${ats.notes ? ` — ${ats.notes}` : ""}`);
    } else {
      await Logger.info("APPLY", "Unknown ATS template — using generic handler");
    }

    // Workday has its own multi-step auth+form flow.
    if (ats?.requiresLogin && (ats.id === "workday")) {
      return this.fillWorkdayForm(application);
    }

    // Generic login wall (Greenhouse candidate portal, Dice, etc.): if the page
    // is gated behind a sign-in form, authenticate with stored ATS creds and
    // continue. Handles my.greenhouse.io and any board that prompts a login.
    await this.handleLoginWallIfPresent(ats);

    // ── Multi-step form loop ──────────────────────────────────────────────────
    // External ATS forms (iCIMS, ADP, Greenhouse, Lever, etc.) commonly have
    // several sections: Resume → Contact → Eligibility → Self-ID → Submit. We
    // walk each step, filling fields and clicking "Next"/"Save & Go to Next
    // Section" until we reach a real Submit. We ONLY report success on a
    // genuine confirmation — never assume. If we get stuck (validation errors,
    // unknown buttons), we hand off to the human instead of faking a submit.
    const MAX_STEPS = 8;
    for (let step = 1; step <= MAX_STEPS; step++) {
      await this.dismissPopups();

      // Did a previous click already land us on a confirmation page?
      if (await this.detectSuccessPage(ats)) {
        await Logger.success("APPLY", "Submission confirmed!");
        return true;
      }

      await Logger.info("APPLY", `Form step ${step}: filling fields...`);
      this.logAction("form_step", `step ${step}`);
      await this.checkpoint(`external-step-${step}`, { ats: ats?.id });
      await this.uploadResumeIfVisible(application, ats);
      await this.attachCoverLetterIfRequested(application);
      const unfilled = await this.fillVisibleFields(application, scope);
      await this.delay(700, 1200);
      await this.takeStepScreenshot(application.folderPath, `step-${step}-filled`);

      // If we couldn't answer some fields, STOP here and let the user fill them.
      // We auto-detect their input and continue — no Resume button needed.
      if (unfilled.length > 0) {
        const progressed = await this.pauseForHumanThenCapture(
          application,
          scope,
          `Fill these in the browser then I'll continue: ${unfilled.slice(0, 6).join(", ")}`
        );
        if (!progressed) break; // timed out
        continue;              // re-scan: their answers are now filled/saved
      }

      const sigBefore = await this.pageSignature();

      // Prefer a real final-submit button; otherwise advance to the next step.
      let action: "submit" | "advance" | null = null;
      if (await this.clickFinalSubmit(ats)) {
        action = "submit";
      } else if (await this.clickAdvance(ats)) {
        action = "advance";
      }

      if (!action) {
        await Logger.warn("APPLY", "No Submit or Next button found — asking you to continue in the browser");
        await this.takeStepScreenshot(application.folderPath, `step-${step}-no-button`);
        const progressed = await this.pauseForHumanThenCapture(
          application, scope,
          "I can't find the next/submit button — click it (or fill remaining fields) in the browser and I'll continue"
        );
        if (!progressed) break;
        continue;
      }

      await Logger.info("APPLY", `Clicked ${action === "submit" ? "Submit" : "Next/Continue"} — waiting...`);
      await this.delay(3000, 5000);
      await this.takeStepScreenshot(application.folderPath, `step-${step}-after-${action}`);

      // Real confirmation? Done.
      if (await this.detectSuccessPage(ats)) {
        await Logger.success("APPLY", "Submission confirmed!");
        return true;
      }

      // Did the page actually change? If not, we're stuck (likely a validation
      // error on a field we couldn't fill). Pause for the human, then resume.
      const sigAfter = await this.pageSignature();
      if (sigAfter === sigBefore) {
        await Logger.warn("APPLY", `Form did not advance after ${action} — probably a required field I missed.`);
        await this.takeStepScreenshot(application.folderPath, `step-${step}-stuck`);
        const progressed = await this.pauseForHumanThenCapture(
          application, scope,
          "Form didn't advance — please fix/fill the highlighted fields in the browser and I'll continue"
        );
        if (!progressed) break;
        continue;
      }
      // Page advanced to a new step — continue the loop.
    }

    // Exhausted steps without confirmation. Final honest fallback.
    return this.waitForHumanTakeover(
      application,
      `Finish & submit "${application.job.jobTitle}" @ ${application.job.companyName} in the browser, then click Resume`
    );
  }

  // Workday-specific flow. Each company has its OWN Workday tenant, so we either
  // sign in (if an account exists on this tenant) or create one — automatically,
  // with ATS_EMAIL/ATS_PASSWORD. Then we run the normal multi-step loop. Only if
  // auth genuinely fails do we hand off to the human.
  private async fillWorkdayForm(application: NonNullable<ApplicationWithRelations>): Promise<boolean> {
    await Logger.info("APPLY", "Workday detected — attempting automated sign-in / account creation.");

    // Step into the application: Workday job pages show an "Apply" then an
    // "Apply Manually" / "Autofill with Resume" choice before the auth screen.
    await this.workdayClickInto();

    const authed = await this.handleWorkdayAuth();
    if (authed) {
      await Logger.success("APPLY", "Workday account ready — continuing with the form");
      // Reuse the generic multi-step loop now that we're past the gate.
      return this.runWorkdayFormLoop(application);
    }

    // Auth couldn't be completed automatically (verification email, captcha,
    // security question, etc.) — pre-fill what we can and hand off honestly.
    await Logger.warn("APPLY", "Couldn't complete Workday auth automatically — handing to you.");
    await this.uploadResumeIfVisible(application).catch(() => {});
    await this.fillVisibleFields(application, "body").catch(() => {});
    return this.waitForHumanTakeover(
      application,
      `Finish Workday sign-in/submit for "${application.job.jobTitle}" @ ${application.job.companyName}, then click "I submitted it" / Resume`,
      10 * 60 * 1000
    );
  }

  // Click through the Workday landing → manual-apply screen to reach the auth form.
  private async workdayClickInto(): Promise<void> {
    const entrySelectors = [
      '[data-automation-id="adventureButton"]',          // "Apply"
      'a[data-automation-id="applyManually"]',           // "Apply Manually"
      'button[data-automation-id="applyManually"]',
      'a:has-text("Apply Manually")',
      'button:has-text("Apply Manually")',
      'a:has-text("Apply")',
    ];
    for (const sel of entrySelectors) {
      const btn = await this.page!.$(sel).catch(() => null);
      if (btn && await btn.isVisible().catch(() => false)) {
        await btn.click({ timeout: 4000 }).catch(() => {});
        await this.delay(1500, 2500);
      }
    }
  }

  // Try to sign in; if that fails (no account on this tenant), create one.
  // Returns true once we're authenticated (past the login screen).
  private async handleWorkdayAuth(): Promise<boolean> {
    const email = this.creds.atsEmail || this.creds.linkedinEmail || "";
    const password = this.creds.atsPassword || this.creds.linkedinPassword || "";
    if (!email || !password) {
      await Logger.warn("APPLY", "No ATS_EMAIL/ATS_PASSWORD set — cannot auto-auth Workday");
      return false;
    }

    // Is there even a login form? If not, we may already be in.
    const emailField = await this.page!.$(
      'input[data-automation-id="email"], input[data-automation-id="userName"], input[type="email"]'
    ).catch(() => null);
    if (!emailField) {
      // No login form visible — assume we're past the gate.
      return true;
    }

    // ── Attempt 1: SIGN IN ──────────────────────────────────────────────────
    await Logger.info("APPLY", `Workday: trying sign-in as ${email}`);
    await this.workdayFillCreds(email, password, /*verify*/ false);
    await this.clickFirstVisible(
      [
        '[data-automation-id="signInSubmitButton"]',
        'button[data-automation-id="click_filter"]',
        'button:has-text("Sign In")',
        'button[type="submit"]',
      ],
      "Workday Sign In"
    );
    await this.delay(3500, 5000);

    if (await this.workdayIsAuthed()) return true;

    // ── Attempt 2: CREATE ACCOUNT ───────────────────────────────────────────
    await Logger.info("APPLY", "Workday: sign-in didn't take — trying to create an account");
    // Switch to the create-account view if there's a toggle link.
    await this.clickFirstVisible(
      [
        '[data-automation-id="createAccountLink"]',
        'button[data-automation-id="createAccountLink"]',
        'a:has-text("Create Account")',
        'button:has-text("Create Account")',
      ],
      "Workday → Create Account"
    );
    await this.delay(1200, 2000);

    await this.workdayFillCreds(email, password, /*verify*/ true);
    // Accept the create-account terms checkbox if present.
    const terms = await this.page!.$(
      'input[data-automation-id="createAccountCheckbox"], input[type="checkbox"]'
    ).catch(() => null);
    if (terms) await this.toggleCheckable(terms, true).catch(() => {});

    await this.clickFirstVisible(
      [
        '[data-automation-id="createAccountSubmitButton"]',
        'button:has-text("Create Account")',
        'button[type="submit"]',
      ],
      "Workday Create Account"
    );
    await this.delay(3500, 5000);

    return this.workdayIsAuthed();
  }

  // Fill Workday email/password (+ verify-password on the create-account form).
  private async workdayFillCreds(email: string, password: string, verify: boolean): Promise<void> {
    const emailSel = 'input[data-automation-id="email"], input[data-automation-id="userName"], input[type="email"]';
    const passSel = 'input[data-automation-id="password"], input[type="password"]:not([data-automation-id="verifyPassword"])';
    const emailEl = await this.page!.$(emailSel).catch(() => null);
    if (emailEl) { await emailEl.fill(email).catch(() => {}); await this.delay(300, 600); }
    const passEl = await this.page!.$(passSel).catch(() => null);
    if (passEl) { await passEl.fill(password).catch(() => {}); await this.delay(300, 600); }
    if (verify) {
      const verifyEl = await this.page!.$('input[data-automation-id="verifyPassword"]').catch(() => null);
      if (verifyEl) { await verifyEl.fill(password).catch(() => {}); await this.delay(300, 600); }
    }
  }

  // Authenticated when the login form is gone and no auth error is shown.
  private async workdayIsAuthed(): Promise<boolean> {
    await this.delay(800, 1200);
    const stillLogin = await this.page!.$(
      'input[data-automation-id="password"], [data-automation-id="signInSubmitButton"], [data-automation-id="createAccountSubmitButton"]'
    ).catch(() => null);
    if (!stillLogin) return true;
    // An error banner (wrong password, account exists, invalid) means not authed.
    const err = await this.page!.evaluate(() => {
      const t = document.body.innerText.toLowerCase();
      return (
        t.includes("incorrect") || t.includes("invalid") ||
        t.includes("does not match") || t.includes("already exists") ||
        t.includes("verify your email") || t.includes("check your email")
      );
    }).catch(() => false);
    return !err && !stillLogin;
  }

  // Generic sign-in handler for ATS pages gated behind a login (Greenhouse
  // candidate portal `my.greenhouse.io`, Dice, etc.). If a password field is
  // visible, fills email+password from stored ATS creds and submits. Best-effort
  // and non-fatal — if it can't log in, the normal flow / human takeover follows.
  private async handleLoginWallIfPresent(ats?: AtsAdapter | null): Promise<boolean> {
    const pw = await this.page!.$('input[type="password"]').catch(() => null);
    if (!pw || !(await pw.isVisible().catch(() => false))) return false;

    const email = this.creds.atsEmail || this.creds.linkedinEmail;
    const password = this.creds.atsPassword || this.creds.linkedinPassword;
    if (!email || !password) {
      await Logger.warn("APPLY", "Login wall detected but no ATS credentials set — skipping auto-login");
      return false;
    }

    await Logger.info("APPLY", `Login wall detected (${ats?.label || "site"}) — signing in as ${email}`);
    this.logAction("login_wall", ats?.label || "site");

    // Fill email/username (skip if there's no email field — some show password only).
    const emailEl = await this.page!.$(
      'input[type="email"], input[name*="email" i], input[id*="email" i], input[autocomplete="username"], input[name="user[email]"]'
    ).catch(() => null);
    if (emailEl) { await emailEl.fill(email).catch(() => {}); await this.delay(300, 600); }
    await pw.fill(password).catch(() => {});
    await this.delay(300, 600);

    // Submit the login.
    const clicked = await this.clickFirstVisible(
      [
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("Sign in")',
        'button:has-text("Sign In")',
        'button:has-text("Log in")',
        'button:has-text("Login")',
        'button:has-text("Continue")',
      ],
      "Sign in"
    );
    if (!clicked) {
      await pw.press("Enter").catch(() => {});
    }
    await this.page!.waitForLoadState("networkidle").catch(() => null);
    await this.delay(2500, 4000);

    // Still showing a password field? Login likely failed (bad creds / 2FA / captcha).
    const stillGated = await this.page!.$('input[type="password"]').catch(() => null);
    if (stillGated && await stillGated.isVisible().catch(() => false)) {
      await Logger.warn("APPLY", "Still on login screen after sign-in attempt — may need manual login / 2FA");
      return false;
    }
    await Logger.success("APPLY", "Signed in — session saved to browser profile for future applies");
    return true;
  }

  // The shared multi-step form walk, reused for Workday after auth.
  private async runWorkdayFormLoop(application: NonNullable<ApplicationWithRelations>): Promise<boolean> {
    const scope = "body";
    const MAX_STEPS = 10;
    for (let step = 1; step <= MAX_STEPS; step++) {
      await this.dismissPopups();
      if (await this.detectSuccessPage()) {
        await Logger.success("APPLY", "Workday submission confirmed!");
        return true;
      }

      await Logger.info("APPLY", `Workday step ${step}: filling…`);
      this.logAction("workday_step", `step ${step}`);
      await this.checkpoint(`workday-step-${step}`);
      await this.uploadResumeIfVisible(application).catch(() => {});
      await this.attachCoverLetterIfRequested(application).catch(() => {});
      const unfilled = await this.fillVisibleFields(application, scope);
      await this.delay(700, 1200);
      await this.takeStepScreenshot(application.folderPath, `wd-step-${step}`);

      if (unfilled.length > 0) {
        const progressed = await this.pauseForHumanThenCapture(
          application, scope,
          `Workday needs these filled, then I'll continue: ${unfilled.slice(0, 6).join(", ")}`
        );
        if (!progressed) break;
        continue;
      }

      const sigBefore = await this.pageSignature();
      let action: "submit" | "advance" | null = null;
      if (await this.clickFinalSubmit()) action = "submit";
      else if (await this.clickAdvance()) action = "advance";

      if (!action) {
        const progressed = await this.pauseForHumanThenCapture(
          application, scope,
          "I can't find Workday's next/submit button — click it in the browser and I'll continue"
        );
        if (!progressed) break;
        continue;
      }

      await this.delay(3000, 5000);
      if (await this.detectSuccessPage()) {
        await Logger.success("APPLY", "Workday submission confirmed!");
        return true;
      }
      const sigAfter = await this.pageSignature();
      if (sigAfter === sigBefore) {
        const progressed = await this.pauseForHumanThenCapture(
          application, scope,
          "Workday didn't advance — fix the highlighted fields and I'll continue"
        );
        if (!progressed) break;
      }
    }

    return this.waitForHumanTakeover(
      application,
      `Finish & submit "${application.job.jobTitle}" @ ${application.job.companyName} on Workday, then click "I submitted it" / Resume`,
      10 * 60 * 1000
    );
  }

  // ─── Find and click submit ─────────────────────────────────────────────────

  // Click a genuine FINAL submit button (the one that completes the whole
  // application). Kept deliberately narrow so we don't mistake a step's "Next"
  // for the real submit. Returns true only if such a button was found+clicked.
  private async clickFinalSubmit(ats?: AtsAdapter | null): Promise<boolean> {
    const candidates = [
      ...(ats?.submitButtons || []),
      'button[aria-label="Submit application"]',
      'button:has-text("Submit application")',
      'button:has-text("Submit Application")',
      'button:has-text("Submit your application")',
      'button:has-text("Submit Your Application")',
      'button:has-text("Send application")',
      'button:has-text("Send Application")',
      'button:has-text("Complete application")',
      'button:has-text("Complete Application")',
      'input[type="submit"][value*="Submit application" i]',
      'a:has-text("Submit application")',
      // Plain "Submit"/"Send" — last, and only as a final action.
      'button:has-text("Submit")',
      'button:has-text("Send")',
      'input[type="submit"][value*="submit" i]',
    ];
    const clicked = await this.clickFirstVisible(candidates, "Submit");
    // Mark that a real final-submit happened — gates success detection so we
    // never declare success on a job page we merely navigated to.
    if (clicked) this.submitClicked = true;
    return clicked;
  }

  // Click a button that ADVANCES to the next step of a multi-step form.
  private async clickAdvance(ats?: AtsAdapter | null): Promise<boolean> {
    const candidates = [
      ...(ats?.advanceButtons || []),
      'button:has-text("Save & Go to Next Section")',
      'button:has-text("Save and Go to Next Section")',
      'button:has-text("Save & Continue")',
      'button:has-text("Save and Continue")',
      'button:has-text("Save & Next")',
      'button:has-text("Continue to next step")',
      'button[aria-label*="Continue to next step"]',
      'button:has-text("Review your application")',
      'button[aria-label*="Review"]',
      'button:has-text("Review")',
      'button:has-text("Continue")',
      'button:has-text("Next")',
      'button:has-text("Proceed")',
      'button:has-text("Save and continue")',
      '[data-automation-id="bottom-navigation-next-button"]',
      'a:has-text("Continue")',
      'a:has-text("Next")',
      // Generic form-submit as a last resort (advances single-form steps).
      'button[type="submit"]',
      'input[type="submit"]',
      '.btn-primary[type="submit"]',
    ];
    return this.clickFirstVisible(candidates, "Next");
  }

  // Click the first visible+enabled element matching any of the selectors.
  // Self-healing (#24): tries the previously-learned selector first, then the
  // candidate list, then a text-based fallback scan; records the winner so it's
  // tried first next time. `kind` doubles as the learning intent.
  private async clickFirstVisible(selectors: string[], kind: string): Promise<boolean> {
    const url = this.page!.url();

    // 1) Remembered winner for this (host, intent) — promoted to first try.
    const learned = rememberedSelector(url, kind);
    const ordered = learned ? [learned, ...selectors.filter((s) => s !== learned)] : selectors;

    for (const sel of ordered) {
      try {
        const btn = await this.page!.$(sel);
        if (!btn) continue;
        if (!(await btn.isVisible().catch(() => false))) continue;
        if (await btn.isDisabled().catch(() => false)) continue;

        await btn.scrollIntoViewIfNeeded().catch(() => null);
        await this.delay(200, 500);
        await Logger.info("APPLY", `${kind} → ${sel}`);
        await btn.click({ timeout: 5000 });
        this.logAction("click", kind, sel);
        learnSelector(url, kind, sel);
        return true;
      } catch { /* try next */ }
    }

    // 2) Self-heal: no known selector matched. Scan the DOM for a button/link
    //    whose visible text or aria-label looks right for this intent, click it,
    //    and remember a durable selector for next time.
    if (learned) forgetSelector(url, kind); // it stopped working
    const healed = await this.healClick(kind);
    return healed;
  }

  // Intent → text patterns used by the self-healing fallback scan.
  private intentTextPatterns(kind: string): RegExp {
    const k = kind.toLowerCase();
    if (k.includes("submit"))
      return /\b(submit|send) (application|app)\b|submit$|send application|complete application/i;
    if (k.includes("next") || k.includes("continue"))
      return /\b(next|continue|save (and|&) (continue|next)|review|proceed|save (and|&) go)\b/i;
    if (k.includes("sign in") || k.includes("login"))
      return /\bsign in\b|\blog in\b|\blogin\b/i;
    if (k.includes("create account"))
      return /create account|sign up|register/i;
    if (k.includes("apply"))
      return /\bapply\b|easy apply|quick apply/i;
    return new RegExp(kind.replace(/[^a-z0-9]+/gi, "\\s*"), "i");
  }

  // Find + click the best-matching visible button/link by text for `kind`.
  // Returns true and learns a stable selector if it succeeds.
  private async healClick(kind: string): Promise<boolean> {
    const rxSource = this.intentTextPatterns(kind).source;
    const rxFlags = this.intentTextPatterns(kind).flags;

    const found = await this.page!.evaluate(
      ({ src, flags }) => {
        const rx = new RegExp(src, flags);
        const norm = (s: string) => (s || "").replace(/\s+/g, " ").trim();
        const els = Array.from(
          document.querySelectorAll<HTMLElement>(
            "button, a, input[type=submit], input[type=button], [role=button]"
          )
        );
        for (const el of els) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if ((el as HTMLButtonElement).disabled) continue;
          const label = norm(
            el.innerText ||
              (el as HTMLInputElement).value ||
              el.getAttribute("aria-label") ||
              ""
          );
          if (!label || !rx.test(label)) continue;
          // Build a durable selector for this element.
          let selector = "";
          const id = el.id;
          const aria = el.getAttribute("aria-label");
          const auto = el.getAttribute("data-automation-id");
          if (id) selector = `#${CSS.escape(id)}`;
          else if (auto) selector = `[data-automation-id="${auto}"]`;
          else if (aria) selector = `${el.tagName.toLowerCase()}[aria-label="${aria.replace(/"/g, '\\"')}"]`;
          // Mark the element so the caller can click it even without a selector.
          el.setAttribute("data-jobagent-heal", "1");
          return { selector, label: label.slice(0, 60) };
        }
        return null;
      },
      { src: rxSource, flags: rxFlags }
    ).catch(() => null);

    if (!found) return false;

    const clickSel = found.selector || "[data-jobagent-heal='1']";
    try {
      const btn = await this.page!.$(clickSel);
      if (!btn) return false;
      await btn.scrollIntoViewIfNeeded().catch(() => null);
      await this.delay(200, 500);
      await Logger.success("APPLY", `${kind} (self-healed) → "${found.label}"`);
      await btn.click({ timeout: 5000 });
      this.logAction("click_healed", kind, found.label);
      // Clean the marker; learn a durable selector when we have one.
      await this.page!.evaluate(() =>
        document.querySelectorAll("[data-jobagent-heal]").forEach((e) => e.removeAttribute("data-jobagent-heal"))
      ).catch(() => {});
      if (found.selector) learnSelector(this.page!.url(), kind, found.selector);
      return true;
    } catch {
      return false;
    }
  }

  // A lightweight fingerprint of the current form page. We compare it before
  // and after a click to tell whether we actually advanced (vs. stuck on a
  // validation error). Combines URL, visible-input count, and the top heading.
  private async pageSignature(): Promise<string> {
    try {
      const url = this.page!.url().split("?")[0];
      const info = await this.page!.evaluate(() => {
        const visibleInputs = Array.from(
          document.querySelectorAll("input:not([type=hidden]), textarea, select")
        ).filter((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        }).length;
        const heading =
          document.querySelector("h1, h2, [role='heading']")?.textContent?.trim().slice(0, 80) || "";
        return `${visibleInputs}|${heading}`;
      });
      return `${url}|${info}`;
    } catch {
      return Math.random().toString(); // force "changed" on error
    }
  }

  // Strict success detection. Declaring success wrongly is worse than missing it
  // (it skips a real application), so we require a STRONG signal — and, for the
  // generic text/URL heuristics, that we have actually clicked a final Submit
  // this run. Adapter-specific successSelectors are trusted unconditionally
  // (they're page-specific confirmation elements).
  private async detectSuccessPage(ats?: AtsAdapter | null): Promise<boolean> {
    try {
      // 1) Platform-specific confirmation element — most reliable, no gate.
      for (const sel of ats?.successSelectors || []) {
        const el = await this.page!.$(sel).catch(() => null);
        if (el && await el.isVisible().catch(() => false)) return true;
      }

      // 2) Generic signals only count AFTER we've actually submitted. This stops
      //    false positives from job-page URLs like ".../applied-ai-engineer/" or
      //    instructional copy ("thank you for your interest").
      if (!this.submitClicked) return false;

      const url = this.page!.url().toLowerCase();
      // Require a confirmation-specific PATH segment or query, not a bare
      // substring that could live inside a job-title slug.
      const urlConfirms =
        /\/(thank[-_]?you|confirmation|application[-_]?(complete|submitted|received|success)|success)(\/|\?|$)/.test(url) ||
        /[?&](status|state)=(success|submitted|complete|confirmed)/.test(url) ||
        /applicationsubmitted|thankyou/.test(url.replace(/[-_]/g, ""));
      if (urlConfirms) return true;

      const body = await this.page!.evaluate(
        () => (document.body.innerText ?? "").slice(0, 4000).toLowerCase()
      );

      // Platform-specific success phrases (adapter-provided).
      for (const phrase of ats?.successText || []) {
        if (body.includes(phrase.toLowerCase())) return true;
      }

      // Strong, submission-specific confirmation phrases only.
      return (
        body.includes("application submitted") ||
        body.includes("application has been submitted") ||
        body.includes("application was submitted") ||
        body.includes("your application has been received") ||
        body.includes("we have received your application") ||
        body.includes("your application was sent") ||
        body.includes("thank you for applying") ||
        body.includes("successfully submitted") ||
        body.includes("application complete")
      );
    } catch {
      return false;
    }
  }

  // ─── Popup dismissal ────────────────────────────────────────────────────────

  private async dismissPopups(): Promise<void> {
    const dismissSelectors = [
      'button[aria-label="Dismiss"]',
      'button[aria-label="Close"]',
      'button.contextual-sign-in-modal__modal-dismiss-icon',
      '.modal__dismiss',
      '#onetrust-accept-btn-handler',
      'button[id*="accept-cookies"]',
      'button:has-text("Accept all")',
      'button:has-text("Accept")',
      'button:has-text("I agree")',
      'button:has-text("Got it")',
      'button:has-text("Continue")',
      '[data-testid="close-button"]',
    ];
    for (const sel of dismissSelectors) {
      try {
        const btn = await this.page!.$(sel);
        if (btn && await btn.isVisible().catch(() => false)) {
          await btn.click({ timeout: 2000 }).catch(() => {});
          await this.delay(300, 600);
        }
      } catch { /* ignore */ }
    }
  }

  // ─── LinkedIn login handler ──────────────────────────────────────────────────

  private async handleLinkedInLogin(): Promise<boolean> {
    const email = this.creds.linkedinEmail;
    const password = this.creds.linkedinPassword;

    try {
      // Try to find and fill the email input
      const emailInput = await this.page!.$('input[type="email"], input[id*="email"], input[name*="email"]');
      if (emailInput) {
        await Logger.info("APPLY", `Entering LinkedIn email: ${email}`);
        await emailInput.fill(email);
        await this.delay(500, 800);
      }

      // Find and fill the password input
      const passwordInput = await this.page!.$('input[type="password"], input[name*="password"]');
      if (passwordInput) {
        await Logger.info("APPLY", "Entering LinkedIn password");
        await passwordInput.fill(password);
        await this.delay(500, 800);
      }

      // Click sign in button
      const signInBtn = await this.page!.$('button[type="submit"], button[aria-label*="Sign in"], button:has-text("Sign in"), button:has-text("Sign In")');
      if (signInBtn) {
        await Logger.info("APPLY", "Clicking Sign In button");
        await signInBtn.click();
        await this.delay(4000, 6000);

        // Check if login was successful
        const stillOnLogin = this.page!.url().includes("linkedin.com/login");
        if (stillOnLogin) {
          await Logger.warn("APPLY", "Still on login page — login may have failed");
          return false;
        }

        await Logger.success("APPLY", "LinkedIn login successful");
        return true;
      } else {
        await Logger.warn("APPLY", "Could not find LinkedIn sign-in button");
        return false;
      }
    } catch (e) {
      await Logger.error("APPLY", `LinkedIn login error: ${e}`);
      return false;
    }
  }

  // ─── LinkedIn email field ────────────────────────────────────────────────────

  private async setLinkedInEmailField(email: string): Promise<void> {
    try {
      const emailInputs = await this.page!.$$('input[type="email"], input[type="text"][placeholder*="email" i], input[placeholder*="email" i]');
      if (emailInputs.length === 0) return;

      for (const input of emailInputs) {
        const currentValue = await input.inputValue().catch(() => "");
        if (currentValue.trim()) {
          // Field already filled, check if it's the right email
          if (!currentValue.includes(email)) {
            await Logger.info("APPLY", `Updating email field from "${currentValue}" to "${email}"`);
            await input.fill(email);
            await this.delay(500, 800);
          }
        } else {
          // Empty email field, fill it
          await Logger.info("APPLY", `Setting email field to "${email}"`);
          await input.fill(email);
          await this.delay(500, 800);
        }
      }
    } catch (e) {
      await Logger.warn("APPLY", `Email field update error: ${e}`);
    }
  }

  // ─── Resume upload ──────────────────────────────────────────────────────────

  private async uploadResumeIfVisible(
    application: NonNullable<ApplicationWithRelations>,
    ats?: AtsAdapter | null
  ): Promise<void> {
    const pdfPath = resolveResumePath(application.tailoredResume?.pdfPath);
    if (!pdfPath) {
      await Logger.warn("APPLY", "Skipping resume upload — no PDF available");
      return;
    }

    try {
      // Prefer the platform's known resume input, then fall back to all file inputs.
      const fileInputs = [];
      for (const sel of ats?.fileInput || []) {
        const found = await this.page!.$$(sel);
        fileInputs.push(...found);
      }
      if (fileInputs.length === 0) {
        // many sites style file inputs invisibly — grab them all
        fileInputs.push(...(await this.page!.$$('input[type="file"]')));
      }
      if (fileInputs.length === 0) return;

      for (const input of fileInputs) {
        const accept = (await input.getAttribute("accept").catch(() => "")) || "";
        const name = (await input.getAttribute("name").catch(() => "")) || "";
        const id = (await input.getAttribute("id").catch(() => "")) || "";

        // Don't put the résumé into a cover-letter / photo slot.
        if (/cover|letter|photo|portrait|headshot/i.test(`${name} ${id}`)) continue;

        const isResumeInput =
          !accept ||
          accept.includes("pdf") ||
          accept.includes("doc") ||
          accept === "*" ||
          /resume|cv|attachment|document|file/i.test(name) ||
          /resume|cv|attachment|document|file/i.test(id);

        if (isResumeInput) {
          await Logger.info("APPLY", `Uploading resume PDF to file input (name=${name}, id=${id})`);
          try {
            await input.setInputFiles(pdfPath);
            // Wait longer for upload to complete, especially on slow connections
            await this.delay(3000, 5000);

            // Verify upload succeeded by checking for upload confirmation
            const uploadSuccess = await this.page!.evaluate(() => {
              const success = document.body.innerText.toLowerCase();
              return !success.includes("error") && !success.includes("failed");
            }).catch(() => true); // Default to true if we can't verify

            if (uploadSuccess) {
              await Logger.success("APPLY", `Resume uploaded: ${pdfPath}`);
              return;
            } else {
              await Logger.warn("APPLY", "Upload might have failed — check screenshots");
            }
          } catch (e) {
            await Logger.warn("APPLY", `setInputFiles failed: ${e}`);
          }
        }
      }
    } catch (e) {
      await Logger.warn("APPLY", `Resume upload error: ${e}`);
    }
  }

  // ─── Cover letter ─────────────────────────────────────────────────────────────

  // If the form asks for a cover letter — either a paste-in text box OR a file
  // upload — fill/upload the job-specific cover letter we generated at tailor
  // time. Safe to call every step (it no-ops if nothing matches).
  private async attachCoverLetterIfRequested(
    application: NonNullable<ApplicationWithRelations>
  ): Promise<void> {
    const cl = application.coverLetter;
    if (!cl) return;
    const content = (cl.content || "").trim();
    const clPdf = resolveResumePath(cl.pdfPath);

    try {
      // 1) Paste-in text areas (e.g. "Cover Letter", "Why do you want to work here?")
      if (content) {
        const textareas = await this.page!.$$("textarea");
        for (const ta of textareas) {
          if (!(await ta.isVisible().catch(() => false))) continue;
          const meta = await ta.evaluate((el) => {
            const e = el as HTMLTextAreaElement;
            const lbl = e.id
              ? document.querySelector(`label[for="${CSS.escape(e.id)}"]`)?.textContent || ""
              : "";
            const container =
              e.closest("[class*='field'], [class*='question'], label, .form-group")?.textContent || "";
            return `${e.name} ${e.id} ${e.placeholder} ${e.getAttribute("aria-label") || ""} ${lbl} ${container}`.toLowerCase();
          }).catch(() => "");

          // ONLY paste the full cover letter into an actual cover-letter box.
          // NOT into short-answer prompts like "Why do you want to join X?",
          // "Additional information", or "From where do you intend to work?" —
          // those need a short, specific answer (handled as normal fields), and
          // dumping the whole letter there looks wrong.
          const isCoverLetterBox =
            /cover\s*letter/i.test(meta) ||
            /anything else you.?d like to share|add a cover letter/i.test(meta);
          if (isCoverLetterBox) {
            const cur = await ta.inputValue().catch(() => "");
            if (!cur.trim()) {
              await ta.fill(content);
              await Logger.success("APPLY", "Pasted cover letter into cover-letter box");
              await this.delay(400, 800);
            }
          }
        }
      }

      // 2) File-upload slot specifically for a cover letter.
      if (clPdf) {
        const fileInputs = await this.page!.$$('input[type="file"]');
        for (const fi of fileInputs) {
          const meta = await fi.evaluate((el) => {
            const e = el as HTMLInputElement;
            const lbl = e.id
              ? document.querySelector(`label[for="${CSS.escape(e.id)}"]`)?.textContent || ""
              : "";
            const container =
              e.closest("[class*='field'], [class*='question'], label, .form-group")?.textContent || "";
            return `${e.name} ${e.id} ${lbl} ${container}`.toLowerCase();
          }).catch(() => "");

          if (/cover\s*letter|cover/i.test(meta)) {
            try {
              await fi.setInputFiles(clPdf);
              await Logger.success("APPLY", `Uploaded cover letter PDF: ${clPdf}`);
              await this.delay(2000, 3500);
            } catch (e) {
              await Logger.warn("APPLY", `Cover letter upload failed: ${e}`);
            }
          }
        }
      }
    } catch (e) {
      await Logger.warn("APPLY", `Cover letter attach error: ${e}`);
    }
  }

  // ─── Field filling ──────────────────────────────────────────────────────────

  // Returns the labels of fields it could NOT fill (unknown / needs human).
  private async fillVisibleFields(
    application: NonNullable<ApplicationWithRelations>,
    scope: string
  ): Promise<string[]> {
    this.currentScope = scope;
    const fields = await this.detectFields(scope);
    if (fields.length === 0) {
      await Logger.info("APPLY", "No fillable fields detected in this view");
      return [];
    }
    await Logger.info("APPLY", `Detected ${fields.length} fields to fill`);

    const unfilled: string[] = [];
    for (const field of fields) {
      try {
        const filled = await this.fillField(field, application);
        if (!filled) unfilled.push(field.label);
        await this.delay(250, 600);
      } catch (e) {
        await Logger.warn("APPLY", `Field "${field.label}" failed: ${e}`);
        unfilled.push(field.label);
      }
    }
    return unfilled;
  }

  private async detectFields(scope: string): Promise<DetectedField[]> {
    return this.page!.evaluate((scopeSel: string) => {
      const root = document.querySelector(scopeSel) || document.body;
      const results: Array<{
        type: string;
        label: string;
        name?: string;
        required: boolean;
        options?: string[];
        selector: string;
      }> = [];

      const getLabel = (el: Element): string => {
        const elId = (el as HTMLInputElement).id;
        if (elId) {
          const lbl = document.querySelector(`label[for="${CSS.escape(elId)}"]`);
          if (lbl) return lbl.textContent?.trim() || "";
        }
        const wrap = el.closest("label");
        if (wrap) return wrap.textContent?.trim() || "";
        const parent = el.closest(
          ".form-group, .jobs-easy-apply-form-element, [class*='field'], [class*='question'], fieldset, [data-automation-id]"
        );
        if (parent) {
          const lbl = parent.querySelector("label, legend, .label, h3, h4, [class*='label'], [class*='title']");
          if (lbl && lbl !== el) return lbl.textContent?.trim() || "";
        }
        return (
          (el as HTMLInputElement).getAttribute("aria-label") ||
          (el as HTMLInputElement).placeholder ||
          (el as HTMLInputElement).name ||
          ""
        );
      };

      const makeSelector = (el: Element): string => {
        const elId = (el as HTMLInputElement).id;
        if (elId) return `#${CSS.escape(elId)}`;
        const name = (el as HTMLInputElement).name;
        if (name) return `[name="${name}"]`;
        return "";
      };

      const inputs = root.querySelectorAll(
        'input:not([type="hidden"]):not([type="submit"]):not([type="file"]):not([type="button"]):not([type="image"]), textarea, select'
      );

      inputs.forEach((el) => {
        const htmlEl = el as HTMLElement;
        // Skip completely invisible (display:none, visibility:hidden)
        const style = window.getComputedStyle(htmlEl);
        if (style.display === "none" || style.visibility === "hidden") return;

        // Allow elements that might be scrolled out of view (still need width/height)
        const rect = htmlEl.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        const label = getLabel(el);
        const selector = makeSelector(el);
        if (!selector) return;

        const type = el.tagName === "SELECT"
          ? "select"
          : el.tagName === "TEXTAREA"
          ? "textarea"
          : (el as HTMLInputElement).type || "text";

        const options = el.tagName === "SELECT"
          ? Array.from((el as HTMLSelectElement).options).map((o) => o.text.trim()).filter(Boolean)
          : undefined;

        results.push({
          type,
          label: label || `field_${results.length}`,
          name: (el as HTMLInputElement).name || undefined,
          required: (el as HTMLInputElement).required || false,
          options,
          selector,
        });
      });

      // Radio groups
      const fieldsets = root.querySelectorAll("fieldset");
      fieldsets.forEach((fs) => {
        const legend = fs.querySelector("legend")?.textContent?.trim();
        const radios = Array.from(fs.querySelectorAll('input[type="radio"]'));
        if (radios.length === 0) return;

        const label = legend || (fs.querySelector("[class*='label']")?.textContent?.trim()) || "";
        if (!label) return;

        const options = radios.map((r) => {
          const rid = (r as HTMLInputElement).id;
          const lbl = rid ? document.querySelector(`label[for="${CSS.escape(rid)}"]`)?.textContent?.trim() : "";
          return lbl || (r as HTMLInputElement).value;
        }).filter(Boolean);

        const firstRadio = radios[0] as HTMLInputElement;
        const groupSelector = firstRadio.name ? `input[type="radio"][name="${firstRadio.name}"]` : "";

        if (groupSelector) {
          results.push({
            type: "radio",
            label,
            name: firstRadio.name,
            required: false,
            options,
            selector: groupSelector,
          });
        }
      });

      // Standalone checkboxes (e.g., "I agree to terms")
      const checkboxes = root.querySelectorAll('input[type="checkbox"]');
      checkboxes.forEach((cb) => {
        const label = getLabel(cb);
        const selector = makeSelector(cb);
        if (!selector || !label) return;
        results.push({ type: "checkbox", label, name: (cb as HTMLInputElement).name, required: false, selector });
      });

      return results;
    }, scope) as Promise<DetectedField[]>;
  }

  // Fills one field. Returns true if it was filled (or safely skippable),
  // false if we genuinely don't know the answer (so the caller can pause once
  // for the human instead of pausing per-field).
  private async fillField(field: DetectedField, application: NonNullable<ApplicationWithRelations>): Promise<boolean> {
    const resumeData = (application.resume?.parsedData as Record<string, unknown>) || {};
    const answeredQuestions = (application.answeredQuestions as { question: string; answer: string }[]) || [];

    // Skip junk "fields" that aren't real questions: unlabeled inputs
    // (field_1, field_2…) and stray UI controls (Save job, search, etc.).
    const junk = /^field_\d+$/i.test(field.label) ||
      /^(save( job)?|search|dismiss|close|follow|share|set alert|skip)$/i.test(field.label.trim());
    if (junk && !field.required) {
      await Logger.info("APPLY", `  ⏭ skipping non-question field: "${field.label}"`);
      return true; // not our problem — don't trigger a human pause
    }

    // Skip pre-filled text fields
    if (!["radio", "checkbox", "select"].includes(field.type)) {
      try {
        const cur = await this.page!.inputValue(field.selector).catch(() => "");
        if (cur.trim().length > 0) {
          await Logger.info("APPLY", `  ✓ pre-filled: "${field.label}" = "${cur.slice(0, 50)}"`);
          return true;
        }
      } catch { /* continue */ }
    }

    // Auto-affirm standard consent/agreement checkboxes (required to submit).
    if (
      field.type === "checkbox" &&
      /agree|consent|certify|terms|privacy|policy|acknowledge|authorize|gdpr|confirm|i understand|read and/i.test(field.label)
    ) {
      await Logger.info("APPLY", `  ☑ consenting: "${field.label.slice(0, 60)}"`);
      await this.applyAnswer(field, "yes");
      return true;
    }

    let answer = "";
    let confidence = 0;   // 0-1; drives auto-fill vs fill+verify vs pause
    let source = "";

    // ── Phase 1: classify the field BEFORE resolving any value. ───────────────
    // The category decides whether AI may answer (do-not-AI), whether a value
    // must be profile-backed (sensitive/legal), and how candidate values are
    // validated. Built from every text signal we have on the field.
    const cls = classifyField({
      label: field.label,
      type: field.type,
      name: field.name,
      options: field.options,
      required: field.required,
    });

    // Reject any candidate value that doesn't make sense for this field
    // (email in a name box, a paragraph in a yes/no dropdown, …).
    const accept = (val: string): boolean => validateValue(cls, val, field.options).ok;

    // 0) Profile Engine V2 — deterministic, structured fields come FIRST.
    //    Identity / contact / visa / education resolve here with no AI.
    const resolution = resolveField(field.label, this.profile);
    let hasProfileValue = false;
    if (resolution) {
      const { spec, field: pf } = resolution;
      if (pf && pf.value.trim()) {
        answer = pf.value.trim();
        // Locked = certain (1.0); else use the field's stored confidence.
        confidence = pf.locked ? 1 : (pf.confidence ?? 0.8);
        source = `profile[${spec.key}]`;
        hasProfileValue = true;
        await Logger.info("APPLY", `  🧬 ${source} (${Math.round(confidence * 100)}%): "${field.label.slice(0, 60)}" → "${answer.slice(0, 60)}"`);
      } else if (spec.compliance || isSensitive(cls.category)) {
        // Compliance/visa/EEO/salary question with NO profile value → never guess.
        await Logger.warn("APPLY", `  🔒 sensitive [${cls.category}] "${field.label.slice(0, 60)}" not in profile — will ask you (no AI/memory guessing)`);
        return false;
      }
    } else if (isSensitive(cls.category)) {
      // Classified sensitive but no profile spec matched → still never guess.
      await Logger.warn("APPLY", `  🔒 sensitive [${cls.category}] "${field.label.slice(0, 60)}" not in profile — will ask you (no AI/memory guessing)`);
      return false;
    }

    // 1) Memory (exact + semantic) — never for sensitive categories. Ignore a
    //    stored value that fails validation (protects against poisoned memory).
    if (!answer && !isSensitive(cls.category)) {
      const mem = await findAnswer(field.label);
      if (mem && accept(mem)) {
        answer = mem;
        confidence = 0.9;
        source = "memory";
        await Logger.info("APPLY", `  💾 memory: "${field.label.slice(0, 60)}" → "${answer.slice(0, 60)}"`);
      } else if (mem) {
        await Logger.warn("APPLY", `  ✗ ignoring memory "${mem.slice(0, 40)}…" — fails [${cls.category}/${cls.domKind}] validation`);
      }
    }

    // 2) Résumé shortcuts for obvious fields — never for sensitive categories.
    if (!answer && !isSensitive(cls.category)) {
      const shortcut = this.shortcutFromResume(field.label, resumeData) || "";
      if (shortcut && accept(shortcut)) {
        answer = shortcut;
        confidence = 0.85;
        source = "resume";
        await Logger.info("APPLY", `  📄 resume: "${field.label.slice(0, 60)}" → "${answer.slice(0, 60)}"`);
        await saveAnswer(field.label, answer, "GENERAL", application.job.platform);
      }
    }

    // 3) Claude AI — ONLY for AI-allowed categories (open-ended essays). Every
    //    other category (identity/contact/education/visa/EEO/…) must NEVER get
    //    an AI guess; with no real value we leave it blank for the human.
    if (!answer) {
      if (aiMayAnswer(cls.category)) {
        try {
          const aiResult = await claudeAnswerQuestion(field.label, resumeData, answeredQuestions);
          const cand = aiResult.answer?.trim() || "";
          if (cand && accept(cand)) {
            answer = cand;
            confidence = 0.6; // AI guesses are lowest trust
            source = "AI";
            await Logger.info("APPLY", `  🤖 AI: "${field.label.slice(0, 60)}" → "${answer.slice(0, 60)}"`);
            await saveAnswer(field.label, answer, aiResult.category, application.job.platform);
          }
        } catch (e) {
          await Logger.warn("APPLY", `  ⚠ AI error for "${field.label}": ${e}`);
        }
      } else {
        await Logger.warn("APPLY", `  🚫 [${cls.category}] "${field.label.slice(0, 50)}" — no saved value; AI not allowed here, leaving blank`);
      }
    }

    // Don't know it → leave blank and report so the step pauses once for the
    // human to fill ALL unknowns together (we then capture them to memory).
    if (!answer) {
      await Logger.warn("APPLY", `  ❓ Don't know "${field.label.slice(0, 60)}" — will ask you to fill it`);
      return false;
    }

    // Final validation guard (defense in depth): never write a value that
    // doesn't fit the field — e.g. prose into a URL/yes-no/email box.
    if (!accept(answer)) {
      const why = validateValue(cls, answer, field.options).reason || "invalid";
      await Logger.warn("APPLY", `  ✗ rejecting "${answer.slice(0, 40)}…" — ${why} for [${cls.category}/${cls.domKind}] "${field.label.slice(0, 40)}"`);
      return false;
    }

    // ── Confidence gates (Phase 1.3) ──────────────────────────────────────────
    // >=95% autofill · 85-94% fill+verify · 60-84% pause · <60% pause · sensitive
    // without a profile value → pause. Required fields get a small boost.
    const effConfidence = field.required ? Math.min(1, confidence + 0.05) : confidence;
    const decision = decideFill(cls.category, effConfidence, hasProfileValue);
    if (decision === "pause_blank" || decision === "pause_low_confidence") {
      const why = decision === "pause_blank"
        ? "needs a profile value"
        : `low confidence (${Math.round(effConfidence * 100)}%, ${source})`;
      await Logger.warn("APPLY", `  ⚠ ${why} for "${field.label.slice(0, 50)}" — leaving blank for your review`);
      return false;
    }

    await this.applyAnswer(field, answer, resolution?.spec.kind);

    // 85-94% → verify the value actually landed; if not, hand to human.
    if (decision === "fill_and_verify") {
      const ok = await this.verifyFieldValue(field, answer);
      if (!ok) {
        await Logger.warn("APPLY", `  ⚠ verify failed for "${field.label}" (${source}) — pausing for review`);
        return false;
      }
      await Logger.info("APPLY", `  ✓ verified "${field.label.slice(0, 50)}" (${Math.round(effConfidence * 100)}%)`);
    }
    return true;
  }

  // Read back a text/select field to confirm our value actually applied.
  // Radios/checkboxes are trusted (toggleCheckable already self-verifies).
  private async verifyFieldValue(field: DetectedField, expected: string): Promise<boolean> {
    if (field.type === "radio" || field.type === "checkbox") return true;
    try {
      if (field.type === "select") {
        const text = await this.page!.$eval(field.selector, (el) => {
          const s = el as HTMLSelectElement;
          return s.options[s.selectedIndex]?.text?.trim().toLowerCase() || "";
        }).catch(() => "");
        // A non-empty, non-placeholder selection counts as success.
        return !!text && !/^(select|choose|--|please)/.test(text);
      }
      const cur = (await this.page!.inputValue(field.selector).catch(() => "")) || "";
      if (!cur.trim()) return false;
      // Field-shortening (truncation/formatting) is fine — check overlap.
      const a = cur.toLowerCase().trim(), b = expected.toLowerCase().trim();
      return a === b || a.includes(b.slice(0, 12)) || b.includes(a.slice(0, 12));
    } catch {
      return false;
    }
  }

  // Quick resume shortcuts — saves AI calls for obvious questions
  private shortcutFromResume(label: string, resumeData: Record<string, unknown>): string | null {
    const l = label.toLowerCase();
    const contact = (resumeData.contactInfo as Record<string, string>) || {};

    if (l.match(/first.?name/)) return (contact.name || "").split(" ")[0] || null;
    if (l.match(/last.?name|surname|family.?name/)) {
      const parts = (contact.name || "").split(" ");
      return parts.length > 1 ? parts.slice(1).join(" ") : null;
    }
    if (l.match(/full.?name|^name$/)) return contact.name || null;
    if (l.includes("email")) return contact.email || null;
    if (l.includes("phone") || l.includes("mobile") || l.includes("telephone")) return contact.phone || null;
    if (l.includes("linkedin")) return contact.linkedin || null;
    if (l.includes("github")) return contact.github || null;
    if (l.includes("portfolio") || l.includes("website")) return contact.portfolio || null;
    if (l.includes("city") || l.includes("location") || l.includes("address")) return contact.location || null;
    return null;
  }

  private async applyAnswer(field: DetectedField, answer: string, kind?: string): Promise<void> {
    if (field.type === "select") {
      const options = await this.page!.$$eval(
        `${field.selector} option`,
        (opts) => opts.map((o) => ({ value: (o as HTMLOptionElement).value, text: o.textContent?.trim() || "" }))
      ).catch(() => []);

      // Dropdown Intelligence: deterministic match (state/country/degree/yesno
      // aware), no AI. Falls back to plain contains if no smart match.
      let chosen = matchDropdownOption(answer, options, kind);
      if (!chosen) {
        const a = answer.toLowerCase();
        chosen = options.find((o) =>
          o.text.toLowerCase().includes(a) || a.includes(o.text.toLowerCase())
        )?.value ?? null;
      }
      if (chosen) {
        await this.page!.selectOption(field.selector, chosen).catch(() => {});
      } else {
        await Logger.warn("APPLY", `  ⚠ no dropdown option matched "${answer}" for "${field.label}"`);
      }
    } else if (field.type === "radio") {
      const radios = await this.page!.$$(field.selector);
      for (const radio of radios) {
        const labelText = await radio.evaluate((el) => {
          const id = (el as HTMLInputElement).id;
          const lbl = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent?.trim() : "";
          return (lbl || (el as HTMLInputElement).value || "").trim();
        }).catch(() => "");
        if (labelText.toLowerCase().includes(answer.toLowerCase()) ||
            answer.toLowerCase().includes(labelText.toLowerCase())) {
          await this.toggleCheckable(radio, true);
          return;
        }
      }
    } else if (field.type === "checkbox") {
      const shouldCheck = /yes|true|agree|accept|authorize|confirm|check|i certify|acknowledge/i.test(answer);
      const cb = await this.page!.$(field.selector);
      if (cb) await this.toggleCheckable(cb, shouldCheck);
    } else {
      await this.page!.fill(field.selector, answer).catch(() => {});
    }
  }

  // Reliably set a checkbox/radio to `target`. Many ATS checkboxes are the real
  // <input> hidden (opacity:0 / off-screen) behind a styled <label>/<span>, so a
  // plain click on the input does nothing. We try, in order: Playwright check()
  // with force, clicking the associated <label>, clicking the parent <label>,
  // then a JS click + change event. Verifies state after each attempt.
  private async toggleCheckable(
    handle: import("playwright").ElementHandle<Element>,
    target: boolean
  ): Promise<void> {
    const isChecked = async () =>
      handle.evaluate((el) => (el as HTMLInputElement).checked).catch(() => false);

    if ((await isChecked()) === target) return;

    // 1) Native Playwright (handles actionability; force bypasses visibility).
    try {
      await (target
        ? handle.check({ force: true, timeout: 3000 })
        : handle.uncheck({ force: true, timeout: 3000 }));
      if ((await isChecked()) === target) return;
    } catch { /* fall through */ }

    // 2) Click the associated label[for=id] (works for styled checkboxes).
    try {
      const id = await handle.evaluate((el) => (el as HTMLInputElement).id).catch(() => "");
      if (id) {
        const lbl = await this.page!.$(`label[for="${id}"]`);
        if (lbl) {
          await lbl.click({ timeout: 3000 }).catch(() => {});
          if ((await isChecked()) === target) return;
        }
      }
    } catch { /* fall through */ }

    // 3) Click the wrapping <label>, if any.
    try {
      const ok = await handle.evaluate((el, want) => {
        const lbl = el.closest("label");
        if (lbl) (lbl as HTMLElement).click();
        return (el as HTMLInputElement).checked === want;
      }, target).catch(() => false);
      if (ok) return;
    } catch { /* fall through */ }

    // 4) Last resort: set checked directly + dispatch events so the app reacts.
    try {
      await handle.evaluate((el, want) => {
        const input = el as HTMLInputElement;
        if (input.checked !== want) {
          input.checked = want;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          input.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        }
      }, target);
    } catch { /* give up silently */ }
  }

  // ─── Human intervention (auto-resume) ───────────────────────────────────────

  // Pause so the user can fill what we couldn't, then AUTOMATICALLY continue —
  // no Resume button required. We watch the form: once they start filling and
  // then stop (input stable for a few seconds) — or the page advances, or they
  // click Resume — we capture everything they entered into memory and return
  // true so the caller's loop resumes. Returns false only on timeout.
  private async pauseForHumanThenCapture(
    application: NonNullable<ApplicationWithRelations>,
    scope: string,
    reason: string,
    maxWaitMs = 8 * 60 * 1000
  ): Promise<boolean> {
    scraperStatus.waitingForUser = true;
    scraperStatus.reason = reason;

    await Logger.warn("APPLY", "═════════════════════════════════════════");
    await Logger.warn("APPLY", "⏸  YOUR TURN — I'll continue automatically");
    await Logger.warn("APPLY", reason);
    await Logger.warn("APPLY", "Just fill it in the browser. (Resume button optional.)");
    await Logger.warn("APPLY", "═════════════════════════════════════════");

    const baseline = await this.combinedFormState(scope);
    const start = Date.now();
    let sawChange = false;
    let lastState = baseline;
    let stableTicks = 0;
    let progressed = false;

    while (Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, 1500));

      // Manual override still works.
      if (!scraperStatus.waitingForUser) { progressed = true; break; }
      // Reached a confirmation page while they worked.
      if (await this.detectSuccessPage().catch(() => false)) { progressed = true; break; }

      const state = await this.combinedFormState(scope);
      if (state !== baseline) sawChange = true;

      if (sawChange) {
        // Wait until they stop editing (~4.5s with no further changes).
        if (state === lastState) stableTicks++;
        else stableTicks = 0;
        if (stableTicks >= 3) { progressed = true; break; }
      }
      lastState = state;
    }

    scraperStatus.waitingForUser = false;

    if (progressed) {
      await this.delay(600, 1000);
      await this.captureFilledFields(application, scope);
      await Logger.success("APPLY", "Detected your input — capturing it and continuing automatically");
    } else {
      await Logger.warn("APPLY", "Timed out waiting for input");
    }
    return progressed;
  }

  // A fingerprint that changes when the user types/selects anything OR the page
  // navigates. Used to detect when the human has finished helping.
  private async combinedFormState(scope: string): Promise<string> {
    try {
      const url = this.page!.url().split("?")[0];
      const fill = await this.page!.evaluate((sel: string) => {
        const root = document.querySelector(sel) || document.body;
        const els = root.querySelectorAll("input, textarea, select");
        let s = "";
        els.forEach((el) => {
          const e = el as HTMLInputElement;
          if (e.type === "checkbox" || e.type === "radio") s += e.checked ? "1" : "0";
          else s += `${(e.value || "").length}:`; // length only — keeps PII out of logs
        });
        return s;
      }, scope);
      return `${url}||${fill}`;
    } catch {
      return Math.random().toString();
    }
  }

  // Read every filled field in the scope and save it to memory, so future
  // applications (even with differently-worded questions) reuse the answer.
  private async captureFilledFields(
    application: NonNullable<ApplicationWithRelations>,
    scope: string
  ): Promise<void> {
    try {
      const fields = await this.detectFields(scope);
      let saved = 0;
      for (const f of fields) {
        if (/^field_\d+$/i.test(f.label)) continue; // unlabeled — can't reuse meaningfully
        if (f.type === "checkbox" || f.type === "radio") continue;

        let value = "";
        if (f.type === "select") {
          value = await this.page!.$eval(
            f.selector,
            (el) => {
              const s = el as HTMLSelectElement;
              return s.options[s.selectedIndex]?.text?.trim() || "";
            }
          ).catch(() => "");
        } else {
          value = (await this.page!.inputValue(f.selector).catch(() => "")) || "";
        }

        value = value.trim();
        if (!value) continue;
        // Skip placeholder/non-answers.
        if (/^(select|choose|--|please select)/i.test(value)) continue;
        // Skip obvious TEST junk (e.g. "USA_1", "test", "asdf", "123") so a
        // throwaway value typed while debugging never poisons memory.
        if (/^(usa_?\d+|test\d*|asdf+|qwerty|xxx+|n\/?a)$/i.test(value)) continue;

        // Don't capture fields the structured Profile owns (name/email/phone/
        // country/etc.) — those come from the locked profile, and capturing a
        // form's echo of them is how junk like "USA_1 → First Name" spread.
        const owned = resolveField(f.label, this.profile);
        if (owned && (owned.spec.category === "identity" || owned.spec.category === "contact")) {
          continue;
        }

        // Human-entered = authoritative: overwrites any prior bad memory,
        // including a differently-worded near-duplicate.
        await saveHumanAnswer(f.label, value, application.job.platform);
        saved++;
        await Logger.info("APPLY", `  💾 saved your answer: "${f.label}" → "${value.slice(0, 50)}"`);
      }
      if (saved > 0) {
        await Logger.success("APPLY", `Saved ${saved} of your answers to memory for next time`);
      }
    } catch (e) {
      await Logger.warn("APPLY", `Could not capture filled fields: ${e}`);
    }
  }

  // Full-application takeover: pause, let the user finish the application in the
  // already-open browser, then VERIFY. Returns true only if we can actually
  // confirm a submission (or the user signals done and the page looks complete).
  // This is the honest alternative to assuming a submit happened.
  private async waitForHumanTakeover(
    application: NonNullable<ApplicationWithRelations>,
    reason: string,
    maxWaitMs = 8 * 60 * 1000
  ): Promise<boolean> {
    scraperStatus.waitingForUser = true;
    scraperStatus.userConfirmedSubmit = false;
    scraperStatus.reason = reason;

    await Logger.warn("APPLY", "═════════════════════════════════════════");
    await Logger.warn("APPLY", "⏸  WAITING FOR HUMAN TAKEOVER");
    await Logger.warn("APPLY", reason);
    await Logger.warn("APPLY", 'Finish in the browser, then click "I submitted it" (or Resume) on the dashboard');
    await Logger.warn("APPLY", "═════════════════════════════════════════");

    let userSaidDone = false;
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, 2000));
      // User explicitly confirmed they submitted it → trust them.
      if (scraperStatus.userConfirmedSubmit) { userSaidDone = true; break; }
      // User clicked Resume/Skip?
      if (!scraperStatus.waitingForUser) break;
      // Or the page reached a confirmation on its own while they worked.
      if (await this.detectSuccessPage().catch(() => false)) {
        await Logger.success("APPLY", "Detected confirmation page during takeover");
        break;
      }
    }
    scraperStatus.waitingForUser = false;
    const confirmedByUser = scraperStatus.userConfirmedSubmit;
    scraperStatus.userConfirmedSubmit = false;

    await this.takeStepScreenshot(application.folderPath, "after-human-takeover");

    // Capture whatever the user entered so future applications reuse it.
    await this.captureFilledFields(application, this.currentScope).catch(() => {});

    // A takeover implies the human may have submitted — allow generic success
    // detection (which is otherwise gated on our own submit click).
    this.submitClicked = true;

    // 1) Page shows a real confirmation → success.
    if (await this.detectSuccessPage().catch(() => false)) {
      await Logger.success("APPLY", "Application confirmed after human takeover");
      return true;
    }
    // 2) User explicitly asserted they submitted it → trust the human.
    if (userSaidDone || confirmedByUser) {
      await Logger.success("APPLY", "Marked submitted — you confirmed you completed it");
      return true;
    }

    await Logger.warn(
      "APPLY",
      "Could not confirm submission after takeover — marking as NOT submitted so you can retry (no false success)"
    );
    return false;
  }

  // ─── Screenshots ────────────────────────────────────────────────────────────

  private async takeStepScreenshot(folderPath: string | null, label: string): Promise<void> {
    if (!folderPath || !this.page) return;
    try {
      const buf = await this.page.screenshot({ fullPage: false });
      saveScreenshot(folderPath, buf, `${label}.png`);
    } catch { /* ignore */ }
  }
}

export const applyEngine = new ApplyEngine();
