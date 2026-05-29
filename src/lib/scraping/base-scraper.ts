import { mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { Browser, BrowserContext, Page, chromium } from "playwright";
import { ScraperConfig, ScrapedJob } from "@/types";
import { Logger } from "@/lib/logging/logger";
import { scraperStatus } from "@/lib/automation/scraper-status";

export abstract class BaseScraper {
  protected browser: Browser | null = null;
  protected context: BrowserContext | null = null;
  protected page: Page | null = null;
  protected config: ScraperConfig;
  private isPersistentContext = false;

  constructor(config?: Partial<ScraperConfig>) {
    this.config = {
      delayMin: parseInt(process.env.AUTOMATION_DELAY_MIN || "2000"),
      delayMax: parseInt(process.env.AUTOMATION_DELAY_MAX || "8000"),
      maxRetries: 3,
      headless: true,
      ...config,
    };
  }

  protected async init(profileKey?: string): Promise<void> {
    const headless = process.env.BROWSER_HEADLESS !== "false"
      ? this.config.headless
      : false;

    if (profileKey) {
      // Persistent profile — browser looks real because it has history, cookies, and fingerprint data
      const profileDir = join(homedir(), ".job-agent-profiles", profileKey);
      mkdirSync(profileDir, { recursive: true });

      await Logger.info("SCRAPER", `Using persistent profile: ${profileDir}`);

      try {
        this.context = await chromium.launchPersistentContext(profileDir, {
          channel: "msedge",
          headless,
          slowMo: headless ? 0 : 80,
          args: [
            "--disable-blink-features=AutomationControlled",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-infobars",
            "--disable-notifications",
          ],
          userAgent: this.config.userAgent || this.getRandomUserAgent(),
          viewport: { width: 1920, height: 1080 },
          locale: "en-US",
          timezoneId: "America/New_York",
          extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
        });
      } catch {
        await Logger.warn("SCRAPER", "Edge profile launch failed, falling back to Chromium profile");
        this.context = await chromium.launchPersistentContext(profileDir, {
          headless,
          slowMo: headless ? 0 : 80,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-blink-features=AutomationControlled",
            "--no-first-run",
            "--disable-infobars",
          ],
          userAgent: this.config.userAgent || this.getRandomUserAgent(),
          viewport: { width: 1920, height: 1080 },
          locale: "en-US",
          timezoneId: "America/New_York",
        });
      }

      this.isPersistentContext = true;
      this.browser = this.context.browser();
    } else {
      // Ephemeral context (no persistence)
      try {
        this.browser = await chromium.launch({
          channel: "msedge",
          headless,
          slowMo: headless ? 0 : 80,
          args: ["--disable-blink-features=AutomationControlled"],
        });
      } catch {
        this.browser = await chromium.launch({
          headless,
          slowMo: headless ? 0 : 80,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-blink-features=AutomationControlled",
          ],
        });
      }

      this.context = await this.browser.newContext({
        userAgent: this.config.userAgent || this.getRandomUserAgent(),
        viewport: { width: 1920, height: 1080 },
        locale: "en-US",
        timezoneId: "America/New_York",
        extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
      });
    }

    // Comprehensive stealth — defeats most bot detectors
    await this.context.addInitScript(() => {
      // 1. Remove webdriver flag
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });

      // 2. Inject a realistic chrome runtime object
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

      // 3. Realistic plugins list
      const fakePlugins = [
        { name: "Chrome PDF Plugin", filename: "internal-pdf-viewer", description: "Portable Document Format" },
        { name: "Chrome PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai", description: "" },
        { name: "Native Client", filename: "internal-nacl-plugin", description: "" },
      ] as unknown as PluginArray;
      Object.defineProperty(navigator, "plugins", { get: () => fakePlugins });

      // 4. Languages + hardware concurrency
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
      try { Object.defineProperty(navigator, "deviceMemory", { get: () => 8 }); } catch { /* readonly in some envs */ }
      Object.defineProperty(navigator, "maxTouchPoints", { get: () => 0 });

      // 5. Permissions API — stop the "notifications denied" bot signal
      try {
        const origQuery = navigator.permissions.query.bind(navigator.permissions);
        navigator.permissions.query = (params) =>
          (params as PermissionDescriptor).name === "notifications"
            ? Promise.resolve({ state: Notification.permission, onchange: null } as PermissionStatus)
            : origQuery(params);
      } catch { /* ignore */ }

      // 6. WebGL vendor — look like a real Intel GPU
      try {
        const origGetParam = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (p: number) {
          if (p === 37445) return "Intel Inc.";
          if (p === 37446) return "Intel Iris OpenGL Engine";
          return origGetParam.call(this, p);
        };
      } catch { /* ignore */ }

      // 7. Screen depth
      try { Object.defineProperty(screen, "colorDepth", { get: () => 24 }); } catch { /* ignore */ }
      try { Object.defineProperty(screen, "pixelDepth", { get: () => 24 }); } catch { /* ignore */ }
    });

    this.page = await this.context.newPage();
  }

  protected async cleanup(): Promise<void> {
    try {
      await this.page?.close();
      if (this.isPersistentContext) {
        // Closing persistent context also closes the browser and saves profile to disk
        await this.context?.close();
      } else {
        await this.context?.close();
        await this.browser?.close();
      }
    } catch {
      // ignore cleanup errors
    }
    this.page = null;
    this.context = null;
    this.browser = null;
    this.isPersistentContext = false;
  }

  protected async delay(min?: number, max?: number): Promise<void> {
    const delayMin = min ?? this.config.delayMin;
    const delayMax = max ?? this.config.delayMax;
    const ms = Math.floor(Math.random() * (delayMax - delayMin) + delayMin);
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  protected async safeNavigate(url: string, timeout = 30000): Promise<boolean> {
    for (let i = 0; i < this.config.maxRetries; i++) {
      try {
        await this.page!.goto(url, { waitUntil: "domcontentloaded", timeout });
        return true;
      } catch (e) {
        const msg = String(e);
        if (msg.includes("ERR_TOO_MANY_REDIRECTS")) {
          await Logger.warn("SCRAPER", `Redirect loop on ${url} — clearing cookies and retrying as guest`);
          try { await this.context!.clearCookies(); } catch { /* ignore */ }
          return false;
        }
        await Logger.warn("SCRAPER", `Navigation failed (attempt ${i + 1}): ${url}`, { error: msg });
        if (i < this.config.maxRetries - 1) await this.delay(3000, 6000);
      }
    }
    return false;
  }

  // Returns true if the current page is a bot-detection wall (authwall, CAPTCHA, challenge)
  protected async detectBotWall(): Promise<boolean> {
    const url = this.page?.url() ?? "";
    if (
      url.includes("authwall") ||
      url.includes("challenge") ||
      url.includes("captcha") ||
      url.includes("checkpoint") ||
      url.includes("bot-challenge") ||
      url.includes("security-check")
    ) {
      return true;
    }

    try {
      const bodyText = (await this.page!.evaluate(() =>
        (document.body?.innerText ?? "").toLowerCase()
      )) as string;

      return (
        bodyText.includes("verify you") ||
        bodyText.includes("security check") ||
        bodyText.includes("are you a human") ||
        bodyText.includes("i'm not a robot") ||
        bodyText.includes("complete the security") ||
        bodyText.includes("unusual traffic") ||
        bodyText.includes("please verify") ||
        bodyText.includes("prove you're human")
      );
    } catch {
      return false;
    }
  }

  // Pauses automation and waits for the user to manually complete verification in the browser window.
  // Returns true when the user has navigated past the wall, false on timeout.
  protected async waitForUserIntervention(
    platformName: string,
    maxWaitMs = 3 * 60 * 1000
  ): Promise<boolean> {
    scraperStatus.waitingForUser = true;
    scraperStatus.reason = `${platformName}: bot/CAPTCHA wall detected`;

    await Logger.warn(
      platformName,
      "BOT WALL DETECTED — browser is open. Please complete verification manually, then navigate to the jobs page."
    );
    await Logger.info(
      platformName,
      "Waiting up to 3 minutes for you to take over. Automation will continue once you reach the jobs page."
    );

    const botIndicators = ["authwall", "challenge", "captcha", "checkpoint", "security-check", "verify"];

    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, 2500));

      // User clicked Resume on dashboard
      if (!scraperStatus.waitingForUser) {
        await Logger.success(platformName, "Resume signal received — continuing automation");
        return true;
      }

      // Check if user navigated away from the bot wall
      const url = this.page?.url() ?? "";
      const cleared = botIndicators.every((indicator) => !url.includes(indicator));
      if (cleared && url.includes(platformName.toLowerCase())) {
        scraperStatus.waitingForUser = false;
        await Logger.success(platformName, "User navigated past bot wall — resuming automation");
        await this.delay(2000, 3000);
        return true;
      }
    }

    scraperStatus.waitingForUser = false;
    await Logger.error(platformName, "Timeout waiting for manual intervention — skipping this platform");
    return false;
  }

  // Click "Show more" / "See more" buttons in job description until fully expanded.
  // Returns true if at least one button was clicked.
  protected async expandJobDescription(): Promise<boolean> {
    if (!this.page) return false;
    let clickedAny = false;

    const showMoreSelectors = [
      // LinkedIn
      "button.show-more-less-html__button",
      "button.show-more-less-button",
      'button[aria-label="See more, visually open the description"]',
      'button[aria-label*="see more"]',
      'button[aria-label*="Show more"]',
      ".show-more-less-html__button--more",
      // Indeed
      "button.jobsearch-jobDescriptionText-button",
      'button[data-testid="job-description-view-more"]',
      // Generic
      'button:has-text("Show more")',
      'button:has-text("See more")',
      'button:has-text("Read more")',
      'button:has-text("View full description")',
    ];

    // Click multiple times in case there are nested expand buttons
    for (let pass = 0; pass < 3; pass++) {
      let clickedThisPass = false;
      for (const sel of showMoreSelectors) {
        try {
          const btn = await this.page.$(sel);
          if (btn) {
            const isVisible = await btn.isVisible().catch(() => false);
            if (isVisible) {
              await btn.click({ timeout: 3000 }).catch(() => {});
              await this.page.waitForTimeout(400);
              clickedThisPass = true;
              clickedAny = true;
            }
          }
        } catch { /* try next selector */ }
      }
      if (!clickedThisPass) break;
    }

    return clickedAny;
  }

  protected async safeClick(selector: string, timeout = 10000): Promise<boolean> {
    try {
      await this.page!.waitForSelector(selector, { timeout });
      await this.page!.click(selector);
      return true;
    } catch {
      return false;
    }
  }

  protected async safeType(selector: string, text: string, timeout = 10000): Promise<boolean> {
    try {
      await this.page!.waitForSelector(selector, { timeout });
      await this.page!.fill(selector, text);
      return true;
    } catch {
      return false;
    }
  }

  protected getRandomUserAgent(): string {
    const agents = [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
    ];
    return agents[Math.floor(Math.random() * agents.length)];
  }

  protected extractSalary(text: string): { min?: number; max?: number; raw: string } {
    const cleaned = text.replace(/[,$]/g, "");
    const ranges = cleaned.match(/(\d+)k?\s*[-–]\s*(\d+)k?/i);
    if (ranges) {
      const multiplier = text.includes("k") ? 1000 : 1;
      return {
        min: parseInt(ranges[1]) * multiplier,
        max: parseInt(ranges[2]) * multiplier,
        raw: text,
      };
    }
    const single = cleaned.match(/\$?([\d,]+)k?/i);
    if (single) {
      const val = parseInt(single[1]) * (text.includes("k") ? 1000 : 1);
      return { min: val, max: val, raw: text };
    }
    return { raw: text };
  }

  protected normalizeJobType(type: string): string {
    const lower = type.toLowerCase();
    if (lower.includes("full")) return "full-time";
    if (lower.includes("part")) return "part-time";
    if (lower.includes("contract")) return "contract";
    if (lower.includes("intern")) return "internship";
    if (lower.includes("temp")) return "temporary";
    return type;
  }

  abstract scrapeJobs(
    keywords: string[],
    locations: string[],
    options?: Record<string, unknown>
  ): Promise<ScrapedJob[]>;
}
