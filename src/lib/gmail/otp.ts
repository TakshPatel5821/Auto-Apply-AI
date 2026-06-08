// ─── Gmail OTP / verification-code retrieval ─────────────────────────────────
// extractOtp() is a pure, unit-tested parser. fetchLatestOtp() polls Gmail for a
// fresh code after a given timestamp — used by the apply engine when a form puts
// up an "enter the code we emailed you" gate, and by the manual "Get latest code"
// button.

import type { GmailMessage } from "./fetch";
import { getAuthedGmail } from "./client";
import { listRecentMessages, getMessages } from "./fetch";

// Words that typically sit next to a one-time code.
const KW =
  "(?:verification|verify|one[\\s-]?time|security|access|login|confirmation|confirm|passcode|otp|code|pin)";

function plausibleNumeric(s: string): boolean {
  if (!/^\d{4,8}$/.test(s)) return false;
  // A bare 4-digit run that's a plausible calendar year is more likely a date.
  if (s.length === 4) {
    const n = Number(s);
    if (n >= 1900 && n <= 2099) return false;
  }
  return true;
}

// Pull a one-time code out of an email body (+ subject). Returns null if none.
// Strategy, most-reliable first: code adjacent to a keyword (either order), then
// a labeled alphanumeric code, then a lone 6-digit number.
export function extractOtp(body: string, subject = ""): string | null {
  const hay = `${subject}\n${body}`;

  // 1) keyword … 4–8 digits  (e.g. "verification code is 123456", "code: 123456")
  const forward = new RegExp(`${KW}[\\s\\S]{0,30}?(\\d{4,8})\\b`, "i");
  const fwd = hay.match(forward);
  if (fwd && plausibleNumeric(fwd[1])) return fwd[1];

  // 2) 4–8 digits … keyword  (e.g. "123456 is your verification code")
  const backward = new RegExp(`\\b(\\d{4,8})\\b[\\s\\S]{0,30}?${KW}`, "i");
  const bwd = hay.match(backward);
  if (bwd && plausibleNumeric(bwd[1])) return bwd[1];

  // 3) labeled alphanumeric code (must look code-like: has a digit AND an
  //    uppercase letter, e.g. "code: A1B2C3").
  const alnum = hay.match(new RegExp(`${KW}[\\s\\S]{0,30}?\\b([A-Za-z0-9]{6,8})\\b`, "i"));
  if (alnum && /\d/.test(alnum[1]) && /[A-Z]/.test(alnum[1])) return alnum[1].toUpperCase();

  // 4) fallback: a standalone 6-digit number not embedded in a longer run.
  const lone = hay.match(/(?<!\d)(\d{6})(?!\d)/);
  if (lone && plausibleNumeric(lone[1])) return lone[1];

  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface OtpQuery {
  since: number; // ms epoch — only consider mail received at/after this time
  fromContains?: string; // narrow by sender (Gmail `from:` filter)
  subjectContains?: string; // narrow by subject (Gmail `subject:` filter)
  timeoutMs?: number; // total polling budget (default 90s)
  pollMs?: number; // delay between polls (default 5s)
}

export interface OtpResult {
  code: string;
  message: GmailMessage;
}

// Poll Gmail until a matching code arrives or the budget runs out. Codes can land
// a few seconds after the form requests them, hence the polling loop.
export async function fetchLatestOtp(q: OtpQuery): Promise<OtpResult | null> {
  const gmail = await getAuthedGmail();
  if (!gmail) return null;

  const timeoutMs = q.timeoutMs ?? 90_000;
  const pollMs = q.pollMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  const seen = new Set<string>();

  const parts = ["newer_than:1h"];
  if (q.fromContains) parts.push(`from:${q.fromContains}`);
  if (q.subjectContains) parts.push(`subject:${q.subjectContains}`);
  const query = parts.join(" ");

  for (;;) {
    const ids = await listRecentMessages({ q: query, maxResults: 15 }, gmail).catch(() => []);
    const fresh = ids.filter((id) => !seen.has(id));
    for (const id of fresh) seen.add(id);

    const msgs = await getMessages(fresh, gmail); // newest first
    for (const m of msgs) {
      if (m.internalDate < q.since) continue;
      const code = extractOtp(m.bodyText, m.subject);
      if (code) return { code, message: m };
    }

    if (Date.now() >= deadline) return null;
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}
