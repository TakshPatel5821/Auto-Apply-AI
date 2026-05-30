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

export async function saveAnswer(
  question: string,
  answer: string,
  category: MemoryCategory | string = "GENERAL",
  platform?: string
): Promise<void> {
  const hash = hashQuestion(question);
  const cat = safeCategory(category);

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
  await saveAnswer(question, answer, "GENERAL", platform);

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
