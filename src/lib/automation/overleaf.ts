import { chromium, BrowserContext } from "playwright";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { Logger } from "@/lib/logging/logger";
import { ensureDir } from "@/lib/storage/file-manager";

const PROFILE_DIR = join(homedir(), ".job-agent-profiles", "overleaf");
const PROJECT_ID_FILE = join(homedir(), ".job-agent-profiles", "overleaf-project-id.txt");

function getSavedProjectId(): string | null {
  if (process.env.OVERLEAF_PROJECT_ID) return process.env.OVERLEAF_PROJECT_ID;
  if (existsSync(PROJECT_ID_FILE)) {
    const id = readFileSync(PROJECT_ID_FILE, "utf-8").trim();
    if (id) return id;
  }
  return null;
}

function saveProjectId(id: string): void {
  mkdirSync(join(homedir(), ".job-agent-profiles"), { recursive: true });
  writeFileSync(PROJECT_ID_FILE, id);
}

// Overleaf drives a single browser profile + project, so two compilations must
// never overlap. Chain every call through one promise so they run strictly
// one-at-a-time, even when the pipeline fires several tailor jobs concurrently.
let overleafQueue: Promise<unknown> = Promise.resolve();

export function compileLatexToPDF(latexContent: string, outputDir: string): Promise<string | null> {
  const result = overleafQueue.then(() => compileLatexToPDFInner(latexContent, outputDir));
  // Keep the chain alive regardless of this call's success/failure.
  overleafQueue = result.catch(() => undefined);
  return result;
}

async function compileLatexToPDFInner(latexContent: string, outputDir: string): Promise<string | null> {
  mkdirSync(PROFILE_DIR, { recursive: true });
  ensureDir(outputDir);

  const headless = process.env.BROWSER_HEADLESS !== "false" ? false : false; // Always visible for Overleaf
  let context: BrowserContext | null = null;

  try {
    await Logger.info("OVERLEAF", "Launching browser for PDF compilation...");

    try {
      context = await chromium.launchPersistentContext(PROFILE_DIR, {
        channel: "msedge",
        headless,
        slowMo: 80,
        viewport: { width: 1600, height: 900 },
        args: ["--no-first-run", "--disable-infobars"],
      });
    } catch {
      context = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless,
        slowMo: 80,
        viewport: { width: 1600, height: 900 },
      });
    }

    const page = await context.newPage();

    // ─── Login if needed ────────────────────────────────────────────────────
    await page.goto("https://www.overleaf.com", { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(2000);

    const isLoggedIn = page.url().includes("/project") || await page.$('[data-testid="user-menu-button"], .nav-icon-btn').then(e => !!e).catch(() => false);

    if (!isLoggedIn) {
      await Logger.info("OVERLEAF", "Logging in to Overleaf...");
      await page.goto("https://www.overleaf.com/login", { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForTimeout(1000);

      await page.fill("#email", process.env.OVERLEAF_EMAIL || "");
      await page.fill("#password", process.env.OVERLEAF_PASSWORD || "");
      await page.click('button[type="submit"]');

      try {
        await page.waitForURL("**/project**", { timeout: 20000 });
        await Logger.success("OVERLEAF", "Logged in successfully");
      } catch {
        await Logger.error("OVERLEAF", "Login failed — please check OVERLEAF_EMAIL and OVERLEAF_PASSWORD in .env");
        return null;
      }
      await page.waitForTimeout(2000);
    }

    // ─── Navigate to project ─────────────────────────────────────────────────
    let projectId = getSavedProjectId();

    if (!projectId) {
      await Logger.info("OVERLEAF", "Creating new resume project on Overleaf...");
      await page.goto("https://www.overleaf.com/project", { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForTimeout(2000);

      // Click "New Project" → "Blank Project"
      await page.click('[data-ol-open-new-doc-modal], button:has-text("New Project"), .new-project-button').catch(() => {});
      await page.waitForTimeout(1500);
      await page.click('button:has-text("Blank Project"), [data-ol-project-type="blank"]').catch(async () => {
        await page.click('.dropdown-item:has-text("Blank Project")').catch(() => {});
      });
      await page.waitForTimeout(1000);

      // Enter project name
      const nameInput = await page.waitForSelector('input[placeholder*="Project Name"], .modal-body input[type="text"]', { timeout: 10000 });
      await nameInput.fill("AI Job Agent Resume");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(500);

      // Confirm
      const confirmBtn = await page.$('.modal-footer .btn-primary, button:has-text("Create")');
      if (confirmBtn) await confirmBtn.click();

      await page.waitForURL("**/project/**", { timeout: 30000 });
      projectId = page.url().match(/\/project\/([a-f0-9]+)/)?.[1] ?? null;

      if (projectId) {
        saveProjectId(projectId);
        await Logger.success("OVERLEAF", `Project created: ${projectId}`);
      } else {
        await Logger.error("OVERLEAF", "Could not get project ID from URL");
        return null;
      }
      await page.waitForTimeout(3000);
    } else {
      await Logger.info("OVERLEAF", `Opening project ${projectId}...`);
      await page.goto(`https://www.overleaf.com/project/${projectId}`, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(3000);
    }

    // ─── Wait for editor to load ─────────────────────────────────────────────
    await Logger.info("OVERLEAF", "Waiting for editor to load...");
    await page.waitForSelector(".cm-editor, .CodeMirror", { timeout: 30000 });
    await page.waitForTimeout(2000);

    // Click on main.tex in file tree (in case another file is selected)
    await page.click('[data-name="main.tex"], li[data-type="doc"]:has-text("main.tex")').catch(() => {});
    await page.waitForTimeout(1000);

    // ─── Replace content ─────────────────────────────────────────────────────
    await Logger.info("OVERLEAF", "Updating LaTeX content...");

    // Try CodeMirror 6 direct manipulation first (most reliable)
    const injected = await page.evaluate((content: string) => {
      const editorEl = document.querySelector(".cm-editor");
      if (!editorEl) return false;

      // Find CodeMirror 6 view instance on the element
      const editorRec = editorEl as unknown as Record<string, unknown>;
      const view = (Object.keys(editorRec) as string[])
        .map((k) => editorRec[k])
        .find((v: unknown) => v && typeof v === "object" && "dispatch" in (v as object) && "state" in (v as object)) as { dispatch: (tr: object) => void; state: { doc: { length: number } } } | null;

      if (view) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
        return true;
      }
      return false;
    }, latexContent);

    if (!injected) {
      // Fallback: select all and use keyboard.insertText
      await Logger.info("OVERLEAF", "Using keyboard fallback for content injection...");
      await page.click(".cm-editor, .CodeMirror-scroll");
      await page.keyboard.press("Control+a");
      await page.waitForTimeout(300);
      await page.keyboard.insertText(latexContent);
    }

    // Save
    await page.keyboard.press("Control+s");
    await page.waitForTimeout(1500);
    await Logger.info("OVERLEAF", "Content saved, triggering compilation...");

    // ─── Compile ─────────────────────────────────────────────────────────────
    const compileBtn = await page.$(
      'button[id="compile"], button[data-cl-close-tooltip="trigger-compile"], .btn-recompile, button:has-text("Recompile"), button:has-text("Compile")'
    );
    if (compileBtn) {
      await compileBtn.click();
    } else {
      // Keyboard shortcut
      await page.keyboard.press("Control+Enter");
    }

    await Logger.info("OVERLEAF", "Compiling... (up to 60 seconds)");

    // Wait for compilation to finish (spinner disappears + PDF appears)
    try {
      await page.waitForSelector(
        '.pdf-viewer canvas, .pdfjs-viewer-inner canvas, iframe.pdf-viewer, #pdf-preview',
        { timeout: 60000 }
      );
    } catch {
      await Logger.warn("OVERLEAF", "PDF preview not detected, attempting download anyway...");
    }
    await page.waitForTimeout(2000);

    // ─── Download PDF ─────────────────────────────────────────────────────────
    await Logger.info("OVERLEAF", "Downloading compiled PDF...");
    const pdfOutputPath = join(outputDir, "tailored_resume.pdf");

    // Try clicking the download button
    let download: import("playwright").Download | null = null;

    try {
      const [dl] = await Promise.all([
        page.waitForEvent("download", { timeout: 20000 }),
        page.click(
          'a[href*="output.pdf"], button[data-testid*="pdf-download"], a[download*="pdf"], .toolbar-pdf-download, a:has-text("PDF")'
        ).catch(async () => {
          const menuBtn = await page.$('.toolbar-right .btn-secondary, button[tooltip="Download PDF"]');
          if (menuBtn) await menuBtn.click();
        }),
      ]);
      download = dl;
    } catch {
      await Logger.warn("OVERLEAF", "Download button not found, trying direct URL...");
      try {
        const [dl] = await Promise.all([
          page.waitForEvent("download", { timeout: 15000 }),
          page.goto(`https://www.overleaf.com/project/${projectId}/output/output.pdf`, { waitUntil: "load" }),
        ]);
        download = dl;
      } catch { /* fall through */ }
    }

    if (download) {
      await download.saveAs(pdfOutputPath);
      await Logger.success("OVERLEAF", `PDF saved: ${pdfOutputPath}`);
      await page.close();
      return pdfOutputPath;
    }

    await Logger.warn("OVERLEAF", "Could not download PDF from Overleaf");
    await page.close();
    return null;
  } catch (e) {
    await Logger.error("OVERLEAF", `PDF compilation failed: ${e}`);
    return null;
  } finally {
    try { await context?.close(); } catch { /* ignore */ }
  }
}
