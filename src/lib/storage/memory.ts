import crypto from "crypto";
import { prisma } from "@/lib/db/prisma";
import { MemoryCategory } from "@/types";

const DEFAULT_USER_ID = "local";

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

  const memory = await prisma.applicationMemory.findFirst({
    where: { userId: DEFAULT_USER_ID, questionHash: hash },
    orderBy: { usageCount: "desc" },
  });

  if (memory) {
    await prisma.applicationMemory.update({
      where: { id: memory.id },
      data: { usageCount: { increment: 1 }, lastUsed: new Date() },
    });
    return memory.answerText;
  }

  return null;
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
