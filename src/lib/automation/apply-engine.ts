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
  type: "text" | "email" | "phone" | "select" | "radio" | "checkbox" | "file" | "textarea" | "date" | string;
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
    runtime: {
      id: "nkbihfbeogaeaoehlefnkodbefgpgknn",
      connect: () => ({ onMessage: { addListener: () => {} }, postMessage: () => {}, disconnect: () => {} }),
      sendMessage: () => {},
      onMessage: { addListener: () => {}, removeListener: () => {}, hasListeners: () => false },
      onConnect: { addListener: () => {}, removeListener: () => {}, hasListeners: () => false },
      lastError: undefined,
    },
    loadTimes: () => ({}),
    csi: () => ({}),
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

  private async init(platform: string): Promise<void> {
    const profileDir = join(homedir(), ".job-agent-profiles", platform);
    mkdirSync(profileDir, { recursive: true });

    await Logger.info("APPLY", `Launching visible browser with ${platform} profile...`);

    try {
      this.context = await chromium.launchPersistentContext(profileDir, {
        channel: "msedge",
        headless: false,
        slowMo: 80,
        args: [
          "--disable-blink-features=AutomationControlled",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-infobars",
          "--start-maximized",
        ],
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        viewport: { width: 1920, height: 1080 },
        locale: "en-US",
        timezoneId: "America/New_York",
      });
    } catch {
      await Logger.warn("APPLY", "Edge launch failed, falling back to Chromium");
      this.context = await chromium.launchPersistentContext(profileDir, {
        headless: false,
        slowMo: 80,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-blink-features=AutomationControlled",
          "--no-first-run",
          "--start-maximized",
        ],
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        viewport: { width: 1920, height: 1080 },
        locale: "en-US",
      });
    }

    await this.context.addInitScript(STEALTH_SCRIPT);
    this.page = await this.context.newPage();
  }

  private async cleanup(): Promise<void> {
    try {
      await this.page?.close();
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
    await Logger.info("APPLY", `╔══ Starting application: ${job.jobTitle} @ ${job.companyName} ══╗`, { jobId: job.id });

    await prisma.application.update({ where: { id: applicationId }, data: { status: "IN_PROGRESS" } });
    await prisma.job.update({ where: { id: job.id }, data: { status: "APPLYING" } });

    const resumePdfPath = application.tailoredResume?.pdfPath;
    if (resumePdfPath) {
      await Logger.info("APPLY", `Resume PDF: ${resumePdfPath}`);
    } else {
      await Logger.warn("APPLY", "No PDF resume available — will try without upload");
    }

    try {
      await this.init(job.platform === "linkedin" ? "linkedin" : "apply");

      let success = false;
      if (job.platform === "linkedin" && job.isEasyApply) {
        success = await this.applyLinkedInEasyApply(application);
      } else if (job.platform === "greenhouse") {
        success = await this.applyGreenhouse(application);
      } else if (job.platform === "lever") {
        success = await this.applyLever(application);
      } else {
        success = await this.applyGeneric(application);
      }

      if (success) {
        await prisma.application.update({
          where: { id: applicationId },
          data: { status: "SUBMITTED", appliedAt: new Date() },
        });
        await prisma.job.update({ where: { id: job.id }, data: { status: "APPLIED" } });
        await Logger.success("APPLY", `╚══ Applied to ${job.companyName} — ${job.jobTitle} ══╝`);
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
      await Logger.error("APPLY", `Application failed: ${job.jobTitle} @ ${job.companyName} — ${e}`);
      return false;
    } finally {
      await this.cleanup();
    }
  }

  // ─── LinkedIn Easy Apply ─────────────────────────────────────────────────────

  private async applyLinkedInEasyApply(application: NonNullable<ApplicationWithRelations>): Promise<boolean> {
    const { job } = application;
    const jobUrl = job.url.includes("linkedin.com") ? job.url : `https://www.linkedin.com/jobs/view/${job.platformJobId}/`;

    await Logger.info("APPLY", `Navigating to LinkedIn job: ${jobUrl}`);
    await this.page!.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
    await this.delay(2500, 4000);

    // Check if already applied
    const alreadyApplied = await this.page!.$("text=Applied, .jobs-apply-button--applied, [aria-label*='Application submitted']").catch(() => null);
    if (alreadyApplied) {
      await Logger.warn("APPLY", "Already applied to this job — skipping");
      return false;
    }

    // Find Easy Apply button
    const easyApplySelectors = [
      'button.jobs-apply-button[aria-label*="Easy Apply"]',
      '.jobs-apply-button--top-card button',
      'button[aria-label*="Easy Apply"]',
      '.jobs-s-apply button',
      'button:has-text("Easy Apply")',
    ];

    let clicked = false;
    for (const sel of easyApplySelectors) {
      try {
        const btn = await this.page!.$(sel);
        if (btn) {
          await btn.click();
          clicked = true;
          await Logger.info("APPLY", `Clicked Easy Apply button (${sel})`);
          break;
        }
      } catch { /* try next */ }
    }

    if (!clicked) {
      await Logger.warn("APPLY", "Could not find Easy Apply button — trying keyboard shortcut");
      await this.page!.keyboard.press("a");
      await this.delay(1000, 2000);
    }

    // Wait for modal
    const modal = await this.page!.waitForSelector(
      '.jobs-easy-apply-modal, [data-test-modal="jobs-apply-modal"], .artdeco-modal',
      { timeout: 15000 }
    ).catch(() => null);

    if (!modal) {
      await Logger.error("APPLY", "Easy Apply modal did not open");
      return false;
    }

    await Logger.info("APPLY", "Easy Apply modal opened — filling form...");

    // Multi-step form loop
    let maxSteps = 15;
    while (maxSteps-- > 0) {
      await this.delay(800, 1500);

      // Check for success
      const successEl = await this.page!.$('.artdeco-inline-feedback--success, [data-test-modal-id="easy-apply-success-modal"]').catch(() => null);
      if (successEl) {
        await Logger.success("APPLY", "Application submitted successfully!");
        return true;
      }

      // Check if modal is still open
      const modalOpen = await this.page!.$('.jobs-easy-apply-modal, .artdeco-modal').catch(() => null);
      if (!modalOpen) break;

      // Upload resume on file upload step
      await this.uploadResumeIfVisible(application);

      // Fill all visible form fields in the modal
      await this.fillModalFields(application, '.jobs-easy-apply-modal, .artdeco-modal');

      await this.delay(500, 800);

      // Find the action button for this step
      const submitBtn = await this.page!.$('button[aria-label="Submit application"], button[aria-label*="Submit"]').catch(() => null);
      const reviewBtn = await this.page!.$('button[aria-label="Review your application"], button[aria-label*="Review"]').catch(() => null);
      const nextBtn = await this.page!.$('button[aria-label="Continue to next step"], button[aria-label*="Continue"], button[aria-label*="Next step"]').catch(() => null);

      if (submitBtn) {
        await Logger.info("APPLY", "Clicking Submit application button...");
        await this.takeScreenshot(application.folderPath);
        await submitBtn.click();
        await this.delay(4000, 6000);

        const confirmed = await this.page!.$('.artdeco-inline-feedback--success, [aria-label*="Application submitted"]').catch(() => null);
        if (confirmed) {
          await Logger.success("APPLY", "Application confirmed!");
          return true;
        }
        // If modal is gone, assume submitted
        const stillOpen = await this.page!.$('.jobs-easy-apply-modal, .artdeco-modal').catch(() => null);
        if (!stillOpen) return true;

      } else if (reviewBtn) {
        await Logger.info("APPLY", "Moving to review step...");
        await reviewBtn.click();
      } else if (nextBtn) {
        await Logger.info("APPLY", "Moving to next step...");
        await nextBtn.click();
      } else {
        // Try generic "Next" or "Continue" buttons
        const genericNext = await this.page!.$('button:has-text("Next"), button:has-text("Continue")').catch(() => null);
        if (genericNext) {
          await genericNext.click();
        } else {
          await Logger.warn("APPLY", "No navigation button found in modal — stopping");
          break;
        }
      }

      await this.delay(1500, 2500);
    }

    return false;
  }

  // ─── Greenhouse ──────────────────────────────────────────────────────────────

  private async applyGreenhouse(application: NonNullable<ApplicationWithRelations>): Promise<boolean> {
    const applyUrl = application.job.applyUrl || application.job.url;
    await Logger.info("APPLY", `Navigating to Greenhouse: ${applyUrl}`);
    await this.page!.goto(applyUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await this.delay(2000, 3000);

    await this.uploadResumeIfVisible(application);
    await this.fillModalFields(application, "body");

    await this.takeScreenshot(application.folderPath);

    const submitBtn = await this.page!.$('input[type="submit"], button[type="submit"], button:has-text("Submit Application")').catch(() => null);
    if (submitBtn) {
      await submitBtn.click();
      await this.delay(3000, 5000);
      return true;
    }
    return false;
  }

  // ─── Lever ──────────────────────────────────────────────────────────────────

  private async applyLever(application: NonNullable<ApplicationWithRelations>): Promise<boolean> {
    const applyUrl = application.job.applyUrl || application.job.url;
    await Logger.info("APPLY", `Navigating to Lever: ${applyUrl}`);
    await this.page!.goto(applyUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await this.delay(2000, 3000);

    await this.uploadResumeIfVisible(application);
    await this.fillModalFields(application, "body");

    await this.takeScreenshot(application.folderPath);

    const submitBtn = await this.page!.$('.postings-btn, button[type="submit"], button:has-text("Submit Application")').catch(() => null);
    if (submitBtn) {
      await submitBtn.click();
      await this.delay(3000, 5000);
      return true;
    }
    return false;
  }

  // ─── Generic external apply ──────────────────────────────────────────────────

  private async applyGeneric(application: NonNullable<ApplicationWithRelations>): Promise<boolean> {
    const applyUrl = application.job.easyApplyUrl || application.job.applyUrl || application.job.url;
    await Logger.info("APPLY", `Navigating to apply page: ${applyUrl}`);
    await this.page!.goto(applyUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await this.delay(2000, 3000);

    await this.uploadResumeIfVisible(application);
    await this.fillModalFields(application, "body");

    await this.takeScreenshot(application.folderPath);

    const submitBtn = await this.page!.$(
      'button[type="submit"], input[type="submit"], button:has-text("Submit"), button:has-text("Apply"), button:has-text("Send Application")'
    ).catch(() => null);

    if (submitBtn) {
      await submitBtn.click();
      await this.delay(3000, 5000);
      return true;
    }
    return false;
  }

  // ─── Resume upload ───────────────────────────────────────────────────────────

  private async uploadResumeIfVisible(application: NonNullable<ApplicationWithRelations>): Promise<void> {
    const pdfPath = application.tailoredResume?.pdfPath;
    if (!pdfPath || !existsSync(pdfPath)) return;

    try {
      const fileInputs = await this.page!.$$('input[type="file"]');
      for (const input of fileInputs) {
        const isVisible = await input.isVisible().catch(() => false);
        const accept = await input.getAttribute("accept").catch(() => "");
        const isResumeInput = !accept || accept.includes("pdf") || accept.includes("doc") || accept === "*";

        if (isVisible && isResumeInput) {
          await Logger.info("APPLY", `Uploading resume: ${pdfPath}`);
          await input.setInputFiles(pdfPath);
          await this.delay(2000, 3000);
          await Logger.success("APPLY", "Resume uploaded");
          return; // upload once
        }
      }
    } catch (e) {
      await Logger.warn("APPLY", `Resume upload failed: ${e}`);
    }
  }

  // ─── Form field detection + filling ─────────────────────────────────────────

  private async fillModalFields(
    application: NonNullable<ApplicationWithRelations>,
    scope: string
  ): Promise<void> {
    const fields = await this.detectFields(scope);
    await Logger.info("APPLY", `Detected ${fields.length} form fields`);

    for (const field of fields) {
      try {
        await this.fillField(field, application);
        await this.delay(300, 700);
      } catch (e) {
        await Logger.warn("APPLY", `Field fill error (${field.label}): ${e}`);
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
        // 1. <label for="id">
        const elId = (el as HTMLInputElement).id;
        if (elId) {
          const lbl = document.querySelector(`label[for="${elId}"]`);
          if (lbl) return lbl.textContent?.trim() || "";
        }
        // 2. Closest label wrapper
        const wrap = el.closest("label");
        if (wrap) return wrap.textContent?.replace((el as HTMLInputElement).value || "", "").trim() || "";
        // 3. Parent container
        const parent = el.closest(".form-group, .jobs-easy-apply-form-element, [class*='field'], [class*='question'], fieldset");
        if (parent) {
          const lbl = parent.querySelector("label, legend, .label, h3, h4, [class*='label'], [class*='title']");
          if (lbl && lbl !== el) return lbl.textContent?.trim() || "";
        }
        // 4. aria-label / placeholder
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

      // Regular inputs + textarea + select (skip file/hidden/submit/button)
      const inputs = root.querySelectorAll(
        'input:not([type="hidden"]):not([type="submit"]):not([type="file"]):not([type="button"]):not([type="radio"]):not([type="checkbox"]), textarea, select'
      );

      inputs.forEach((el) => {
        const label = getLabel(el);
        const selector = makeSelector(el);
        if (!selector || !label) return;

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
          label,
          name: (el as HTMLInputElement).name || undefined,
          required: (el as HTMLInputElement).required || false,
          options,
          selector,
        });
      });

      // Radio groups — grouped by fieldset > legend
      const fieldsets = root.querySelectorAll("fieldset");
      fieldsets.forEach((fs) => {
        const legend = fs.querySelector("legend")?.textContent?.trim();
        if (!legend) return;

        const radios = Array.from(fs.querySelectorAll('input[type="radio"]'));
        if (radios.length === 0) return;

        const options = radios.map((r) => {
          const rid = (r as HTMLInputElement).id;
          const lbl = rid ? document.querySelector(`label[for="${rid}"]`)?.textContent?.trim() : "";
          return lbl || (r as HTMLInputElement).value;
        }).filter(Boolean);

        const firstRadio = radios[0] as HTMLInputElement;
        const groupSelector = firstRadio.name ? `input[type="radio"][name="${firstRadio.name}"]` : "";

        if (groupSelector) {
          results.push({
            type: "radio",
            label: legend,
            name: firstRadio.name,
            required: false,
            options,
            selector: groupSelector,
          });
        }
      });

      // Checkboxes
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

    // Skip if field appears to be already filled with non-empty value
    if (field.type !== "radio" && field.type !== "checkbox" && field.type !== "select") {
      try {
        const currentVal = await this.page!.inputValue(field.selector).catch(() => "");
        if (currentVal.trim().length > 0) {
          await Logger.info("APPLY", `  Skipping pre-filled: "${field.label}" = "${currentVal.slice(0, 40)}"`);
          return;
        }
      } catch { /* continue */ }
    }

    // Look up saved answer first
    let answer = await findAnswer(field.label);
    let fromMemory = !!answer;

    if (!answer) {
      // Ask Claude
      try {
        const aiResult = await claudeAnswerQuestion(
          field.label,
          resumeData,
          answeredQuestions
        ) as { answer: string; category: string };

        answer = aiResult.answer?.trim() || "";
        const category = (aiResult.category as MemoryCategory) || "GENERAL";

        if (answer) {
          await Logger.info("APPLY", `  AI answered: "${field.label}" → "${answer.slice(0, 60)}"`);
          await saveAnswer(field.label, answer, category, application.job.platform);
        } else {
          // AI returned empty — wait for human
          await Logger.warn("APPLY", `  AI returned empty for: "${field.label}" — waiting for human input`);
          const humanAnswer = await this.waitForHumanInput(field.label, field.selector, category, application.job.platform);
          answer = humanAnswer || answer;
        }
      } catch (e) {
        await Logger.warn("APPLY", `  AI failed for "${field.label}": ${e} — waiting for human`);
        const humanAnswer = await this.waitForHumanInput(field.label, field.selector, "CUSTOM" as MemoryCategory, application.job.platform);
        answer = humanAnswer || "";
      }
    } else {
      await Logger.info("APPLY", `  Memory: "${field.label}" → "${answer.slice(0, 60)}"`);
    }

    if (!answer) return;

    // Apply the answer
    await this.applyAnswer(field, answer, fromMemory);
  }

  private async applyAnswer(field: DetectedField, answer: string, _fromMemory: boolean): Promise<void> {
    if (field.type === "select") {
      const options = await this.page!.$$eval(
        `${field.selector} option`,
        (opts) => opts.map((o) => ({ value: (o as HTMLOptionElement).value, text: o.textContent?.trim() || "" }))
      );
      const bestOption = options.find(
        (o) => o.text.toLowerCase().includes(answer.toLowerCase()) || answer.toLowerCase().includes(o.text.toLowerCase())
      );
      if (bestOption) {
        await this.page!.selectOption(field.selector, bestOption.value);
      }

    } else if (field.type === "radio") {
      // Click the radio button whose label best matches the answer
      const radios = await this.page!.$$(`${field.selector}`);
      for (const radio of radios) {
        const labelText = await radio.evaluate((el) => {
          const id = (el as HTMLInputElement).id;
          return id ? document.querySelector(`label[for="${id}"]`)?.textContent?.trim() || "" : "";
        });
        if (labelText.toLowerCase().includes(answer.toLowerCase()) || answer.toLowerCase().includes(labelText.toLowerCase())) {
          await radio.click();
          break;
        }
      }

    } else if (field.type === "checkbox") {
      const shouldCheck = /yes|true|agree|accept|authorize/i.test(answer);
      const isChecked = await this.page!.$eval(field.selector, (el) => (el as HTMLInputElement).checked).catch(() => false);
      if (shouldCheck !== isChecked) {
        await this.page!.click(field.selector);
      }

    } else {
      // Text / textarea / email / phone / date
      await this.page!.fill(field.selector, answer);
    }
  }

  // ─── Human intervention wait ─────────────────────────────────────────────────

  private async waitForHumanInput(
    fieldLabel: string,
    fieldSelector: string,
    category: MemoryCategory,
    platform: string,
    maxWaitMs = 5 * 60 * 1000
  ): Promise<string | null> {
    scraperStatus.waitingForUser = true;
    scraperStatus.reason = `Please fill in: "${fieldLabel}"`;

    await Logger.warn("APPLY", "═══════════════════════════════════════════");
    await Logger.warn("APPLY", `WAITING FOR HUMAN INPUT`);
    await Logger.warn("APPLY", `Question: "${fieldLabel}"`);
    await Logger.warn("APPLY", `Fill the field in the browser, then click RESUME in the dashboard`);
    await Logger.warn("APPLY", "═══════════════════════════════════════════");

    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, 2000));
      if (!scraperStatus.waitingForUser) break;
    }

    scraperStatus.waitingForUser = false;

    // Read what the human typed
    let humanAnswer: string | null = null;
    try {
      humanAnswer = await this.page!.inputValue(fieldSelector).catch(() => null);
      if (!humanAnswer) {
        humanAnswer = await this.page!.$eval(fieldSelector, (el) => (el as HTMLInputElement).value).catch(() => null);
      }
    } catch { /* ignore */ }

    if (humanAnswer && humanAnswer.trim()) {
      humanAnswer = humanAnswer.trim();
      await Logger.success("APPLY", `Human answered "${fieldLabel}" → "${humanAnswer.slice(0, 80)}"`);
      await saveAnswer(fieldLabel, humanAnswer, category, platform);
    } else {
      await Logger.warn("APPLY", `No answer detected for "${fieldLabel}" after human intervention`);
    }

    return humanAnswer || null;
  }

  // ─── Screenshot ─────────────────────────────────────────────────────────────

  private async takeScreenshot(folderPath: string | null): Promise<void> {
    if (!folderPath || !this.page) return;
    try {
      const screenshot = await this.page.screenshot({ fullPage: false });
      saveScreenshot(folderPath, screenshot);
    } catch { /* ignore */ }
  }
}

export const applyEngine = new ApplyEngine();
