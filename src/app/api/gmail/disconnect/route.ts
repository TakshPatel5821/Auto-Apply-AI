import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { disconnectGmail } from "@/lib/gmail/client";

export const runtime = "nodejs";

// POST — revoke + clear the stored Gmail token.
export async function POST() {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await disconnectGmail();
  return NextResponse.json({ ok: true });
}
