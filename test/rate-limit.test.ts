import { describe, it, expect, beforeEach } from "vitest";
import {
  checkLoginAllowed,
  recordLoginFailure,
  resetLoginAttempts,
  resetAllLoginAttempts,
} from "@/lib/auth/rate-limit";

const MAX_ATTEMPTS = 5;

describe("login rate limiter", () => {
  beforeEach(() => resetAllLoginAttempts());

  it("allows a fresh key", () => {
    const state = checkLoginAllowed("1.2.3.4");
    expect(state.allowed).toBe(true);
    expect(state.remainingAttempts).toBe(MAX_ATTEMPTS);
  });

  it("counts down remaining attempts on each failure", () => {
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      const state = recordLoginFailure("1.2.3.4");
      expect(state.allowed).toBe(true);
      expect(state.remainingAttempts).toBe(MAX_ATTEMPTS - i);
    }
  });

  it("locks out after the maximum failures and reports a retry delay", () => {
    let state = { allowed: true, retryAfterSeconds: 0, remainingAttempts: MAX_ATTEMPTS };
    for (let i = 0; i < MAX_ATTEMPTS; i++) state = recordLoginFailure("1.2.3.4");

    expect(state.allowed).toBe(false);
    expect(state.retryAfterSeconds).toBeGreaterThan(0);
    expect(checkLoginAllowed("1.2.3.4").allowed).toBe(false);
  });

  it("isolates keys from one another", () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) recordLoginFailure("1.2.3.4");
    expect(checkLoginAllowed("1.2.3.4").allowed).toBe(false);
    expect(checkLoginAllowed("5.6.7.8").allowed).toBe(true);
  });

  it("clears history after a successful login", () => {
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) recordLoginFailure("1.2.3.4");
    resetLoginAttempts("1.2.3.4");
    expect(checkLoginAllowed("1.2.3.4").remainingAttempts).toBe(MAX_ATTEMPTS);
  });
});
