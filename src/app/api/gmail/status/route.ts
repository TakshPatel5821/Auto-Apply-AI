import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { gmailStatus } from "@/lib/gmail/client";

export const runtime = "nodejs";

// GET — connection status for the inbox panel (never returns the token).
export async function GET() {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await gmailStatus());
}
