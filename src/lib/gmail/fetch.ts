// ─── Gmail message fetch + parse ─────────────────────────────────────────────
// Thin helpers over the Gmail API: list message ids by search query, fetch a
// full message, and normalize it into a flat shape with a decoded plain-text
// body. HTML-only mails are stripped to text with cheerio (already a dep).

import type { gmail_v1 } from "googleapis";
import * as cheerio from "cheerio";
import { getAuthedGmail } from "./client";

export interface GmailMessage {
  id: string;
  threadId: string;
  from: string;       // raw "Name <email>" header
  fromName: string;
  fromEmail: string;
  subject: string;
  date: Date;
  internalDate: number; // ms epoch (Gmail's authoritative receive time)
  snippet: string;
  bodyText: string;
}

function header(payload: gmail_v1.Schema$MessagePart | undefined, name: string): string {
  const h = payload?.headers?.find((x) => (x.name || "").toLowerCase() === name.toLowerCase());
  return h?.value || "";
}

function parseFrom(raw: string): { fromName: string; fromEmail: string } {
  const m = raw.match(/^\s*(?:"?([^"<]*?)"?\s*)?<?([^<>\s]+@[^<>\s]+)>?\s*$/);
  if (m) return { fromName: (m[1] || "").trim(), fromEmail: (m[2] || "").trim() };
  return { fromName: "", fromEmail: raw.trim() };
}

function decodeB64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

// Walk the MIME tree collecting decoded text/plain and text/html separately.
function collectBodies(part: gmail_v1.Schema$MessagePart | undefined, acc: { plain: string[]; html: string[] }): void {
  if (!part) return;
  const mime = part.mimeType || "";
  const data = part.body?.data;
  if (data) {
    if (mime === "text/plain") acc.plain.push(decodeB64Url(data));
    else if (mime === "text/html") acc.html.push(decodeB64Url(data));
  }
  for (const child of part.parts || []) collectBodies(child, acc);
}

function extractBodyText(payload: gmail_v1.Schema$MessagePart | undefined): string {
  const acc = { plain: [] as string[], html: [] as string[] };
  collectBodies(payload, acc);
  if (acc.plain.length) return acc.plain.join("\n").trim();
  if (acc.html.length) {
    const $ = cheerio.load(acc.html.join("\n"));
    $("style, script").remove();
    return $("body").text().replace(/\n{3,}/g, "\n\n").trim() || $.text().trim();
  }
  return "";
}

export function normalizeMessage(msg: gmail_v1.Schema$Message): GmailMessage {
  const payload = msg.payload;
  const fromRaw = header(payload, "From");
  const { fromName, fromEmail } = parseFrom(fromRaw);
  const internalDate = Number(msg.internalDate || 0);
  return {
    id: msg.id || "",
    threadId: msg.threadId || "",
    from: fromRaw,
    fromName,
    fromEmail,
    subject: header(payload, "Subject"),
    date: internalDate ? new Date(internalDate) : new Date(),
    internalDate,
    snippet: msg.snippet || "",
    bodyText: extractBodyText(payload),
  };
}

// List message ids matching a Gmail search query (e.g. "newer_than:1d", "in:inbox").
export async function listRecentMessages(
  opts: { q?: string; maxResults?: number } = {},
  gmail?: gmail_v1.Gmail | null
): Promise<string[]> {
  const client = gmail ?? (await getAuthedGmail());
  if (!client) return [];
  const res = await client.users.messages.list({
    userId: "me",
    q: opts.q || "newer_than:1d",
    maxResults: opts.maxResults ?? 25,
  });
  return (res.data.messages || []).map((m) => m.id!).filter(Boolean);
}

// Fetch + normalize a single message by id.
export async function getMessage(
  id: string,
  gmail?: gmail_v1.Gmail | null
): Promise<GmailMessage | null> {
  const client = gmail ?? (await getAuthedGmail());
  if (!client) return null;
  const res = await client.users.messages.get({ userId: "me", id, format: "full" });
  return normalizeMessage(res.data);
}

// Convenience: fetch + normalize many ids, newest first.
export async function getMessages(
  ids: string[],
  gmail?: gmail_v1.Gmail | null
): Promise<GmailMessage[]> {
  const client = gmail ?? (await getAuthedGmail());
  if (!client) return [];
  const out: GmailMessage[] = [];
  for (const id of ids) {
    const m = await getMessage(id, client).catch(() => null);
    if (m) out.push(m);
  }
  return out.sort((a, b) => b.internalDate - a.internalDate);
}
