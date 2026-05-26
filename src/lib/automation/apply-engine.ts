import { Browser, BrowserContext, Page, chromium } from "playwright";
import { prisma } from "@/lib/db/prisma";
import { findAnswer, saveAnswer } from "@/lib/storage/memory";
import { claudeAnswerQuestion } from "@/lib/ai/claude";
import { saveScreenshot } from "@/lib/storage/file-manager";
import { Logger } from "@/lib/logging/logger";
import { MemoryCategory } from "@/types";

type ApplicationWithRelations = Awaited<ReturnType<typeof getApplicationWithRelations>>;

async function getApplicationWithRelations(id: string) {
  return prisma.application.findUnique({
    where: { id },
    include: {
      job: true,
      tailoredResume: { select: { pdfPath: true, texPath: true } },
      coverLetter: { select: { pdfPath: true } },
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
  selector?: string;
}

export class ApplyEngine {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  private async init(): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
    });
    this.context = await this.browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1920, height: 1080 },
    });
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    this.page = await this.context.newPage();
  }

  private async cleanup(): Promise<void> {
    await this.page?.close();
    await this.context?.close();
    await this.browser?.close();
    this.page = null;
    this.context = null;
    this.browser = null;
  }

  async applyToJob(applicationId: string): Promise<boolean> {
    const application = await getApplicationWithRelations(applicationId);
    if (!application) throw new Error("Application not found");

    const { job } = application;
    await Logger.info("APPLY", `Starting application: ${job.jobTitle} @ ${job.companyName}`, {
      jobId: job.id,
      applicationId,
    });

    await prisma.application.update({
      where: { id: applicationId },
      data: { status: "IN_PROGRESS" },
    });

    await prisma.job.update({
      where: { id: job.id },
      data: { status: "APPLYING" },
    });

    try {
      await this.init();

      const applyUrl = job.easyApplyUrl || job.applyUrl || job.url;
      const success = await this.navigateAndApply(applyUrl, application, job.platform);

      if (success) {
        await prisma.application.update({
          where: { id: applicationId },
          data: { status: "SUBMITTED", appliedAt: new Date() },
        });
        await prisma.job.update({
          where: { id: job.id },
          data: { status: "APPLIED" },
        });
        await Logger.success("APPLY", `Applied to ${job.companyName}!`, { jobId: job.id });
        return true;
      } else {
        throw new Error("Application submission failed");
      }
    } catch (e) {
      await prisma.application.update({
        where: { id: applicationId },
        data: {
          status: "FAILED",
          error: String(e),
          retryCount: { increment: 1 },
        },
      });
      await prisma.job.update({
        where: { id: job.id },
        data: { status: "FAILED" },
      });
      await Logger.error("APPLY", `Application failed: ${job.companyName}`, {
        error: String(e),
        jobId: job.id,
      });
      return false;
    } finally {
      await this.cleanup();
    }
  }

  private async navigateAndApply(
    url: string,
    application: NonNullable<ApplicationWithRelations>,
    platform: string
  ): Promise<boolean> {
    await this.page!.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await this.delay(2000, 4000);

    if (platform === "linkedin") return this.applyLinkedIn(application);
    if (platform === "greenhouse") return this.applyGreenhouse(application);
    if (platform === "lever") return this.applyLever(application);
    return this.applyGeneric(application);
  }

  private async applyLinkedIn(application: NonNullable<ApplicationWithRelations>): Promise<boolean> {
    const easyApplyBtn = await this.page!.$(".jobs-apply-button--top-card button");
    if (!easyApplyBtn) return false;

    await easyApplyBtn.click();
    await this.delay(1500, 2500);

    let maxSteps = 10;
    while (maxSteps-- > 0) {
      const isComplete = await this.page!.$(".artdeco-inline-feedback--success");
      if (isComplete) return true;

      const hasModal = await this.page!.$(".jobs-easy-apply-modal");
      if (!hasModal) break;

      await this.fillFormFields(application);

      const submitBtn = await this.page!.$('button[aria-label="Submit application"]');
      const reviewBtn = await this.page!.$('button[aria-label="Review your application"]');
      const nextBtn = await this.page!.$('button[aria-label="Continue to next step"]');

      if (submitBtn) {
        await this.takeScreenshot(application.folderPath);
        await submitBtn.click();
        await this.delay(3000, 5000);
        return true;
      } else if (reviewBtn) {
        await reviewBtn.click();
      } else if (nextBtn) {
        await nextBtn.click();
      } else {
        break;
      }

      await this.delay(1500, 3000);
    }

    return false;
  }

  private async applyGreenhouse(application: NonNullable<ApplicationWithRelations>): Promise<boolean> {
    await this.fillFormFields(application);

    const resumeInput = await this.page!.$('input[type="file"][id*="resume"], input[type="file"][name*="resume"]');
    if (resumeInput && application.tailoredResume?.pdfPath) {
      await resumeInput.setInputFiles(application.tailoredResume.pdfPath);
      await this.delay(1000, 2000);
    }

    const coverInput = await this.page!.$('input[type="file"][id*="cover"], input[type="file"][name*="cover"]');
    if (coverInput && application.coverLetter?.pdfPath) {
      await coverInput.setInputFiles(application.coverLetter.pdfPath);
      await this.delay(1000, 2000);
    }

    await this.takeScreenshot(application.folderPath);

    const submitBtn = await this.page!.$('input[type="submit"], button[type="submit"]');
    if (submitBtn) {
      await submitBtn.click();
      await this.delay(3000, 5000);
      return true;
    }

    return false;
  }

  private async applyLever(application: NonNullable<ApplicationWithRelations>): Promise<boolean> {
    await this.fillFormFields(application);

    const resumeInput = await this.page!.$('input[type="file"]');
    if (resumeInput && application.tailoredResume?.pdfPath) {
      await resumeInput.setInputFiles(application.tailoredResume.pdfPath);
      await this.delay(1000, 2000);
    }

    await this.takeScreenshot(application.folderPath);

    const submitBtn = await this.page!.$('.postings-btn, button[type="submit"]');
    if (submitBtn) {
      await submitBtn.click();
      await this.delay(3000, 5000);
      return true;
    }

    return false;
  }

  private async applyGeneric(application: NonNullable<ApplicationWithRelations>): Promise<boolean> {
    await this.fillFormFields(application);

    const resumeInput = await this.page!.$('input[type="file"]');
    if (resumeInput && application.tailoredResume?.pdfPath) {
      await resumeInput.setInputFiles(application.tailoredResume.pdfPath);
      await this.delay(1000, 2000);
    }

    await this.takeScreenshot(application.folderPath);

    const submitBtn = await this.page!.$(
      'button[type="submit"], input[type="submit"], button:has-text("Submit"), button:has-text("Apply")'
    );

    if (submitBtn) {
      await submitBtn.click();
      await this.delay(3000, 5000);
      return true;
    }

    return false;
  }

  private async fillFormFields(application: NonNullable<ApplicationWithRelations>): Promise<void> {
    const formFields = await this.detectFormFields();

    for (const field of formFields) {
      try {
        await this.fillField(field, application);
        await this.delay(300, 800);
      } catch (e) {
        await Logger.warn("APPLY", `Failed to fill field: ${field.label}`, { error: String(e) });
      }
    }
  }

  private async detectFormFields(): Promise<DetectedField[]> {
    return this.page!.evaluate(() => {
      const fields: DetectedField[] = [];

      const inputs = document.querySelectorAll(
        'input:not([type="hidden"]):not([type="submit"]):not([type="file"]), textarea, select'
      );

      inputs.forEach((input) => {
        const el = input as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        let label = "";

        if (el.id) {
          const labelEl = document.querySelector(`label[for="${el.id}"]`);
          if (labelEl) label = labelEl.textContent?.trim() || "";
        }

        if (!label) {
          const parent = el.closest(".form-group, .field, .question, [class*='field']");
          if (parent) {
            const labelEl = parent.querySelector("label, .label, h3, h4");
            if (labelEl && labelEl !== el) label = labelEl.textContent?.trim() || "";
          }
        }

        if (!label) label = el.getAttribute("placeholder") || el.getAttribute("aria-label") || "";

        const type = el.tagName === "SELECT" ? "select" : el.tagName === "TEXTAREA" ? "textarea" : (el as HTMLInputElement).type || "text";
        const options = el.tagName === "SELECT" ? Array.from((el as HTMLSelectElement).options).map((o) => o.text) : undefined;
        const uniqueSelector = el.id ? `#${el.id}` : el.name ? `[name="${el.name}"]` : undefined;

        if (label && uniqueSelector) {
          fields.push({ type, label, name: (el as HTMLInputElement).name || undefined, required: (el as HTMLInputElement).required || false, options, selector: uniqueSelector });
        }
      });

      return fields;
    }) as Promise<DetectedField[]>;
  }

  private async fillField(field: DetectedField, application: NonNullable<ApplicationWithRelations>): Promise<void> {
    if (!field.selector) return;

    let answer = await findAnswer(field.label);

    if (!answer) {
      const resumeData = (application.resume?.parsedData as Record<string, unknown>) || {};
      const answeredQuestions = (application.answeredQuestions as { question: string; answer: string }[]) || [];
      const aiResult = await claudeAnswerQuestion(field.label, resumeData, answeredQuestions) as { answer: string; category: string };

      answer = aiResult.answer;
      await saveAnswer(field.label, answer, (aiResult.category as MemoryCategory) || "GENERAL", application.job.platform);
      await Logger.info("APPLY", `AI answered: "${field.label}" → "${answer}"`);
    }

    const type = field.type;

    if (type === "select") {
      const options = await this.page!.$$eval(`${field.selector} option`, (opts) =>
        opts.map((o) => ({ value: (o as HTMLOptionElement).value, text: o.textContent?.trim() || "" }))
      );
      const bestOption = options.find(
        (o) => o.text.toLowerCase().includes(answer!.toLowerCase()) || answer!.toLowerCase().includes(o.text.toLowerCase())
      );
      if (bestOption) await this.page!.selectOption(field.selector, bestOption.value);
    } else if (type === "radio") {
      const radios = await this.page!.$$(`input[type="radio"][name="${field.name}"]`);
      for (const radio of radios) {
        const lbl = await radio.evaluate((el) => document.querySelector(`label[for="${(el as HTMLInputElement).id}"]`)?.textContent?.trim() || "");
        if (lbl.toLowerCase().includes(answer!.toLowerCase())) {
          await radio.click();
          break;
        }
      }
    } else if (type === "checkbox") {
      const shouldCheck = answer!.toLowerCase().includes("yes") || answer!.toLowerCase().includes("true");
      const isChecked = await this.page!.$eval(field.selector, (el) => (el as HTMLInputElement).checked);
      if (shouldCheck !== isChecked) await this.page!.click(field.selector);
    } else {
      await this.page!.fill(field.selector, answer!);
    }
  }

  private async takeScreenshot(folderPath: string | null): Promise<void> {
    if (!folderPath) return;
    try {
      const screenshot = await this.page!.screenshot({ fullPage: true });
      saveScreenshot(folderPath, screenshot);
    } catch {
      // ignore screenshot failures
    }
  }

  private async delay(min: number, max: number): Promise<void> {
    const ms = Math.floor(Math.random() * (max - min) + min);
    await new Promise((r) => setTimeout(r, ms));
  }
}

export const applyEngine = new ApplyEngine();
