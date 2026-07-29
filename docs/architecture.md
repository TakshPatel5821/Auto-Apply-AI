# Architecture

How the system is put together: the end-to-end flows, the folder layout, every
module and its role, and the data model.

For the public overview see the [README](../README.md). For per-function detail
see the [function reference](function-reference.md).

---

## The Five Core Flows

```
          ┌─────────┐   ┌──────────┐   ┌─────────┐   ┌────────┐   ┌────────┐
  SETTINGS│ Scrape  │──▶│ Analyze  │──▶│ Tailor  │──▶│ Screen │──▶│ Apply  │──▶ TRACK
          └─────────┘   └──────────┘   └─────────┘   └────────┘   └────────┘
           per-site      fast-filter    FactBook →    employer     Playwright    Gmail sync,
           scrapers      + Claude        deterministic ATS loop      + ATS         analytics,
                         match score     compose+PDF   (no invent)   adapters      Excel, logs
```

1. **Scrape** — `scraping-orchestrator` fans out to per-site scrapers; each fit job is streamed straight into the pipeline.
2. **Analyze** — cheap `fast-filter` gate, then a Claude match score + ATS/visa/experience signals.
3. **Tailor** — `tailoring/index.tailorJob` builds the FactBook, selects facts, composes summary + letter, validates, renders LaTeX, compiles PDFs.
4. **Screen** *(optional)* — `ats-screen` runs the employer-side accept/reject loop and feeds back real under-featured skills.
5. **Apply** — `apply-engine` drives the browser, fills fields safely, handles OTP/login/takeover, and only reports verified submissions.

The whole sequence is orchestrated per-job and concurrently with scraping by `automation-engine`, with live state streamed to the dashboard over SSE.

---

## Project Structure

```text
src/
  app/                      Next.js pages + API routes (App Router)
    page.tsx                Login / landing screen
    layout.tsx              Root layout (fonts, aurora background)
    dashboard/page.tsx      The entire dashboard UI (9 tabs)
    api/                    ~47 route handlers (see Module Reference)
  components/
    ui/                     Radix-based primitives (button, card, tabs, …)
    dashboard/              Feature panels & modals (jobs, applications, …)
  lib/
    automation/             Apply engine, ATS adapters, field classifier, orchestrator
      apply/                Extracted apply-engine modules (stealth, selectors, dom, types)
    scraping/               Orchestrator + per-site scrapers
    matching/               Fast keyword filter + visa detector
    tailoring/              Hallucination-proof résumé/letter pipeline
    ats-screen/             Employer-side screening loop
    profile/                Structured profile (Engine V2) + dropdown intelligence
    ai/                     Claude / OpenAI / Ollama provider wrappers + ATS analyzer
    gmail/                  OAuth client, fetch, OTP parser, inbox sync
    github/                 GitHub REST client + project importer
    resume/                 PDF/DOCX parsing + quick regex extraction
    storage/                Application memory + file/folder manager
    security/               AES-256-GCM crypto + credential resolution
    auth/                   JWT session helpers
    db/                     Prisma client singleton
    logging/                DB-backed logger
    queue/                  Lightweight in-process job queue
    export/                 Excel workbook generation
    utils.ts                cn() class merge helper
  types/index.ts            Shared TypeScript types
  middleware.ts             Route auth guard
prisma/                     schema.prisma + migrations + seed
extension/                  Companion browser extension
applications/               Generated artifacts (PDFs, screenshots, .tex)
test/                       Vitest suites + fixtures
```

---

## Module Reference

> Every module below has a one-to-three-line description. File-level header comments in the source go deeper.

### App shell & pages (`src/app`)

| File | What it does |
|---|---|
| [page.tsx](src/app/page.tsx) | Password login / landing screen. Posts to `/api/auth/login`, then routes to `/dashboard`. Shows the feature + pipeline marketing strip. |
| [layout.tsx](src/app/layout.tsx) | Root HTML layout — Inter font, page metadata, forced dark mode, and a small script that strips browser-extension-injected attributes before React hydrates (avoids hydration warnings). Global styles (the aurora/glass theme) live in `globals.css`. |
| [dashboard/page.tsx](src/app/dashboard/page.tsx) | The whole authenticated app: a 9-tab client page (Dashboard, Jobs, Applications, Analytics, Career, Profile, Resume, Memory, Settings). Loads all data once, then receives live `state`/`logs`/`stats` over an SSE `EventSource`, refetching heavy tables only when counts change. Also contains the inline Memory and Settings/Credentials tabs. |
| [middleware.ts](src/middleware.ts) | Edge auth guard. Lets `/` and `/api/auth/login` through; 401s unauthenticated `/api/*`; redirects unauthenticated `/dashboard` to `/`. |

### API routes (`src/app/api`)

Each is a Next.js route handler. All non-auth routes require a valid session (enforced by middleware **and** re-checked via `getSession()`).

**Auth**
| Route | Purpose |
|---|---|
| [auth/login](src/app/api/auth/login/route.ts) | Validates the shared password, creates the JWT session cookie, ensures the `"local"` user exists. |
| [auth/logout](src/app/api/auth/logout/route.ts) | Clears the session cookie. |

**Jobs**
| Route | Purpose |
|---|---|
| [jobs/scrape](src/app/api/jobs/scrape/route.ts) | Kick off a scrape-only run via the orchestrator. |
| [jobs/list](src/app/api/jobs/list/route.ts) | Paginated job list for the Jobs table. |
| [jobs/match](src/app/api/jobs/match/route.ts) | Re-run the Claude match score for a job. |
| [jobs/ats-score](src/app/api/jobs/ats-score/route.ts) | Compute the transparent ATS keyword score for a job. |
| [jobs/interview-prep](src/app/api/jobs/interview-prep/route.ts) | Generate system-design/behavioral interview prep for a job. |
| [jobs/recruiter-message](src/app/api/jobs/recruiter-message/route.ts) | Draft a recruiter outreach message. |

**Automation**
| Route | Purpose |
|---|---|
| [automation/start](src/app/api/automation/start/route.ts) | Builds the `SearchConfig` from settings + body and starts `automationEngine`. |
| [automation/stop](src/app/api/automation/stop/route.ts) | Requests a graceful stop. |
| [automation/status](src/app/api/automation/status/route.ts) | Returns engine state + dashboard stats (also used as the non-SSE fallback). |

**Applications**
| Route | Purpose |
|---|---|
| [applications/list](src/app/api/applications/list/route.ts) | Applications table data. |
| [applications/apply](src/app/api/applications/apply/route.ts) | Multi-action endpoint: `tailor`, `approve`, `submit` (runs the apply engine in the background). |
| [applications/apply-all](src/app/api/applications/apply-all/route.ts) | Batch-apply approved applications. |
| [applications/tailor-all](src/app/api/applications/tailor-all/route.ts) | Batch-tailor fit jobs. |
| [applications/screen](src/app/api/applications/screen/route.ts) | Run the employer-side ATS screening loop for a job. |
| [applications/diff](src/app/api/applications/diff/route.ts) | Base vs. tailored résumé diff for the diff viewer. |
| [applications/status](src/app/api/applications/status/route.ts) | Manually set an application status. |
| [applications/decisions](src/app/api/applications/decisions/route.ts) | Per-field decision audit trail (replay/debug view). |
| [applications/file](src/app/api/applications/file/route.ts) | Serve a generated artifact (PDF/screenshot/.tex). |
| [applications/delete](src/app/api/applications/delete/route.ts) | Delete an application + its files. |
| [applications/classify-email](src/app/api/applications/classify-email/route.ts) | Classify pasted email text and apply the detected status. |

**Resume / Profile / Settings / Credentials / Memory**
| Route | Purpose |
|---|---|
| [resume/upload](src/app/api/resume/upload/route.ts) | Upload + parse a résumé (PDF/DOCX); also lists résumés. |
| [resume/status](src/app/api/resume/status/route.ts) · [resume/update](src/app/api/resume/update/route.ts) · [resume/delete](src/app/api/resume/delete/route.ts) | Parse status, edit parsed data, delete. |
| [profile](src/app/api/profile/route.ts) | Read/write the structured Profile Engine V2 data. |
| [settings](src/app/api/settings/route.ts) · [settings/sites](src/app/api/settings/sites/route.ts) | Search/automation settings; custom-site CRUD. |
| [credentials](src/app/api/credentials/route.ts) | Save encrypted LinkedIn/ATS creds; migrate from `.env`; status. |
| [memory](src/app/api/memory/route.ts) | CRUD over `ApplicationMemory` (add/edit/lock/delete/cleanup). |

**Gmail**
| Route | Purpose |
|---|---|
| [gmail/connect](src/app/api/gmail/connect/route.ts) | Start the OAuth consent flow. |
| [gmail/oauth/callback](src/app/api/gmail/oauth/callback/route.ts) | OAuth redirect handler; stores the encrypted refresh token. |
| [gmail/status](src/app/api/gmail/status/route.ts) · [gmail/disconnect](src/app/api/gmail/disconnect/route.ts) | Connection status; revoke. |
| [gmail/sync](src/app/api/gmail/sync/route.ts) | Scan inbox and auto-update statuses. |
| [gmail/otp](src/app/api/gmail/otp/route.ts) | Fetch the latest emailed verification code on demand. |

**GitHub & misc**
| Route | Purpose |
|---|---|
| [github/fetch](src/app/api/github/fetch/route.ts) | Import + clean repos into `GithubProject` rows. |
| [github/projects](src/app/api/github/projects/route.ts) | List / toggle which projects appear on the résumé. |
| [career](src/app/api/career/route.ts) | Career-advisor analysis (skill-gap, trajectory). |
| [analytics](src/app/api/analytics/route.ts) | Funnel + outcome analytics for the Analytics tab. |
| [dashboard/stats](src/app/api/dashboard/stats/route.ts) | Aggregate counters. |
| [logs](src/app/api/logs/route.ts) | Recent `AutomationLog` rows; clear. |
| [stream](src/app/api/stream/route.ts) | **SSE** endpoint streaming `state` / `logs` / `stats` to the dashboard. |
| [export](src/app/api/export/route.ts) | Stream the Excel workbook (jobs or applications). |
| [ats-check](src/app/api/ats-check/route.ts) | Standalone résumé-vs-JD ATS checker (the header modal). |
| [extension/scan](src/app/api/extension/scan/route.ts) | Endpoint the companion browser extension posts page data to. |

### UI components (`src/components`)

**Primitives (`ui/`)** — thin Radix wrappers styled with Tailwind: [button](src/components/ui/button.tsx), [badge](src/components/ui/badge.tsx), [card](src/components/ui/card.tsx), [tabs](src/components/ui/tabs.tsx), [progress](src/components/ui/progress.tsx), [scroll-area](src/components/ui/scroll-area.tsx).

**Dashboard panels & modals (`dashboard/`)**
| Component | Purpose |
|---|---|
| [DashboardOverview](src/components/dashboard/DashboardOverview.tsx) | The "Dashboard" tab — at-a-glance funnel + recent activity. |
| [StatsCards](src/components/dashboard/StatsCards.tsx) | Top metric cards (jobs, applied today, totals). |
| [AutomationControls](src/components/dashboard/AutomationControls.tsx) | Start/stop/pause, mode toggle, resume selector, takeover buttons. |
| [QuickSetupPanel](src/components/dashboard/QuickSetupPanel.tsx) | One-shot setup of keywords/locations/platforms. |
| [JobsTable](src/components/dashboard/JobsTable.tsx) | Scraped jobs with scores, tailor/apply actions. |
| [ApplicationsTable](src/components/dashboard/ApplicationsTable.tsx) | Applications with status, files, decisions. |
| [ResumeUpload](src/components/dashboard/ResumeUpload.tsx) · [ResumeCard](src/components/dashboard/ResumeCard.tsx) | Upload dropzone; parsed-résumé editor card. |
| [ProfilePanel](src/components/dashboard/ProfilePanel.tsx) | Structured Profile Engine V2 editor. |
| [GithubProjectsPanel](src/components/dashboard/GithubProjectsPanel.tsx) | Import + select GitHub projects for the résumé. |
| [CustomSitesPanel](src/components/dashboard/CustomSitesPanel.tsx) | Manage custom scraping targets. |
| [AnalyticsPanel](src/components/dashboard/AnalyticsPanel.tsx) | Recharts funnel/outcome charts. |
| [CareerAdvisorPanel](src/components/dashboard/CareerAdvisorPanel.tsx) | Skill-gap + trajectory advice. |
| [EmailClassifierPanel](src/components/dashboard/EmailClassifierPanel.tsx) | Paste/scan email → detected status. |
| [ScreeningPanel](src/components/dashboard/ScreeningPanel.tsx) | Run + display the ATS screening loop result. |
| [LogsConsole](src/components/dashboard/LogsConsole.tsx) | Live, color-coded log stream. |
| [AtsCheckerModal](src/components/dashboard/AtsCheckerModal.tsx) | Header résumé-vs-JD ATS score modal. |
| [InterviewPrepModal](src/components/dashboard/InterviewPrepModal.tsx) · [RecruiterOutreachModal](src/components/dashboard/RecruiterOutreachModal.tsx) | Post-apply helpers. |
| [ResumeDiffModal](src/components/dashboard/ResumeDiffModal.tsx) · [PdfCompareModal](src/components/dashboard/PdfCompareModal.tsx) | Base-vs-tailored text diff / PDF compare. |

### Automation & apply engine (`src/lib/automation`)

The heart of the system. The apply engine was split so the brittle, site-facing parts live in dedicated files.

| File | What it does |
|---|---|
| [automation-engine.ts](src/lib/automation/automation-engine.ts) | The orchestrator singleton. Runs the streaming pipeline (scrape → analyze → tailor → CV → optional auto-apply) per job, manages run state (running/paused/stopped, daily caps), pre-warms ATS logins, kicks Gmail sync, and saves the Excel tracker. |
| [apply-engine.ts](src/lib/automation/apply-engine.ts) | The Playwright apply engine (`ApplyEngine` class). Drives LinkedIn Easy Apply, external sites, and Workday; detects + fills fields safely; handles OTP/login walls; pre-submit review; strict success detection; and human-takeover with auto-resume. ~2,450 lines of flow logic; the DOM/selectors/types are imported from `apply/`. |
| [apply/stealth.ts](src/lib/automation/apply/stealth.ts) | The anti-bot-detection init script injected into every apply browser context (patches `navigator.webdriver`, plugins, WebGL vendor, etc.). |
| [apply/selectors.ts](src/lib/automation/apply/selectors.ts) | **The brittle bits in one place** — generic final-submit / advance / dismiss selector lists, OTP label/exclude regexes, and the self-heal intent→text patterns. *Fix these when a site changes its DOM.* |
| [apply/dom-scripts.ts](src/lib/automation/apply/dom-scripts.ts) | Pure in-browser scanners passed to `page.evaluate()` — field detection, the LinkedIn apply-button finder, and the self-healing click scanner. Run in the page context, never reference Node scope. |
| [apply/types.ts](src/lib/automation/apply/types.ts) | Shared apply types (`DetectedField`, `FieldDecisionRecord`, `ApplicationWithRelations`), the `getApplicationWithRelations` query, and `resolveResumePath`. |
| [ats-adapters.ts](src/lib/automation/ats-adapters.ts) | A pattern library of major ATS platforms. Each adapter augments the generic form loop with platform-specific button text, file-input quirks, success markers, validation-error selectors, and a "needs login" flag. **Add a new ATS here.** |
| [field-classifier.ts](src/lib/automation/field-classifier.ts) | The safety net (Phase 1). Classifies what a blank is *actually* asking, decides whether AI may answer it, gates on confidence, and validates that a candidate value even fits the field. Single source of truth; unit-tested. |
| [selector-memory.ts](src/lib/automation/selector-memory.ts) | Self-healing selector cache (#24). Remembers which selector worked for a `(host, intent)` so it's tried first next time; on-disk + in-process. |
| [scraper-status.ts](src/lib/automation/scraper-status.ts) | Shared cross-module signal for "waiting for human" / "user confirmed submit" during bot-wall or takeover pauses. |
| [latex-compiler.ts](src/lib/automation/latex-compiler.ts) | Compiles `.tex` → PDF with the Tectonic binary (env override → `~/.job-agent-tools` → PATH); reports page count. |
| [overleaf.ts](src/lib/automation/overleaf.ts) | Browser-driven Overleaf compile fallback. Serializes all compiles through one promise (a single project/profile can't run two at once). |
| [resume-template.ts](src/lib/automation/resume-template.ts) | The canonical one-page résumé as **structured data** + a renderer that reproduces the exact hand-tuned Overleaf layout. The single source of truth tailoring reorders. |

### Scraping (`src/lib/scraping`)

| File | What it does |
|---|---|
| [scraping-orchestrator.ts](src/lib/scraping/scraping-orchestrator.ts) | Coordinates a scrape run across enabled platforms, dedupes, applies the fast filter, persists `Job` rows + a `ScrapingSession`, and streams each fit job id to a callback (so the pipeline starts immediately). |
| [base-scraper.ts](src/lib/scraping/base-scraper.ts) | Shared Playwright base — launches a persistent, real-looking browser profile with cookies/fingerprint; common navigation + extraction helpers. |
| [linkedin.ts](src/lib/scraping/linkedin.ts) | LinkedIn jobs scraper (handles both result layouts; reads the detail panel). |
| [indeed.ts](src/lib/scraping/indeed.ts) | Indeed scraper with cookie/popup dismissal. |
| [greenhouse.ts](src/lib/scraping/greenhouse.ts) | Pulls full descriptions from Greenhouse's public boards JSON API per company (more reliable than HTML). |
| [registry.ts](src/lib/scraping/registry.ts) | The unified source registry. `sourceForUrl(url)` claims a pasted URL; `parseUrl(url)` extracts from it; `searchAllSources(cfg)` runs every board/feed in parallel with per-domain rate limiting; `listSources()` powers the dashboard's platform toggles. |
| [source.ts](src/lib/scraping/source.ts) | The `ScraperSource` contract (`supports`/`parseUrl`/`search`) + `runBoards`/`streamJobs` helpers every source reuses. |
| [generic-jsonld.ts](src/lib/scraping/generic-jsonld.ts) | **Universal scraper** — extracts a job from ANY URL via schema.org JSON-LD (incl. `@graph`), then microdata, then a conservative heuristic. Honors robots.txt. Covers thousands of career pages instantly. |
| lever / ashby / smartrecruiters / workable / recruitee `.ts` | Public-API ATS board scrapers (one file each), modeled on `greenhouse.ts`. Curated default company lists; stale tokens 404 harmlessly. |
| remoteok / remotive / weworkremotely / hackernews-hiring `.ts` | Remote-job feed sources (JSON APIs, RSS, and the HN "Who is hiring" thread via Algolia). |
| [http-client.ts](src/lib/scraping/http-client.ts) · [robots.ts](src/lib/scraping/robots.ts) | Polite shared HTTP: per-domain rate limiting, exponential backoff on 429/403/503, UA rotation, robots.txt for the generic scraper. |
| [util.ts](src/lib/scraping/util.ts) · [selector-suggester.ts](src/lib/scraping/selector-suggester.ts) | `htmlToText`/`makeJob`/keyword + salary helpers; and the heuristic that auto-generates a custom-site selector config from a jobs page. |

**Universal "search all" + paste-a-URL.** `POST /api/jobs/scrape` accepts any source id in `platforms` (e.g. `"lever"`, `"ashby"`) or the meta token `"all"` to run every reliable source. `POST /api/jobs/scrape-url` ingests a pasted board/posting URL (or list) — the registry routes it to the matching source, or the generic JSON-LD parser for any other career page. `GET /api/jobs/scrape` lists available sources.

### Matching (`src/lib/matching`)

| File | What it does |
|---|---|
| [fast-filter.ts](src/lib/matching/fast-filter.ts) | Instant keyword pre-filter that eliminates obvious mismatches in microseconds before any AI/embedding call. Also exposes `extractRequiredYears` used to gate over-senior roles. |
| [visa-detector.ts](src/lib/matching/visa-detector.ts) | Deterministic phrase scan for sponsorship + CPT/OPT signals → an `intlFriendlyScore` and accept flags. Fast and explainable. |

### Tailoring pipeline (`src/lib/tailoring`)

A pipeline engineered so **hallucination is structurally impossible**: the LLM only selects fact ids from a strict allowlist; deterministic templates write all prose.

| File | What it does |
|---|---|
| [index.ts](src/lib/tailoring/index.ts) | Public entry. `tailorJob()` (and `composeApplication` / `finalize` for the screening loop) runs the full pipeline and persists. Re-exports the error/result types. |
| [types.ts](src/lib/tailoring/types.ts) | The contract: `FactBook`, `FactSelection`, `JobAnalysis`, `TailorResult`, and the `EligibilityError` / `ValidationError` types. |
| [facts/load-facts.ts](src/lib/tailoring/facts/load-facts.ts) | Builds the FactBook from the canonical résumé + skill-synonym map used to match JD skills to fact ids. Also merges the user's *selected* GitHub projects into the FactBook, collapsing near-duplicate repos (`dedupeGithubProjects` / `nearDuplicateProjectName`) so the same project never appears twice on the résumé/cover letter. |
| [analysis/analyze-jd.ts](src/lib/tailoring/analysis/analyze-jd.ts) | LLM JD analysis (required/nice-to-have skills, level, signals), cached by `jobId`. |
| [routing/pre-filter.ts](src/lib/tailoring/routing/pre-filter.ts) | Pure routing gate — throws `EligibilityError` when the candidate is clearly disqualified, so the job is soft-skipped before any generation. |
| [composition/select-facts.ts](src/lib/tailoring/composition/select-facts.ts) | Deterministic skill↔JD matching + the LLM fact-selection step. Also exports `computeRequiredSkillMatch` reused by screening. Enforces the 30% coverage floor. |
| [composition/summary-builder.ts](src/lib/tailoring/composition/summary-builder.ts) | Composes the résumé summary purely from level phrases + real skill canonicals + real achievements — no free text. |
| [composition/letter-builder.ts](src/lib/tailoring/composition/letter-builder.ts) | Composes the cover letter from the same fact selection. |
| [composition/text-utils.ts](src/lib/tailoring/composition/text-utils.ts) | Deterministic text helpers (`humanList`, `clip`, `lowerFirst`, …) — same input always yields the same prose. |
| [validation/gates.ts](src/lib/tailoring/validation/gates.ts) | Defense-in-depth gates that re-check final strings and **throw loudly** if a template change breaks an invariant. |
| [rendering/resume-latex.ts](src/lib/tailoring/rendering/resume-latex.ts) | Renders the tailored + a guaranteed-one-page canonical LaTeX résumé. |
| [rendering/letter-latex.ts](src/lib/tailoring/rendering/letter-latex.ts) | Renders the cover-letter LaTeX (with proper escaping). |
| [rendering/compile.ts](src/lib/tailoring/rendering/compile.ts) | Compiles both PDFs (with a tex-only/skip-compile fallback). |
| [persistence/save.ts](src/lib/tailoring/persistence/save.ts) | Writes `.tex`/letter/JD/metadata to the application folder, creates `TailoredResume` + `CoverLetter`, flips the job to `TAILORED`. |

### ATS screening loop (`src/lib/ats-screen`)

The inverse of the applicant engine — decide as a recruiter's ATS would.

| File | What it does |
|---|---|
| [screening-loop.ts](src/lib/ats-screen/screening-loop.ts) | The closed loop: generate → screen → on reject, feed real under-featured skills back to feature next round; stops with an honest reject + learn-list when only genuinely-absent gaps remain. Only the accepted version is compiled + persisted. |
| [screen.ts](src/lib/ats-screen/screen.ts) | The single-round screener — required-coverage threshold accept/reject, gap classification (coverable vs. absent), optional LLM recruiter note. |
| [types.ts](src/lib/ats-screen/types.ts) | `LoopResult` / `LoopRound` / screen result shapes. |
| [persist.ts](src/lib/ats-screen/persist.ts) | Saves a screening run (accepted or rejected) with full round history to `ScreeningResult`. |

### Profile engine (`src/lib/profile`)

| File | What it does |
|---|---|
| [profile.ts](src/lib/profile/profile.ts) | Profile Engine V2 — a structured source of truth (value + category + confidence + lock per field) and a deterministic field resolver that maps a detected form field → the right profile value, so name/email/phone/visa/education never need AI. |
| [profile-store.ts](src/lib/profile/profile-store.ts) | Load/save the profile (stored in `UserSettings.profile` JSON); seed it from a parsed résumé. |
| [dropdown-intelligence.ts](src/lib/profile/dropdown-intelligence.ts) | Deterministically picks the best dropdown/radio option for a value (state abbreviations, country spellings, degree levels, yes/no), with ambiguity detection — no AI. Unit-tested. |

### AI providers (`src/lib/ai`)

| File | What it does |
|---|---|
| [claude.ts](src/lib/ai/claude.ts) | Provider router (`AI_PROVIDER` ∈ ollama/bedrock/anthropic, falls back to Ollama). Exposes the typed helpers used everywhere: `claudeComplete`, `claudeCompleteJSON`, `claudeMatchJobToResume`, `claudeAnswerQuestion`, `claudeParseResume`, `claudeClassifyEmail`, etc. |
| [openai.ts](src/lib/ai/openai.ts) | OpenAI client wrapper. |
| [ollama.ts](src/lib/ai/ollama.ts) | Local Ollama wrapper (OpenAI-compatible). Long timeout (default 10 min) because local LaTeX generation is slow. |
| [ats-analyzer.ts](src/lib/ai/ats-analyzer.ts) | Transparent ATS scorer — 0-100 weighted keyword score (required 2× nice-to-have), strong matches, missing keywords, suggestions. Also `atsKeywordPct`. |

### Gmail integration (`src/lib/gmail`)

| File | What it does |
|---|---|
| [client.ts](src/lib/gmail/client.ts) | OAuth2 client + token lifecycle (read-only scope). Refresh token encrypted at rest; `gmailStatus()` reports connection. |
| [fetch.ts](src/lib/gmail/fetch.ts) | List/fetch/normalize Gmail messages into a flat shape with decoded plain-text bodies (HTML stripped via cheerio). |
| [otp.ts](src/lib/gmail/otp.ts) | `extractOtp()` pure parser (unit-tested) + `fetchLatestOtp()` polling used by the apply engine's OTP gate. |
| [sync.ts](src/lib/gmail/sync.ts) | `syncInbox()` scans new mail, classifies it, records `EmailEvent` (dedupes), and auto-updates the matching application's status. |

### GitHub import (`src/lib/github`)

| File | What it does |
|---|---|
| [client.ts](src/lib/github/client.ts) | Minimal GitHub REST client (no SDK). Public repos unauthenticated; PAT unlocks private repos + higher rate limit. |
| [import.ts](src/lib/github/import.ts) | Fetches repos + READMEs, cleans each into a presentable `GithubProject` (LLM, batched) with a deterministic metadata fallback. |

### Résumé parsing (`src/lib/resume`)

| File | What it does |
|---|---|
| [parser.ts](src/lib/resume/parser.ts) | Extracts text from PDF/DOCX and runs `claudeParseResume` into structured `parsedData`. |
| [quick-extract.ts](src/lib/resume/quick-extract.ts) | Instant regex extraction (contact info, etc.) that runs before AI to cut latency. |

### Storage & memory (`src/lib/storage`)

| File | What it does |
|---|---|
| [memory.ts](src/lib/storage/memory.ts) | The application-answer memory: exact + **semantic** lookup (cached embeddings), `saveAnswer`/`saveHumanAnswer`, negative memory (`recordRejection`/`isRejected`), locking, and cleanup. Also `getOrCreateUser`. |
| [file-manager.ts](src/lib/storage/file-manager.ts) | Per-application folder layout + writers (`saveApplicationFiles`, `saveScreenshot`, `saveFile`, `getApplicationFolder`, `ensureDir`), defensively serializing non-string content. |

### Security (`src/lib/security`)

| File | What it does |
|---|---|
| [crypto.ts](src/lib/security/crypto.ts) | AES-256-GCM encrypt/decrypt with a key in `~/.job-agent-tools/secret.key` (or `JOB_AGENT_SECRET_KEY`). `enc:v1:` prefix marks blobs; plaintext is tolerated during migration. |
| [credentials.ts](src/lib/security/credentials.ts) | Resolves credentials preferring the encrypted DB value, falling back to legacy `.env`; save/migrate/status helpers. |

### Auth (`src/lib/auth`)

| File | What it does |
|---|---|
| [session.ts](src/lib/auth/session.ts) | JWT session helpers (jose): `createSession`, `verifySession`, `getSession`, set/clear the `job_agent_session` cookie (7-day, httpOnly). |

### Cross-cutting utilities

| File | What it does |
|---|---|
| [db/prisma.ts](src/lib/db/prisma.ts) | Prisma client singleton (HMR-safe). Quiet logging by default; `PRISMA_LOG_QUERIES=true` for SQL. |
| [logging/logger.ts](src/lib/logging/logger.ts) | DB-backed `Logger` (`info/warn/error/success/debug`) writing `AutomationLog` rows that feed the live console; never throws on logging failure. |
| [queue/job-queue.ts](src/lib/queue/job-queue.ts) | Lightweight in-process `EventEmitter`-based job queue. |
| [export/excel.ts](src/lib/export/excel.ts) | Builds the jobs/applications Excel workbook (exceljs); encodes the "is fit" rule (matchScore ≤ 6). |
| [utils.ts](src/lib/utils.ts) | `cn()` — clsx + tailwind-merge class combiner. |
| [types/index.ts](src/types/index.ts) | Shared TS types: `JobStatus`, `ApplicationStatus`, `LogLevel`, `MemoryCategory`, `ParsedResume`, `AutomationState`, `SearchConfig`, `ScrapedJob`, `CustomSite`, `ExcelJobRow`, etc. |

### Database (`prisma`)

| File | What it does |
|---|---|
| [schema.prisma](prisma/schema.prisma) | The data model (see [Data Model](#data-model)). |
| [migrations/](prisma/migrations/) | SQL migrations (`init`, `add_custom_sites`). |
| [seed.ts](prisma/seed.ts) | Seeds the `"local"` user + default settings. |

### Other top-level folders

| Path | What it is |
|---|---|
| `extension/` | Companion browser extension that posts captured page data to `/api/extension/scan`. |
| `applications/` | Generated artifacts at runtime — tailored PDFs, `.tex`, cover letters, screenshots, `jobs_tracker.xlsx`. |
| `test/` | Vitest suites (field-classifier, profile, dropdown-intelligence, gmail-otp) + fixtures. The tailoring suite lives in `src/lib/tailoring/__tests__/`. |
| `scripts/gh-debug.ts` | Ad-hoc GitHub-import debugging script. |

---

## Data Model

PostgreSQL via Prisma. Key models (full definitions in [schema.prisma](prisma/schema.prisma)):

- **User / UserSettings** — the single `"local"` user; settings hold search prefs, enabled platforms, daily caps, custom sites, the structured `profile` JSON, encrypted credentials, and Gmail tokens.
- **Resume / TailoredResume / CoverLetter** — the base résumé (parsed + `baseLatex`) and per-job generated artifacts (LaTeX, PDF paths, ATS score, keywords).
- **Job** — a scraped posting with all match/ATS/visa signals and a `JobStatus` lifecycle (`FOUND → ANALYZED → TAILORING → TAILORED → APPLYING → APPLIED → …`).
- **Application** — the apply record: status, screenshots, confirmation, `answeredQuestions`, and the recovery/replay fields (`recoveryState`, `actionLog`, `fieldDecisions`).
- **ApplicationMemory** — reusable Q&A with category, usage count, lock flag, and `rejectedAnswers` (negative memory).
- **GithubProject** — imported, cleaned repos with a `selected` toggle.
- **ScreeningResult** — one row per employer-screening run with full round history.
- **EmailEvent** — Gmail-derived events (OTP fetches + classified status mail), deduped by `gmailId`.
- **AutomationLog / ScrapingSession** — the live log feed and scrape-run records.

---

