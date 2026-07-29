# Security Policy

## Supported Versions

This project is pre-1.0. Only the latest `main` receives security fixes.

| Version | Supported |
| ------- | --------- |
| `main`  | ✅        |
| < 1.0   | ❌        |

## Reporting a Vulnerability

**Do not open a public issue for security problems.**

Report privately through
[GitHub Security Advisories](https://github.com/TakshPatel5821/Auto-Apply-AI/security/advisories/new).

Please include:

- what the issue is and which component it affects,
- reproduction steps or a proof of concept,
- the impact you believe it has.

You can expect an acknowledgement within 7 days and a status update within 30 days.
Please give a reasonable window for a fix before public disclosure.

## Threat Model — read this before deploying

This application is designed as a **single-user, local-first tool**. It is *not*
multi-tenant and is *not* hardened for exposure to the public internet:

- `userId` is hardcoded to `"local"` throughout — there are no user accounts,
  no per-user data isolation, and no authorization layer beyond a single shared
  password.
- The login rate limiter keeps state **in process memory**. It protects a single
  instance only; behind a load balancer, back it with a shared store.
- The app holds broad capability by design: it drives a real browser, reads your
  Gmail (read-only OAuth), stores ATS credentials, and writes files to disk.
  Anyone who obtains a session cookie inherits all of it.

**Run it on `localhost` or behind a VPN.** If you must expose it, put it behind
an authenticating reverse proxy with TLS and IP allow-listing.

## Handling of Secrets

| Secret | Where it lives | Protection |
| ------ | -------------- | ---------- |
| `AUTH_SECRET` | `.env` | Required, ≥ 32 chars, no default — the app refuses to sign sessions without it |
| Dashboard password | `.env` | Store as a bcrypt hash in `AUTH_PASSWORD_HASH` (`npm run auth:hash`); plaintext `AUTH_PASSWORD` is compared in constant time |
| ATS / LinkedIn credentials | Postgres | AES-256-GCM at rest, key in `~/.job-agent-tools/secret.key` (mode `600`) |
| Gmail refresh token | Postgres | AES-256-GCM at rest; scope limited to `gmail.readonly` |
| AI provider API keys | `.env` | Never logged, never sent to the browser |

The encryption key protects data at rest against casual disk access. It is stored
on the same machine as the data, so it is **not** a substitute for a real secrets
manager — it is a meaningful upgrade over plaintext for a local install.

## Built-in Protections

- **Session**: `HttpOnly`, `SameSite=Lax`, `Secure` in production; HS256 JWT with
  a pinned algorithm.
- **Login**: constant-time comparison, bcrypt hash support, 5 attempts per
  15 minutes then a 15-minute lockout.
- **SSRF**: user-supplied scrape URLs are protocol-checked and DNS-resolved, and
  private, loopback, link-local and cloud-metadata addresses are rejected
  (`src/lib/scraping/url-guard.ts`).
- **Injection**: all database access goes through Prisma's parameterised queries;
  LaTeX input is escaped before compilation; subprocesses are spawned with
  `execFile`/`spawn` and argument arrays, never a shell string.
- **Headers**: `X-Content-Type-Options`, `X-Frame-Options: DENY`,
  `Referrer-Policy`, and a restrictive `Permissions-Policy`.

## Dependency Hygiene

CI fails the build on **high or critical** advisories in runtime dependencies
(`npm audit --omit=dev --audit-level=high`). Dev-only advisories are reported but
not blocking, since they don't ship.

Where an upstream package has not yet released a fix, `package.json` pins a
patched transitive version via npm `overrides` rather than accepting the
advisory. Each entry there exists for a specific CVE — check `git log` before
removing one.

One advisory is knowingly accepted: `uuid <11.1.1` reached through `exceljs`.
The only offered remedy is a major downgrade of `exceljs`, and the flaw requires
a caller-supplied `buf` argument to `v3`/`v5`/`v6`, which this codebase never
passes.

## Known Gaps

These are accepted trade-offs for the current single-user scope, not oversights:

- **No CSP.** Next's inline runtime scripts need a nonce-based policy delivered
  per request. Tracked on the roadmap.
- **No CSRF tokens.** Mitigated by `SameSite=Lax` cookies; a dedicated token
  layer is warranted if the app is ever exposed beyond localhost.
- **DNS rebinding.** The SSRF guard resolves at validation time; a determined
  attacker could race the subsequent connect.
- **Git history.** Releases before the `config/resume.json` split contain the
  original author's personal details. Forks intending a clean public history
  should squash or rewrite.
