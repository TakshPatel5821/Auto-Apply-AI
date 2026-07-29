import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { exchangeCodeForTokens } from "@/lib/gmail/client";

export const runtime = "nodejs";

// GET — OAuth redirect target. Exchanges the code for tokens (persisting the
// encrypted refresh token), then sends the user back to the dashboard.
export async function GET(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.redirect(new URL("/", req.url));
  }

  const code = req.nextUrl.searchParams.get("code");
  const err = req.nextUrl.searchParams.get("error");
  if (err || !code) {
    return NextResponse.redirect(new URL("/dashboard?gmail=error", req.url));
  }

  try {
    await exchangeCodeForTokens(code);
    return NextResponse.redirect(new URL("/dashboard?gmail=connected", req.url));
  } catch {
    return NextResponse.redirect(new URL("/dashboard?gmail=error", req.url));
  }
}
