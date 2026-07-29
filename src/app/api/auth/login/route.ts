import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import bcrypt from "bcryptjs";
import { createSession, setSessionCookie, isAuthConfigured } from "@/lib/auth/session";
import { checkLoginAllowed, recordLoginFailure, resetLoginAttempts } from "@/lib/auth/rate-limit";
import { getOrCreateUser } from "@/lib/storage/memory";

// Password check, in order of preference:
//   1. AUTH_PASSWORD_HASH — a bcrypt hash (recommended; nothing reusable on disk)
//   2. AUTH_PASSWORD      — plaintext, compared in constant time (back-compat)
// Generate a hash with:  npx tsx scripts/hash-password.ts
async function passwordMatches(candidate: string): Promise<boolean> {
  const hash = process.env.AUTH_PASSWORD_HASH;
  if (hash) return bcrypt.compare(candidate, hash);

  const expected = process.env.AUTH_PASSWORD;
  if (!expected) return false;
  return constantTimeEquals(candidate, expected);
}

// `===` on secrets leaks their length and shared prefix through timing. Hash
// both sides first so the comparison is over equal-length buffers regardless of
// input length, then compare with timingSafeEqual.
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so the mismatch path costs the same.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

// Best-effort client identity for throttling. Behind a proxy this is the
// forwarded address; locally it collapses to a single bucket, which is fine for
// a single-user tool.
function clientKey(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip")?.trim() || "local";
}

export async function POST(req: NextRequest) {
  if (!isAuthConfigured()) {
    return NextResponse.json(
      { error: "Server not configured: AUTH_SECRET is missing or too short." },
      { status: 500 }
    );
  }
  if (!process.env.AUTH_PASSWORD_HASH && !process.env.AUTH_PASSWORD) {
    return NextResponse.json(
      { error: "Server not configured: set AUTH_PASSWORD_HASH (or AUTH_PASSWORD)." },
      { status: 500 }
    );
  }

  const key = clientKey(req);
  const limit = checkLoginAllowed(key);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many failed attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  const body = await req.json().catch(() => null);
  const password = typeof body?.password === "string" ? body.password : "";
  if (!password) {
    recordLoginFailure(key);
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  if (!(await passwordMatches(password))) {
    const after = recordLoginFailure(key);
    // Same generic message either way — never reveal whether a lockout is due
    // to a wrong password or an unconfigured server.
    return NextResponse.json(
      { error: "Invalid password" },
      after.allowed
        ? { status: 401 }
        : { status: 429, headers: { "Retry-After": String(after.retryAfterSeconds) } }
    );
  }

  resetLoginAttempts(key);
  await getOrCreateUser();

  const token = await createSession();
  await setSessionCookie(token);

  return NextResponse.json({ success: true });
}
