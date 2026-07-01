// Board prober — turns a raw list of company names into VALIDATED ATS boards.
// For each slug it makes ONE cheap existence request per ATS (the listing
// endpoint, no per-job description fetch) and records which ATSes actually host
// a board for that token. Hits are appended to the company catalog, so a big
// company-name list becomes a big set of working boards without anyone hand-
// mapping which ATS each firm uses.
//
// This is the engine behind scaling discovery toward Tsenta's 50k+ boards: keep
// feeding company names in; the catalog grows with only the ones that resolve.
// Existence checks are deliberately lightweight (1 request/ATS) so probing tens
// of thousands of companies stays feasible.

import { politeGet } from "./http-client";
import { addCompanies, Catalog } from "./company-catalog";
import { Logger } from "@/lib/logging/logger";

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "").slice(0, 60);
}

// A board "exists" when the ATS's listing endpoint returns at least ONE posting.
// We require non-empty (not just a valid shape) on purpose: some ATSes — notably
// SmartRecruiters — answer 200 with an empty list for unknown/foreign tokens
// instead of 404, which would false-positive every slug. Non-empty also means
// "exists" == "has jobs we can actually discover", so a board with zero current
// openings is simply re-probed later when it has some. One request each, no
// description enrichment.
const nonEmpty = (a: unknown): boolean => Array.isArray(a) && a.length > 0;

const EXISTS: Record<string, (slug: string) => Promise<boolean>> = {
  greenhouse: async (s) => {
    const d = await politeGet<{ jobs?: unknown[] }>(`https://boards-api.greenhouse.io/v1/boards/${s}/jobs`);
    return nonEmpty(d?.jobs);
  },
  lever: async (s) => {
    const d = await politeGet<unknown[]>(`https://api.lever.co/v0/postings/${s}?mode=json&limit=1`);
    return nonEmpty(d);
  },
  ashby: async (s) => {
    const d = await politeGet<{ jobs?: unknown[] }>(`https://api.ashbyhq.com/posting-api/job-board/${s}`);
    return nonEmpty(d?.jobs);
  },
  smartrecruiters: async (s) => {
    const d = await politeGet<{ content?: unknown[] }>(`https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=1`);
    return nonEmpty(d?.content);
  },
  workable: async (s) => {
    const d = await politeGet<{ jobs?: unknown[] }>(`https://apply.workable.com/api/v1/widget/accounts/${s}?details=false`);
    return nonEmpty(d?.jobs);
  },
  recruitee: async (s) => {
    const d = await politeGet<{ offers?: unknown[] }>(`https://${s}.recruitee.com/api/offers/`);
    return nonEmpty(d?.offers);
  },
};

/** Which slug-based ATSes host a board for this token (Workday excluded — URL-based). */
export async function probeBoards(slug: string): Promise<string[]> {
  const entries = Object.entries(EXISTS);
  const results = await Promise.all(
    entries.map(async ([id, check]) => {
      try {
        return (await check(slug)) ? id : null;
      } catch {
        return null;
      }
    })
  );
  return results.filter((x): x is string => x !== null);
}

export interface ImportResult {
  probed: number;
  resolved: number; // slugs that matched at least one ATS
  boardsFound: number; // total (slug, ATS) boards discovered
  added: number; // newly persisted (excludes already-known)
  perSource: Record<string, number>;
}

/**
 * Probe many company names and append the validated boards to the catalog.
 * `names` may be company names or slugs — they're slugified before probing.
 */
export async function importCompanies(
  names: string[],
  opts: { concurrency?: number; onProgress?: (done: number, total: number) => void } = {}
): Promise<ImportResult> {
  const slugs = Array.from(new Set(names.map(slugify).filter((s) => s.length >= 2)));
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const additions: Catalog = {};
  let resolved = 0;
  let boardsFound = 0;
  let done = 0;
  let idx = 0;

  const worker = async (): Promise<void> => {
    while (idx < slugs.length) {
      const slug = slugs[idx++];
      const hits = await probeBoards(slug);
      if (hits.length) {
        resolved++;
        boardsFound += hits.length;
        for (const sourceId of hits) (additions[sourceId] ||= []).push(slug);
        await Logger.info("CATALOG", `✓ ${slug} → ${hits.join(", ")}`);
      }
      done++;
      opts.onProgress?.(done, slugs.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, slugs.length) }, worker));

  const { added, perSource } = addCompanies(additions);
  await Logger.success("CATALOG", `Import: ${resolved}/${slugs.length} resolved, ${boardsFound} boards, ${added} new`);
  return { probed: slugs.length, resolved, boardsFound, added, perSource };
}
