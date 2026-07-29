import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth/session";
import { automationEngine } from "@/lib/automation/automation-engine";
import { prisma } from "@/lib/db/prisma";

// Server-Sent Events stream of live automation state, stats, and logs.
// Chosen over Socket.IO because it works natively with App Router route
// handlers (no custom server / no ejecting from `next dev`).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function computeStats() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [totalJobs, analyzedJobs, appliedToday, totalApplications, scrapedToday, fitJobs] =
    await Promise.all([
      prisma.job.count({ where: { isSpam: false, isBlacklisted: false } }),
      prisma.job.count({ where: { status: { in: ["ANALYZED", "TAILORED", "APPLIED"] } } }),
      prisma.application.count({ where: { userId: "local", appliedAt: { gte: today } } }),
      prisma.application.count({ where: { userId: "local" } }),
      prisma.job.count({ where: { scrapedAt: { gte: today }, isSpam: false } }),
      prisma.job.count({ where: { matchScore: { lte: 6 }, isSpam: false, isBlacklisted: false } }),
    ]);
  return { totalJobs, analyzedJobs, appliedToday, totalApplications, scrapedToday, fitJobs };
}

const LOG_SELECT = {
  id: true,
  level: true,
  category: true,
  message: true,
  createdAt: true,
} as const;

export async function GET(req: NextRequest) {
  if (!(await getSession())) {
    return new Response("Unauthorized", { status: 401 });
  }

  const encoder = new TextEncoder();
  let closed = false;
  let lastLogTime = new Date(0);

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* controller already closed */
        }
      };

      // Initial snapshot.
      send("state", automationEngine.getState());
      send("stats", await computeStats());
      const initLogs = await prisma.automationLog.findMany({
        orderBy: { createdAt: "desc" },
        take: 100,
        select: LOG_SELECT,
      });
      if (initLogs.length) lastLogTime = initLogs[0].createdAt;
      send("logs", initLogs.reverse());

      const tick = async () => {
        if (closed) return;
        try {
          send("state", automationEngine.getState());
          send("stats", await computeStats());

          // Only resend logs when new ones exist (keeps the stream cheap).
          const fresh = await prisma.automationLog.findMany({
            where: { createdAt: { gt: lastLogTime } },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { createdAt: true },
          });
          if (fresh.length) {
            lastLogTime = fresh[0].createdAt;
            const recent = await prisma.automationLog.findMany({
              orderBy: { createdAt: "desc" },
              take: 100,
              select: LOG_SELECT,
            });
            send("logs", recent.reverse());
          }
        } catch {
          /* transient DB error — keep the stream alive */
        }
      };

      const interval = setInterval(tick, 2000);
      // SSE comment heartbeat so proxies don't drop the idle connection.
      const heartbeat = setInterval(() => {
        if (!closed) {
          try {
            controller.enqueue(encoder.encode(`: ping\n\n`));
          } catch {
            /* closed */
          }
        }
      }, 15000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(interval);
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      req.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
