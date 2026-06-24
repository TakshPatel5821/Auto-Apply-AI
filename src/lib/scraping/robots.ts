// Minimal, conservative robots.txt support for the generic URL scraper. We only
// honor the `User-agent: *` group (the safe common case) and cache per origin so
// a search doesn't refetch robots.txt for every URL. No robots.txt = allowed.

import axios from "axios";

interface RobotRules {
  disallow: string[];
  allow: string[];
}

const cache = new Map<string, { rules: RobotRules; fetchedAt: number }>();
const TTL_MS = 6 * 60 * 60 * 1000; // 6h

async function loadRobots(origin: string): Promise<RobotRules> {
  const cached = cache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.rules;

  const rules: RobotRules = { disallow: [], allow: [] };
  try {
    const res = await axios.get(`${origin}/robots.txt`, {
      timeout: 8000,
      responseType: "text",
      validateStatus: (s) => s < 500,
      headers: { "User-Agent": "JobAgent/1.0" },
    });
    if (res.status === 200 && typeof res.data === "string") {
      let inStarGroup = false;
      for (const raw of res.data.split(/\r?\n/)) {
        const line = raw.replace(/#.*/, "").trim();
        if (!line) continue;
        const idx = line.indexOf(":");
        if (idx < 0) continue;
        const key = line.slice(0, idx).toLowerCase().trim();
        const val = line.slice(idx + 1).trim();
        if (key === "user-agent") {
          inStarGroup = val === "*";
        } else if (inStarGroup && key === "disallow" && val) {
          rules.disallow.push(val);
        } else if (inStarGroup && key === "allow" && val) {
          rules.allow.push(val);
        }
      }
    }
  } catch {
    // Network error / no robots.txt → treat as allowed.
  }
  cache.set(origin, { rules, fetchedAt: Date.now() });
  return rules;
}

/**
 * Is `url` crawlable per the site's robots.txt (`User-agent: *` group)?
 * Uses standard longest-match precedence where an explicit Allow overrides a
 * shorter Disallow. Fails OPEN (returns true) on any error.
 */
export async function isAllowedByRobots(url: string): Promise<boolean> {
  try {
    const u = new URL(url);
    const rules = await loadRobots(u.origin);
    const path = `${u.pathname}${u.search}` || "/";
    const longest = (patterns: string[]): number =>
      patterns
        .filter((p) => path.startsWith(p.replace(/\*$/, "")))
        .reduce((max, p) => Math.max(max, p.length), -1);
    const dis = longest(rules.disallow);
    const allow = longest(rules.allow);
    if (dis < 0) return true;          // nothing disallows this path
    return allow >= dis;               // an equal/longer Allow wins
  } catch {
    return true;
  }
}
