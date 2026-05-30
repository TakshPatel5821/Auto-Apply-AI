import { chromium, BrowserContext, Page } from "playwright";
import { mkdirSync, existsSync } from "fs";
import { join, isAbsolute } from "path";
import { homedir } from "os";
import { prisma } from "@/lib/db/prisma";
import { findAnswer, saveAnswer, saveHumanAnswer } from "@/lib/storage/memory";
import { claudeAnswerQuestion } from "@/lib/ai/claude";
import { saveScreenshot } from "@/lib/storage/file-manager";

// Résumé PDF paths are stored relative to the project root ("applications/..").
// existsSync on a relative path is cwd-dependent, so resolve to absolute first.
function resolveResumePath(p?: string | null): string | null {
  if (!p) return null;
  const abs = isAbsolute(p) ? p : join(process.cwd(), p);
  return existsSync(abs) ? abs : null;
}
import { Logger } from "@/lib/logging/logger";
import { scraperStatus } from "./scraper-status";
import { detectAts, AtsAdapter } from "./ats-adapters";

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
      await this.setLinkedInEmailField(process.env.LINKEDIN_EMAIL || 'takshpatel051102@gmail.com');

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

    // Workday (and other login-gated platforms) need a human account first.
    if (ats?.requiresLogin && (ats.id === "workday")) {
      return this.fillWorkdayForm(application);
    }

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

  // Workday-specific flow — these almost always require an account/login the
  // first time, so we hand off to the human, then verify honestly.
  private async fillWorkdayForm(application: NonNullable<ApplicationWithRelations>): Promise<boolean> {
    await Logger.warn("APPLY", "Workday detected — usually needs a manual login the first time.");
    // Try to pre-fill anything visible to save the user time.
    await this.uploadResumeIfVisible(application).catch(() => {});
    await this.fillVisibleFields(application, "body").catch(() => {});
    return this.waitForHumanTakeover(
      application,
      `Log in & submit "${application.job.jobTitle}" @ ${application.job.companyName} on Workday, then click Resume`,
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
    return this.clickFirstVisible(candidates, "Submit");
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
  private async clickFirstVisible(selectors: string[], kind: string): Promise<boolean> {
    for (const sel of selectors) {
      try {
        const btn = await this.page!.$(sel);
        if (!btn) continue;
        if (!(await btn.isVisible().catch(() => false))) continue;
        if (await btn.isDisabled().catch(() => false)) continue;

        await btn.scrollIntoViewIfNeeded().catch(() => null);
        await this.delay(200, 500);
        await Logger.info("APPLY", `${kind} → ${sel}`);
        await btn.click({ timeout: 5000 });
        return true;
      } catch { /* try next */ }
    }
    return false;
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

  private async detectSuccessPage(ats?: AtsAdapter | null): Promise<boolean> {
    try {
      // Platform-specific success element (most reliable signal).
      for (const sel of ats?.successSelectors || []) {
        const el = await this.page!.$(sel).catch(() => null);
        if (el && await el.isVisible().catch(() => false)) return true;
      }

      const url = this.page!.url();
      if (
        url.includes("thank") ||
        url.includes("success") ||
        url.includes("confirmation") ||
        url.includes("submitted") ||
        url.includes("applied") ||
        url.includes("complete") ||
        url.includes("finish")
      ) {
        return true;
      }

      const body = await this.page!.evaluate(
        () => (document.body.innerText ?? "").slice(0, 4000).toLowerCase()
      );

      // Platform-specific success phrases.
      for (const phrase of ats?.successText || []) {
        if (body.includes(phrase.toLowerCase())) return true;
      }

      return (
        body.includes("application submitted") ||
        body.includes("application received") ||
        body.includes("thank you for applying") ||
        body.includes("your application was sent") ||
        body.includes("we received your") ||
        body.includes("successfully applied") ||
        body.includes("application complete") ||
        body.includes("application sent")
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
    const email = process.env.LINKEDIN_EMAIL || "takshpatel051102@gmail.com";
    const password = process.env.LINKEDIN_PASSWORD || "T@k$h@020921";

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

          if (/cover\s*letter|motivation|why (do|would) you|message to|additional information/i.test(meta)) {
            const cur = await ta.inputValue().catch(() => "");
            if (!cur.trim()) {
              await ta.fill(content);
              await Logger.success("APPLY", "Pasted cover letter into text area");
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

    // 1) Memory (exact + semantic — same question phrased differently)
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
          const aiResult = await claudeAnswerQuestion(field.label, resumeData, answeredQuestions);
          answer = aiResult.answer?.trim() || "";
          if (answer) {
            await Logger.info("APPLY", `  🤖 AI: "${field.label}" → "${answer.slice(0, 60)}"`);
            await saveAnswer(field.label, answer, aiResult.category, application.job.platform);
          }
        } catch (e) {
          await Logger.warn("APPLY", `  ⚠ AI error for "${field.label}": ${e}`);
        }
      }
    }

    // Don't know it → leave blank and report so the step pauses once for the
    // human to fill ALL unknowns together (we then capture them to memory).
    if (!answer) {
      await Logger.warn("APPLY", `  ❓ Don't know "${field.label}" — will ask you to fill it`);
      return false;
    }

    await this.applyAnswer(field, answer);
    return true;
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
    scraperStatus.reason = reason;

    await Logger.warn("APPLY", "═════════════════════════════════════════");
    await Logger.warn("APPLY", "⏸  WAITING FOR HUMAN TAKEOVER");
    await Logger.warn("APPLY", reason);
    await Logger.warn("APPLY", "Finish in the browser, then click RESUME on the dashboard");
    await Logger.warn("APPLY", "═════════════════════════════════════════");

    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, 2000));
      // User clicked Resume?
      if (!scraperStatus.waitingForUser) break;
      // Or the page reached a confirmation on its own while they worked.
      if (await this.detectSuccessPage().catch(() => false)) {
        await Logger.success("APPLY", "Detected confirmation page during takeover");
        break;
      }
    }
    scraperStatus.waitingForUser = false;

    await this.takeStepScreenshot(application.folderPath, "after-human-takeover");

    // Capture whatever the user entered so future applications reuse it.
    await this.captureFilledFields(application, this.currentScope).catch(() => {});

    const confirmed = await this.detectSuccessPage().catch(() => false);
    if (confirmed) {
      await Logger.success("APPLY", "Application confirmed after human takeover");
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
