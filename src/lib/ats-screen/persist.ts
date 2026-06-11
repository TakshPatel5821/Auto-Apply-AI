import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import type { LoopResult } from "./types";

// Save one screening run (accepted OR rejected) with its full round history.
export async function saveScreeningResult(jobId: string, resumeId: string | null, result: LoopResult) {
  return prisma.screeningResult.create({
    data: {
      jobId,
      resumeId,
      accepted: result.accepted,
      finalScore: result.finalScore,
      reason: result.reason ?? null,
      learnList: result.learnList,
      rounds: result.rounds as unknown as Prisma.InputJsonValue,
      tailoredResumeId: result.tailoredResumeId ?? null,
      coverLetterId: result.coverLetterId ?? null,
    },
  });
}

// The most recent screening for a job (so the panel can show it without re-running).
export async function getLatestScreening(jobId: string) {
  return prisma.screeningResult.findFirst({ where: { jobId }, orderBy: { createdAt: "desc" } });
}
