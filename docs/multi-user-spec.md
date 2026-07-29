# Multi-User Conversion — Phase 1 & 2 Spec

Status: **spec only, not implemented.** Scopes the work to turn the single-user
(`userId = "local"`) tool into a real multi-user application. Concurrency
(Phase 3) and hosted deploy/onboarding (Phase 4) are **out of scope here** — see
"Deferred" at the end. Phase 3 has been decided in principle: a **durable job
queue + persisted run-state** (e.g. pg-boss/BullMQ), not per-user in-memory
engines.

---

## Goal

After Phases 1–2, multiple people can each sign up, log in, and see **only their
own** jobs, applications, résumés, memory, settings, credentials, Gmail data, and
logs. No request can read or mutate another user's data. The engine still runs
in one process (Phase 3 fixes that), but every query is correctly scoped.

## Current state (as-is)

- **Identity is fake.** `createSession()` hardcodes `userId:"local"` into the JWT
  ([session.ts:12](../src/lib/auth/session.ts#L12)). Login checks a single shared
  `AUTH_PASSWORD` env var ([login/route.ts:14](../src/app/api/auth/login/route.ts#L14)).
  `User.id` is a cuid but nothing ever reads it — everything queries the literal
  `"local"`.
- **Middleware checks validity, not identity.** It verifies the token is signed
  but never extracts *who* ([middleware.ts:13-19](../src/middleware.ts#L13-L19)).
- **`"local"` appears in 91 call sites across 30 files** (see inventory below).
  Some are inline `where: { userId: "local" }`; some are module-level constants
  (`USER_ID` / `DEFAULT_USER_ID`) in library files that take no user parameter.
- **Data model is partly ready.** `Resume`/`Application`/`ApplicationMemory`/
  `UserSettings` already have `userId` + cascade. `Job`, `GithubProject`,
  `AutomationLog`, `EmailEvent`, `ScrapingSession`, `ScreeningResult` do **not**.

---

# Phase 1 — Identity plumbing

Goal: a real, per-user identity flows from login → JWT → every request. No query
scoping yet (that's Phase 2); this phase just makes `getUserId()` return the
correct real id.

### 1.1 Schema — real users

Add auth fields to `User` and a migration:

```prisma
model User {
  id           String   @id @default(cuid())
  email        String   @unique          // NEW — login identifier
  passwordHash String                    // NEW — bcrypt
  name         String?                   // NEW — optional display name
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  // ...existing relations
}
```

Migration also needs a **data step**: rename the existing `"local"` user to a
real account (or create one) so existing rows (which point at `userId:"local"`)
keep working. Simplest: keep the row with `id:"local"`, backfill
`email`/`passwordHash` from `AUTH_PASSWORD` + a seed email, so the current user's
data survives the cutover. New signups get cuid ids.

### 1.2 Session carries the real id

- `createSession(userId: string)` — put the real id in the JWT instead of
  `"local"` ([session.ts:11-17](../src/lib/auth/session.ts#L11-L17)).
- `verifySession(token)` → return the **decoded payload** (or `null`), not a
  boolean, so callers can read `userId`.
- New `getUserId(): Promise<string | null>` in `session.ts` — reads the cookie,
  verifies, returns `payload.userId`. This is the function Phase 2 threads
  everywhere. Keep `getSession()` as a boolean shim during migration.

### 1.3 Auth routes

- **`POST /api/auth/signup`** (new): `{ email, password, name? }` → validate,
  `bcrypt.hash`, create `User` + seed default `UserSettings` (mirror
  `getOrCreateUser` / `prisma/seed.ts`), create session, set cookie.
- **`POST /api/auth/login`** (rewrite [login/route.ts](../src/app/api/auth/login/route.ts)):
  look up user by `email`, `bcrypt.compare`, `createSession(user.id)`. Drop the
  shared-password path (keep it only behind an env flag for the existing account
  during transition, if desired).
- **`GET /api/auth/me`** (new, optional but useful): returns `{ id, email, name }`
  for the UI header.

### 1.4 Middleware

Middleware already gates `/api/*` and `/dashboard`. Change: on invalid/missing
token for `/dashboard` redirect to `/` (unchanged); no per-user logic needed here
because routes do their own scoping. Optionally forward `userId` as a request
header to save a re-verify in each route — **not required** if routes call
`getUserId()`.

### 1.5 Login/landing UI

`page.tsx` currently posts a single password. Add email + password fields and a
signup toggle. Low effort; the API shape above drives it.

**Phase 1 exit criteria:** a new user can sign up, log in, and `getUserId()`
returns their real cuid on every request. Old `"local"` data still loads for the
migrated account. All 175 existing tests still pass; add tests for
signup/login/getUserId.

---

# Phase 2 — Scope every query

Goal: replace all 91 `"local"` usages with the session `userId`, add `userId` to
the models that lack it, and verify ownership on every read/mutate. This is the
phase where isolation bugs hide — each route is checked individually.

### 2.1 Schema additions (migration)

| Model | Change | Why |
|---|---|---|
| `Job` | add `userId` + relation + `@@index([userId])` | match/ATS/visa scores are résumé-specific; jobs must be per-user, not a shared pool |
| `GithubProject` | add `userId`; change `repo @unique` → `@@unique([userId, repo])` | two users must be able to import the same repo |
| `AutomationLog` | add `userId` (nullable ok for system logs) + index | the live log console must show only the caller's logs |
| `EmailEvent` | add `userId` + index; keep `gmailId @unique` (per-account ids don't collide) | scope inbox events + display |
| `ScrapingSession` | add `userId` + index | per-user scrape history |
| `ScreeningResult` | scoped via `jobId` today; once `Job` has `userId`, verify ownership in queries (no column strictly required, but add `userId` for direct filtering) | avoid cross-user reads via a guessed `jobId` |

Backfill step in the migration: set `userId = "local"` (the migrated account)
for all existing rows.

### 2.2 Refactor module-level `USER_ID` constants → parameters

These library files hardcode the user and take no user argument. Each needs its
public functions to accept `userId`:

- [memory.ts](../src/lib/storage/memory.ts) — `DEFAULT_USER_ID` used across
  `saveAnswer`/`saveHumanAnswer`/`recordRejection`/lookup/`getOrCreateUser`.
  Thread `userId` through all exported fns.
- [credentials.ts](../src/lib/security/credentials.ts) — `USER_ID`; resolve/save/
  status must take `userId`.
- [profile-store.ts](../src/lib/profile/profile-store.ts) — `USER_ID`; load/save/
  seed take `userId`.
- [gmail/client.ts](../src/lib/gmail/client.ts) & [gmail/sync.ts](../src/lib/gmail/sync.ts)
  — `USER_ID`; OAuth token read/write and `syncInbox()` take `userId`. Note the
  Gmail OAuth `state` param must round-trip the `userId` through
  `connect`→`callback`.
- [export/excel.ts](../src/lib/export/excel.ts) — `generateJobsExcel(userId)`.
- [agent/core.ts](../src/lib/agent/core.ts), [scraping/discovery-monitor.ts](../src/lib/scraping/discovery-monitor.ts),
  [scraping/scraping-orchestrator.ts](../src/lib/scraping/scraping-orchestrator.ts)
  — accept `userId` (the orchestrator persists `Job` rows → now needs the owner).

### 2.3 Thread `userId` into the engine

[automation-engine.ts](../src/lib/automation/automation-engine.ts) is a singleton
with in-memory run state ([lines 30-53](../src/lib/automation/automation-engine.ts#L30-L53))
and two `userId:"local"` writes ([347](../src/lib/automation/automation-engine.ts#L347),
[418](../src/lib/automation/automation-engine.ts#L418)). For Phase 2 (still one
process), `start()` must accept `userId` and pass it to the orchestrator, tailor,
apply, and gmail-sync calls. **This is the seam Phase 3 replaces** with a durable
queue keyed by `userId` — so keep `userId` an explicit argument now, never read
from a global.

### 2.4 API routes — replace `"local"` with `getUserId()`

Every route below: call `const userId = await getUserId()`; `401` if null; use it
in the query. Any route that reads a record by id (`applicationId`, `jobId`,
`tailoredResumeId`, project `id`, memory `id`) must **also verify the record
belongs to `userId`** before returning/mutating — a valid session for user A must
not fetch user B's `applicationId`.

Routes touching `"local"` (from inventory):
`analytics`, `applications/{apply, apply-all, file, list, screen, tailor-all}`,
`automation/{start, status}`, `career`, `dashboard/stats`,
`jobs/{interview-prep, recruiter-message}`, `resume/upload`,
`settings`, `settings/sites`, `stream`.

Plus routes that don't currently say `"local"` but read records by id and will
need ownership checks once data is multi-user: `applications/{diff, status,
decisions, delete, classify-email}`, `jobs/{list, match, ats-score}`,
`github/{fetch, projects}`, `memory`, `gmail/*`, `export`, `logs`,
`extension/scan` (this one posts from the browser extension — needs a per-user
token, see risk below).

### 2.5 Scripts / non-HTTP entry points

`scripts/agent-cli.ts`, `scripts/mcp-server.ts`, `scripts/screen-loop.ts`,
`scripts/smoke-tailor.ts` assume `"local"`. Give them a `--user <email|id>` flag
(or `JOB_AGENT_USER` env) resolving to a real id. Lower priority than the HTTP
surface but must not silently write to the wrong account.

### 2.6 Per-user filesystem

- Generated artifacts live in `applications/<...>`. Namespace by user:
  `applications/<userId>/<...>` in [file-manager.ts](../src/lib/storage/file-manager.ts)
  and `resolveResumePath`. The Excel tracker path in
  [automation-engine.ts:17](../src/lib/automation/automation-engine.ts#L17) must
  become per-user too.
- The encryption key `~/.job-agent-tools/secret.key` is machine-global — that's
  fine (it's the server's key), but per-user *credentials* encrypted with it are
  already row-scoped, so no change beyond 2.2.

**Phase 2 exit criteria:** with two seeded accounts, a request authenticated as
A can never read or mutate B's jobs/applications/résumés/memory/settings/creds/
gmail/logs/files. Add integration tests that assert cross-user 403/empty results
for the id-taking routes. `tsc --noEmit` clean, full test suite green.

---

## Risks / call-outs

1. **`extension/scan`** is cross-origin from the job site to localhost and today
   is unauthenticated-by-origin. Multi-user needs a per-user API token the
   extension sends, or it becomes a cross-user write hole.
2. **`GithubProject.repo @unique`** is a hard global constraint — the migration
   *must* drop it and add the compound unique, or the second user importing a
   shared repo errors.
3. **Job as shared vs per-user.** This spec makes `Job` per-user because scores
   are résumé-specific. If you'd rather share a scrape pool across users to save
   scraping, that's a different (bigger) design — flag before implementing 2.1.
4. **Gmail OAuth `state`** must carry `userId` so the callback stores the token
   on the right account.
5. **Migration data step** is load-bearing: existing `"local"` rows must be
   re-owned by the migrated account or they orphan.

## Deferred (not this spec)

- **Phase 3 — Concurrency:** durable job queue (pg-boss/BullMQ) + run-state
  persisted in DB, replacing the in-memory `AutomationEngine` singleton so runs
  survive restarts and can scale to replicas. Phase 2's explicit `userId`
  arguments are the seam this builds on.
- **Phase 4 — Deploy & onboarding:** hosted Postgres + long-running Node host
  (not serverless), per-user secrets UX (no `.env` editing), email verification /
  password reset, and a **ToS/legal review** of LinkedIn/Indeed scraping +
  auto-apply before offering the tool to other people.

## Rough effort

| Phase | Scope | Estimate |
|---|---|---|
| 1 | Identity plumbing | ~2–3 days |
| 2 | Query scoping + schema + files + tests | ~4–6 days |
