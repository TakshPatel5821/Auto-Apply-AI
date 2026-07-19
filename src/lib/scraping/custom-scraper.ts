import { chromium, Browser, BrowserContext, Page, ElementHandle } from "playwright";
import { ScrapedJob, CustomSite } from "@/types";
import { Logger } from "@/lib/logging/logger";

export class CustomScraper {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  async scrapeJobs(site: CustomSite): Promise<ScrapedJob[]> {
    const jobs: ScrapedJob[] = [];

    try {
      await this.init();
      await Logger.info("CUSTOM", `Opening ${site.name}: ${site.url}`);

      const ok = await this.safeNavigate(site.url);
      if (!ok) throw new Error(`Could not open ${site.url}`);

      await this.delay(2000, 3500);
      await this.humanScroll(1, 2);

      const loggedIn = await this.login(site.email, site.password);
      if (!loggedIn) {
        await Logger.warn("CUSTOM", `Login failed for ${site.name}`);
        return jobs;
      }

      await Logger.info("CUSTOM", `Logged into ${site.name}, finding jobs page...`);
      await this.delay(2000, 4000);

      const jobsPageUrl = site.jobsUrl || await this.findJobsPage(site.url);
      if (!jobsPageUrl) {
        await Logger.warn("CUSTOM", `Could not find jobs page on ${site.name}`);
        return jobs;
      }

      await Logger.info("CUSTOM", `Jobs page: ${jobsPageUrl}`);
      await this.safeNavigate(jobsPageUrl);
      await this.delay(2000, 4000);
      await this.humanScroll(2, 4);

      const pageJobs = await this.extractJobs(site);
      jobs.push(...pageJobs);

      // Try up to 2 more pages
      for (let p = 2; p <= 3; p++) {
        const next = await this.clickNextPage(site.selectors?.nextPage);
        if (!next) break;
        await this.delay(2500, 4000);
        const more = await this.extractJobs(site);
        if (more.length === 0) break;
        jobs.push(...more);
      }

      await Logger.info("CUSTOM", `${site.name}: found ${jobs.length} jobs`);
    } catch (e) {
      await Logger.error("CUSTOM", `Scraping failed for ${site.name}`, { error: String(e) });
    } finally {
      await this.cleanup();
    }

    return jobs;
  }

  private async init(): Promise<void> {
    const headless = process.env.BROWSER_HEADLESS !== "false";
    try {
      this.browser = await chromium.launch({ channel: "msedge", headless, slowMo: headless ? 0 : 150 });
    } catch {
      this.browser = await chromium.launch({ headless, slowMo: headless ? 0 : 150 });
    }
    this.context = await this.browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1920, height: 1080 },
      locale: "en-US",
    });
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    this.page = await this.context.newPage();
  }

  private async cleanup(): Promise<void> {
    try { await this.page?.close(); await this.context?.close(); await this.browser?.close(); } catch { /* ignore */ }
    this.page = null; this.context = null; this.browser = null;
  }

  private async safeNavigate(url: string, timeout = 30000): Promise<boolean> {
    try {
      await this.page!.goto(url, { waitUntil: "domcontentloaded", timeout });
      return true;
    } catch (e) {
      await Logger.warn("CUSTOM", `Navigation failed: ${url}`, { error: String(e) });
      return false;
    }
  }

  private async delay(min: number, max: number): Promise<void> {
    const ms = Math.floor(Math.random() * (max - min) + min);
    await new Promise((r) => setTimeout(r, ms));
  }

  private async humanType(text: string): Promise<void> {
    for (const char of text) {
      await this.page!.keyboard.type(char, { delay: 50 + Math.random() * 100 });
    }
  }

  private async humanScroll(minScrolls = 2, maxScrolls = 4): Promise<void> {
    const scrolls = Math.floor(Math.random() * (maxScrolls - minScrolls + 1)) + minScrolls;
    for (let i = 0; i < scrolls; i++) {
      await this.page!.evaluate((y) => window.scrollBy(0, y), 200 + Math.floor(Math.random() * 400));
      await this.delay(500, 1200);
    }
  }

  private async login(email: string, password: string): Promise<boolean> {
    const alreadyIn = await this.page!.$("a[href*='logout'], button:has-text('Sign out')").catch(() => null);
    if (alreadyIn) return true;

    // Click login link if present
    const loginLinks = ["a[href*='login']", "a[href*='sign-in']", "a:has-text('Login')", "a:has-text('Sign in')"];
    for (const sel of loginLinks) {
      const el = await this.page!.$(sel).catch(() => null);
      if (el) { await el.click(); await this.delay(1500, 3000); break; }
    }

    // Email field
    const emailSelectors = ['input[type="email"]', 'input[name*="email"]', 'input[name*="user"]', 'input[placeholder*="email" i]'];
    let emailInput = null;
    for (const sel of emailSelectors) {
      emailInput = await this.page!.$(sel).catch(() => null);
      if (emailInput) break;
    }
    if (!emailInput) return false;

    await emailInput.click({ delay: 60 });
    await this.delay(200, 400);
    await this.humanType(email);
    await this.delay(400, 800);

    // Password field
    const pwInput = await this.page!.$('input[type="password"]').catch(() => null);
    if (!pwInput) return false;

    await pwInput.click({ delay: 60 });
    await this.delay(200, 400);
    await this.humanType(password);
    await this.delay(500, 1000);

    // Submit
    const submitSelectors = ['button[type="submit"]', 'input[type="submit"]', "button:has-text('Login')", "button:has-text('Sign in')", "button:has-text('Continue')"];
    for (const sel of submitSelectors) {
      const btn = await this.page!.$(sel).catch(() => null);
      if (btn) { await btn.click(); break; }
    }

    await this.delay(3000, 5000);
    const stillPw = await this.page!.$('input[type="password"]').catch(() => null);
    return !stillPw;
  }

  private async findJobsPage(baseUrl: string): Promise<string | null> {
    const origin = new URL(baseUrl).origin;
    const linkPatterns = [
      "a[href*='/jobs']", "a[href*='/careers']", "a[href*='/openings']",
      "a:has-text('Jobs')", "a:has-text('Careers')", "a:has-text('Open Positions')",
      "a:has-text('Work With Us')", "a:has-text('Join Us')",
    ];
    for (const sel of linkPatterns) {
      const el = await this.page!.$(sel).catch(() => null);
      if (el) {
        const href = await el.getAttribute("href").catch(() => null);
        if (href) return href.startsWith("http") ? href : `${origin}${href}`;
      }
    }
    for (const path of ["/jobs", "/careers", "/openings", "/positions"]) {
      try {
        const res = await fetch(`${origin}${path}`, { method: "HEAD", signal: AbortSignal.timeout(5000) });
        if (res.ok) return `${origin}${path}`;
      } catch { continue; }
    }
    return null;
  }

  private async extractJobs(site: CustomSite): Promise<ScrapedJob[]> {
    const siteName = site.name;
    const baseUrl = site.url;
    const sel = site.selectors || {};
    const jobs: ScrapedJob[] = [];
    const origin = new URL(baseUrl).origin;

    // Configured card selector (from the visual picker) is tried first, then the
    // built-in fallback chain.
    const cardSelectors = [
      ...(sel.card ? [sel.card] : []),
      ".job-listing", ".job-item", ".job-card", ".job-post",
      ".opening", ".posting",
      "[data-automation-id='jobItem']",
      "li[class*='job']", "div[class*='job-']", "article[class*='job']",
    ];

    let cards: ElementHandle[] = [];
    for (const cardSel of cardSelectors) {
      const found = await this.page!.$$(cardSel).catch(() => []);
      if (found.length > 0) { cards = found; break; }
    }

    if (cards.length === 0) {
      // Fallback: look for job-like links
      const links = await this.page!.$$("a[href]").catch(() => []);
      for (const link of links) {
        const href = await link.getAttribute("href").catch(() => "");
        const text = (await link.textContent().catch(() => ""))?.trim() || "";
        if (href && text && /\/(job|opening|posting|position)\//i.test(href)) {
          jobs.push(this.makeBasicJob(text, siteName, href.startsWith("http") ? href : `${origin}${href}`));
        }
      }
      return jobs;
    }

    for (const card of cards.slice(0, 25)) {
      try {
        const title = await this.extractText(card, [...(sel.title ? [sel.title] : []), "h1","h2","h3","h4",".title","[class*='title']","a","strong"]);
        if (!title) continue;

        const company = await this.extractText(card, [...(sel.company ? [sel.company] : []), ".company","[class*='company']"]) || siteName;
        const location = await this.extractText(card, [...(sel.location ? [sel.location] : []), ".location","[class*='location']","[class*='city']"]);
        const linkEl = (sel.link ? await card.$(sel.link).catch(() => null) : null) || await card.$("a").catch(() => null);
        const href = (await linkEl?.getAttribute("href").catch(() => "")) || "";
        const url = href ? (href.startsWith("http") ? href : `${origin}${href}`) : this.page!.url();

        jobs.push({
          platform: siteName.toLowerCase().replace(/\s+/g, "-"),
          url,
          applyUrl: url,
          isEasyApply: false,
          companyName: company,
          jobTitle: title,
          location: location || undefined,
          isRemote: (location || "").toLowerCase().includes("remote"),
          isHybrid: (location || "").toLowerCase().includes("hybrid"),
          requiresSponsorship: false,
          description: "",
          requirements: [],
          responsibilities: [],
          niceToHave: [],
          benefits: [],
          scrapedAt: new Date(),
        });
      } catch { /* skip */ }
    }

    return jobs;
  }

  private async extractText(el: ElementHandle, selectors: string[]): Promise<string> {
    for (const sel of selectors) {
      const text = await el.$eval(sel, (e) => e.textContent?.trim() || "").catch(() => "");
      if (text) return text;
    }
    return (await el.textContent().catch(() => ""))?.trim() || "";
  }

  private async clickNextPage(configured?: string): Promise<boolean> {
    const selectors = [
      ...(configured ? [configured] : []),
      "a[aria-label='Next']", "button:has-text('Next')", "a:has-text('Next')", ".pagination__next",
    ];
    for (const sel of selectors) {
      const btn = await this.page!.$(sel).catch(() => null);
      if (btn) {
        const disabled = await btn.getAttribute("disabled").catch(() => null);
        if (disabled) return false;
        await btn.click();
        return true;
      }
    }
    return false;
  }

  private makeBasicJob(title: string, siteName: string, url: string): ScrapedJob {
    return {
      platform: siteName.toLowerCase().replace(/\s+/g, "-"),
      url, applyUrl: url, isEasyApply: false,
      companyName: siteName, jobTitle: title,
      isRemote: false, isHybrid: false, requiresSponsorship: false,
      description: "", requirements: [], responsibilities: [], niceToHave: [], benefits: [],
      scrapedAt: new Date(),
    };
  }
}
