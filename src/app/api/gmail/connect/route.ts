import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getAuthUrl } from "@/lib/gmail/client";

export const runtime = "nodejs";

// GET — kick off the OAuth consent flow. Redirects the browser to Google's
// consent screen; on success Google redirects back to /api/gmail/oauth/callback.
export async function GET(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.redirect(new URL("/", req.url));
  }
  try {
    return NextResponse.redirect(getAuthUrl());
  } catch {
    // Missing GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET.
    return NextResponse.redirect(new URL("/dashboard?gmail=not_configured", req.url));
  }
}
