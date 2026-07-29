import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";

// Phase 9: per-field decision log for the replay/debug view. Returned lazily
// (not in the applications list) since it can hold up to ~500 records per run.
export async function GET(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "missing id" }, { status: 400 });

  const app = await prisma.application.findUnique({
    where: { id },
    select: { fieldDecisions: true, status: true, error: true },
  });
  if (!app) return NextResponse.json({ error: "not found" }, { status: 404 });

  return NextResponse.json({
    status: app.status,
    error: app.error,
    fieldDecisions: app.fieldDecisions ?? [],
  });
}
