import { Browser, BrowserContext, Page, chromium } from "playwright";
import fs from "fs";
import path from "path";
import { Logger } from "@/lib/logging/logger";
import { ensureDir } from "@/lib/storage/file-manager";

interface OverleafCredentials {
  email: string;
  password: string;
  projectId?: string;
}

export class OverleafAutomation {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private credentials: OverleafCredentials;
  private isLoggedIn = false;

  constructor() {
    this.credentials = {
      email: process.env.OVERLEAF_EMAIL || "",
      password: process.env.OVERLEAF_PASSWORD || "",
      projectId: process.env.OVERLEAF_PROJECT_ID,
    };
  }

  async initialize(): Promise<void> {
    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext({
      viewport: { width: 1920, height: 1080 },
    });
    this.page = await this.context.newPage();
  }

  async login(): Promise<boolean> {
    if (!this.credentials.email || !this.credentials.password) {
      await Logger.warn("OVERLEAF", "No credentials configured");
      return false;
    }

    try {
      await this.page!.goto("https://www.overleaf.com/login", {
        waitUntil: "networkidle",
      });

      await this.page!.fill("#email", this.credentials.email);
      await this.page!.fill("#password", this.credentials.password);
      await this.page!.click('button[type="submit"]');

      await this.page!.waitForURL("**/project", { timeout: 15000 });
      this.isLoggedIn = true;
      await Logger.success("OVERLEAF", "Logged in successfully");
      return true;
    } catch (e) {
      await Logger.error("OVERLEAF", "Login failed", { error: String(e) });
      return false;
    }
  }

  async compileToPDF(latexContent: string, outputDir: string): Promise<string | null> {
    try {
      await this.initialize();

      const loggedIn = await this.login();
      if (!loggedIn) return null;

      let projectUrl: string;

      if (this.credentials.projectId) {
        projectUrl = `https://www.overleaf.com/project/${this.credentials.projectId}`;
        await this.page!.goto(projectUrl, { waitUntil: "networkidle" });
      } else {
        projectUrl = await this.createNewProject();
      }

      await this.updateMainTex(latexContent);
      const pdfPath = await this.downloadPDF(outputDir);

      return pdfPath;
    } catch (e) {
      await Logger.error("OVERLEAF", "Compilation failed", { error: String(e) });
      return null;
    } finally {
      await this.cleanup();
    }
  }

  private async createNewProject(): Promise<string> {
    await this.page!.goto("https://www.overleaf.com/project", {
      waitUntil: "networkidle",
    });

    await this.page!.click('[data-ol-loading-text="Creating a new project…"]');
    await this.page!.waitForSelector('.modal-body input[type="text"]', { timeout: 10000 });
    await this.page!.fill('.modal-body input[type="text"]', `Resume_${Date.now()}`);
    await this.page!.click('.modal-footer .btn-primary');

    await this.page!.waitForURL("**/project/**", { timeout: 30000 });
    return this.page!.url();
  }

  private async updateMainTex(latexContent: string): Promise<void> {
    // Wait for editor to load
    await this.page!.waitForSelector('.cm-editor, .CodeMirror', { timeout: 30000 });
    await new Promise((r) => setTimeout(r, 3000));

    // Click on main.tex in file tree
    await this.page!.click('li[data-name="main.tex"]').catch(() => {});
    await new Promise((r) => setTimeout(r, 1000));

    // Select all content and replace
    await this.page!.keyboard.down("Control");
    await this.page!.keyboard.press("a");
    await this.page!.keyboard.up("Control");
    await new Promise((r) => setTimeout(r, 500));

    await this.page!.keyboard.type(latexContent, { delay: 0 });
    await new Promise((r) => setTimeout(r, 1000));

    // Save
    await this.page!.keyboard.down("Control");
    await this.page!.keyboard.press("s");
    await this.page!.keyboard.up("Control");
    await new Promise((r) => setTimeout(r, 2000));

    await Logger.info("OVERLEAF", "LaTeX content updated");
  }

  private async downloadPDF(outputDir: string): Promise<string | null> {
    // Trigger compilation
    await this.page!.click('button[id="compile"]').catch(async () => {
      await this.page!.click('.btn-recompile').catch(() => {});
    });

    // Wait for compilation
    await this.page!.waitForSelector('.pdfjs-viewer-inner, #pdf-download', {
      timeout: 60000,
    });

    await new Promise((r) => setTimeout(r, 3000));

    // Download PDF
    ensureDir(outputDir);
    const pdfPath = path.join(outputDir, "tailored_resume.pdf");

    const [download] = await Promise.all([
      this.page!.waitForEvent("download"),
      this.page!.click('#pdf-download, a[download]').catch(() => {}),
    ]);

    if (download) {
      await download.saveAs(pdfPath);
      await Logger.success("OVERLEAF", `PDF downloaded to ${pdfPath}`);
      return pdfPath;
    }

    return null;
  }

  async cleanup(): Promise<void> {
    await this.page?.close();
    await this.context?.close();
    await this.browser?.close();
    this.page = null;
    this.context = null;
    this.browser = null;
    this.isLoggedIn = false;
  }
}

export async function compileLatexToPDF(
  latexContent: string,
  outputDir: string
): Promise<string | null> {
  const overleaf = new OverleafAutomation();
  return overleaf.compileToPDF(latexContent, outputDir);
}
