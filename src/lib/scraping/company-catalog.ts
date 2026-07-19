// Company catalog — the path to Tsenta-scale discovery (50k+ boards). Instead of
// the tiny per-source default arrays, discovery draws its board tokens from here:
//
//   built-in seeds  ∪  an external file you can grow without code changes
//
// The external file (data/company-catalog.json, or $COMPANY_CATALOG_PATH) is how
// you scale: feed raw company names through the board prober (board-prober.ts),
// which validates which ATS each one actually uses and appends the hits here.
// So "scale to 50k" becomes "keep importing", not "edit source files".

import fs from "fs";
import path from "path";
import { DEFAULT_GREENHOUSE_COMPANIES } from "./greenhouse";
import { DEFAULT_LEVER_COMPANIES } from "./lever";
import { DEFAULT_ASHBY_COMPANIES } from "./ashby";
import { DEFAULT_SMARTRECRUITERS_COMPANIES } from "./smartrecruiters";
import { DEFAULT_WORKABLE_COMPANIES } from "./workable";
import { DEFAULT_RECRUITEE_COMPANIES } from "./recruitee";
import { DEFAULT_WORKDAY_BOARDS } from "./workday";

export type Catalog = Record<string, string[]>;

// Modest, high-confidence expansions over each source's own defaults. Wrong
// tokens only cost a skipped fetch, but these are well-known users of each ATS.
const EXPANSION: Catalog = {
  greenhouse: [
    "stripe", "airbnb", "coinbase", "doordash", "robinhood", "dropbox", "lyft",
    "pinterest", "reddit", "gitlab", "databricks", "instacart", "twilio", "asana",
    "discord", "figma", "benchling", "samsara", "affirm", "cloudflare", "snyk",
    "wealthsimple", "faire", "gusto", "airtable", "checkr", "flexport",
  ],
  lever: [
    "spotify", "netflix", "kraken", "mistral", "anthropic", "nubank", "atlassian",
    "shopify", "quora", "yelp", "eventbrite", "fivetran", "scaleai", "loom",
  ],
  ashby: [
    "openai", "ramp", "linear", "vercel", "runway", "replicate", "hex", "modal",
    "supabase", "posthog", "clipboardhealth", "perplexityai", "cursor", "deel",
    "mercury", "watershed", "tome", "browserbase",
  ],
  smartrecruiters: ["visa", "bosch", "ikea", "skechers", "publicissapient", "wargaming"],
  workable: ["deliveroo", "huel", "moonpay", "form3"],
  recruitee: ["recruitee", "toptal"],
  workday: [...DEFAULT_WORKDAY_BOARDS],
};

const BUILTIN: Catalog = {
  greenhouse: dedupe([...DEFAULT_GREENHOUSE_COMPANIES, ...(EXPANSION.greenhouse || [])]),
  lever: dedupe([...DEFAULT_LEVER_COMPANIES, ...(EXPANSION.lever || [])]),
  ashby: dedupe([...DEFAULT_ASHBY_COMPANIES, ...(EXPANSION.ashby || [])]),
  smartrecruiters: dedupe([...DEFAULT_SMARTRECRUITERS_COMPANIES, ...(EXPANSION.smartrecruiters || [])]),
  workable: dedupe([...DEFAULT_WORKABLE_COMPANIES, ...(EXPANSION.workable || [])]),
  recruitee: dedupe([...DEFAULT_RECRUITEE_COMPANIES, ...(EXPANSION.recruitee || [])]),
  workday: dedupe([...DEFAULT_WORKDAY_BOARDS, ...(EXPANSION.workday || [])]),
};

function dedupe(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of arr) {
    const v = (raw || "").trim();
    if (!v) continue;
    // Slugs are case-insensitive; board URLs (Workday) are kept verbatim.
    const key = /^https?:\/\//i.test(v) ? v : v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(/^https?:\/\//i.test(v) ? v : v.toLowerCase());
  }
  return out;
}

export function catalogPath(): string {
  return process.env.COMPANY_CATALOG_PATH || path.join(process.cwd(), "data", "company-catalog.json");
}

let externalCache: { mtimeMs: number; data: Catalog } | null = null;

/** Read the external catalog file (merged on top of the built-ins). Cached by mtime. */
export function loadExternalCatalog(): Catalog {
  const file = catalogPath();
  try {
    const stat = fs.statSync(file);
    if (externalCache && externalCache.mtimeMs === stat.mtimeMs) return externalCache.data;
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Catalog;
    const clean: Catalog = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (Array.isArray(v)) clean[k] = dedupe(v as string[]);
    }
    externalCache = { mtimeMs: stat.mtimeMs, data: clean };
    return clean;
  } catch {
    return {}; // no file yet, or unreadable — built-ins still apply
  }
}

/** The full board-token list for a source: built-in ∪ external file. */
export function companiesFor(sourceId: string): string[] {
  return dedupe([...(BUILTIN[sourceId] || []), ...(loadExternalCatalog()[sourceId] || [])]);
}

/** Per-source counts across built-in + external (for a stats view). */
export function catalogStats(): { sourceId: string; builtin: number; external: number; total: number }[] {
  const ext = loadExternalCatalog();
  const ids = dedupe([...Object.keys(BUILTIN), ...Object.keys(ext)]);
  return ids.map((id) => ({
    sourceId: id,
    builtin: (BUILTIN[id] || []).length,
    external: (ext[id] || []).length,
    total: companiesFor(id).length,
  }));
}

/**
 * Append validated board tokens to the external catalog file (creating it if
 * needed). Only NEW tokens (not already in built-in or external) are written.
 * Returns how many were actually added per source.
 */
export function addCompanies(additions: Catalog): { added: number; perSource: Record<string, number> } {
  const file = catalogPath();
  const current = loadExternalCatalog();
  const perSource: Record<string, number> = {};
  let added = 0;

  for (const [sourceId, tokens] of Object.entries(additions)) {
    const have = new Set(companiesFor(sourceId)); // built-in + existing external
    const fresh: string[] = [];
    for (const t of dedupe(tokens)) {
      if (!have.has(t)) {
        fresh.push(t);
        have.add(t);
      }
    }
    if (fresh.length) {
      current[sourceId] = dedupe([...(current[sourceId] || []), ...fresh]);
      perSource[sourceId] = fresh.length;
      added += fresh.length;
    }
  }

  if (added > 0) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(current, null, 2), "utf-8");
    externalCache = null; // invalidate so next read reflects the write
  }
  return { added, perSource };
}
