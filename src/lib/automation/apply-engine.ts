import { chromium, BrowserContext, Page, Frame } from "playwright";
import { mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { prisma } from "@/lib/db/prisma";
import { findAnswer, suggestAnswer, saveAnswer, saveHumanAnswer, recordRejection, isRejected } from "@/lib/storage/memory";
import { Profile, resolveField } from "@/lib/profile/profile";
import { loadProfile } from "@/lib/profile/profile-store";
import { matchDropdownOptionScored } from "@/lib/profile/dropdown-intelligence";
import { getCredentials, Credentials } from "@/lib/security/credentials";
import { rememberedSelector, learnSelector, forgetSelector } from "./selector-memory";
import { claudeAnswerQuestion } from "@/lib/ai/claude";
import { saveScreenshot, saveFile } from "@/lib/storage/file-manager";
import { fetchLatestOtp } from "@/lib/gmail/otp";
import { gmailStatus } from "@/lib/gmail/client";
import { Logger } from "@/lib/logging/logger";
import { scraperStatus } from "./scraper-status";
import { detectAts, AtsAdapter, GENERIC_VALIDATION_ERROR_SELECTORS } from "./ats-adapters";
import {
  classifyField,
  validateValue,
  decideFill,
  isSensitive,
  aiMayAnswer,
} from "./field-classifier";
import { STEALTH_SCRIPT } from "./apply/stealth";
import {
  type OtpHandle,
  type DetectedField,
  type FieldDecisionRecord,
  type ApplicationWithRelations,
  getApplicationWithRelations,
  resolveResumePath,
} from "./apply/types";
import {
  FINAL_SUBMIT_SELECTORS,
  ADVANCE_SELECTORS,
  DISMISS_SELECTORS,
  OTP_LABEL_RE,
  OTP_EXCLUDE_RE,
  intentTextPatterns,
} from "./apply/selectors";
import { scanDetectFields, scanLinkedInApplyButton, scanHealClick } from "./apply/dom-scripts";

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
  // OTP codes already filled this run — guards the form loop from re-fetching /
  // re-entering the same email verification code over and over.
  private otpFilledCodes = new Set<string>();
  // Failure-recovery (#19): current application + in-memory action log for this run.
  private currentApplicationId: string | null = null;
  private actionLog: { t: string; action: string; target?: string; detail?: string }[] = [];
  // True once we've actually clicked a final Submit this run. Success can ONLY be
  // declared after this — prevents false positives from job-page URLs/copy that
  // happen to contain words like "applied" or "thank you for your interest".
  private submitClicked = false;
  // Phase 7: what the AGENT filled this run (field label → value), so when the
  // human later changes a value we can record the old one as negative memory.
  private appliedValues = new Map<string, string>();
  // Phase 9 debug/replay: per-field decisions + a monotonic fill-pass counter.
  private fieldDecisions: FieldDecisionRecord[] = [];
  private currentStep = 0;

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

  // Phase 9: record why one field was handled the way it was (for replay/debug).
  private recordFieldDecision(
    field: DetectedField,
    cls: { category: string; domKind: string },
    outcome: { decision: string; source?: string; confidence?: number; value?: string; reason?: string }
  ): void {
    const sensitive = isSensitive(cls.category as never);
    this.fieldDecisions.push({
      t: new Date().toISOString(),
      step: this.currentStep,
      label: field.label.slice(0, 120),
      category: cls.category,
      domKind: cls.domKind,
      source: outcome.source ?? null,
      confidence: outcome.confidence ?? null,
      decision: outcome.decision,
      valuePreview: outcome.value ? (sensitive ? "‹hidden›" : outcome.value.slice(0, 80)) : null,
      reason: outcome.reason ?? null,
      labelConfidence: field.labelConfidence ?? null,
      frame: field.frameKey || null,
    });
    if (this.fieldDecisions.length > 500) this.fieldDecisions.shift();
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
        fieldDecisions: this.fieldDecisions as object,
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
    this.appliedValues.clear();
    this.otpFilledCodes.clear();
    this.fieldDecisions = [];
    this.currentStep = 0;
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
        const receipt = await this.captureReceipt(application.folderPath);
        const now = new Date();
        await prisma.application.update({
          where: { id: applicationId },
          data: {
            status: "SUBMITTED",
            appliedAt: now,
            confirmedAt: now,
            confirmationText: receipt.confirmationText,
            confirmationId: receipt.confirmationId,
            screenshotPath: receipt.screenshotPath,
            recoveryState: { phase: "submitted", ts: now.toISOString() } as object,
            actionLog: this.actionLog as object,
            fieldDecisions: this.fieldDecisions as object,
          },
        });
        await prisma.job.update({ where: { id: job.id }, data: { status: "APPLIED" } });
        await Logger.success(
          "APPLY",
          `✓✓✓ Application submitted: ${job.companyName} — ${job.jobTitle}${receipt.confirmationId ? ` (ref ${receipt.confirmationId})` : ""}`
        );
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
          fieldDecisions: this.fieldDecisions as object,
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

    return this.page!.evaluate(scanLinkedInApplyButton);
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

      // Email verification step inside the modal? Auto-enter the Gmail code.
      if (await this.handleEmailVerificationIfPresent(".jobs-easy-apply-modal, .artdeco-modal")) continue;

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
      for (const q of ats.quirks || []) {
        await Logger.info("APPLY", `  ⚙ ${ats.label} quirk: ${q}`);
      }
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

      // Email verification gate? Auto-enter the code from Gmail if connected.
      if (await this.handleEmailVerificationIfPresent(scope)) continue;

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

      // Phase 8: if a final-submit button is present, REVIEW before sending.
      // A blocking issue pauses for the human instead of submitting; we only
      // fall through to "advance" when there's no submit button at all.
      if (await this.isFinalSubmitPresent(ats)) {
        const issues = await this.preSubmitReview(application, scope, ats);
        if (issues.length > 0) {
          await Logger.warn("APPLY", `⛔ Pre-submit review held back submission — ${issues.length} issue(s): ${issues.slice(0, 5).join(" · ")}`);
          await this.takeStepScreenshot(application.folderPath, `step-${step}-presubmit-blocked`);
          const progressed = await this.pauseForHumanThenCapture(
            application, scope,
            `Before submitting I found issues — fix these in the browser and I'll continue: ${issues.slice(0, 5).join("; ")}`
          );
          if (!progressed) break;
          continue; // re-scan after the human fixes them
        }
        await Logger.success("APPLY", "✓ Pre-submit review passed — submitting");
        if (await this.clickFinalSubmit(ats)) action = "submit";
      }

      if (!action && await this.clickAdvance(ats)) {
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
        // Phase 4: surface the platform's validation errors so the pause is
        // specific ("Email is invalid") rather than a generic stall message.
        const errors = await this.detectValidationErrors(ats);
        if (errors.length) {
          await Logger.warn("APPLY", `Form did not advance after ${action} — ${ats?.label || "the site"} is showing: ${errors.slice(0, 4).join(" · ")}`);
        } else {
          await Logger.warn("APPLY", `Form did not advance after ${action} — probably a required field I missed.`);
        }
        await this.takeStepScreenshot(application.folderPath, `step-${step}-stuck`);
        const msg = errors.length
          ? `The form is showing validation errors — fix these in the browser and I'll continue: ${errors.slice(0, 4).join("; ")}`
          : "Form didn't advance — please fix/fill the highlighted fields in the browser and I'll continue";
        const progressed = await this.pauseForHumanThenCapture(application, scope, msg);
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

    // ── Recovery: account exists but the password is wrong/forgotten ─────────
    // Recover it automatically (forgot-password + emailed code) instead of
    // creating a duplicate, so the candidate is never stranded mid-apply.
    const wrongPassword = await this.page!.evaluate(() => {
      const t = (document.body.innerText || "").toLowerCase();
      return t.includes("incorrect") || t.includes("does not match") || t.includes("password you entered");
    }).catch(() => false);
    if (wrongPassword && (await this.workdayPasswordRecovery(email, password))) return true;

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

    if (await this.workdayIsAuthed()) return true;

    // Create-account rejected because the email is already registered → recover.
    const alreadyExists = await this.page!.evaluate(() =>
      (document.body.innerText || "").toLowerCase().includes("already exists")
    ).catch(() => false);
    if (alreadyExists && (await this.workdayPasswordRecovery(email, password))) return true;

    // Workday usually emails a verification code on account creation — if Gmail
    // is connected, fetch + enter it automatically, then re-check auth.
    if (await this.handleEmailVerificationIfPresent()) {
      await this.delay(1500, 2500);
      if (await this.workdayIsAuthed()) return true;
    }

    return this.workdayIsAuthed();
  }

  // Workday password recovery: when an account exists but sign-in fails (wrong /
  // forgotten password), run the "Forgot password" flow — request a reset email,
  // read the emailed code via Gmail (reusing the OTP gate handler), set a new
  // password (the stored one), and continue. Returns true only if it ends
  // authenticated; otherwise the caller falls back to human takeover. Needs
  // Gmail connected — there's no way to read the reset code without it.
  private async workdayPasswordRecovery(email: string, newPassword: string): Promise<boolean> {
    const status = await gmailStatus().catch(() => null);
    if (!status?.connected) {
      await Logger.warn("APPLY", "Workday password reset needs Gmail connected to read the code — handing to you");
      return false;
    }
    await Logger.info("APPLY", "Workday: account exists — attempting automated password recovery");
    this.logAction("workday_recovery", email);

    // 1) Open the forgot-password form.
    const opened = await this.clickFirstVisible(
      ['[data-automation-id="forgotPasswordLink"]', 'a:has-text("Forgot")', 'button:has-text("Forgot")'],
      "Workday → Forgot Password"
    );
    if (!opened) return false;
    await this.delay(1200, 2200);

    // 2) Enter the email + submit the reset request.
    const emailEl = await this.page!
      .$('input[data-automation-id="email"], input[data-automation-id="userName"], input[type="email"]')
      .catch(() => null);
    if (emailEl) { await emailEl.fill(email).catch(() => {}); await this.delay(300, 600); }
    await this.clickFirstVisible(
      ['[data-automation-id="email-form-submit-button"]', 'button:has-text("Reset")', 'button:has-text("Send")', 'button:has-text("Submit")', 'button[type="submit"]'],
      "Workday Reset Request"
    );
    await this.delay(3500, 5500);

    // 3) Fetch + enter the emailed reset code (reuses the OTP gate handler).
    if (!(await this.handleEmailVerificationIfPresent())) {
      await Logger.warn("APPLY", "Workday reset code didn't arrive / couldn't be entered — handing to you");
      return false;
    }
    await this.delay(2000, 3500);

    // 4) Set a new password (the stored one) on the reset form.
    const newPassEl = await this.page!
      .$('input[data-automation-id="newPassword"], input[data-automation-id="password"], input[type="password"]:not([data-automation-id="verifyNewPassword"]):not([data-automation-id="verifyPassword"])')
      .catch(() => null);
    if (newPassEl && (await newPassEl.isVisible().catch(() => false))) {
      await newPassEl.fill(newPassword).catch(() => {});
      const verifyEl = await this.page!
        .$('input[data-automation-id="verifyNewPassword"], input[data-automation-id="verifyPassword"]')
        .catch(() => null);
      if (verifyEl) await verifyEl.fill(newPassword).catch(() => {});
      await this.delay(300, 600);
      await this.clickFirstVisible(
        ['[data-automation-id="submitButton"]', 'button:has-text("Change Password")', 'button:has-text("Submit")', 'button:has-text("Save")', 'button[type="submit"]'],
        "Workday Set New Password"
      );
      await this.delay(3000, 4500);
    }

    const ok = await this.workdayIsAuthed();
    if (ok) await Logger.success("APPLY", "Workday password recovery succeeded — continuing");
    return ok;
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

  // ─── Email OTP / verification-code gate (Gmail) ─────────────────────────────
  // Many ATS account flows email a one-time code ("we sent a code to your
  // email"). When Gmail is connected, fetch the freshly-emailed code and enter
  // it automatically; otherwise return false so the existing human-takeover path
  // handles it. Returns true only when a code was filled + submitted.
  // OTP_LABEL_RE / OTP_EXCLUDE_RE now live in ./apply/selectors.
  private async handleEmailVerificationIfPresent(scope: string = "body"): Promise<boolean> {
    // Cheap pre-check: any code-ish input or one-time-code field on the page?
    const quick = await this.page!
      .$(
        'input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[name*="code" i], input[id*="code" i], input[placeholder*="code" i], input[aria-label*="code" i]'
      )
      .catch(() => null);

    const verifyContext = await this.page!
      .evaluate(() => {
        const t = (document.body.innerText || "").toLowerCase();
        return /(verify your email|check your (?:email|inbox)|we (?:sent|emailed)|enter the code|one[\s-]?time (?:code|password|pin)|verification code|security code|confirmation code|passcode)/.test(
          t
        );
      })
      .catch(() => false);

    if (!quick && !verifyContext) return false; // not an OTP gate

    // Gmail must be connected to auto-fetch the code.
    const status = await gmailStatus().catch(() => null);
    if (!status?.connected) {
      if (verifyContext) {
        await Logger.warn(
          "APPLY",
          "Email verification needed but Gmail isn't connected — connect it in the dashboard, or enter the code manually."
        );
      }
      return false;
    }

    const gate = await this.findOtpInputs(verifyContext);
    if (!gate) return false;

    await Logger.info("APPLY", "📧 Email verification detected — fetching the code from Gmail…");
    this.logAction("otp_gate", scope);

    const since = Date.now() - 60_000; // accept a code emailed up to 60s before we noticed
    const otp = await fetchLatestOtp({ since, timeoutMs: 90_000, pollMs: 5_000 }).catch(() => null);
    if (!otp) {
      await Logger.warn("APPLY", "No verification code arrived in Gmail within 90s — leaving it for human takeover.");
      return false;
    }
    if (this.otpFilledCodes.has(otp.code)) return false; // already tried this code; don't loop

    await Logger.success(
      "APPLY",
      `📧 Got verification code from ${otp.message.fromEmail || "email"} — entering it`
    );
    const filled = await this.fillOtp(gate, otp.code);
    if (!filled) return false;
    this.otpFilledCodes.add(otp.code);

    // Record the OTP retrieval for the inbox / audit trail.
    await prisma.emailEvent
      .upsert({
        where: { gmailId: otp.message.id },
        create: {
          gmailId: otp.message.id,
          threadId: otp.message.threadId || null,
          fromEmail: otp.message.fromEmail || null,
          fromName: otp.message.fromName || null,
          subject: otp.message.subject || null,
          snippet: otp.message.snippet || null,
          receivedAt: otp.message.date,
          isOtp: true,
          otpCode: otp.code,
          applicationId: this.currentApplicationId,
        },
        update: { isOtp: true, otpCode: otp.code, applicationId: this.currentApplicationId },
      })
      .catch(() => {});

    // Submit the code (Verify / Confirm / Continue / Submit).
    await this.delay(400, 800);
    const clicked = await this.clickFirstVisible(
      [
        'button:has-text("Verify")',
        'button:has-text("Confirm")',
        'button:has-text("Continue")',
        'button:has-text("Submit")',
        'button:has-text("Next")',
        'button[type="submit"]',
      ],
      "Verify code"
    );
    if (!clicked) await this.page!.keyboard.press("Enter").catch(() => {});
    await this.page!.waitForLoadState("networkidle").catch(() => null);
    await this.delay(2000, 3500);
    return true;
  }

  // Locate the verification-code input(s): a single field or a row of
  // single-character "segmented" boxes. verifyContext loosens the match so a
  // generic code field counts when the page clearly asks for an email code.
  private async findOtpInputs(
    verifyContext: boolean
  ): Promise<
    | { mode: "single"; handle: OtpHandle }
    | { mode: "segmented"; handles: OtpHandle[] }
    | null
  > {
    const candidates = await this.page!
      .$$('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="password"])')
      .catch(() => [] as OtpHandle[]);

    type Meta = {
      name: string; id: string; placeholder: string; aria: string;
      autocomplete: string; maxLength: number; label: string; value: string;
    };
    const visible: { h: OtpHandle; meta: Meta }[] = [];
    for (const h of candidates) {
      if (!(await h.isVisible().catch(() => false))) continue;
      const meta = await h
        .evaluate((el) => {
          const i = el as HTMLInputElement;
          let label = "";
          if (i.id) {
            const l = document.querySelector(`label[for="${CSS.escape(i.id)}"]`);
            if (l) label = l.textContent || "";
          }
          if (!label) { const p = i.closest("label"); if (p) label = p.textContent || ""; }
          return {
            name: i.name || "", id: i.id || "", placeholder: i.placeholder || "",
            aria: i.getAttribute("aria-label") || "", autocomplete: i.autocomplete || "",
            maxLength: i.maxLength, label: (label || "").trim(), value: i.value || "",
          };
        })
        .catch(() => null);
      if (meta) visible.push({ h, meta });
    }
    if (!visible.length) return null;

    // Segmented: ≥4 single-char inputs (maxLength 1) — common for 6-digit codes.
    const segmented = visible.filter((v) => v.meta.maxLength === 1);
    if (
      segmented.length >= 4 &&
      (verifyContext || segmented.some((v) => /otp|code|pin/i.test(`${v.meta.name}${v.meta.id}${v.meta.aria}`)))
    ) {
      return { mode: "segmented", handles: segmented.map((v) => v.h) };
    }

    // Single field whose label/attrs look like a verification code.
    const score = (v: { meta: Meta }): number => {
      const hay = `${v.meta.label} ${v.meta.name} ${v.meta.id} ${v.meta.placeholder} ${v.meta.aria}`;
      if (OTP_EXCLUDE_RE.test(hay)) return -1;
      if (v.meta.autocomplete === "one-time-code") return 3;
      if (OTP_LABEL_RE.test(hay)) return 2;
      if (verifyContext && /\bcode\b|otp|pin/i.test(hay)) return 1;
      return 0;
    };
    const best = visible
      .map((v) => ({ v, s: score(v) }))
      .filter((x) => x.s > 0 && !x.v.meta.value)
      .sort((a, b) => b.s - a.s)[0];
    return best ? { mode: "single", handle: best.v.h } : null;
  }

  // Type the code into either a single field or the segmented boxes.
  private async fillOtp(
    gate: { mode: "single"; handle: OtpHandle } | { mode: "segmented"; handles: OtpHandle[] },
    code: string
  ): Promise<boolean> {
    try {
      if (gate.mode === "single") {
        await gate.handle.fill("").catch(() => {});
        await gate.handle.type(code, { delay: 60 });
        return true;
      }
      const chars = code.split("");
      for (let i = 0; i < gate.handles.length && i < chars.length; i++) {
        await gate.handles[i].fill("").catch(() => {});
        await gate.handles[i].type(chars[i], { delay: 60 }).catch(() => {});
      }
      return true;
    } catch {
      return false;
    }
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

      // Email verification gate? Auto-enter the code from Gmail if connected.
      if (await this.handleEmailVerificationIfPresent(scope)) continue;

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
      const wdAts = detectAts(this.page!.url());
      // Phase 8: review before any Workday final submit.
      if (await this.isFinalSubmitPresent(wdAts)) {
        const issues = await this.preSubmitReview(application, scope, wdAts);
        if (issues.length > 0) {
          await Logger.warn("APPLY", `⛔ Pre-submit review held back Workday submission — ${issues.length} issue(s): ${issues.slice(0, 5).join(" · ")}`);
          const progressed = await this.pauseForHumanThenCapture(
            application, scope,
            `Before submitting I found issues — fix these in the browser and I'll continue: ${issues.slice(0, 5).join("; ")}`
          );
          if (!progressed) break;
          continue;
        }
        if (await this.clickFinalSubmit()) action = "submit";
      }
      if (!action && await this.clickAdvance()) action = "advance";

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
        const wdAdapter = detectAts(this.page!.url());
        const errors = await this.detectValidationErrors(wdAdapter);
        if (errors.length) {
          await Logger.warn("APPLY", `Workday didn't advance — showing: ${errors.slice(0, 4).join(" · ")}`);
        }
        const msg = errors.length
          ? `Workday is showing validation errors — fix these in the browser and I'll continue: ${errors.slice(0, 4).join("; ")}`
          : "Workday didn't advance — fix the highlighted fields and I'll continue";
        const progressed = await this.pauseForHumanThenCapture(application, scope, msg);
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
  // The selectors that identify a genuine FINAL submit button (shared by the
  // clicker and the pre-submit probe).
  private finalSubmitCandidates(ats?: AtsAdapter | null): string[] {
    return [...(ats?.submitButtons || []), ...FINAL_SUBMIT_SELECTORS];
  }

  // Is a final-submit button visible right now (without clicking it)? Used to
  // decide whether to run the Phase 8 pre-submit review this step.
  private async isFinalSubmitPresent(ats?: AtsAdapter | null): Promise<boolean> {
    for (const sel of this.finalSubmitCandidates(ats)) {
      const el = await this.page!.$(sel).catch(() => null);
      if (el && await el.isVisible().catch(() => false)) return true;
    }
    return false;
  }

  private async clickFinalSubmit(ats?: AtsAdapter | null): Promise<boolean> {
    const clicked = await this.clickFirstVisible(this.finalSubmitCandidates(ats), "Submit");
    // Mark that a real final-submit happened — gates success detection so we
    // never declare success on a job page we merely navigated to.
    if (clicked) this.submitClicked = true;
    return clicked;
  }

  // Click a button that ADVANCES to the next step of a multi-step form.
  private async clickAdvance(ats?: AtsAdapter | null): Promise<boolean> {
    const candidates = [...(ats?.advanceButtons || []), ...ADVANCE_SELECTORS];
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

  // Find + click the best-matching visible button/link by text for `kind`.
  // Returns true and learns a stable selector if it succeeds. The DOM scan +
  // intent→text patterns now live in ./apply/dom-scripts + ./apply/selectors.
  private async healClick(kind: string): Promise<boolean> {
    const rx = intentTextPatterns(kind);
    const found = await this.page!
      .evaluate(scanHealClick, { src: rx.source, flags: rx.flags })
      .catch(() => null);

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

  // Phase 4: read any visible validation-error messages so a stuck step can
  // explain WHY (which field the ATS rejected) instead of a generic message.
  // Uses the adapter's selectors first, then generic ARIA/class conventions.
  private async detectValidationErrors(ats?: AtsAdapter | null): Promise<string[]> {
    const selectors = [...(ats?.validationErrorSelectors || []), ...GENERIC_VALIDATION_ERROR_SELECTORS];
    try {
      return await this.page!.evaluate((sels: string[]) => {
        const out = new Set<string>();
        for (const sel of sels) {
          let nodes: Element[];
          try { nodes = Array.from(document.querySelectorAll(sel)); } catch { continue; }
          for (const n of nodes) {
            const el = n as HTMLElement;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            let text = (el.innerText || "").replace(/\s+/g, " ").trim();
            // aria-invalid inputs carry no text — identify by label/name instead.
            if (!text) {
              const inp = el as HTMLInputElement;
              const lblFor = inp.id ? document.querySelector(`label[for="${CSS.escape(inp.id)}"]`) : null;
              text = (lblFor?.textContent || inp.name || "").replace(/\s+/g, " ").trim();
              if (text) text = `“${text}” needs attention`;
            }
            if (text && text.length <= 160) out.add(text);
          }
        }
        return [...out].slice(0, 8);
      }, selectors);
    } catch {
      return [];
    }
  }

  // Phase 8: pre-submit verification. Scans every filled field one last time and
  // returns a list of human-readable issues. A non-empty list MUST block the
  // final submit — we pause for the human instead of sending a bad application.
  private async preSubmitReview(
    application: NonNullable<ApplicationWithRelations>,
    scope: string,
    ats?: AtsAdapter | null
  ): Promise<string[]> {
    const issues: string[] = [];

    // 1) Validation errors already visible on the page.
    for (const e of (await this.detectValidationErrors(ats)).slice(0, 4)) {
      issues.push(`form error: ${e}`);
    }

    // 2) Per-field scan.
    const fields = await this.detectFields(scope);
    const valueToLabels = new Map<string, string[]>();
    for (const f of fields) {
      if (/^field_\d+$/i.test(f.label)) continue;
      // Choice/ARIA controls have no readable text value here; their state is
      // trusted (apply self-verifies) and required-but-empty is handled below.
      const isChoice = ["checkbox", "radio", "aria-radio", "aria-combobox"].includes(f.type);
      const frame = this.frameByKey(f.frameKey);
      let value = "";
      try {
        if (isChoice) {
          value = "";
        } else if (f.type === "select") {
          value = await frame.$eval(f.selector, (el) => {
            const s = el as HTMLSelectElement;
            return s.options[s.selectedIndex]?.text?.trim() || "";
          }).catch(() => "");
        } else {
          value = (await frame.inputValue(f.selector).catch(() => "")) || "";
        }
      } catch { /* ignore unreadable field */ }
      value = value.trim();

      const cls = classifyField({
        label: f.label, type: f.type, name: f.name,
        placeholder: f.placeholder, ariaLabel: f.ariaLabel,
        sectionHeading: f.sectionHeading, options: f.options, required: f.required,
      });

      // Required but empty (text/select only — choice controls handled separately).
      if (f.required && !value && !isChoice) {
        issues.push(`required field empty: "${f.label.slice(0, 40)}"`);
        continue;
      }
      // Dropdown left on its placeholder.
      if (f.type === "select" && value && /^(select|choose|--|please|none)\b/i.test(value.toLowerCase())) {
        issues.push(`dropdown not chosen: "${f.label.slice(0, 40)}"`);
      }
      // A value that doesn't fit the field (email in name box, prose in yes/no…).
      if (value && !isChoice) {
        const v = validateValue(cls, value, f.options);
        if (!v.ok) issues.push(`"${f.label.slice(0, 40)}": ${v.reason}`);
      }
      // Sensitive/legal field that somehow got a value with no profile backing.
      if (value && isSensitive(cls.category)) {
        const res = resolveField(f.label, this.profile);
        if (!res?.field?.value?.trim()) {
          issues.push(`sensitive field filled without a profile value: "${f.label.slice(0, 40)}"`);
        }
      }
      // Collect non-trivial values to detect the same answer repeated everywhere.
      if (value && value.length > 3 && !isChoice) {
        const k = value.toLowerCase();
        (valueToLabels.get(k) ?? valueToLabels.set(k, []).get(k)!).push(f.label);
      }
    }

    // 3) Same value pasted into many unrelated fields (classic contamination).
    for (const [, labels] of valueToLabels) {
      if (labels.length >= 3) {
        issues.push(`same value in ${labels.length} fields (${labels.slice(0, 3).map((l) => l.slice(0, 20)).join(", ")})`);
        break;
      }
    }

    // 4) Résumé expected but no file attached to any native file input.
    if (resolveResumePath(application.tailoredResume?.pdfPath)) {
      const fileMissing = await this.page!.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input[type="file"]')) as HTMLInputElement[];
        const resumeInputs = inputs.filter((i) =>
          /resume|cv|curriculum/i.test((i.name || "") + (i.id || "") + (i.getAttribute("aria-label") || ""))
        );
        if (resumeInputs.length === 0) return false; // no obvious resume input → can't tell, don't flag
        return resumeInputs.every((i) => !i.files || i.files.length === 0);
      }).catch(() => false);
      if (fileMissing) issues.push("résumé file doesn't appear to be attached");
    }

    return issues;
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
    for (const sel of DISMISS_SELECTORS) {
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
    this.currentStep++; // Phase 9: monotonic fill-pass number for replay grouping
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

  // Detect fields across EVERY frame, not just the top document. Workday,
  // iCIMS, and embedded Greenhouse render their forms inside iframes — the old
  // top-frame-only scan literally couldn't see those fields, which is the main
  // cause of "left blank" failures. Each field is tagged with its owning frame
  // so the fill path targets the right document. The main frame uses the caller
  // `scope`; child frames are scanned whole (their document IS the form).
  private async detectFields(scope: string): Promise<DetectedField[]> {
    const page = this.page!;
    const frames = page.frames();
    const out: DetectedField[] = [];
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      const url = frame.url();
      if (i > 0 && this.isThirdPartyFrame(url)) continue; // skip ads / captcha / analytics noise
      const frameScope = i === 0 ? scope : "body";
      let fields: DetectedField[] = [];
      try {
        fields = (await frame.evaluate(scanDetectFields, frameScope)) as DetectedField[];
      } catch {
        continue; // detached / navigating frame — skip this pass
      }
      const key = i === 0 ? "" : `${i}|${url}`;
      for (const f of fields) {
        f.frameKey = key;
        out.push(f);
      }
    }
    return out;
  }

  // Resolve a field's owning frame from its key ("idx|url"); fall back to the
  // main frame. Detect→fill happens in the same tick, so frame order is stable;
  // we still match on url to survive the rare reorder.
  private frameByKey(key?: string): Frame {
    const page = this.page!;
    if (!key) return page.mainFrame();
    const frames = page.frames();
    const sep = key.indexOf("|");
    const idx = Number(key.slice(0, sep));
    const url = key.slice(sep + 1);
    const atIdx = frames[idx];
    if (atIdx && atIdx.url() === url) return atIdx;
    return frames.find((f) => f.url() === url) || atIdx || page.mainFrame();
  }

  // Frames we never want to fill into — third-party widgets that show up as
  // iframes on application pages but never contain the application form.
  private isThirdPartyFrame(url: string): boolean {
    return /recaptcha|hcaptcha|gstatic\.com|google\.com\/recaptcha|doubleclick|googletagmanager|google-analytics|youtube\.com|facebook\.com|twitter\.com|linkedin\.com\/(li\/|px\/)|datadoghq|segment\.|hotjar|intercom|drift\.com|optimizely/i.test(url);
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
    if (!["radio", "checkbox", "select", "aria-radio", "aria-combobox"].includes(field.type)) {
      try {
        const cur = await this.frameByKey(field.frameKey).inputValue(field.selector).catch(() => "");
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
      placeholder: field.placeholder,
      ariaLabel: field.ariaLabel,
      sectionHeading: field.sectionHeading,
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
        this.recordFieldDecision(field, cls, { decision: "pause", reason: "sensitive — not set in profile" });
        return false;
      }
    } else if (isSensitive(cls.category)) {
      // Classified sensitive but no profile spec matched → still never guess.
      await Logger.warn("APPLY", `  🔒 sensitive [${cls.category}] "${field.label.slice(0, 60)}" not in profile — will ask you (no AI/memory guessing)`);
      this.recordFieldDecision(field, cls, { decision: "pause", reason: "sensitive — not set in profile" });
      return false;
    }

    // 1) Memory (exact + semantic) — never for sensitive categories. Ignore a
    //    stored value that fails validation (protects against poisoned memory).
    //    suggestAnswer returns a calibrated confidence (exact > semantic) which
    //    we cap by category trust so an unknown-category memory still pauses.
    if (!answer && !isSensitive(cls.category)) {
      const sug = await suggestAnswer(field.label);
      if (sug && accept(sug.answer)) {
        answer = sug.answer;
        // Known category: trust the suggestion's confidence (≤0.9, so it stays
        // in fill-and-verify, never blind autofill). Unknown category: cap low
        // so it pauses for review.
        confidence = cls.category === "unknown" ? Math.min(0.6, sug.confidence) : sug.confidence;
        source = cls.category === "unknown" ? `memory-unverified(${sug.source})` : `memory(${sug.source})`;
        await Logger.info("APPLY", `  💾 memory[${sug.source} ${Math.round(sug.confidence * 100)}%]: "${field.label.slice(0, 60)}" → "${answer.slice(0, 60)}"`);
      } else if (sug) {
        await Logger.warn("APPLY", `  ✗ ignoring memory "${sug.answer.slice(0, 40)}…" — fails [${cls.category}/${cls.domKind}] validation`);
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
          const aiResult = await claudeAnswerQuestion(field.label, resumeData, answeredQuestions, {
            profileFacts: this.profileFactsString(),
            jobDescription: application.job.description || undefined,
            companyName: application.job.companyName,
            jobTitle: application.job.jobTitle,
            maxLength: field.maxLength,
          });
          const cand = aiResult.answer?.trim() || "";
          // Phase 7: never re-propose a value the human previously rejected here.
          if (cand && (await isRejected(field.label, cand))) {
            await Logger.warn("APPLY", `  🚫 AI suggested a previously-rejected answer for "${field.label.slice(0, 50)}" — leaving blank`);
          } else if (cand && accept(cand)) {
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
      this.recordFieldDecision(field, cls, { decision: "pause", reason: aiMayAnswer(cls.category) ? "no value found" : "AI not allowed for this category; no saved value" });
      return false;
    }

    // Final validation guard (defense in depth): never write a value that
    // doesn't fit the field — e.g. prose into a URL/yes-no/email box.
    if (!accept(answer)) {
      const why = validateValue(cls, answer, field.options).reason || "invalid";
      await Logger.warn("APPLY", `  ✗ rejecting "${answer.slice(0, 40)}…" — ${why} for [${cls.category}/${cls.domKind}] "${field.label.slice(0, 40)}"`);
      this.recordFieldDecision(field, cls, { decision: "reject", source, value: answer, reason: why });
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
      this.recordFieldDecision(field, cls, { decision: "pause", source, confidence: effConfidence, value: answer, reason: why });
      return false;
    }

    let applied = await this.applyAnswer(field, answer, resolution?.spec.kind, !isSensitive(cls.category));

    // Retry loop: a choice field (select/radio/aria) may list the answer under
    // different wording than the profile value (e.g. profile "Master's" vs the
    // dropdown's "Graduate Degree"). For NON-sensitive fields only, try one
    // alternative phrasing from memory before giving up.
    if (
      !applied &&
      !isSensitive(cls.category) &&
      ["select", "radio", "aria-radio", "aria-combobox"].includes(field.type)
    ) {
      const alt = await findAnswer(field.label).catch(() => null);
      if (alt && alt !== answer && accept(alt)) {
        await Logger.info("APPLY", `  ↻ retrying "${field.label.slice(0, 40)}" with alternative "${alt.slice(0, 30)}"`);
        applied = await this.applyAnswer(field, alt, resolution?.spec.kind, true);
        if (applied) {
          answer = alt;
          source = source ? `${source}→memory-alt` : "memory-alt";
        }
      }
    }

    if (!applied) {
      // Couldn't confidently apply (e.g. no/ambiguous dropdown option) — pause.
      await Logger.warn("APPLY", `  ⚠ couldn't apply a clear value to "${field.label.slice(0, 50)}" (${cls.domKind}) — leaving blank for your review`);
      this.recordFieldDecision(field, cls, { decision: "pause", source, confidence: effConfidence, value: answer, reason: "couldn't apply (no/ambiguous option)" });
      return false;
    }
    // Phase 7: remember what we put here so a later human edit becomes a
    // learned correction (old value → negative memory).
    this.appliedValues.set(field.label, answer);

    // 85-94% → verify the value actually landed; if not, hand to human.
    if (decision === "fill_and_verify") {
      const ok = await this.verifyFieldValue(field, answer);
      if (!ok) {
        await Logger.warn("APPLY", `  ⚠ verify failed for "${field.label}" (${source}) — pausing for review`);
        this.recordFieldDecision(field, cls, { decision: "pause", source, confidence: effConfidence, value: answer, reason: "value didn't land (verify failed)" });
        return false;
      }
      await Logger.info("APPLY", `  ✓ verified "${field.label.slice(0, 50)}" (${Math.round(effConfidence * 100)}%)`);
    }
    this.recordFieldDecision(field, cls, {
      decision: decision === "fill_and_verify" ? "verified" : "filled",
      source, confidence: effConfidence, value: answer,
    });
    return true;
  }

  // Read back a text/select field to confirm our value actually applied.
  // Radios/checkboxes are trusted (toggleCheckable already self-verifies).
  private async verifyFieldValue(field: DetectedField, expected: string): Promise<boolean> {
    // Checkables (native + ARIA) self-verify on apply; the click either took or
    // it didn't, and there's no readable text value to compare against.
    if (["radio", "checkbox", "aria-radio", "aria-combobox"].includes(field.type)) return true;
    const frame = this.frameByKey(field.frameKey);
    try {
      if (field.type === "select") {
        const text = await frame.$eval(field.selector, (el) => {
          const s = el as HTMLSelectElement;
          return s.options[s.selectedIndex]?.text?.trim().toLowerCase() || "";
        }).catch(() => "");
        // A non-empty, non-placeholder selection counts as success.
        return !!text && !/^(select|choose|--|please)/.test(text);
      }
      const cur = (await frame.inputValue(field.selector).catch(() => "")) || "";
      if (!cur.trim()) return false;
      // Field-shortening (truncation/formatting) is fine — check overlap.
      const a = cur.toLowerCase().trim(), b = expected.toLowerCase().trim();
      return a === b || a.includes(b.slice(0, 12)) || b.includes(a.slice(0, 12));
    } catch {
      return false;
    }
  }

  // Phase 6: format the structured profile into grounding facts for the
  // open-ended answer engine. Sensitive values (visa/EEO/salary) are excluded —
  // the AI must never reference them in an essay answer.
  private profileFactsString(): string {
    const EXCLUDE = new Set([
      "workAuthorized", "requiresSponsorship", "cptEligible", "optEligible",
      "stemOptEligible", "citizenship", "gender", "race", "veteranStatus",
      "disabilityStatus", "pronouns", "lgbtq", "salaryExpectation",
    ]);
    const lines: string[] = [];
    for (const [key, f] of Object.entries(this.profile)) {
      if (EXCLUDE.has(key)) continue;
      const v = (f?.value || "").trim();
      if (v) lines.push(`${key}: ${v}`);
    }
    return lines.join("\n");
  }

  // Quick resume shortcuts — saves AI calls for obvious questions
  private shortcutFromResume(label: string, resumeData: Record<string, unknown>): string | null {
    const l = label.toLowerCase();
    const contact = (resumeData.contactInfo as Record<string, string>) || {};
    const experience = Array.isArray(resumeData.experience)
      ? (resumeData.experience as Record<string, unknown>[])
      : [];
    const latestExperience =
      experience.find((e) => e?.current === true || /present|current/i.test(String(e?.endDate || ""))) ||
      experience[0];
    const expValue = (key: string): string | null => {
      const v = latestExperience?.[key];
      return typeof v === "string" && v.trim() ? v.trim() : null;
    };

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
    if (l.match(/^(job\s*)?title\b|position\b|role\b/)) return expValue("title");
    if (l.match(/\b(company|employer|organization)\b/)) return expValue("company");
    if (l.match(/\b(from|start)\s*date\b/)) return expValue("startDate");
    if (l.match(/\b(to|end)\s*date\b/)) return expValue("endDate") || "Present";
    if (l.includes("city") || l.includes("location") || l.includes("address")) return contact.location || null;
    return null;
  }

  // Apply a value to a field. Returns false when it could NOT confidently set
  // the value (no dropdown/radio option matched, or the match was ambiguous) so
  // the caller can pause for the human instead of leaving a wrong/blank choice.
  private async applyAnswer(field: DetectedField, answer: string, kind?: string, allowFallback = false): Promise<boolean> {
    // Operate inside the frame that actually owns the field (iframe ATS forms).
    const frame = this.frameByKey(field.frameKey);

    if (field.type === "select") {
      const options = await frame.$$eval(
        `${field.selector} option`,
        (opts) => opts.map((o) => ({ value: (o as HTMLOptionElement).value, text: o.textContent?.trim() || "" }))
      ).catch(() => [] as { value: string; text: string }[]);

      // Phase 5: scored, deterministic match (state/country/degree/yesno aware).
      // Never type blindly — match against the REAL options, and pause when the
      // best match is weak or ambiguous between two options. For non-sensitive
      // fields, allowFallback lets a substring/token-overlap resolve a tie.
      const m = matchDropdownOptionScored(answer, options, kind, { allowFallback });
      if (!m.value || m.ambiguous) {
        await Logger.warn(
          "APPLY",
          `  ⚠ ${m.ambiguous ? "ambiguous" : "no"} dropdown match for "${answer.slice(0, 30)}" in "${field.label.slice(0, 40)}" (${options.length} options) — leaving for you`
        );
        return false;
      }
      await frame.selectOption(field.selector, m.value).catch(() => {});
      return true;
    } else if (field.type === "radio") {
      const radios = await frame.$$(field.selector);
      // Read each radio's label, then reuse the same scored matcher (options
      // keyed by index) so radios get identical synonym/ambiguity handling.
      const labels: string[] = [];
      for (const radio of radios) {
        labels.push(
          await radio.evaluate((el) => {
            const id = (el as HTMLInputElement).id;
            const r = el.getRootNode() as Document | ShadowRoot;
            const lbl = id ? r.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent?.trim() : "";
            return (lbl || (el as HTMLInputElement).value || "").trim();
          }).catch(() => "")
        );
      }
      const opts = labels.map((t, i) => ({ value: String(i), text: t }));
      const m = matchDropdownOptionScored(answer, opts, kind, { allowFallback });
      if (m.value === null || m.ambiguous) {
        await Logger.warn(
          "APPLY",
          `  ⚠ ${m.ambiguous ? "ambiguous" : "no"} radio match for "${answer.slice(0, 30)}" in "${field.label.slice(0, 40)}" — leaving for you`
        );
        return false;
      }
      await this.toggleCheckable(radios[Number(m.value)], true);
      return true;
    } else if (field.type === "aria-radio") {
      // div[role=radiogroup] with [role=radio] children — no native input to
      // toggle, so match by accessible label and click the chosen option.
      const radios = await frame.$$(`${field.selector} [role="radio"]`);
      const labels: string[] = [];
      for (const r of radios) {
        labels.push(
          await r.evaluate((el) => (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim()).catch(() => "")
        );
      }
      const opts = labels.map((t, i) => ({ value: String(i), text: t }));
      const m = matchDropdownOptionScored(answer, opts, kind, { allowFallback });
      if (m.value === null || m.ambiguous) {
        await Logger.warn("APPLY", `  ⚠ ${m.ambiguous ? "ambiguous" : "no"} ARIA-radio match for "${answer.slice(0, 30)}" in "${field.label.slice(0, 40)}" — leaving for you`);
        return false;
      }
      await radios[Number(m.value)].click({ timeout: 3000 }).catch(() => {});
      return true;
    } else if (field.type === "aria-combobox") {
      return this.fillAriaCombobox(frame, field, answer, kind, allowFallback);
    } else if (field.type === "checkbox") {
      const shouldCheck = /yes|true|agree|accept|authorize|confirm|check|i certify|acknowledge/i.test(answer);
      const cb = await frame.$(field.selector);
      if (!cb) return false;
      await this.toggleCheckable(cb, shouldCheck);
      return true;
    } else if (field.inputType === "range") {
      // A slider has no safe deterministic mapping from a text answer — never
      // guess a position; pause for the human.
      return false;
    } else {
      await frame.fill(field.selector, answer).catch(() => {});
      return true;
    }
  }

  // Fill a pure-ARIA combobox (button + popup listbox, no backing <input>):
  // open it, read the now-visible options, scored-match, and click — or pause.
  // Custom widgets vary wildly, so anything uncertain returns false (human).
  private async fillAriaCombobox(frame: Frame, field: DetectedField, answer: string, kind?: string, allowFallback = false): Promise<boolean> {
    try {
      const control = await frame.$(field.selector);
      if (!control) return false;
      await control.click({ timeout: 3000 }).catch(() => {});
      await this.delay(300, 650);

      const raw = await frame.$$('[role="option"]');
      const visible: { handle: import("playwright").ElementHandle<Element>; text: string }[] = [];
      for (const o of raw) {
        if (!(await o.isVisible().catch(() => false))) continue;
        const text = await o.evaluate((e) => (e.textContent || "").replace(/\s+/g, " ").trim()).catch(() => "");
        if (text) visible.push({ handle: o, text });
      }
      if (!visible.length) return false;

      const opts = visible.map((v, i) => ({ value: String(i), text: v.text }));
      const m = matchDropdownOptionScored(answer, opts, kind, { allowFallback });
      if (m.value === null || m.ambiguous) {
        await Logger.warn("APPLY", `  ⚠ ${m.ambiguous ? "ambiguous" : "no"} combobox match for "${answer.slice(0, 30)}" in "${field.label.slice(0, 40)}" — leaving for you`);
        return false;
      }
      await visible[Number(m.value)].handle.click({ timeout: 2000 }).catch(() => {});
      return true;
    } catch {
      return false;
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
        const owner = (await handle.ownerFrame().catch(() => null)) || this.page!.mainFrame();
        const lbl = await owner.$(`label[for="${id}"]`);
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
      const page = this.page!;
      const url = page.url().split("?")[0];
      const frames = page.frames();
      const snap = async (frame: Frame, sel: string): Promise<string> =>
        frame.evaluate((s: string) => {
          const root = document.querySelector(s) || document.body;
          if (!root) return "";
          const els = root.querySelectorAll("input, textarea, select");
          let out = "";
          els.forEach((el) => {
            const e = el as HTMLInputElement;
            if (e.type === "checkbox" || e.type === "radio") out += e.checked ? "1" : "0";
            else out += `${(e.value || "").length}:`; // length only — keeps PII out of logs
          });
          return out;
        }, sel).catch(() => "");
      let fill = "";
      for (let i = 0; i < frames.length; i++) {
        if (i > 0 && this.isThirdPartyFrame(frames[i].url())) continue;
        fill += await snap(frames[i], i === 0 ? scope : "body");
      }
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
        if (["checkbox", "radio", "aria-radio", "aria-combobox"].includes(f.type)) continue;
        // Never memorize one-time / email verification codes — they're single-use,
        // so a captured "Security code" → "B" would only poison future applies.
        if (OTP_LABEL_RE.test(f.label) && !OTP_EXCLUDE_RE.test(f.label)) continue;

        const frame = this.frameByKey(f.frameKey);
        let value = "";
        if (f.type === "select") {
          value = await frame.$eval(
            f.selector,
            (el) => {
              const s = el as HTMLSelectElement;
              return s.options[s.selectedIndex]?.text?.trim() || "";
            }
          ).catch(() => "");
        } else {
          value = (await frame.inputValue(f.selector).catch(() => "")) || "";
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

        // Phase 7: if the agent had filled this field and the human changed it,
        // that's a CORRECTION — record the old value as negative memory so it's
        // never served again, then save the corrected value.
        const agentValue = this.appliedValues.get(f.label);
        if (agentValue && agentValue.trim().toLowerCase() !== value.toLowerCase()) {
          await recordRejection(f.label, agentValue, application.job.platform);
          await Logger.info("APPLY", `  🧠 learned correction for "${f.label}": "${agentValue.slice(0, 30)}" ✗ → "${value.slice(0, 30)}" ✓`);
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
    // Phase 9: also snapshot the page HTML so failures can be inspected offline.
    try {
      const html = await this.page.content();
      const safe = label.replace(/[^a-z0-9_\-.]/gi, "_");
      saveFile(folderPath, `${safe}.html`, html);
    } catch { /* ignore */ }
  }

  // ─── Submission receipt ───────────────────────────────────────────────────────
  // Tsenta-style proof of submission: on a confirmed apply, capture the
  // confirmation sentence, any reference/confirmation number on the page, and a
  // full-page screenshot. Persisted into the Application's existing receipt
  // fields so the UI can show "submitted, here's the proof".
  private async captureReceipt(
    folderPath: string | null
  ): Promise<{ confirmationText: string | null; confirmationId: string | null; screenshotPath: string | null }> {
    const empty = { confirmationText: null, confirmationId: null, screenshotPath: null };
    if (!this.page) return empty;
    try {
      const body = await this.page
        .evaluate(() => (document.body.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 2000))
        .catch(() => "");

      // A confirmation/reference number if the page shows one.
      const idMatch = body.match(
        /(?:confirmation|reference|application|tracking|req(?:uisition)?)\s*(?:#|number|no\.?|id)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{4,})/i
      );
      // A short confirmation sentence, else the first slice of the page text.
      const sentence = body.match(
        /[^.!?]*\b(?:thank you for applying|application (?:submitted|received|complete)|successfully submitted|we (?:have )?received your application)\b[^.!?]*[.!?]/i
      );
      const confirmationText = (sentence?.[0] || body.slice(0, 240)).trim() || null;

      let screenshotPath: string | null = null;
      if (folderPath) {
        const buf = await this.page.screenshot({ fullPage: true }).catch(() => null);
        if (buf) screenshotPath = saveScreenshot(folderPath, buf, "receipt.png");
      }
      return { confirmationText, confirmationId: idMatch?.[1] ?? null, screenshotPath };
    } catch {
      return empty;
    }
  }
}

export const applyEngine = new ApplyEngine();
