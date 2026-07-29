// ─── Login throttling ────────────────────────────────────────────────────────
// The dashboard is protected by a single shared password, so an unthrottled
// login endpoint is a free offline-speed guessing oracle. This adds a small
// fixed-window limiter with progressive lockout.
//
// State is in-process on purpose: this app is a single-user, single-instance
// local tool (see README). If it is ever run multi-instance, back this with
// Redis — the interface below is deliberately narrow enough to swap.

const MAX_ATTEMPTS = 5; // failures allowed inside the window
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const LOCKOUT_MS = 15 * 60 * 1000; // lock for 15 minutes once tripped
const MAX_TRACKED_KEYS = 1_000; // bound memory against spoofed-IP floods

interface AttemptRecord {
  failures: number;
  firstFailureAt: number;
  lockedUntil: number;
}

const attempts = new Map<string, AttemptRecord>();

// Drop expired records, then oldest-first if still over the cap. Called on each
// failure, so the map can't grow without bound from rotating client IPs.
function evictStale(now: number): void {
  for (const [key, rec] of attempts) {
    const expired = now - rec.firstFailureAt > WINDOW_MS && now > rec.lockedUntil;
    if (expired) attempts.delete(key);
  }
  if (attempts.size <= MAX_TRACKED_KEYS) return;
  const oldest = [...attempts.entries()].sort((a, b) => a[1].firstFailureAt - b[1].firstFailureAt);
  for (const [key] of oldest.slice(0, attempts.size - MAX_TRACKED_KEYS)) attempts.delete(key);
}

export interface RateLimitState {
  allowed: boolean;
  /** Seconds until the caller may retry (only meaningful when blocked). */
  retryAfterSeconds: number;
  remainingAttempts: number;
}

/** Check whether `key` (typically a client IP) may attempt a login right now. */
export function checkLoginAllowed(key: string): RateLimitState {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec) return { allowed: true, retryAfterSeconds: 0, remainingAttempts: MAX_ATTEMPTS };

  if (now < rec.lockedUntil) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((rec.lockedUntil - now) / 1000),
      remainingAttempts: 0,
    };
  }

  // Window elapsed with no lock in force → forget the old failures.
  if (now - rec.firstFailureAt > WINDOW_MS) {
    attempts.delete(key);
    return { allowed: true, retryAfterSeconds: 0, remainingAttempts: MAX_ATTEMPTS };
  }

  return {
    allowed: true,
    retryAfterSeconds: 0,
    remainingAttempts: Math.max(0, MAX_ATTEMPTS - rec.failures),
  };
}

/** Record a failed login, locking the key out once it exceeds MAX_ATTEMPTS. */
export function recordLoginFailure(key: string): RateLimitState {
  const now = Date.now();
  evictStale(now);

  const rec = attempts.get(key);
  if (!rec || now - rec.firstFailureAt > WINDOW_MS) {
    attempts.set(key, { failures: 1, firstFailureAt: now, lockedUntil: 0 });
    return { allowed: true, retryAfterSeconds: 0, remainingAttempts: MAX_ATTEMPTS - 1 };
  }

  rec.failures += 1;
  if (rec.failures >= MAX_ATTEMPTS) {
    rec.lockedUntil = now + LOCKOUT_MS;
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil(LOCKOUT_MS / 1000),
      remainingAttempts: 0,
    };
  }
  return {
    allowed: true,
    retryAfterSeconds: 0,
    remainingAttempts: MAX_ATTEMPTS - rec.failures,
  };
}

/** Clear a key's history after a successful login. */
export function resetLoginAttempts(key: string): void {
  attempts.delete(key);
}

/** Test-only: wipe all limiter state. */
export function resetAllLoginAttempts(): void {
  attempts.clear();
}
