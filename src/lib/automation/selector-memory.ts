// ─── Self-healing selectors (#24) ─────────────────────────────────────────────
// When a known selector stops working (ATS markup changed), we want to (a) try
// alternative strategies, and (b) remember which selector actually worked for a
// given (host, intent) so next time we try it first. This is a small in-process
// + on-disk cache keyed by ATS host + intent ("Submit", "Next", "email", …).
//
// Stored in ~/.job-agent-tools/selector-memory.json so it survives restarts and
// improves over time across runs.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const DIR = join(homedir(), ".job-agent-tools");
const PATH = join(DIR, "selector-memory.json");

type Store = Record<string, string>; // key → winning selector
let cache: Store | null = null;

function load(): Store {
  if (cache) return cache;
  try {
    if (existsSync(PATH)) cache = JSON.parse(readFileSync(PATH, "utf8")) as Store;
    else cache = {};
  } catch {
    cache = {};
  }
  return cache!;
}

function persist(): void {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    writeFileSync(PATH, JSON.stringify(cache ?? {}, null, 2));
  } catch { /* best-effort */ }
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "unknown"; }
}

export function selectorKey(url: string, intent: string): string {
  return `${hostOf(url)}::${intent}`;
}

// The selector that worked last time for this (host, intent), if any.
export function rememberedSelector(url: string, intent: string): string | null {
  return load()[selectorKey(url, intent)] ?? null;
}

// Record a selector that just worked. Promotes it to first-try next time.
export function learnSelector(url: string, intent: string, selector: string): void {
  const store = load();
  const key = selectorKey(url, intent);
  if (store[key] !== selector) {
    store[key] = selector;
    persist();
  }
}

// Forget a learned selector that has stopped working.
export function forgetSelector(url: string, intent: string): void {
  const store = load();
  const key = selectorKey(url, intent);
  if (key in store) { delete store[key]; persist(); }
}
