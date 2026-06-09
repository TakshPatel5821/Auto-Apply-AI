// ─── Gmail inbox scan + auto status update ───────────────────────────────────
// syncInbox() pulls mail received since our cursor, classifies each with the
// existing claudeClassifyEmail, records an EmailEvent (which also dedupes so we
// never re-classify the same message), and auto-updates the matching
// application's status. applyClassificationToApplication() is the shared matcher
// reused by the paste-based classify-email route.

import { prisma } from "@/lib/db/prisma";
import { claudeClassifyEmail, type EmailClassification } from "@/lib/ai/claude";
import { getAuthedGmail } from "./client";
import { listRecentMessages, getMessage } from "./fetch";

const USER_ID = "local";
const OVERLAP_MS = 5 * 60 * 1000; // re-query a small window each run; dedupe guards repeats
const FIRST_RUN_LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000; // 2 days on first connect

export interface AppliedStatus {
  id: string;
  company: string;
  status: string;
}

// Match a classified email to the most recent application for that company and
// apply the detected status. Returns the update, or null if nothing matched.
export async function applyClassificationToApplication(
  result: Pick<EmailClassification, "company" | "newStatus">
): Promise<AppliedStatus | null> {
  if (!result.newStatus || !result.company) return null;
  const company = result.company.trim();
  if (!company) return null;

  const app = await prisma.application.findFirst({
    where: {
      userId: USER_ID,
      job: { companyName: { contains: company, mode: "insensitive" } },
    },
    orderBy: { createdAt: "desc" },
    include: { job: { select: { companyName: true } } },
  });
  if (!app) return null;

  await prisma.application.update({
    where: { id: app.id },
    data: { status: result.newStatus },
  });
  return { id: app.id, company: app.job.companyName, status: result.newStatus };
}

export interface SyncResult {
  scanned: number;
  classified: number;
  updated: AppliedStatus[];
}

// In-process guard so overlapping triggers (panel auto-poll, StrictMode double
// effects, the batch-start sync) can't run two scans at once — concurrent runs
// would both pass the dedupe check and race on the gmailId unique insert.
let isSyncing = false;

// Fetch + classify + auto-apply for all inbox mail since the last sync cursor.
export async function syncInbox(opts: { maxResults?: number } = {}): Promise<SyncResult> {
  if (isSyncing) return { scanned: 0, classified: 0, updated: [] };
  isSyncing = true;
  try {
    const gmail = await getAuthedGmail();
    if (!gmail) return { scanned: 0, classified: 0, updated: [] };

    const s = await prisma.userSettings.findUnique({ where: { userId: USER_ID } });
    const lastSync = s?.gmailLastSyncAt ? s.gmailLastSyncAt.getTime() : Date.now() - FIRST_RUN_LOOKBACK_MS;
    const afterSec = Math.floor((lastSync - OVERLAP_MS) / 1000);

    const ids = await listRecentMessages(
      { q: `in:inbox after:${afterSec}`, maxResults: opts.maxResults ?? 25 },
      gmail
    ).catch(() => []);

    let scanned = 0;
    let classified = 0;
    const updated: AppliedStatus[] = [];

    for (const id of ids) {
      // Dedupe: skip messages we've already recorded (no re-classify, no token burn).
      const exists = await prisma.emailEvent.findUnique({ where: { gmailId: id } }).catch(() => null);
      if (exists) continue;

      const m = await getMessage(id, gmail).catch(() => null);
      if (!m) continue;
      scanned++;

      let result: EmailClassification | null = null;
      try {
        result = await claudeClassifyEmail(m.bodyText || m.snippet);
        classified++;
      } catch {
        /* classification failed — still record the event so we don't retry forever */
      }

      const applied = result ? await applyClassificationToApplication(result) : null;

      // upsert (not create) so a same-message race / overlap is a silent no-op
      // instead of a unique-constraint error.
      await prisma.emailEvent
        .upsert({
          where: { gmailId: m.id },
          update: {},
          create: {
            gmailId: m.id,
            threadId: m.threadId || null,
            fromEmail: m.fromEmail || null,
            fromName: m.fromName || null,
            subject: m.subject || null,
            snippet: m.snippet || null,
            receivedAt: m.date,
            category: result?.category || null,
            company: result?.company || null,
            detectedStatus: result?.newStatus || null,
            summary: result?.summary || null,
            suggestedReply: result?.suggestedReply || null,
            applicationId: applied?.id || null,
            statusApplied: !!applied,
          },
        })
        .catch(() => {});

      if (applied) updated.push(applied);
    }

    // Advance the cursor. The OVERLAP_MS re-query window + gmailId dedupe ensure
    // no message slips through the boundary.
    await prisma.userSettings
      .update({ where: { userId: USER_ID }, data: { gmailLastSyncAt: new Date() } })
      .catch(() => {});

    return { scanned, classified, updated };
  } finally {
    isSyncing = false;
  }
}
