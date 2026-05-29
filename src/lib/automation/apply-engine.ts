import { chromium, BrowserContext, Page } from "playwright";
import { mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { prisma } from "@/lib/db/prisma";
import { findAnswer, saveAnswer } from "@/lib/storage/memory";
import { claudeAnswerQuestion } from "@/lib/ai/claude";
import { saveScreenshot } from "@/lib/storage/file-manager";
import { Logger } from "@/lib/logging/logger";
import { scraperStatus } from "./scraper-status";
import { MemoryCategory } from "@/types";

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

  // ─── Public entry point ──────────────────────────────────────────────────────

  async applyToJob(applicationId: string): Promise<boolean> {
    const application = await getApplicationWithRelations(applicationId);
    if (!application) throw new Error("Application not found");

    const { job } = application;
    await Logger.info("APPLY", `╔═══════════════════════════════════════════════`);
    await Logger.info("APPLY", `║ Applying: ${job.jobTitle}`);
    await Logger.info("APPLY", `║ Company: ${job.companyName}`);
    await Logger.info("APPLY", `║ Platform: ${job.platform}${job.isEasyApply ? " (Easy Apply)" : ""}`);
    await Logger.info("APPLY", `╚═══════════════════════════════════════════════`);

    await prisma.application.update({ where: { id: applicationId }, data: { status: "IN_PROGRESS" } });
    await prisma.job.update({ where: { id: job.id }, data: { status: "APPLYING" } });

    const resumePdfPath = application.tailoredResume?.pdfPath;
    if (resumePdfPath && existsSync(resumePdfPath)) {
      await Logger.info("APPLY", `Resume PDF ready: ${resumePdfPath}`);
    } else {
      await Logger.warn("APPLY", `No PDF resume available (path: ${resumePdfPath || "none"}) — apply will try without upload`);
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
        await prisma.application.update({
          where: { id: applicationId },
          data: { status: "SUBMITTED", appliedAt: new Date() },
        });
        await prisma.job.update({ where: { id: job.id }, data: { status: "APPLIED" } });
        await Logger.success("APPLY", `✓✓✓ Application submitted: ${job.companyName} — ${job.jobTitle}`);
        return true;
      } else {
        throw new Error("Application submission did not complete");
      }
    } catch (e) {
      await prisma.application.update({
        where: { id: applicationId },
        data: { status: "FAILED", error: String(e), retryCount: { increment: 1 } },
      });
      await prisma.job.update({ where: { id: job.id }, data: { status: "FAILED" } });
      await Logger.error("APPLY", `✗ Application failed: ${job.jobTitle} @ ${job.companyName}: ${e}`);
      return false;
    } finally {
      // Pause before closing so user can see the result
      await this.delay(2000, 3000);
      await this.cleanup();
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

    if (buttonInfo.isEasyApply) {
      return this.runEasyApplyFlow(application, buttonInfo.selector);
    } else {
      return this.runExternalApplyFlow(application, buttonInfo.selector);
    }
  }

  // Find the apply button on a LinkedIn page and tell us if it's Easy Apply
  private async findLinkedInApplyButton(): Promise<{ selector: string; text: string; isEasyApply: boolean } | null> {
    return this.page!.evaluate(() => {
      // Look at every button/link, find one that looks like the apply button
      const allButtons = Array.from(document.querySelectorAll("button, a[role='button']")) as HTMLElement[];
      for (const b of allButtons) {
        if ((b as HTMLButtonElement).disabled) continue;
        const text = ((b.innerText || "") + " " + (b.getAttribute("aria-label") || "")).trim();
        const lower = text.toLowerCase();

        // Skip if it's clearly not an apply button
        if (!lower.includes("apply") && !lower.includes("easy apply")) continue;
        // Skip share/save/follow
        if (lower.includes("save") || lower.includes("share") || lower.includes("follow")) continue;

        // Build a usable selector
        const id = b.id ? `#${CSS.escape(b.id)}` : "";
        const ariaLabel = b.getAttribute("aria-label");
        let selector = id;
        if (!selector && ariaLabel) {
          selector = `[aria-label="${ariaLabel.replace(/"/g, '\\"')}"]`;
        }
        if (!selector) {
          // Position-based fallback: count buttons up to this one with the same text
          const all = Array.from(document.querySelectorAll("button"));
          const idx = all.indexOf(b as HTMLButtonElement);
          if (idx >= 0) selector = `button:nth-of-type(${idx + 1})`;
        }
        if (!selector) continue;

        return {
          selector,
          text: text.slice(0, 80),
          isEasyApply: lower.includes("easy apply"),
        };
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

      // Upload resume if there's a file input
      await this.uploadResumeIfVisible(application);

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

      await Logger.warn("APPLY", "No next/submit button found in modal — stopping");
      await this.takeStepScreenshot(application.folderPath, "stuck");
      return false;
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
    await this.dismissPopups();
    await this.takeStepScreenshot(application.folderPath, "external-form");

    // Site-specific quirks
    const url = this.page!.url();
    if (url.includes("workday") || url.includes("myworkdayjobs")) {
      return this.fillWorkdayForm(application);
    }

    // Upload resume FIRST (some forms auto-fill from resume)
    await this.uploadResumeIfVisible(application);

    // Then fill remaining fields
    await this.fillVisibleFields(application, scope);

    await this.delay(800, 1500);
    await this.takeStepScreenshot(application.folderPath, "form-filled");

    // Find and click submit
    await Logger.info("APPLY", "Step 6/6: Locating submit button...");
    const submitted = await this.clickSubmitButton();
    if (!submitted) {
      await Logger.error("APPLY", "Could not find submit button");
      await this.takeStepScreenshot(application.folderPath, "no-submit");
      return false;
    }

    await Logger.info("APPLY", "Submit clicked — waiting for confirmation");
    await this.delay(4000, 6000);
    await this.takeStepScreenshot(application.folderPath, "post-submit");

    const success = await this.detectSuccessPage();
    if (success) {
      await Logger.success("APPLY", "Submission confirmed!");
      return true;
    }

    await Logger.warn("APPLY", "Could not confirm success — assuming submitted (check screenshots)");
    return true;
  }

  // Workday-specific multi-step flow (skeleton — most Workday flows need login)
  private async fillWorkdayForm(application: NonNullable<ApplicationWithRelations>): Promise<boolean> {
    await Logger.warn("APPLY", "Workday detected — these usually require manual login first time. Pausing for human takeover.");
    await this.waitForHumanInput(
      "Workday login + first step",
      "body",
      "CUSTOM" as MemoryCategory,
      application.job.platform,
      10 * 60 * 1000
    );
    return this.fillVisibleFields(application, "body").then(() => this.clickSubmitButton());
  }

  // ─── Find and click submit ─────────────────────────────────────────────────

  private async clickSubmitButton(): Promise<boolean> {
    const candidates = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Submit application")',
      'button:has-text("Submit Application")',
      'button:has-text("Submit")',
      'button:has-text("Send application")',
      'button:has-text("Send Application")',
      'button:has-text("Send")',
      'button:has-text("Apply Now")',
      'button:has-text("Apply now")',
      'button:has-text("Complete Application")',
      'a:has-text("Submit application")',
      '.btn-primary[type="submit"]',
      '[data-automation-id="bottom-navigation-next-button"]',
    ];

    for (const sel of candidates) {
      try {
        const btn = await this.page!.$(sel);
        if (!btn) continue;
        const visible = await btn.isVisible().catch(() => false);
        if (!visible) continue;

        await Logger.info("APPLY", `Clicking submit: ${sel}`);
        await btn.click({ timeout: 5000 });
        return true;
      } catch { /* try next */ }
    }
    return false;
  }

  private async detectSuccessPage(): Promise<boolean> {
    try {
      const url = this.page!.url();
      if (
        url.includes("thank") ||
        url.includes("success") ||
        url.includes("confirmation") ||
        url.includes("submitted") ||
        url.includes("applied")
      ) {
        return true;
      }

      const body = await this.page!.evaluate(
        () => (document.body.innerText ?? "").slice(0, 4000).toLowerCase()
      );

      return (
        body.includes("application submitted") ||
        body.includes("application received") ||
        body.includes("thank you for applying") ||
        body.includes("your application was sent") ||
        body.includes("we received your") ||
        body.includes("successfully applied")
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

  // ─── Resume upload ──────────────────────────────────────────────────────────

  private async uploadResumeIfVisible(application: NonNullable<ApplicationWithRelations>): Promise<void> {
    const pdfPath = application.tailoredResume?.pdfPath;
    if (!pdfPath || !existsSync(pdfPath)) {
      await Logger.warn("APPLY", "Skipping resume upload — no PDF available");
      return;
    }

    try {
      // Find all file inputs (including hidden ones — many sites style them invisibly)
      const fileInputs = await this.page!.$$('input[type="file"]');
      if (fileInputs.length === 0) return;

      for (const input of fileInputs) {
        const accept = (await input.getAttribute("accept").catch(() => "")) || "";
        const name = (await input.getAttribute("name").catch(() => "")) || "";
        const id = (await input.getAttribute("id").catch(() => "")) || "";

        const isResumeInput =
          !accept ||
          accept.includes("pdf") ||
          accept.includes("doc") ||
          accept === "*" ||
          /resume|cv/i.test(name) ||
          /resume|cv/i.test(id);

        if (isResumeInput) {
          await Logger.info("APPLY", `Uploading resume to file input (name=${name}, id=${id})`);
          try {
            await input.setInputFiles(pdfPath);
            await this.delay(2000, 3500);
            await Logger.success("APPLY", "Resume uploaded");
            return;
          } catch (e) {
            await Logger.warn("APPLY", `setInputFiles failed: ${e}`);
          }
        }
      }
    } catch (e) {
      await Logger.warn("APPLY", `Resume upload error: ${e}`);
    }
  }

  // ─── Field filling ──────────────────────────────────────────────────────────

  private async fillVisibleFields(
    application: NonNullable<ApplicationWithRelations>,
    scope: string
  ): Promise<void> {
    const fields = await this.detectFields(scope);
    if (fields.length === 0) {
      await Logger.info("APPLY", "No fillable fields detected in this view");
      return;
    }
    await Logger.info("APPLY", `Detected ${fields.length} fields to fill`);

    for (const field of fields) {
      try {
        await this.fillField(field, application);
        await this.delay(250, 600);
      } catch (e) {
        await Logger.warn("APPLY", `Field "${field.label}" failed: ${e}`);
      }
    }
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
        'input:not([type="hidden"]):not([type="submit"]):not([type="file"]):not([type="button"]):not([type="radio"]):not([type="checkbox"]):not([type="image"]), textarea, select'
      );

      inputs.forEach((el) => {
        const htmlEl = el as HTMLElement;
        // Skip invisible
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

  private async fillField(field: DetectedField, application: NonNullable<ApplicationWithRelations>): Promise<void> {
    const resumeData = (application.resume?.parsedData as Record<string, unknown>) || {};
    const answeredQuestions = (application.answeredQuestions as { question: string; answer: string }[]) || [];

    // Skip pre-filled text fields
    if (!["radio", "checkbox", "select"].includes(field.type)) {
      try {
        const cur = await this.page!.inputValue(field.selector).catch(() => "");
        if (cur.trim().length > 0) {
          await Logger.info("APPLY", `  ✓ pre-filled: "${field.label}" = "${cur.slice(0, 50)}"`);
          return;
        }
      } catch { /* continue */ }
    }

    // 1) Memory
    let answer = await findAnswer(field.label);

    if (answer) {
      await Logger.info("APPLY", `  💾 memory: "${field.label}" → "${answer.slice(0, 60)}"`);
    } else {
      // 2) Try resume data shortcuts (don't burn AI on obvious things)
      answer = this.shortcutFromResume(field.label, resumeData);
      if (answer) {
        await Logger.info("APPLY", `  📄 resume: "${field.label}" → "${answer.slice(0, 60)}"`);
        await saveAnswer(field.label, answer, "GENERAL", application.job.platform);
      } else {
        // 3) Claude AI
        try {
          const aiResult = await claudeAnswerQuestion(
            field.label,
            resumeData,
            answeredQuestions
          ) as { answer: string; category: string };

          answer = aiResult.answer?.trim() || "";
          const category = (aiResult.category as MemoryCategory) || "GENERAL";

          if (answer) {
            await Logger.info("APPLY", `  🤖 AI: "${field.label}" → "${answer.slice(0, 60)}"`);
            await saveAnswer(field.label, answer, category, application.job.platform);
          } else {
            await Logger.warn("APPLY", `  ⚠ AI empty for "${field.label}" — pausing for human`);
            const human = await this.waitForHumanInput(field.label, field.selector, category, application.job.platform);
            answer = human || "";
          }
        } catch (e) {
          await Logger.warn("APPLY", `  ⚠ AI error for "${field.label}": ${e} — pausing for human`);
          const human = await this.waitForHumanInput(field.label, field.selector, "CUSTOM" as MemoryCategory, application.job.platform);
          answer = human || "";
        }
      }
    }

    if (!answer) return;
    await this.applyAnswer(field, answer);
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

  private async applyAnswer(field: DetectedField, answer: string): Promise<void> {
    if (field.type === "select") {
      const options = await this.page!.$$eval(
        `${field.selector} option`,
        (opts) => opts.map((o) => ({ value: (o as HTMLOptionElement).value, text: o.textContent?.trim() || "" }))
      ).catch(() => []);

      const a = answer.toLowerCase();
      const best = options.find((o) =>
        o.text.toLowerCase().includes(a) || a.includes(o.text.toLowerCase())
      );
      if (best) {
        await this.page!.selectOption(field.selector, best.value).catch(() => {});
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
          await radio.click().catch(() => {});
          return;
        }
      }
    } else if (field.type === "checkbox") {
      const shouldCheck = /yes|true|agree|accept|authorize|confirm/i.test(answer);
      const isChecked = await this.page!.$eval(field.selector, (el) => (el as HTMLInputElement).checked).catch(() => false);
      if (shouldCheck !== isChecked) {
        await this.page!.click(field.selector).catch(() => {});
      }
    } else {
      await this.page!.fill(field.selector, answer).catch(() => {});
    }
  }

  // ─── Human intervention wait ───────────────────────────────────────────────

  private async waitForHumanInput(
    fieldLabel: string,
    fieldSelector: string,
    category: MemoryCategory,
    platform: string,
    maxWaitMs = 5 * 60 * 1000
  ): Promise<string | null> {
    scraperStatus.waitingForUser = true;
    scraperStatus.reason = `Fill: ${fieldLabel}`;

    await Logger.warn("APPLY", "═════════════════════════════════════════");
    await Logger.warn("APPLY", "⏸  WAITING FOR HUMAN INPUT");
    await Logger.warn("APPLY", `Question: ${fieldLabel}`);
    await Logger.warn("APPLY", "Fill it in the browser, then click RESUME on dashboard");
    await Logger.warn("APPLY", "═════════════════════════════════════════");

    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, 2000));
      if (!scraperStatus.waitingForUser) break;
    }

    scraperStatus.waitingForUser = false;

    let humanAnswer: string | null = null;
    try {
      humanAnswer = await this.page!.inputValue(fieldSelector).catch(() => null);
    } catch { /* ignore */ }

    if (humanAnswer && humanAnswer.trim()) {
      humanAnswer = humanAnswer.trim();
      await Logger.success("APPLY", `Human answered: "${humanAnswer.slice(0, 80)}"`);
      await saveAnswer(fieldLabel, humanAnswer, category, platform);
    }

    return humanAnswer || null;
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
