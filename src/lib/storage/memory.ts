import crypto from "crypto";
import { prisma } from "@/lib/db/prisma";
import { MemoryCategory } from "@/types";
import { generateEmbedding, cosineSimilarity } from "@/lib/ai/ollama";

const DEFAULT_USER_ID = "local";

// In-memory cache of question embeddings (questionHash → vector) so semantic
// lookup doesn't re-embed every stored question on each field. Lives for the
// server process lifetime; small (dozens of entries).
const embeddingCache = new Map<string, number[]>();
// If the embed model isn't installed, stop trying after the first failure.
let embeddingsDisabled = false;

const VALID_CATEGORIES: MemoryCategory[] = [
  "GENERAL",
  "VISA_SPONSORSHIP",
  "WORK_AUTHORIZATION",
  "SALARY",
  "EXPERIENCE",
  "RELOCATION",
  "DEMOGRAPHICS",
  "AVAILABILITY",
  "REFERENCES",
  "CUSTOM",
];

// Coerce any input into a valid enum value. Local models sometimes return the
// whole "A|B|C" list or junk — never let that reach Prisma (it throws).
function safeCategory(raw: unknown): MemoryCategory {
  const s = String(raw || "").toUpperCase().trim();
  for (const token of s.split(/[|,/\s]+/)) {
    if (VALID_CATEGORIES.includes(token as MemoryCategory)) return token as MemoryCategory;
  }
  return "GENERAL";
}

export function hashQuestion(question: string): string {
  const normalized = question.toLowerCase().trim().replace(/\s+/g, " ");
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

// ─── Value ↔ label sanity check ───────────────────────────────────────────────
// The auto-capture bug saved the email into "Degree", "Country", "Last Name"…,
// and a phone number into "School". Before saving ANY answer we verify the value
// is plausible for the field. Mismatches are rejected so memory stays clean.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^[+(]?[\d][\d\s().-]{6,}$/;
const URL_RE = /^(https?:\/\/|www\.)|\.(com|io|dev|net|org)\b|github\.com|linkedin\.com/i;

export function isPlausibleAnswer(label: string, value: string): boolean {
  const l = label.toLowerCase().replace(/\*/g, "").trim();
  const v = value.trim();
  if (!v) return false;

  const looksEmail = EMAIL_RE.test(v);
  const looksPhone = PHONE_RE.test(v) && /\d{7,}/.test(v.replace(/\D/g, ""));
  const looksUrl = URL_RE.test(v);

  // Field-type expectations.
  const wantsEmail = /\bemail\b|e-mail/.test(l);
  const wantsPhone = /\bphone\b|mobile|telephone|cell\b/.test(l);
  const wantsUrl = /url|website|portfolio|linkedin|github|link\b/.test(l);
  const wantsName = /first name|last name|surname|family name|full name|^name$/.test(l);
  const wantsDate = /date|mm\/dd|dd\/mm|yyyy|birth/.test(l);

  // An email value may ONLY go into an email field.
  if (looksEmail && !wantsEmail) return false;
  // A phone value may ONLY go into a phone field.
  if (looksPhone && !wantsPhone && !looksEmail) return false;
  // A bare URL may ONLY go into a url-ish field.
  if (looksUrl && !looksEmail && !wantsUrl && !wantsPhone) return false;

  // Email field must receive an email.
  if (wantsEmail && !looksEmail) return false;
  // Phone field must receive something phone-ish.
  if (wantsPhone && !looksPhone) return false;
  // Name field must not receive email/phone/url, and should be short-ish.
  if (wantsName && (looksEmail || looksPhone || looksUrl)) return false;
  if (wantsName && v.length > 60) return false;
  // Date field should look like a date, not a name or email.
  if (wantsDate && (looksEmail || looksPhone || /[a-z]{4,}/i.test(v.replace(/[a-z]+ \d/i, "")))) {
    // allow things like "January 2020"; reject "Patel"
    if (!/\d/.test(v)) return false;
  }

  return true;
}

export async function findAnswer(
  question: string
): Promise<string | null> {
  const hash = hashQuestion(question);

  // 1) Exact match (normalized text hash) — fast path.
  const exact = await prisma.applicationMemory.findFirst({
    where: { userId: DEFAULT_USER_ID, questionHash: hash },
    orderBy: { usageCount: "desc" },
  });
  if (exact) {
    await bumpUsage(exact.id);
    return exact.answerText;
  }

  // 2) Semantic match — the same question phrased differently (e.g.
  //    "Are you authorized to work in the US?" vs "Do you have US work
  //    authorization?"). Uses local embeddings (nomic-embed-text). Degrades
  //    gracefully to null if the embed model isn't available.
  return findAnswerSemantic(question);
}

async function findAnswerSemantic(question: string): Promise<string | null> {
  if (embeddingsDisabled) return null;
  try {
    const all = await prisma.applicationMemory.findMany({
      where: { userId: DEFAULT_USER_ID },
      orderBy: { usageCount: "desc" },
      take: 300,
    });
    if (all.length === 0) return null;

    const queryEmb = await generateEmbedding(question);

    let best: { id: string; answerText: string; questionText: string } | null = null;
    let bestScore = 0;
    for (const m of all) {
      let emb = embeddingCache.get(m.questionHash);
      if (!emb) {
        emb = await generateEmbedding(m.questionText);
        embeddingCache.set(m.questionHash, emb);
      }
      const score = cosineSimilarity(queryEmb, emb);
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }

    // 0.85+ cosine on nomic-embed-text reliably means "same intent".
    if (best && bestScore >= 0.85) {
      await bumpUsage(best.id);
      return best.answerText;
    }
    return null;
  } catch {
    // Embed model missing or Ollama down — disable to avoid repeated failures.
    embeddingsDisabled = true;
    return null;
  }
}

async function bumpUsage(id: string): Promise<void> {
  await prisma.applicationMemory.update({
    where: { id },
    data: { usageCount: { increment: 1 }, lastUsed: new Date() },
  }).catch(() => {});
}

// Automated save (AI/capture/shortcut). Validates value↔label and NEVER
// overwrites a locked memory. `force` (human edits) bypasses validation.
export async function saveAnswer(
  question: string,
  answer: string,
  category: MemoryCategory | string = "GENERAL",
  platform?: string,
  force = false
): Promise<void> {
  if (!force && !isPlausibleAnswer(question, answer)) {
    // Reject implausible auto-captures (email into "Degree", etc.).
    return;
  }

  const hash = hashQuestion(question);
  const cat = safeCategory(category);

  const existing = await prisma.applicationMemory.findUnique({
    where: { userId_questionHash: { userId: DEFAULT_USER_ID, questionHash: hash } },
  });

  // Locked memory is authoritative — automated saves can't change it.
  if (existing?.locked && !force) {
    await bumpUsage(existing.id);
    return;
  }

  await prisma.applicationMemory.upsert({
    where: { userId_questionHash: { userId: DEFAULT_USER_ID, questionHash: hash } },
    update: {
      answerText: answer,
      category: cat,
      platform: platform || null,
      usageCount: { increment: 1 },
      lastUsed: new Date(),
    },
    create: {
      userId: DEFAULT_USER_ID,
      questionText: question,
      questionHash: hash,
      answerText: answer,
      category: cat,
      platform: platform || null,
    },
  });
}

// Save an answer the HUMAN typed/corrected — treated as authoritative. Besides
// the exact upsert, it OVERWRITES any near-duplicate memory whose answer
// differs, so a previously-saved bad answer (even phrased differently) gets
// corrected instead of leaving stale wrong data to be re-served later.
export async function saveHumanAnswer(
  question: string,
  answer: string,
  platform?: string
): Promise<void> {
  // Human-entered → authoritative: skip validation (force) so a legitimately
  // unusual answer the user typed is always kept.
  await saveAnswer(question, answer, "GENERAL", platform, true);

  if (embeddingsDisabled) return;
  try {
    const myHash = hashQuestion(question);
    const all = await prisma.applicationMemory.findMany({
      where: { userId: DEFAULT_USER_ID },
      take: 300,
    });
    if (all.length <= 1) return;

    const queryEmb = await generateEmbedding(question);
    for (const m of all) {
      if (m.questionHash === myHash) continue;
      if (m.locked) continue; // never clobber a locked memory
      if (m.answerText.trim() === answer.trim()) continue; // already correct

      let emb = embeddingCache.get(m.questionHash);
      if (!emb) {
        emb = await generateEmbedding(m.questionText);
        embeddingCache.set(m.questionHash, emb);
      }
      // Higher threshold (0.90) than lookup (0.85) — only correct what is almost
      // certainly the SAME question, to avoid clobbering a genuinely different one.
      if (cosineSimilarity(queryEmb, emb) >= 0.9) {
        await prisma.applicationMemory.update({
          where: { id: m.id },
          data: { answerText: answer, lastUsed: new Date() },
        }).catch(() => {});
      }
    }
  } catch {
    embeddingsDisabled = true;
  }
}

// Toggle the lock on a memory (locked = AI/capture can't change it).
export async function setMemoryLock(id: string, locked: boolean): Promise<void> {
  await prisma.applicationMemory.update({ where: { id }, data: { locked } });
}

// Delete memories whose stored answer is implausible for their field label —
// cleans up the email-everywhere / phone-in-School pollution. Locked rows are
// kept. Returns how many were removed.
export async function cleanupBadMemories(): Promise<number> {
  const all = await prisma.applicationMemory.findMany({ where: { userId: DEFAULT_USER_ID } });
  const badIds = all
    .filter((m) => !m.locked && !isPlausibleAnswer(m.questionText, m.answerText))
    .map((m) => m.id);
  if (badIds.length) {
    await prisma.applicationMemory.deleteMany({ where: { id: { in: badIds } } });
  }
  return badIds.length;
}

export async function getAllMemories(category?: MemoryCategory) {
  return prisma.applicationMemory.findMany({
    where: {
      userId: DEFAULT_USER_ID,
      ...(category ? { category } : {}),
    },
    orderBy: [{ usageCount: "desc" }, { lastUsed: "desc" }],
  });
}

export async function deleteMemory(id: string): Promise<void> {
  await prisma.applicationMemory.delete({ where: { id } });
}

export async function updateMemory(id: string, answerText: string): Promise<void> {
  await prisma.applicationMemory.update({
    where: { id },
    data: { answerText, updatedAt: new Date() },
  });
}

export async function getOrCreateUser() {
  let user = await prisma.user.findFirst({
    where: { id: DEFAULT_USER_ID },
  });

  if (!user) {
    user = await prisma.user.create({
      data: { id: DEFAULT_USER_ID },
    });
  }

  return user;
}
