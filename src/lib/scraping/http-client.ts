// Polite, shared HTTP layer for the API/feed/JSON-LD scrapers. Adds the three
// things every well-behaved crawler needs and that the per-source files
// shouldn't each reinvent: per-domain rate limiting, exponential backoff on
// 429/403/503 (honoring Retry-After), and user-agent rotation. Optionally
// consults robots.txt for the generic (arbitrary-URL) scraper.

import axios, { AxiosResponse } from "axios";
import { Logger } from "@/lib/logging/logger";
import { isAllowedByRobots } from "./robots";

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
];
const randomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// Minimum gap between requests to the SAME host (jittered). Per-domain so we can
// fan out across many sources concurrently without hammering any single one.
const MIN_GAP_MS = parseInt(process.env.SCRAPER_DOMAIN_GAP_MS || "1100", 10);
const lastHit = new Map<string, number>();

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

async function throttle(host: string): Promise<void> {
  const now = Date.now();
  const wait = (lastHit.get(host) || 0) + MIN_GAP_MS - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait + Math.random() * 250));
  lastHit.set(host, Date.now());
}

export interface PoliteGetOptions {
  headers?: Record<string, string>;
  timeout?: number;
  /** Consult robots.txt before fetching (default false; true for generic scraping). */
  respectRobots?: boolean;
  maxRetries?: number;
  /** "json" (default) or "text". */
  responseType?: "json" | "text";
}

/**
 * GET a URL politely. Returns the parsed body, or null on a hard failure /
 * robots-disallow / 4xx — callers treat null as "no data" and move on, so a
 * single bad source never throws and aborts a whole multi-source search.
 */
export async function politeGet<T = unknown>(url: string, opts: PoliteGetOptions = {}): Promise<T | null> {

  if (opts.respectRobots) {
    const allowed = await isAllowedByRobots(url).catch(() => true);
    if (!allowed) {
      await Logger.warn("SCRAPER", `robots.txt disallows ${url} — skipping`);
      return null;
    }
  }

  return politeRequest<T>(url, "get", undefined, opts);
}

/**
 * POST a URL politely with a JSON body, sharing the same per-domain throttling,
 * backoff, and UA rotation as politeGet. Used by sources whose listing API is a
 * POST endpoint (e.g. Workday's CXS `/jobs` search). Returns null on failure.
 */
export async function politePost<T = unknown>(url: string, body: unknown, opts: PoliteGetOptions = {}): Promise<T | null> {
  return politeRequest<T>(url, "post", body, opts);
}

async function politeRequest<T>(
  url: string,
  method: "get" | "post",
  body: unknown,
  opts: PoliteGetOptions
): Promise<T | null> {
  const host = hostOf(url);
  const maxRetries = opts.maxRetries ?? 3;
  let attempt = 0;
  let backoff = 1000;

  while (attempt <= maxRetries) {
    await throttle(host);
    try {
      const config = {
        headers: {
          "User-Agent": randomUA(),
          "Accept-Language": "en-US,en;q=0.9",
          ...(method === "post" ? { "Content-Type": "application/json", Accept: "application/json" } : {}),
          ...(opts.headers || {}),
        },
        timeout: opts.timeout ?? 15000,
        responseType: (opts.responseType === "text" ? "text" : "json") as "text" | "json",
        // We handle 4xx ourselves; only let 5xx (except 503) throw.
        validateStatus: (s: number) => s < 500 || s === 503,
      };
      const res: AxiosResponse<T> =
        method === "post" ? await axios.post(url, body, config) : await axios.get(url, config);

      if (res.status === 429 || res.status === 403 || res.status === 503) {
        const retryAfter = Number(res.headers?.["retry-after"]);
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff;
        await Logger.warn("SCRAPER", `${res.status} from ${host} — backing off ${Math.round(wait)}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, wait + Math.random() * 500));
        backoff = Math.min(backoff * 2, 30000);
        attempt++;
        continue;
      }
      if (res.status >= 400) return null; // 404/401/etc. — no data
      return res.data;
    } catch (e) {
      attempt++;
      if (attempt > maxRetries) {
        await Logger.warn("SCRAPER", `${method.toUpperCase()} failed ${url}: ${String(e).slice(0, 120)}`);
        return null;
      }
      await new Promise((r) => setTimeout(r, backoff + Math.random() * 500));
      backoff = Math.min(backoff * 2, 30000);
    }
  }
  return null;
}
