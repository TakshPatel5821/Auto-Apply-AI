import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { syncInbox } from "@/lib/gmail/sync";

export const runtime = "nodejs";
export const maxDuration = 300;

// GET — recent EmailEvents for the live inbox panel.
export async function GET() {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const events = await prisma.emailEvent.findMany({
    orderBy: { receivedAt: "desc" },
    take: 30,
  });
  return NextResponse.json({ events });
}

// POST — scan the inbox now (classify + auto-update statuses).
export async function POST() {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await syncInbox();
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: `Sync failed: ${String(e)}` }, { status: 500 });
  }
}
