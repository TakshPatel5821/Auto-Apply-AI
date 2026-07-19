// Auto-generate a custom-site scraper config from a jobs-page's HTML — the
// "point at the cards" step of the visual selector picker, done heuristically.
// We find the repeated container pattern that most looks like a list of job
// cards (each holding a link + a title) and propose card/title/link selectors
// the user can accept or tweak. Pure (operates on HTML), so it's unit-testable.

import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { CustomSiteSelectors } from "@/types";

export interface SuggestedSelectors extends CustomSiteSelectors {
  sampleTitles: string[];
  cardCount: number;
}

// Layout/utility class noise we don't want to key a selector on.
const NOISE_CLASS = /^(active|selected|open|show|hide|col|row|container|wrapper|d-|m[btlrxy]?-|p[btlrxy]?-|flex|grid|w-|h-|text-|bg-|gap-)/;

function escapeClass(cls: string): string {
  return cls.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}

export function suggestCustomSelectors(html: string): SuggestedSelectors {
  const $ = cheerio.load(html);

  // Group candidate containers (that hold a link) by tag + a representative class.
  const groups = new Map<string, { els: Element[]; selector: string }>();
  $("li, div, article, tr, section").each((_, el) => {
    const $el = $(el);
    if ($el.find("a[href]").length === 0) return;
    const tag = ($el.prop("tagName") || "div").toLowerCase();
    const classes = ($el.attr("class") || "")
      .split(/\s+/)
      .filter(Boolean)
      .filter((c) => !NOISE_CLASS.test(c));
    if (!classes.length) return;
    // Prefer a job-ish class to key on; else the first meaningful class.
    const keyClass =
      classes.find((c) => /job|posting|opening|position|vacanc|career|result|listing|card|item|role/i.test(c)) ||
      classes[0];
    const sig = `${tag}.${keyClass}`;
    const g = groups.get(sig) || { els: [], selector: `${tag}.${escapeClass(keyClass)}` };
    g.els.push(el);
    groups.set(sig, g);
  });

  // Pick the most-repeated group, strongly preferring job-ish signatures.
  let best: { selector: string; els: Element[] } | null = null;
  let bestScore = -1;
  for (const [sig, g] of groups) {
    if (g.els.length < 3) continue; // a real list repeats
    const jobish = /job|posting|opening|position|vacanc|career|listing|result|role/i.test(sig);
    const score = g.els.length + (jobish ? 100 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = { selector: g.selector, els: g.els };
    }
  }
  if (!best) return { sampleTitles: [], cardCount: 0 };

  // Within a card, derive a title selector + sample a few titles for preview.
  const sampleTitles: string[] = [];
  let titleSel: string | undefined;
  for (const el of best.els.slice(0, 6)) {
    const $el = $(el);
    const heading = $el.find("h1, h2, h3, h4, h5, [class*='title']").first();
    const text = (heading.text() || $el.find("a").first().text() || "").replace(/\s+/g, " ").trim();
    if (text) sampleTitles.push(text.slice(0, 80));
    if (!titleSel && heading.length) titleSel = ($el.find("h1, h2, h3, h4, h5").first().prop("tagName") || "").toLowerCase() || undefined;
  }

  return {
    card: best.selector,
    title: titleSel,
    link: "a",
    sampleTitles,
    cardCount: best.els.length,
  };
}
