import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { fetchLatestOtp } from "@/lib/gmail/otp";

export const runtime = "nodejs";
export const maxDuration = 120;

// POST { sinceMinutes?, fromContains?, subjectContains?, timeoutMs? }
// Manual "Get latest code" — pulls the newest verification code from Gmail.
export async function POST(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const sinceMinutes = Number(body.sinceMinutes) > 0 ? Number(body.sinceMinutes) : 10;
  const since = Date.now() - sinceMinutes * 60 * 1000;

  const result = await fetchLatestOtp({
    since,
    fromContains: body.fromContains || undefined,
    subjectContains: body.subjectContains || undefined,
    // Manual button: short budget so the UI doesn't hang.
    timeoutMs: Number(body.timeoutMs) > 0 ? Number(body.timeoutMs) : 25_000,
    pollMs: 4_000,
  });

  if (!result) {
    return NextResponse.json({ code: null, error: "No verification code found" }, { status: 404 });
  }
  return NextResponse.json({
    code: result.code,
    from: result.message.fromEmail,
    subject: result.message.subject,
    receivedAt: result.message.date,
  });
}
