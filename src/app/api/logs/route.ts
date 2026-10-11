import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";

const MAX_LIMIT = 500;

export async function GET(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const limit = Math.min(Math.max(Number(searchParams.get("limit")) || 100, 1), MAX_LIMIT);

  // Newest first from the DB, returned oldest → newest so the console reads top-down.
  const logs = await prisma.automationLog.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return NextResponse.json({ logs: logs.reverse() });
}

export async function DELETE(_req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { count } = await prisma.automationLog.deleteMany({});
  return NextResponse.json({ success: true, deleted: count });
}
