import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";

// ─── Session secret ──────────────────────────────────────────────────────────
// AUTH_SECRET signs the session JWT. There is deliberately NO fallback value: a
// hardcoded default would be public in this repository, letting anyone mint a
// valid session cookie for any deployment that forgot to set it. Missing or
// too-short secrets fail loudly at first use instead.

const MIN_SECRET_LENGTH = 32;

let cachedSecret: Uint8Array | null = null;

function getSecret(): Uint8Array {
  if (cachedSecret) return cachedSecret;

  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.trim().length < MIN_SECRET_LENGTH) {
    throw new Error(
      `AUTH_SECRET must be set to a random string of at least ${MIN_SECRET_LENGTH} characters. ` +
        `Generate one with:  openssl rand -base64 48`
    );
  }
  cachedSecret = new TextEncoder().encode(secret);
  return cachedSecret;
}

/** True when AUTH_SECRET is configured well enough to sign sessions. */
export function isAuthConfigured(): boolean {
  const secret = process.env.AUTH_SECRET;
  return !!secret && secret.trim().length >= MIN_SECRET_LENGTH;
}

const SESSION_COOKIE = "job_agent_session";
const SESSION_DURATION = 7 * 24 * 60 * 60; // 7 days

export async function createSession(): Promise<string> {
  return new SignJWT({ authenticated: true, userId: "local" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DURATION}s`)
    .sign(getSecret());
}

export async function verifySession(token: string): Promise<boolean> {
  try {
    // Pin the algorithm: without this, a token could declare its own `alg`.
    await jwtVerify(token, getSecret(), { algorithms: ["HS256"] });
    return true;
  } catch {
    return false;
  }
}

export async function getSession(): Promise<boolean> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return false;
  return verifySession(token);
}

export async function setSessionCookie(token: string) {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_DURATION,
    path: "/",
  });
}

export async function clearSession() {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}
