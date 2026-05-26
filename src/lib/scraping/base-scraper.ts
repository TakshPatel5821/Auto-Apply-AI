import { Browser, BrowserContext, Page, chromium } from "playwright";
import { ScraperConfig, ScrapedJob } from "@/types";
import { Logger } from "@/lib/logging/logger";

export abstract class BaseScraper {
  protected browser: Browser | null = null;
  protected context: BrowserContext | null = null;
  protected page: Page | null = null;
  protected config: ScraperConfig;

  constructor(config?: Partial<ScraperConfig>) {
    this.config = {
      delayMin: parseInt(process.env.AUTOMATION_DELAY_MIN || "2000"),
      delayMax: parseInt(process.env.AUTOMATION_DELAY_MAX || "8000"),
      maxRetries: 3,
      headless: true,
      ...config,
    };
  }

  protected async init(): Promise<void> {
    this.browser = await chromium.launch({
      headless: this.config.headless,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    this.context = await this.browser.newContext({
      userAgent: this.config.userAgent || this.getRandomUserAgent(),
      viewport: { width: 1920, height: 1080 },
      locale: "en-US",
      timezoneId: "America/New_York",
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-US", "en"],
      });
    });

    this.page = await this.context.newPage();
  }

  protected async cleanup(): Promise<void> {
    try {
      await this.page?.close();
      await this.context?.close();
      await this.browser?.close();
    } catch {
      // ignore cleanup errors
    }
    this.page = null;
    this.context = null;
    this.browser = null;
  }

  protected async delay(
    min?: number,
    max?: number
  ): Promise<void> {
    const delayMin = min ?? this.config.delayMin;
    const delayMax = max ?? this.config.delayMax;
    const ms = Math.floor(Math.random() * (delayMax - delayMin) + delayMin);
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  protected async safeNavigate(url: string, timeout = 30000): Promise<boolean> {
    for (let i = 0; i < this.config.maxRetries; i++) {
      try {
        await this.page!.goto(url, {
          waitUntil: "domcontentloaded",
          timeout,
        });
        return true;
      } catch (e) {
        await Logger.warn("SCRAPER", `Navigation failed (attempt ${i + 1}): ${url}`, { error: String(e) });
        if (i < this.config.maxRetries - 1) await this.delay(3000, 6000);
      }
    }
    return false;
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

  protected async safeType(
    selector: string,
    text: string,
    timeout = 10000
  ): Promise<boolean> {
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
