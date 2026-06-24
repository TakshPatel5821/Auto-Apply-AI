# Job Application Automation Tool

A full-stack, **single-user, local-first** AI job-application assistant. It scrapes jobs, scores them against your résumé, tailors a résumé + cover letter from your *real* facts (no hallucination), compiles them to PDF, auto-applies across 13+ ATS platforms with a human-in-the-loop safety net, and tracks everything — including reading application OTP codes and status emails straight from your Gmail.

> Designed to run on **your own machine** for **just you** (`userId` is hardcoded to `"local"` throughout). It is not multi-tenant SaaS.

---

## Table of Contents

- [What It Does](#what-it-does)
- [Tech Stack](#tech-stack)
- [The Five Core Flows](#the-five-core-flows)
- [Project Structure](#project-structure)
- [Module Reference](#module-reference) — *every module explained*
  - [App shell & pages (`src/app`)](#app-shell--pages-srcapp)
  - [API routes (`src/app/api`)](#api-routes-srcappapi)
  - [UI components (`src/components`)](#ui-components-srccomponents)
  - [Automation & apply engine (`src/lib/automation`)](#automation--apply-engine-srclibautomation)
  - [Scraping (`src/lib/scraping`)](#scraping-srclibscraping)
  - [Matching (`src/lib/matching`)](#matching-srclibmatching)
  - [Tailoring pipeline (`src/lib/tailoring`)](#tailoring-pipeline-srclibtailoring)
  - [ATS screening loop (`src/lib/ats-screen`)](#ats-screening-loop-srclibats-screen)
  - [Profile engine (`src/lib/profile`)](#profile-engine-srclibprofile)
  - [AI providers (`src/lib/ai`)](#ai-providers-srclibai)
  - [Gmail integration (`src/lib/gmail`)](#gmail-integration-srclibgmail)
  - [GitHub import (`src/lib/github`)](#github-import-srclibgithub)
  - [Résumé parsing (`src/lib/resume`)](#résumé-parsing-srclibresume)
  - [Storage & memory (`src/lib/storage`)](#storage--memory-srclibstorage)
  - [Security (`src/lib/security`)](#security-srclibsecurity)
  - [Auth (`src/lib/auth`)](#auth-srclibauth)
  - [Cross-cutting (`db`, `logging`, `queue`, `export`, `utils`, `types`)](#cross-cutting-utilities)
  - [Database (`prisma`)](#database-prisma)
  - [Other top-level folders](#other-top-level-folders)
- [Data Model](#data-model)
- [Setup](#setup)
- [Environment](#environment)
- [Commands](#commands)
- [Extending the System](#extending-the-system)
- [Production Notes & Known Limitations](#production-notes--known-limitations)
- [Complete Function Reference](#complete-function-reference) — *every exported function & class method*
- [License](#license)

---

## What It Does

- **Scrapes** jobs from LinkedIn, Indeed, Greenhouse company boards, and arbitrary custom sites.
- **Scores** each job against your résumé with a fast keyword filter, then a Claude/OpenAI/Ollama match score, plus ATS-keyword, visa/sponsorship, and experience-level signals.
- **Tailors** a per-job summary + cover letter from a strict **FactBook** built from your canonical résumé — the LLM selects facts, deterministic templates write the prose, so a skill you don't have *cannot* be claimed.
- **Compiles** a one-page LaTeX résumé + cover letter to PDF locally (Tectonic) or via Overleaf.
- **Screens** the application as an employer's ATS would, in a closed loop that re-features your real-but-underweighted skills until accept — or an honest reject with a "skills to learn" list.
- **Auto-applies** with Playwright across 13+ ATS templates: LinkedIn Easy Apply, Workday (auto sign-in/account-create), Greenhouse, Lever, iCIMS, etc. — with strict success detection and a human-takeover fallback that never fakes a submission.
- **Remembers** your answers (semantic + exact match), learns corrections as negative memory, and auto-fills repeat questions while never guessing on sensitive/legal fields.
- **Reads Gmail** (read-only OAuth) to auto-enter emailed OTP/verification codes mid-apply and to scan your inbox and auto-update application statuses (interview / offer / rejection).
- **Tracks** everything: live dashboard, analytics, logs, screenshots, Excel export, and per-field decision audit trails.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 15 (App Router, Turbopack), React 19, TypeScript 5.7 |
| Styling | Tailwind CSS 3, Radix UI primitives, lucide-react icons |
| Database | PostgreSQL via Prisma 5 |
| Browser automation | Playwright (Edge/Chromium, persistent profiles, stealth) |
| AI | Anthropic Claude · OpenAI · Ollama (local) — pluggable provider |
| Email | Gmail API (googleapis), read-only OAuth2 |
| PDF / LaTeX | Tectonic (local) or Overleaf (browser-driven) |
| Files | pdf-parse, mammoth (docx), exceljs, adm-zip, cheerio |
| Security | AES-256-GCM at rest, JWT sessions (jose), bcryptjs |
| Tests | Vitest |

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

## Setup

```bash
git clone <repo-url>
cd Application-automation-tool
npm install
npx playwright install
cp .env.example .env        # then edit it
npx prisma db push
npm run db:seed             # optional: create the local user + defaults
npm run dev
```

Open `http://localhost:3000` and log in with `AUTH_PASSWORD`.

**Requirements:** Node 18+, PostgreSQL, Playwright browsers, at least one AI provider key (or local Ollama). Optional: Tectonic for local PDF compile, Gmail OAuth for OTP/status sync.

---

## Environment

Configure `.env` (see [.env.example](.env.example) for the full list). Highlights:

```env
AUTH_PASSWORD=your_secure_password
AUTH_SECRET=your_64_char_random_secret
DATABASE_URL=postgresql://postgres:password@localhost:5432/job_agent

AI_PROVIDER=anthropic            # anthropic | bedrock | ollama
ANTHROPIC_API_KEY=...
ANTHROPIC_MODEL=claude-sonnet-4-6
OPENAI_API_KEY=...

LINKEDIN_COOKIE=your_li_at_cookie

GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_OAUTH_REDIRECT=http://localhost:3000/api/gmail/oauth/callback

AUTOMATION_AUTO_APPLY=false
AUTOMATION_REQUIRE_APPROVAL=true
AUTOMATION_MAX_APPLICATIONS_PER_DAY=30
```

Prefer the in-app **Settings → Credentials** screen (encrypts at rest) over plaintext `.env`. Other useful knobs: `ANALYZE_TIMEOUT_MS`, `TAILOR_TIMEOUT_MS`, `OLLAMA_TIMEOUT_MS`, `JOB_AGENT_SECRET_KEY`, `PRISMA_LOG_QUERIES`, `SKIP_OVERLEAF`.

Scraping knobs: `SCRAPER_DOMAIN_GAP_MS` (min gap between requests to the same host for the API/feed/generic scrapers; default `1100`), `AUTOMATION_DELAY_MIN` / `AUTOMATION_DELAY_MAX` (browser-scraper jitter), `BLACKLIST_COMPANIES`. To auto-answer a salary field, set the profile's **Salary Expectation** (e.g. `Negotiable`) — salary is sensitive and never guessed.

---

## Commands

```bash
npm run dev          # Dev server (Turbopack)
npm run build        # Production build
npm run start        # Production server
npm run test         # Vitest (run once)
npm run test:watch   # Vitest watch
npm run db:generate  # prisma generate
npm run db:push      # push schema (dev)
npm run db:migrate   # create + apply a migration
npm run db:studio    # Prisma Studio
npm run db:seed      # seed local user + defaults
npx tsc --noEmit     # typecheck (no script alias yet)
```

---

## Extending the System

- **Add a job board/source** → implement the `ScraperSource` contract ([source.ts](src/lib/scraping/source.ts)) in a new file (API sources can model [greenhouse.ts](src/lib/scraping/greenhouse.ts); browser sources subclass [base-scraper.ts](src/lib/scraping/base-scraper.ts)) and add it to the `SOURCES` array in [registry.ts](src/lib/scraping/registry.ts). It's then available to "search all", per-URL paste, and the dashboard toggles automatically.
- **Add an ATS platform** → add an adapter in [ats-adapters.ts](src/lib/automation/ats-adapters.ts) (button text, file inputs, success markers, login flag).
- **A site changed its DOM** → fix the relevant list in [apply/selectors.ts](src/lib/automation/apply/selectors.ts) (and/or the adapter); the self-healing layer often recovers automatically.
- **New form-field behavior** → extend the rules in [field-classifier.ts](src/lib/automation/field-classifier.ts) (the single source of truth) and add a test.
- **Tune fit scoring** → [fast-filter.ts](src/lib/matching/fast-filter.ts) and `composition/select-facts.ts`.
- **Change the résumé layout** → edit the structured data in [resume-template.ts](src/lib/automation/resume-template.ts).

---

## Production Notes & Known Limitations

This is a **local, single-user** tool; "production-ready" here means *reliable and maintainable*, not *hosted multi-tenant*.

- `automationEngine` and the apply engine are **in-memory singletons** — they assume one Node process. Run state is lost on restart, and this design will **not** scale to serverless or multiple replicas without a job queue + persisted run state.
- `userId` is hardcoded `"local"`; making it multi-user requires real auth + scoping every query.
- Browser automation depends on live sessions, selectors, and site behavior; some applications intentionally **pause for human input** rather than risk a wrong/fake submission.
- `AUTOMATION_AUTO_APPLY=false` is recommended until you've reviewed the flow.
- No CI workflow yet, and ESLint isn't configured; `npx tsc --noEmit` (strict) + `npm run test` are the current gates. Tests cover tailoring, the field classifier (+ extended vectors), profile, dropdown intelligence (+ fallback ladder), **cross-frame/shadow-DOM field detection** (via linkedom), the **JSON-LD parser**, the **scraper registry**, memory plausibility, the selector suggester, and OTP parsing — **158 tests**.
- The **universal JSON-LD scraper covers most career pages**, but aggressively bot-protected sites (Glassdoor, Monster, ZipRecruiter, Dice) are only captured when they expose structured data — there are intentionally no brittle dedicated HTML scrapers for them.
- API endpoints of third-party boards can change without notice; each source **degrades gracefully** (logs + skips) instead of throwing.
- Generated files live under `applications/` (git-ignored).

### Troubleshooting

- **Autofill leaves fields blank on Workday/iCIMS/embedded Greenhouse.** The engine now scans **every frame** (`page.frames()`) and open shadow roots, so this should be resolved. Check `Application.fieldDecisions` (persisted on each checkpoint) — each record shows the field's `frame`, `labelConfidence`, decision path (`profile`/`memory`/`AI`), and why it paused.
- **A field paused that you expected to fill.** Sensitive categories (visa/EEO/veteran/disability/salary) are **never guessed** — set them in **Settings → Profile** (locked) so they autofill. Non-sensitive dropdowns that were ambiguous now use a fallback ladder; a remaining pause means no safe option matched.
- **A scraper source returns nothing.** ATS boards are company-scoped — set **preferred companies** in Settings (defaults are curated but may be stale; bad tokens 404 and are skipped). For feeds, check the logs for `429/403` backoff. Use `GET /api/jobs/scrape` to see which sources are live.
- **`POST /api/jobs/scrape-url` found no job.** The page had no JSON-LD/microdata and wasn't clearly a posting. Try the board URL instead of a wrapper page, or add it as a **custom site** and use the selector picker (`POST /api/settings/sites/selectors` with `action:"suggest"`).
- **Rate-limited / IP blocked.** Increase `SCRAPER_DOMAIN_GAP_MS`. The generic scraper obeys robots.txt; disallowed URLs are logged and skipped.

---

<!-- FNREF:START -->

## Complete Function Reference

> Auto-generated from source: every exported function and every method of an exported class, with its real signature and its own header-comment as the description. Internal (non-exported) module helpers are documented inline in the code.

### API routes (`src/app/api`)

#### `src/app/api/analytics/route.ts`

- **`async function GET(req: NextRequest)`** — Aggregates job + application data for the analytics dashboard.

#### `src/app/api/applications/apply-all/route.ts`

- **`async function POST(req: NextRequest)`**
- **`async function GET()`**

#### `src/app/api/applications/apply/route.ts`

- **`async function POST(req: NextRequest)`**

#### `src/app/api/applications/classify-email/route.ts`

- **`async function POST(req: NextRequest)`** — POST { emailText, apply?: boolean } Classifies a job-related email (interview / offer / rejection / etc.) and, if apply=true and it can match the email to an application by company, updates that application's status. v1 = paste an email; live Gmail/Outlook sync is a follow-up (needs OAuth credentials).

#### `src/app/api/applications/decisions/route.ts`

- **`async function GET(req: NextRequest)`** — Phase 9: per-field decision log for the replay/debug view. Returned lazily (not in the applications list) since it can hold up to ~500 records per run.

#### `src/app/api/applications/delete/route.ts`

- **`async function POST(req: NextRequest)`** — Delete an application. With deleteJob=true, also removes the job (the whole "company" entry) — its application/tailored/cover-letter rows cascade away. Otherwise just the application is removed and the job stays in the job list.

#### `src/app/api/applications/diff/route.ts`

- **`async function GET(req: NextRequest)`** — Returns the base résumé LaTeX vs the job-tailored LaTeX for a diff view. Query param: tailoredResumeId

#### `src/app/api/applications/file/route.ts`

- **`async function GET(req: NextRequest)`**

#### `src/app/api/applications/list/route.ts`

- **`async function GET(req: NextRequest)`**

#### `src/app/api/applications/screen/route.ts`

- **`async function POST(req: NextRequest)`** — POST { jobId, resumeId? } → run the employer-ATS screening loop, persist the result (accepted OR rejected, with round history), and return it.
- **`async function GET(req: NextRequest)`** — GET ?jobId=… → the latest persisted screening for a job (no re-run).

#### `src/app/api/applications/status/route.ts`

- **`async function POST(req: NextRequest)`** — POST { applicationId, status } → manually set an application's status (keeps the funnel analytics accurate).

#### `src/app/api/applications/tailor-all/route.ts`

- **`async function POST(req: NextRequest)`**
- **`async function GET()`**

#### `src/app/api/ats-check/route.ts`

- **`async function POST(req: NextRequest)`** — Standalone ATS checker: paste ANY job description + ANY résumé/CV text and get a keyword-coverage ATS score. No DB job, no stored résumé — purely ad-hoc. POST { jobDescription, cvText }

#### `src/app/api/auth/login/route.ts`

- **`async function POST(req: NextRequest)`**

#### `src/app/api/auth/logout/route.ts`

- **`async function POST()`**

#### `src/app/api/automation/start/route.ts`

- **`async function POST(req: NextRequest)`**

#### `src/app/api/automation/status/route.ts`

- **`async function GET(req: NextRequest)`**
- **`async function PUT(req: NextRequest)`**

#### `src/app/api/automation/stop/route.ts`

- **`async function POST(req: NextRequest)`**

#### `src/app/api/career/route.ts`

- **`async function POST(req: NextRequest)`**

#### `src/app/api/credentials/route.ts`

- **`async function GET()`** — GET → presence only (never returns secret values).
- **`async function POST(req: NextRequest)`** — POST: { action: "migrate" } → pull .env creds into encrypted store { linkedinEmail?, linkedinPassword?, atsEmail?, atsPassword? } → save encrypted

#### `src/app/api/dashboard/stats/route.ts`

- **`async function GET(req: NextRequest)`**

#### `src/app/api/export/route.ts`

- **`async function GET(req: NextRequest)`**

#### `src/app/api/extension/scan/route.ts`

- **`async function POST(req: NextRequest)`**
- **`async function OPTIONS()`** — The extension's fetch is cross-origin (job site → localhost), so allow it.

#### `src/app/api/github/fetch/route.ts`

- **`async function POST(req: NextRequest)`** — POST { username?, token? } → scan the user's GitHub, clean each repo (+ README) into a presentable project entry, upsert them, and return the catalog.

#### `src/app/api/github/projects/route.ts`

- **`async function GET()`** — GET → the imported GitHub project catalog (selected first, then most recent).
- **`async function POST(req: NextRequest)`** — POST { id, selected?, name?, bullet? } → toggle a project's selection, or inline- edit its cleaned title / bullet.

#### `src/app/api/gmail/connect/route.ts`

- **`async function GET(req: NextRequest)`** — GET — kick off the OAuth consent flow. Redirects the browser to Google's consent screen; on success Google redirects back to /api/gmail/oauth/callback.

#### `src/app/api/gmail/disconnect/route.ts`

- **`async function POST()`** — POST — revoke + clear the stored Gmail token.

#### `src/app/api/gmail/oauth/callback/route.ts`

- **`async function GET(req: NextRequest)`** — GET — OAuth redirect target. Exchanges the code for tokens (persisting the encrypted refresh token), then sends the user back to the dashboard.

#### `src/app/api/gmail/otp/route.ts`

- **`async function POST(req: NextRequest)`** — POST { sinceMinutes?, fromContains?, subjectContains?, timeoutMs? } Manual "Get latest code" — pulls the newest verification code from Gmail.

#### `src/app/api/gmail/status/route.ts`

- **`async function GET()`** — GET — connection status for the inbox panel (never returns the token).

#### `src/app/api/gmail/sync/route.ts`

- **`async function GET()`** — GET — recent EmailEvents for the live inbox panel.
- **`async function POST()`** — POST — scan the inbox now (classify + auto-update statuses).

#### `src/app/api/jobs/ats-score/route.ts`

- **`async function POST(req: NextRequest)`** — POST { jobId, resumeId? } → on-demand ATS analysis of a job vs. the résumé.

#### `src/app/api/jobs/interview-prep/route.ts`

- **`async function POST(req: NextRequest)`**

#### `src/app/api/jobs/list/route.ts`

- **`async function GET(req: NextRequest)`**

#### `src/app/api/jobs/match/route.ts`

- **`async function POST(req: NextRequest)`**

#### `src/app/api/jobs/recruiter-message/route.ts`

- **`async function POST(req: NextRequest)`** — POST { jobId, recruiterName? } → AI-generated recruiter outreach (connection note + message + follow-up) for that job against the active résumé.

#### `src/app/api/jobs/scrape/route.ts`

- **`async function POST(req: NextRequest)`**

#### `src/app/api/logs/route.ts`

- **`async function GET(req: NextRequest)`**
- **`async function DELETE(req: NextRequest)`**

#### `src/app/api/memory/route.ts`

- **`async function GET(req: NextRequest)`**
- **`async function POST(req: NextRequest)`**
- **`async function PUT(req: NextRequest)`**
- **`async function DELETE(req: NextRequest)`**

#### `src/app/api/profile/route.ts`

- **`async function GET()`** — GET → { profile, specs } so the UI can render every known field with its current value/lock/confidence, even ones not yet set.
- **`async function POST(req: NextRequest)`** — POST actions: { action: "seed" } → seed from active résumé { action: "set", key, value, locked? } → set/update one field { action: "lock", key, locked } → toggle lock { action: "delete", key } → remove a field

#### `src/app/api/resume/delete/route.ts`

- **`async function POST(req: NextRequest)`** — Delete a resume. TailoredResume rows cascade-delete; applications keep their row (their optional resume/tailoredResume links are set null). If the deleted resume was active, the most recent remaining one is promoted to active so the app always has an active resume when any exist.

#### `src/app/api/resume/status/route.ts`

- **`async function GET(req: NextRequest)`** — Poll this to know when AI parsing of an uploaded resume is done

#### `src/app/api/resume/update/route.ts`

- **`async function POST(req: NextRequest)`** — Edit a resume's parsed fields (summary, skills, years of experience) from the Resume tab. We update BOTH the top-level columns (shown in the UI) AND the parsedData JSON (read by tailoring + profile seeding) so edits actually take effect downstream.

#### `src/app/api/resume/upload/route.ts`

- **`async function POST(req: NextRequest)`** — Upload: save + quick extract (instant) then AI parse in background
- **`async function GET(req: NextRequest)`**

#### `src/app/api/settings/route.ts`

- **`async function GET(req: NextRequest)`**
- **`async function POST(req: NextRequest)`**

#### `src/app/api/settings/sites/route.ts`

- **`async function GET()`**
- **`async function POST(req: NextRequest)`**
- **`async function PUT(req: NextRequest)`**
- **`async function DELETE(req: NextRequest)`**

#### `src/app/api/stream/route.ts`

- **`async function GET(req: NextRequest)`**

### Components (`src/components`)

#### `src/components/dashboard/AnalyticsPanel.tsx`

- **`function AnalyticsPanel()`**

#### `src/components/dashboard/ApplicationsTable.tsx`

- **`function ApplicationsTable({ applications, onRefresh, }: { applications: Application[]; onRefresh: () => void; })`**

#### `src/components/dashboard/AtsCheckerModal.tsx`

- **`function AtsCheckerModal()`** — A standalone "paste JD + paste CV → ATS score" checker. Renders its own header button + modal; nothing is persisted.

#### `src/components/dashboard/AutomationControls.tsx`

- **`function AutomationControls({ state, resumes, onRefresh, }: { state: AutomationState; resumes: Resume[]; onRefresh: () => void; })`**

#### `src/components/dashboard/CareerAdvisorPanel.tsx`

- **`function CareerAdvisorPanel()`**

#### `src/components/dashboard/CustomSitesPanel.tsx`

- **`function CustomSitesPanel()`**

#### `src/components/dashboard/DashboardOverview.tsx`

- **`function DashboardOverview({ stats, jobs, applications, automationState, onRefresh, }: { stats: Stats; jobs: Job[]; applications: App[]; automationState: { isRunning?: boolean; isPaused?: boolean; currentAction?: string }; onRefresh: () => void; })`**

#### `src/components/dashboard/EmailClassifierPanel.tsx`

- **`function EmailClassifierPanel({ onApplied }: { onApplied?: () => void })`**

#### `src/components/dashboard/GithubProjectsPanel.tsx`

- **`function GithubProjectsPanel()`**

#### `src/components/dashboard/InterviewPrepModal.tsx`

- **`function InterviewPrepModal({ jobId, onClose, }: { jobId: string; onClose: () => void; })`**

#### `src/components/dashboard/JobsTable.tsx`

- **`function JobsTable({ jobs, onRefresh, }: { jobs: Job[]; onRefresh: () => void; })`**

#### `src/components/dashboard/LogsConsole.tsx`

- **`function LogsConsole({ logs, onClear, }: { logs: LogEntry[]; onClear: () => void; })`**

#### `src/components/dashboard/PdfCompareModal.tsx`

- **`function PdfCompareModal({ app, onClose }: { app: PdfApp; onClose: () => void })`** — Side-by-side PDF viewer: original (uploaded) résumé vs the job-tailored PDF, plus a tab to view the cover-letter PDF. Streams files from /api/applications/file.

#### `src/components/dashboard/ProfilePanel.tsx`

- **`function ProfilePanel()`**

#### `src/components/dashboard/QuickSetupPanel.tsx`

- **`function QuickSetupPanel({ onSave }: { onSave?: () => void })`**

#### `src/components/dashboard/RecruiterOutreachModal.tsx`

- **`function RecruiterOutreachModal({ jobId, onClose }: Props)`**

#### `src/components/dashboard/ResumeCard.tsx`

- **`function ResumeCard({ resume, onSaved }: { resume: ResumeCardData; onSaved: () => void })`**

#### `src/components/dashboard/ResumeDiffModal.tsx`

- **`function ResumeDiffModal({ tailoredResumeId, onClose, }: { tailoredResumeId: string; onClose: () => void; })`**

#### `src/components/dashboard/ResumeUpload.tsx`

- **`function ResumeUpload({ resumes, onUpload }: { resumes: Resume[]; onUpload: () => void })`**

#### `src/components/dashboard/ScreeningPanel.tsx`

- **`function ScreeningPanel({ screening }: { screening: ScreeningView })`**

#### `src/components/dashboard/StatsCards.tsx`

- **`function StatsCards({ stats, automationState, }: { stats: Stats; automationState: AutomationState; })`**

### `src/lib/automation`

#### `src/lib/automation/apply-engine.ts`

- **`const applyEngine = new ApplyEngine(…)`** — Singleton instance of `ApplyEngine` (see the class below).
- **class `ApplyEngine`**
  - *(private)* **`private async init(platform: string): Promise<void>`**
  - *(private)* **`private async cleanup(): Promise<void>`**
  - *(private)* **`private delay(min: number, max: number): Promise<void>`**
  - *(private)* **`private logAction(action: string, target?: string, detail?: string): void`** — Append an action to the in-memory log (persisted on checkpoint/failure).
  - *(private)* **`private recordFieldDecision( field: DetectedField, cls: { category: string; domKind: string }, outcome: { decision: string; source?: string; confidence?: number; value?: string; reason?: string } ): void`** — Phase 9: record why one field was handled the way it was (for replay/debug).
  - *(private)* **`private async checkpoint(phase: string, extra?: Record<string, unknown>): Promise<void>`** — Persist a recoverable checkpoint: where we are + the action log so far. On a later retry we can fast-forward to this URL/phase instead of starting over.
  - **`async prewarmLogins(): Promise<void>`** — Log into account-gated ATS portals ONCE at the start of a batch so every later apply in the run is already authenticated (the session persists in the browser profile). Best-effort + non-fatal. Currently warms Greenhouse's candidate portal (my.greenhouse.io). Skips silently if no ATS creds are set.
  - **`async applyToJob(applicationId: string): Promise<boolean>`**
  - *(private)* **`private async applyLinkedIn(application: NonNullable<ApplicationWithRelations>): Promise<boolean>`**
  - *(private)* **`private async findLinkedInApplyButton(): Promise<{ selector: string; text: string; isEasyApply: boolean } | null>`** — Find the apply button on a LinkedIn page and tell us if it's Easy Apply. NOTE: LinkedIn's external "Apply" control is a plain <a> (external-link icon), often WITHOUT role="button", and the button also renders async — so we wait for it and scan both <button> and <a> elements.
  - *(private)* **`private async runEasyApplyFlow(application: NonNullable<ApplicationWithRelations>, buttonSelector: string): Promise<boolean>`**
  - *(private)* **`private async runExternalApplyFlow(application: NonNullable<ApplicationWithRelations>, buttonSelector: string): Promise<boolean>`**
  - *(private)* **`private async applyExternalSite(application: NonNullable<ApplicationWithRelations>): Promise<boolean>`**
  - *(private)* **`private async fillExternalForm( application: NonNullable<ApplicationWithRelations>, scope: string = "body" ): Promise<boolean>`**
  - *(private)* **`private async fillWorkdayForm(application: NonNullable<ApplicationWithRelations>): Promise<boolean>`** — Workday-specific flow. Each company has its OWN Workday tenant, so we either sign in (if an account exists on this tenant) or create one — automatically, with ATS_EMAIL/ATS_PASSWORD. Then we run the normal multi-step loop. Only if auth genuinely fails do we hand off to the human.
  - *(private)* **`private async workdayClickInto(): Promise<void>`** — Click through the Workday landing → manual-apply screen to reach the auth form.
  - *(private)* **`private async handleWorkdayAuth(): Promise<boolean>`** — Try to sign in; if that fails (no account on this tenant), create one. Returns true once we're authenticated (past the login screen).
  - *(private)* **`private async workdayFillCreds(email: string, password: string, verify: boolean): Promise<void>`** — Fill Workday email/password (+ verify-password on the create-account form).
  - *(private)* **`private async workdayIsAuthed(): Promise<boolean>`** — Authenticated when the login form is gone and no auth error is shown.
  - *(private)* **`private async handleLoginWallIfPresent(ats?: AtsAdapter | null): Promise<boolean>`** — Generic sign-in handler for ATS pages gated behind a login (Greenhouse candidate portal `my.greenhouse.io`, Dice, etc.). If a password field is visible, fills email+password from stored ATS creds and submits. Best-effort and non-fatal — if it can't log in, the normal flow / human takeover follows.
  - *(private)* **`private async handleEmailVerificationIfPresent(scope: string = "body"): Promise<boolean>`** — Many ATS account flows email a one-time code ("we sent a code to your email"). When Gmail is connected, fetch the freshly-emailed code and enter it automatically; otherwise return false so the existing human-takeover path handles it. Returns true only when a code was filled + submitted. OTP_LABEL_RE / OTP_EXCLUDE_RE now live in ./apply/selectors.
  - *(private)* **`private async findOtpInputs( verifyContext: boolean ): Promise< | { mode: "single"; handle: OtpHandle } | { mode: "segmented"; handles: OtpHandle[] } | null >`** — Locate the verification-code input(s): a single field or a row of single-character "segmented" boxes. verifyContext loosens the match so a generic code field counts when the page clearly asks for an email code.
  - *(private)* **`private async fillOtp( gate: { mode: "single"; handle: OtpHandle } | { mode: "segmented"; handles: OtpHandle[] }, code: string ): Promise<boolean>`** — Type the code into either a single field or the segmented boxes.
  - *(private)* **`private async runWorkdayFormLoop(application: NonNullable<ApplicationWithRelations>): Promise<boolean>`** — The shared multi-step form walk, reused for Workday after auth.
  - *(private)* **`private finalSubmitCandidates(ats?: AtsAdapter | null): string[]`** — Click a genuine FINAL submit button (the one that completes the whole application). Kept deliberately narrow so we don't mistake a step's "Next" for the real submit. Returns true only if such a button was found+clicked. The selectors that identify a genuine FINAL submit button (shared by the clicker and the pre-submit probe).
  - *(private)* **`private async isFinalSubmitPresent(ats?: AtsAdapter | null): Promise<boolean>`** — Is a final-submit button visible right now (without clicking it)? Used to decide whether to run the Phase 8 pre-submit review this step.
  - *(private)* **`private async clickFinalSubmit(ats?: AtsAdapter | null): Promise<boolean>`**
  - *(private)* **`private async clickAdvance(ats?: AtsAdapter | null): Promise<boolean>`** — Click a button that ADVANCES to the next step of a multi-step form.
  - *(private)* **`private async clickFirstVisible(selectors: string[], kind: string): Promise<boolean>`** — Click the first visible+enabled element matching any of the selectors. Self-healing (#24): tries the previously-learned selector first, then the candidate list, then a text-based fallback scan; records the winner so it's tried first next time. `kind` doubles as the learning intent.
  - *(private)* **`private async healClick(kind: string): Promise<boolean>`** — Find + click the best-matching visible button/link by text for `kind`. Returns true and learns a stable selector if it succeeds. The DOM scan + intent→text patterns now live in ./apply/dom-scripts + ./apply/selectors.
  - *(private)* **`private async pageSignature(): Promise<string>`** — A lightweight fingerprint of the current form page. We compare it before and after a click to tell whether we actually advanced (vs. stuck on a validation error). Combines URL, visible-input count, and the top heading.
  - *(private)* **`private async detectValidationErrors(ats?: AtsAdapter | null): Promise<string[]>`** — Phase 4: read any visible validation-error messages so a stuck step can explain WHY (which field the ATS rejected) instead of a generic message. Uses the adapter's selectors first, then generic ARIA/class conventions.
  - *(private)* **`private async preSubmitReview( application: NonNullable<ApplicationWithRelations>, scope: string, ats?: AtsAdapter | null ): Promise<string[]>`** — Phase 8: pre-submit verification. Scans every filled field one last time and returns a list of human-readable issues. A non-empty list MUST block the final submit — we pause for the human instead of sending a bad application.
  - *(private)* **`private async detectSuccessPage(ats?: AtsAdapter | null): Promise<boolean>`** — Strict success detection. Declaring success wrongly is worse than missing it (it skips a real application), so we require a STRONG signal — and, for the generic text/URL heuristics, that we have actually clicked a final Submit this run. Adapter-specific successSelectors are trusted unconditionally (they're page-specific confirmation elements).
  - *(private)* **`private async dismissPopups(): Promise<void>`**
  - *(private)* **`private async handleLinkedInLogin(): Promise<boolean>`**
  - *(private)* **`private async setLinkedInEmailField(email: string): Promise<void>`**
  - *(private)* **`private async uploadResumeIfVisible( application: NonNullable<ApplicationWithRelations>, ats?: AtsAdapter | null ): Promise<void>`**
  - *(private)* **`private async attachCoverLetterIfRequested( application: NonNullable<ApplicationWithRelations> ): Promise<void>`** — If the form asks for a cover letter — either a paste-in text box OR a file upload — fill/upload the job-specific cover letter we generated at tailor time. Safe to call every step (it no-ops if nothing matches).
  - *(private)* **`private async fillVisibleFields( application: NonNullable<ApplicationWithRelations>, scope: string ): Promise<string[]>`** — Returns the labels of fields it could NOT fill (unknown / needs human).
  - *(private)* **`private async detectFields(scope: string): Promise<DetectedField[]>`**
  - *(private)* **`private async fillField(field: DetectedField, application: NonNullable<ApplicationWithRelations>): Promise<boolean>`** — Fills one field. Returns true if it was filled (or safely skippable), false if we genuinely don't know the answer (so the caller can pause once for the human instead of pausing per-field).
  - *(private)* **`private async verifyFieldValue(field: DetectedField, expected: string): Promise<boolean>`** — Read back a text/select field to confirm our value actually applied. Radios/checkboxes are trusted (toggleCheckable already self-verifies).
  - *(private)* **`private profileFactsString(): string`** — Phase 6: format the structured profile into grounding facts for the open-ended answer engine. Sensitive values (visa/EEO/salary) are excluded — the AI must never reference them in an essay answer.
  - *(private)* **`private shortcutFromResume(label: string, resumeData: Record<string, unknown>): string | null`** — Quick resume shortcuts — saves AI calls for obvious questions
  - *(private)* **`private async applyAnswer(field: DetectedField, answer: string, kind?: string): Promise<boolean>`** — Apply a value to a field. Returns false when it could NOT confidently set the value (no dropdown/radio option matched, or the match was ambiguous) so the caller can pause for the human instead of leaving a wrong/blank choice.
  - *(private)* **`private async toggleCheckable( handle: import("playwright").ElementHandle<Element>, target: boolean ): Promise<void>`** — Reliably set a checkbox/radio to `target`. Many ATS checkboxes are the real <input> hidden (opacity:0 / off-screen) behind a styled <label>/<span>, so a plain click on the input does nothing. We try, in order: Playwright check() with force, clicking the associated <label>, clicking the parent <label>, then a JS click + change event. Verifies state after each attempt.
  - *(private)* **`private async pauseForHumanThenCapture( application: NonNullable<ApplicationWithRelations>, scope: string, reason: string, maxWaitMs = 8 * 60 * 1000 ): Promise<boolean>`** — Pause so the user can fill what we couldn't, then AUTOMATICALLY continue — no Resume button required. We watch the form: once they start filling and then stop (input stable for a few seconds) — or the page advances, or they click Resume — we capture everything they entered into memory and return true so the caller's loop resumes. Returns false only on timeout.
  - *(private)* **`private async combinedFormState(scope: string): Promise<string>`** — A fingerprint that changes when the user types/selects anything OR the page navigates. Used to detect when the human has finished helping.
  - *(private)* **`private async captureFilledFields( application: NonNullable<ApplicationWithRelations>, scope: string ): Promise<void>`** — Read every filled field in the scope and save it to memory, so future applications (even with differently-worded questions) reuse the answer.
  - *(private)* **`private async waitForHumanTakeover( application: NonNullable<ApplicationWithRelations>, reason: string, maxWaitMs = 8 * 60 * 1000 ): Promise<boolean>`** — Full-application takeover: pause, let the user finish the application in the already-open browser, then VERIFY. Returns true only if we can actually confirm a submission (or the user signals done and the page looks complete). This is the honest alternative to assuming a submit happened.
  - *(private)* **`private async takeStepScreenshot(folderPath: string | null, label: string): Promise<void>`**

#### `src/lib/automation/apply/dom-scripts.ts`

- **`function scanDetectFields(scopeSel: string)`** — Detect all fillable fields within `scopeSel`: text/select/textarea inputs, radio groups (by fieldset), and standalone checkboxes — each with a resolved label, a usable selector, and classifier context (placeholder/aria/heading).
- **`function scanLinkedInApplyButton()`** — Find the apply button on a LinkedIn page and tell us if it's Easy Apply. LinkedIn's external "Apply" control is a plain <a> (external-link icon), often WITHOUT role="button" — so we scan both <button> and <a> elements.
- **`function scanHealClick({ src, flags }: { src: string; flags: string })`** — Self-healing click: find the best-matching visible button/link by text for an intent (regex serialized as {src, flags}), tag it for the caller to click, and return a durable selector when one can be built.

#### `src/lib/automation/apply/selectors.ts`

- **`function intentTextPatterns(kind: string): RegExp`** — Intent → visible-text patterns used by the self-healing button click fallback (healClick) when no known selector matches.

#### `src/lib/automation/apply/stealth.ts`

- **`const STEALTH_SCRIPT = ()`**

#### `src/lib/automation/apply/types.ts`

- **`async function getApplicationWithRelations(id: string)`** — The application row + the relations the apply flow needs, loaded once per run.
- **`function resolveResumePath(p?: string | null): string | null`** — Résumé PDF paths are stored relative to the project root ("applications/.."). existsSync on a relative path is cwd-dependent, so resolve to absolute first.

#### `src/lib/automation/ats-adapters.ts`

- **`function detectAts(url: string): AtsAdapter | null`** — Find the adapter whose hosts match the current URL, if any.

#### `src/lib/automation/automation-engine.ts`

- **`const automationEngine = new AutomationEngine(…)`** — Singleton instance of `AutomationEngine` (see the class below).

#### `src/lib/automation/field-classifier.ts`

- **`function isDoNotAI(cat: FieldCategory): boolean`**
- **`function isSensitive(cat: FieldCategory): boolean`**
- **`function aiMayAnswer(cat: FieldCategory): boolean`**
- **`function decideFill(cat: FieldCategory, confidence: number, hasProfileValue: boolean): FillDecision`** — Map a (category, confidence) pair to what the engine should do.
- **`function domKindOf(type: string): DomKind`** — Map raw DOM type → DomKind bucket.
- **`function classifyField(ctx: FieldContext): Classification`** — Classify a field from all the context we have.
- **`function validateValue( cls: Classification, value: string, options?: string[] ): ValidationResult`** — Validate `value` for a classified field.

#### `src/lib/automation/latex-compiler.ts`

- **`async function compileLatexToPDF( latexContent: string, outputDir: string, baseName = "tailored_resume" ): Promise<string | null>`** — Compile LaTeX → PDF locally with Tectonic. Deterministic, offline (after the one-time package-bundle download), ~3s steady state. Replaces the old Overleaf browser automation entirely. Returns the PDF path, or null on failure.
- **`function pdfPageCount(outputDir: string, baseName = "tailored_resume"): number | null`** — Read the page count from Tectonic's kept log (the XeTeX line "Output written on <file>.xdv (N page(s), …)"). Returns null if unknown.

#### `src/lib/automation/overleaf.ts`

- **`function compileLatexToPDF(latexContent: string, outputDir: string): Promise<string | null>`**

#### `src/lib/automation/resume-template.ts`

- **`function escapeTex(t: string): string`** — Escape characters that are special in LaTeX.
- **`function buildResumeLatex(summary: string, overrides?: ResumeOverrides): string`** — Build the full résumé LaTeX from the canonical data + (optional) per-job overrides. With no overrides this reproduces the hand-tuned one-page layout.

#### `src/lib/automation/selector-memory.ts`

- **`function selectorKey(url: string, intent: string): string`**
- **`function rememberedSelector(url: string, intent: string): string | null`** — The selector that worked last time for this (host, intent), if any.
- **`function learnSelector(url: string, intent: string, selector: string): void`** — Record a selector that just worked. Promotes it to first-try next time.
- **`function forgetSelector(url: string, intent: string): void`** — Forget a learned selector that has stopped working.

### `src/lib/scraping`

#### `src/lib/scraping/base-scraper.ts`

- **class `BaseScraper`**
  - **`constructor(config?: Partial<ScraperConfig>)`**
  - *(protected)* **`protected async init(profileKey?: string): Promise<void>`**
  - *(protected)* **`protected async cleanup(): Promise<void>`**
  - *(protected)* **`protected async delay(min?: number, max?: number): Promise<void>`**
  - *(protected)* **`protected async safeNavigate(url: string, timeout = 30000): Promise<boolean>`**
  - *(protected)* **`protected async detectBotWall(): Promise<boolean>`** — Returns true if the current page is a bot-detection wall (authwall, CAPTCHA, challenge)
  - *(protected)* **`protected async waitForUserIntervention( platformName: string, maxWaitMs = 3 * 60 * 1000 ): Promise<boolean>`** — Pauses automation and waits for the user to manually complete verification in the browser window. Returns true when the user has navigated past the wall, false on timeout.
  - *(protected)* **`protected async expandJobDescription(): Promise<boolean>`** — Click "Show more" / "See more" buttons in job description until fully expanded. Returns true if at least one button was clicked.
  - *(protected)* **`protected async safeClick(selector: string, timeout = 10000): Promise<boolean>`**
  - *(protected)* **`protected async safeType(selector: string, text: string, timeout = 10000): Promise<boolean>`**
  - *(protected)* **`protected getRandomUserAgent(): string`**
  - *(protected)* **`protected extractSalary(text: string): { min?: number; max?: number; raw: string }`**
  - *(protected)* **`protected normalizeJobType(type: string): string`**

#### `src/lib/scraping/custom-scraper.ts`

- **class `CustomScraper`**
  - **`async scrapeJobs(site: CustomSite): Promise<ScrapedJob[]>`**
  - *(private)* **`private async init(): Promise<void>`**
  - *(private)* **`private async cleanup(): Promise<void>`**
  - *(private)* **`private async safeNavigate(url: string, timeout = 30000): Promise<boolean>`**
  - *(private)* **`private async delay(min: number, max: number): Promise<void>`**
  - *(private)* **`private async humanType(text: string): Promise<void>`**
  - *(private)* **`private async humanScroll(minScrolls = 2, maxScrolls = 4): Promise<void>`**
  - *(private)* **`private async login(email: string, password: string): Promise<boolean>`**
  - *(private)* **`private async findJobsPage(baseUrl: string): Promise<string | null>`**
  - *(private)* **`private async extractJobs(siteName: string, baseUrl: string): Promise<ScrapedJob[]>`**
  - *(private)* **`private async extractText(el: ElementHandle, selectors: string[]): Promise<string>`**
  - *(private)* **`private async clickNextPage(): Promise<boolean>`**
  - *(private)* **`private makeBasicJob(title: string, siteName: string, url: string): ScrapedJob`**

#### `src/lib/scraping/greenhouse.ts`

- **class `GreenhouseScraper`**
  - **`async scrapeJobs( companies: string[], keywords: string[], locations: string[] = [], onJob?: (job: ScrapedJob) => Promise<void> ): Promise<ScrapedJob[]>`** — `locations` lets us drop non-US postings when the user's search is US-based (the Greenhouse API returns a company's jobs worldwide). `onJob` streams each matching job as it's found — same live, per-job logging as the LinkedIn scraper — instead of returning one silent batch.
  - *(private)* **`private async scrapeCompany(company: string, keywords: string[], usOnly: boolean): Promise<ScrapedJob[]>`**

#### `src/lib/scraping/indeed.ts`

- **class `IndeedScraper`**
  - **`async scrapeJobs( keywords: string[], locations: string[], options?: ScraperOptions ): Promise<ScrapedJob[]>`**
  - *(private)* **`private async scrapeSearch(keyword: string, location: string): Promise<ScrapedJob[]>`**
  - *(private)* **`private async detectIndeedBlock(): Promise<boolean>`** — Detect Indeed's specific block pages — they don't always trigger the generic bot wall.
  - *(private)* **`private async dismissPopups(): Promise<void>`** — Dismiss cookie consent / popup overlays that block scraping
  - *(private)* **`private async scrollResultsPage(): Promise<void>`**
  - *(private)* **`private async debugScreenshot(label: string): Promise<void>`**
  - *(private)* **`private async collectJobCards(): Promise<Array<{ jobId: string; titleHint: string; companyHint: string; locationHint: string }>>`**
  - *(private)* **`private async extractJobDetails( jobId: string, titleHint: string, companyHint: string, locationHint: string ): Promise<ScrapedJob | null>`**
  - *(private)* **`private async typeHumanLike(selectors: string[], text: string): Promise<boolean>`**

#### `src/lib/scraping/linkedin.ts`

- **class `LinkedInScraper`**
  - **`async scrapeJobs( keywords: string[], locations: string[], options?: ScraperOptions ): Promise<ScrapedJob[]>`**
  - *(private)* **`private async scrapeSearch(keyword: string, location: string): Promise<ScrapedJob[]>`**
  - *(private)* **`private async processCardsInSidebar( jobIds: Array<{ jobId: string; titleHint: string; companyHint: string; locationHint: string }>, jobs: ScrapedJob[] ): Promise<ScrapedJob[]>`**
  - *(private)* **`private async clickSidebarCard(cardSelector: string): Promise<boolean>`**
  - *(private)* **`private async waitForDetailPanel(): Promise<void>`**
  - *(private)* **`private async processCardsByUrl( jobIds: Array<{ jobId: string; titleHint: string; companyHint: string; locationHint: string }>, jobs: ScrapedJob[] ): Promise<ScrapedJob[]>`**
  - *(private)* **`private async detectAuthLayout(): Promise<boolean>`**
  - *(private)* **`private async scrollToLoadMore(isAuth: boolean): Promise<void>`**
  - *(private)* **`private async collectJobIds( isAuth: boolean ): Promise<Array<{ jobId: string; titleHint: string; companyHint: string; locationHint: string }>>`**
  - *(private)* **`private async extractJobDetailsFromPanel( jobId: string, titleHint: string, companyHint: string, locationHint: string ): Promise<ScrapedJob | null>`**
  - *(private)* **`private async dismissModal(): Promise<void>`**
  - *(private)* **`private async typeHumanLike(selectors: string[], text: string): Promise<boolean>`**

#### `src/lib/scraping/scraping-orchestrator.ts`

- **`const scrapingOrchestrator = new ScrapingOrchestrator(…)`** — Singleton instance of `ScrapingOrchestrator` (see the class below).
- **class `ScrapingOrchestrator`**
  - **`async startScraping( config: SearchConfig, resumeId?: string, onFitJob?: (jobId: string) => void ): Promise<{ newCount: number; fitCount: number; notFitCount: number }>`**
  - **`async analyzeAndScoreJobs(resumeId: string): Promise<void>`**
  - *(private)* **`private isCompanyBlacklisted(company: string): boolean`**
  - *(private)* **`private isSpamJob(job: ScrapedJob): boolean`**

### `src/lib/matching`

#### `src/lib/matching/fast-filter.ts`

- **`function extractRequiredYears(text: string): number`** — Pull the highest "N years (of) experience" requirement out of a job description. Returns 0 if none stated. Handles "4 years", "4+ years", "3-5 years", "minimum of 5 years", "5 yrs".
- **`function fastFilter( jobTitle: string, jobDescription: string, candidateSkills: string[], candidateTech: string[], searchKeywords: string[], options: { blacklistCompanies?: string[]; minSalary?: number; salaryMin?: number; requireSponsorship?: boolean; candidateYears?: number; // candidate's years of experience entryLevelTarget?: boolean; // user is targeting entry/intern roles } = {} ): FilterResult`**

#### `src/lib/matching/visa-detector.ts`

- **`function detectVisaInfo(description: string): VisaInfo`**

### `src/lib/tailoring`

#### `src/lib/tailoring/analysis/analyze-jd.ts`

- **`async function analyzeJob(jobId: string): Promise<JobAnalysis>`**

#### `src/lib/tailoring/composition/letter-builder.ts`

- **`function composeLetter(sel: FactSelection, facts: FactBook, analysis: JobAnalysis): string`** — Properties the gates rely on, true by construction: • Every sentence is first person (literal "I am", "I bring", "I would"). • Each employer reference is immediately followed by an achievement from that employer (achA→empA, achB→empB by construction). • No template placeholder labels exist, so none can leak. • Forbidden phrases never appear because they are not in these strings. • Every clause is composed from real skill canonicals, real achievement text, a real project, and JD-derived terms — there is no free-text path.

#### `src/lib/tailoring/composition/select-facts.ts`

- **`function matchSkillStrings( skillStrings: string[], facts: FactBook ): { present: SkillId[]; absent: string[] }`** — Split a list of JD skill strings into those the candidate genuinely has (present) and those they lack (absent), synonym-aware. Deterministic.
- **`function computeRequiredSkillMatch( analysis: JobAnalysis, facts: FactBook ): { present: SkillId[]; absent: string[] }`** — Exact intersection of analysis.requiredSkills ↔ FactBook skills. Drives the 30% eligibility floor and composeLetter's "maps directly to …" line.
- **`function verifySelection(sel: FactSelection, facts: FactBook): void`**
- **`async function selectFacts( analysis: JobAnalysis, facts: FactBook, hints?: TailorHints ): Promise<FactSelection>`** — ONE Claude call → judgment picks only (summary skills, anchor, two evidence achievements, a verbatim company detail). Orderings, present/absent, and any missing/invalid judgment pick are filled deterministically from REAL facts, so the selection is always valid + fully grounded on any model (incl. local Ollama). verifySelection is the final guard (it can only throw the eligibility floor once the structure is built deterministically).

#### `src/lib/tailoring/composition/summary-builder.ts`

- **`function composeSummary(sel: FactSelection, facts: FactBook, analysis: JobAnalysis): string`** — JD-targeted, still 100% real: names the role being applied for and leads with the required skills the candidate genuinely HAS (their matched keywords), then anchors one real achievement/project. Stays within the 280-char summary gate.

#### `src/lib/tailoring/composition/text-utils.ts`

- **`function humanList(items: string[]): string`** — "A" → "A"; "A, B" → "A and B"; "A, B, C" → "A, B, and C" (Oxford comma).
- **`function lowerFirst(s: string): string`** — Lowercase only the first character (so a verb-initial achievement flows after "I "). Leaves acronyms/proper nouns later in the string untouched.
- **`function truncate(s: string, max: number): string`** — Trim to <= max chars at a word boundary, appending an ASCII ellipsis only when actually truncated. ASCII (not "…") so it is safe in the résumé LaTeX.
- **`function clip(s: string, max: number): string`** — Like truncate but with NO ellipsis and trailing punctuation stripped — for embedding a clean fragment inside another sentence ("Recent work: <clip>.").

#### `src/lib/tailoring/facts/load-facts.ts`

- **`function defaultCandidate(): Candidate`**
- **`function buildFactBook(candidate: Candidate): FactBook`**
- **`async function loadFacts(resumeId: string): Promise<FactBook>`** — Reads the canonical résumé content (resume-template.ts) plus the candidate's Resume row (contact info only) and returns a fully-built, immutable FactBook.
- **`function nearDuplicateProjectName(a: string, b: string): boolean`** — Two project names are near-duplicates when one normalized name is a prefix or suffix of the other (covers "TestCaseCheckByJacoco" vs "TestCaseCheckByJacoco JAVA"), guarded by a min length so short fragments never collapse unrelated projects ("api" inside "apiserver").
- **`function dedupeGithubProjects<T extends { name: string; bullet: string; stars: number }>(rows: T[]): T[]`** — Collapse near-duplicate GitHub repos (the user keeps two copies of the same project) down to one, keeping the highest-quality entry per cluster. Pure + exported so the dedup is unit-testable without a database.

#### `src/lib/tailoring/index.ts`

- **`async function composeApplication( resumeId: string, jobId: string, hints?: TailorHints ): Promise<ComposedApplication>`** — Pure generation: loadFacts → analyzeJob → preFilter → selectFacts → compose → validate. NO DB writes, NO PDF compile. Throws EligibilityError (not a fit) or ValidationError (a template regression). `hints` lets a caller (the screening loop) ask selectFacts to feature specific REAL skills more prominently.
- **`async function finalize(resumeId: string, jobId: string, c: ComposedApplication): Promise<TailorResult>`** — Compile both PDFs + persist the TailoredResume / CoverLetter (sets the job TAILORED). The back half of tailorJob, reusable by the screening loop once an application is accepted.
- **`async function tailorJob(resumeId: string, jobId: string, hints?: TailorHints): Promise<TailorResult>`** — The ONE public entry point. Signature is backward-compatible (the optional hints are only used by the screening loop). The LLM runs only in analyzeJob + selectFacts, both returning structured data — a fabricated skill cannot be expressed because there is no fact id for it.

#### `src/lib/tailoring/persistence/save.ts`

- **`async function persist(a: PersistArgs): Promise<TailorResult>`** — Save .tex + cover letter + job description + metadata to the application folder, then create the TailoredResume + CoverLetter rows and flip the job to TAILORED. Reuses the existing file-manager + folder layout (same filenames as before).

#### `src/lib/tailoring/rendering/compile.ts`

- **`async function compileBoth( resumeTex: string, canonicalResumeTex: string, letterTex: string, folderPath: string ): Promise<{ resumePdf: string | null; letterPdf: string | null; resumeTexUsed: string }>`** — Compile résumé + cover letter to PDF (Tectonic). The résumé keeps the one-page guarantee: if the reordered version spills to 2 pages, fall back to the canonical content and recompile. Returns the résumé .tex that actually shipped so persistence stores the one that matches the PDF.

#### `src/lib/tailoring/rendering/letter-latex.ts`

- **`function renderLetterLatex(letter: string, facts: FactBook, analysis: JobAnalysis): string`** — A professional cover-letter layout that mirrors the résumé: centered name + contact header, today's date, recipient block, a single greeting, the 3 body paragraphs (already clean — composeLetter emits no greeting/sign-off/labels), and a single sign-off. Contact comes from the FactBook candidate.

#### `src/lib/tailoring/rendering/resume-latex.ts`

- **`function renderCanonicalResumeLatex(summary: string): string`** — The canonical one-page résumé (summary tailored, content untouched). Used as the guaranteed-fits fallback when the reordered version spills to a second page.
- **`function renderResumeLatex(sel: FactSelection, facts: FactBook, summary: string): string`** — Render the résumé from the selection: tailored summary + skill reordering (resumeSkillOrder) + per-employer bullet reordering (resumeAchievementOrder). Both overrides are permutations BY CONSTRUCTION — we only sort each group's own items / each employer's own bullets, never adding, dropping, or inventing.

#### `src/lib/tailoring/routing/pre-filter.ts`

- **`function preFilter(analysis: JobAnalysis, facts: FactBook): void`** — Pure routing gate (no LLM). Throws EligibilityError when the candidate is clearly disqualified, so tailorJob can soft-skip the job instead of generating (and then having to validate / discard) materials it should never produce.

#### `src/lib/tailoring/types.ts`

- **class `EligibilityError`**
  - **`constructor(public reason: string)`**
- **class `ValidationError`**
  - **`constructor(public gate: string, public reason: string)`**

#### `src/lib/tailoring/validation/gates.ts`

- **`function validateOutputs( summary: string, letter: string, analysis: JobAnalysis, sel: FactSelection, facts: FactBook ): void`** — Defense in depth. Composition (step 6) already guarantees most of these by construction; these gates re-check the final strings so that if someone later edits a template and breaks an invariant, it fails LOUDLY rather than shipping. Every gate THROWS — there is no retry here.

### `src/lib/ats-screen`

#### `src/lib/ats-screen/persist.ts`

- **`async function saveScreeningResult(jobId: string, resumeId: string | null, result: LoopResult)`** — Save one screening run (accepted OR rejected) with its full round history.
- **`async function getLatestScreening(jobId: string)`** — The most recent screening for a job (so the panel can show it without re-running).

#### `src/lib/ats-screen/screen.ts`

- **`function screenApplication( analysis: JobAnalysis, facts: FactBook, sel: FactSelection, summary: string, letter: string ): ScreenResult`** — Screen a generated application the way an employer's ATS + a recruiter would: • required-skill coverage (from the FactBook — what the candidate truly has) • evidence quality (does the cover letter SHOW the skill via a real achievement/project, or just name it?) • nice-to-have coverage • experience fit Gaps are split into coverable (real skill under-featured → the loop can fix it) and absent (genuinely missing → never claimed).
- **`async function recruiterNote(analysis: JobAnalysis, result: ScreenResult): Promise<string>`** — Optional: a short, grounded recruiter note (LLM). Never changes the decision — it only narrates it. Degrades to "" if the model is unavailable.

#### `src/lib/ats-screen/screening-loop.ts`

- **`async function runScreeningLoop( resumeId: string, jobId: string, opts: LoopOptions = {} ): Promise<LoopResult>`** — The closed loop. Applicant agent generates → employer ATS screens → on reject, the candidate's REAL under-featured skills are fed back to feature next round. It NEVER invents a skill: when only genuinely-absent gaps remain, it stops with an honest reject + a learn-list. The accepted version is the only one compiled to PDF + persisted.

### `src/lib/profile`

#### `src/lib/profile/dropdown-intelligence.ts`

- **`function normalizeDegreeLevel(value: string): string | null`** — Map a free value to a canonical degree LEVEL (for "Degree Level" dropdowns).
- **`function matchDropdownOptionScored( value: string, options: DropdownOption[], kind?: string ): DropdownMatch`**
- **`function matchDropdownOption( value: string, options: DropdownOption[], kind?: string ): string | null`** — Back-compat: choose the best option, or null if nothing matches well OR the match is ambiguous (so callers that ignore scoring still fail safe).

#### `src/lib/profile/profile-store.ts`

- **`async function loadProfile(): Promise<Profile>`** — Load the structured profile (from UserSettings.profile JSON).
- **`async function saveProfile(profile: Profile): Promise<void>`**
- **`async function seedProfileFromActiveResume(): Promise<Profile>`** — Seed/refresh the profile from the active résumé without clobbering locked or already-set fields. Safe to call after a résumé upload.

#### `src/lib/profile/profile.ts`

- **`function resolveField(label: string, profile: Profile): FieldResolution | null`** — Resolve a detected form-field label to a profile field. Returns the matched spec (so callers know category/compliance) and the stored value if present.
- **`function seedProfileFromResume( existing: Profile, resume: { contactInfo?: Record<string, string>; yearsOfExperience?: number; education?: unknown[]; experience?: unknown[]; skills?: unknown[]; } ): Profile`** — Build a default profile from a parsed résumé's contactInfo (best-effort, lower confidence than user-entered). Existing locked values are preserved.

### `src/lib/ai`

#### `src/lib/ai/ats-analyzer.ts`

- **`function atsKeywordPct(matching: string[], missing: string[]): number | null`** — Keyword-coverage ATS % (0-100) from matched vs. missing skills — no AI call. Used to populate Job.atsKeywordScore during scraping/analysis.
- **`async function analyzeATS( resumeData: Record<string, unknown>, jobDescription: string ): Promise<AtsAnalysis>`**

#### `src/lib/ai/claude.ts`

- **`async function claudeComplete(prompt: string, system?: string, tokens?: number)`**
- **`async function claudeCompleteJSON<T>(prompt: string, system?: string, tokens?: number)`**
- **`async function claudeParseResume(text: string)`**
- **`async function claudeAnalyzeJob(description: string)`**
- **`async function claudeMatchJobToResume( description: string, resumeData: Record<string, unknown> )`**
- **`async function claudeBatchMatchJobs( jobs: { id: string; title: string; company: string; description: string }[], resumeData: Record<string, unknown> )`**
- **`async function claudeTailorResume( latex: string, description: string, resumeData: Record<string, unknown>, jobAnalysis: Record<string, unknown> )`**
- **`async function claudeGenerateCoverLetter( description: string, company: string, title: string, resumeData: Record<string, unknown> )`**
- **`function normalizeCategory(raw: unknown): string`** — Coerce whatever the model returns into a valid enum value (defaults GENERAL).
- **`async function claudeAnswerQuestion( question: string, context: Record<string, unknown>, previousAnswers: { question: string; answer: string }[], opts: OpenEndedContext = {} ): Promise<{ answer: string; category: string }>`**
- **`async function claudeGenerateLatexResume(data: Record<string, unknown>)`**
- **`async function claudeInterviewPrep( resumeData: Record<string, unknown>, jobDescription: string, jobTitle: string, companyName: string ): Promise<InterviewPrep>`**
- **`async function claudeCareerAdvice( profile: { name: string; years: number; skills: string[]; technologies: string[] }, demand: { topGaps: { skill: string; count: number }[]; topStrengths: { skill: string; count: number }[]; commonTitles: string[]; jobsAnalyzed: number; salaryRange: string; } ): Promise<CareerAdvice>`**
- **`async function claudeRecruiterMessage( profile: { name: string; years: number; skills: string[] }, job: { jobTitle: string; companyName: string; description?: string }, recruiterName?: string ): Promise<RecruiterOutreach>`**
- **`async function claudeClassifyEmail(emailText: string): Promise<EmailClassification>`**

#### `src/lib/ai/ollama.ts`

- **`async function ollamaComplete( prompt: string, systemPrompt?: string, maxTokens = 4096 ): Promise<string>`**
- **`async function ollamaCompleteJSON<T>( prompt: string, systemPrompt?: string, maxTokens = 4096, useCoder = false ): Promise<T>`**
- **`async function generateEmbedding(text: string): Promise<number[]>`**
- **`function cosineSimilarity(a: number[], b: number[]): number`**
- **`async function semanticScore(textA: string, textB: string): Promise<number>`** — Semantic similarity score 0-100 between two texts

#### `src/lib/ai/openai.ts`

- **`async function openaiComplete( prompt: string, systemPrompt?: string, maxTokens: number = 4096 ): Promise<string>`**
- **`async function openaiCompleteJSON<T>( prompt: string, systemPrompt?: string, maxTokens: number = 4096 ): Promise<T>`**

### `src/lib/gmail`

#### `src/lib/gmail/client.ts`

- **`function getRedirectUri(): string`**
- **`function getOAuthClient(): GoogleOAuth2Client`** — Build an OAuth2 client from the app's Google Cloud credentials (env). Throws a clear error if they're missing so the UI can tell the user to set them up.
- **`function getAuthUrl(): string`** — Consent URL the "Connect Gmail" button redirects to. access_type=offline + prompt=consent guarantees Google returns a refresh token we can persist.
- **`async function exchangeCodeForTokens(code: string): Promise<{ address: string }>`** — Exchange the OAuth callback code for tokens, persist the (encrypted) refresh token + the connected address. Returns the connected Gmail address.
- **`async function getAuthedGmail(): Promise<gmail_v1.Gmail | null>`** — Build an authed Gmail client from the stored refresh token. Returns null if Gmail isn't connected. The OAuth2 client auto-refreshes access tokens; we also persist any rotated refresh token Google hands back via the `tokens` event.
- **`async function gmailStatus(): Promise<GmailStatus>`**
- **`async function disconnectGmail(): Promise<void>`** — Disconnect: best-effort token revoke at Google, then clear the stored token.

#### `src/lib/gmail/fetch.ts`

- **`function normalizeMessage(msg: gmail_v1.Schema$Message): GmailMessage`**
- **`async function listRecentMessages( opts: { q?: string; maxResults?: number } = {}, gmail?: gmail_v1.Gmail | null ): Promise<string[]>`** — List message ids matching a Gmail search query (e.g. "newer_than:1d", "in:inbox").
- **`async function getMessage( id: string, gmail?: gmail_v1.Gmail | null ): Promise<GmailMessage | null>`** — Fetch + normalize a single message by id.
- **`async function getMessages( ids: string[], gmail?: gmail_v1.Gmail | null ): Promise<GmailMessage[]>`** — Convenience: fetch + normalize many ids, newest first.

#### `src/lib/gmail/otp.ts`

- **`function extractOtp(body: string, subject = ""): string | null`** — Pull a one-time code out of an email body (+ subject). Returns null if none. Strategy, most-reliable first: code adjacent to a keyword (either order), then a labeled alphanumeric code, then a lone 6-digit number.
- **`async function fetchLatestOtp(q: OtpQuery): Promise<OtpResult | null>`** — Poll Gmail until a matching code arrives or the budget runs out. Codes can land a few seconds after the form requests them, hence the polling loop.

#### `src/lib/gmail/sync.ts`

- **`async function applyClassificationToApplication( result: Pick<EmailClassification, "company" | "newStatus"> ): Promise<AppliedStatus | null>`** — Match a classified email to the most recent application for that company and apply the detected status. Returns the update, or null if nothing matched.
- **`async function syncInbox(opts: { maxResults?: number } = {}): Promise<SyncResult>`** — Fetch + classify + auto-apply for all inbox mail since the last sync cursor.

### `src/lib/github`

#### `src/lib/github/client.ts`

- **`async function fetchRepos(username: string, token?: string): Promise<GhRepo[]>`** — With a token we hit /user/repos (the token owner's OWN repos — includes private); without one, /users/{username}/repos (public only). Paginated up to 500 repos.
- **`async function ghAuthInfo( token: string ): Promise<{ login: string | null; scopes: string[]; ownedRepos: number }>`** — Verify a token + read its scopes (classic tokens expose them via the X-OAuth-Scopes header; fine-grained tokens return an empty list). login === null means the token is invalid/expired.
- **`async function fetchReadme(fullName: string, token?: string): Promise<string>`** — The README endpoint returns the repo's README regardless of filename/branch. Returns "" if there is none (or on any error — README is best-effort context).

#### `src/lib/github/import.ts`

- **`async function importGithubProjects( username: string, token?: string, opts: { includeForks?: boolean } = {} ): Promise<{ projects: Awaited<ReturnType<typeof prisma.githubProject.upsert>>[]; stats: ImportStats }>`**

### `src/lib/resume`

#### `src/lib/resume/parser.ts`

- **`async function extractTextFromPDF(filePath: string): Promise<string>`**
- **`async function extractTextFromDOCX(filePath: string): Promise<string>`**
- **`async function extractTextFromTex(filePath: string): Promise<string>`**
- **`async function extractTextFromFile(filePath: string): Promise<string>`**
- **`async function parseResume(filePath: string): Promise<ParsedResume>`**
- **`async function extractLatexFromZip(zipPath: string): Promise<string>`**

#### `src/lib/resume/quick-extract.ts`

- **`function quickExtract(text: string): QuickExtract`**

### `src/lib/storage`

#### `src/lib/storage/file-manager.ts`

- **`function ensureDir(dirPath: string): void`**
- **`function initStorageDirs(): void`**
- **`function getApplicationFolder( companyName: string, jobTitle: string, date?: Date ): string`**
- **`function saveUploadedResume( buffer: Buffer, originalName: string ): { filePath: string; fileName: string }`**
- **`function saveFile( folderPath: string, fileName: string, content: string | Buffer ): string`**
- **`function saveApplicationFiles( folderPath: string, files: { resumeTex?: string; coverLetterTex?: string; jobDescription?: string; metadata?: Record<string, unknown>; } ): Record<string, string>`**
- **`function savePDF(folderPath: string, fileName: string, pdfBuffer: Buffer): string`**
- **`function saveScreenshot(folderPath: string, screenshot: Buffer, label?: string): string`**
- **`function getFileSize(filePath: string): number`**
- **`function fileExists(filePath: string): boolean`**
- **`function readFile(filePath: string): string`**
- **`function listApplicationFolders(): string[]`**
- **`function getAbsolutePath(relativePath: string): string`**

#### `src/lib/storage/memory.ts`

- **`function hashQuestion(question: string): string`**
- **`function isPlausibleAnswer(label: string, value: string): boolean`**
- **`async function findAnswer( question: string ): Promise<string | null>`**
- **`async function saveAnswer( question: string, answer: string, category: MemoryCategory | string = "GENERAL", platform?: string, force = false ): Promise<void>`** — Automated save (AI/capture/shortcut). Validates value↔label and NEVER overwrites a locked memory. `force` (human edits) bypasses validation.
- **`async function saveHumanAnswer( question: string, answer: string, platform?: string ): Promise<void>`** — Save an answer the HUMAN typed/corrected — treated as authoritative. Besides the exact upsert, it OVERWRITES any near-duplicate memory whose answer differs, so a previously-saved bad answer (even phrased differently) gets corrected instead of leaving stale wrong data to be re-served later.
- **`async function recordRejection( question: string, badAnswer: string, platform?: string ): Promise<void>`** — Record that `badAnswer` was the WRONG value for `question` — the agent filled it and the human corrected it. The value is then never auto-served or auto-saved for this question again (see findAnswer/saveAnswer guards).
- **`async function isRejected(question: string, answer: string): Promise<boolean>`** — Has the human rejected `answer` for `question`? Used to discard an AI/profile candidate before it's applied.
- **`async function setMemoryLock(id: string, locked: boolean): Promise<void>`** — Toggle the lock on a memory (locked = AI/capture can't change it).
- **`async function cleanupBadMemories(): Promise<number>`** — Delete memories whose stored answer is implausible for their field label — cleans up the email-everywhere / phone-in-School pollution. Locked rows are kept. Returns how many were removed.
- **`async function getAllMemories(category?: MemoryCategory)`**
- **`async function deleteMemory(id: string): Promise<void>`**
- **`async function updateMemory(id: string, answerText: string): Promise<void>`**
- **`async function getOrCreateUser()`**

### `src/lib/security`

#### `src/lib/security/credentials.ts`

- **`async function getCredentials(): Promise<Credentials>`**
- **`async function saveCredentials(input: Partial<Credentials>): Promise<void>`** — Save credentials encrypted. Empty/undefined values are left unchanged.
- **`async function migratePlaintextCredentials(): Promise<boolean>`** — One-time migration: if .env has plaintext creds and the DB has none, pull them into the encrypted store. Safe to call repeatedly (no-op once migrated).
- **`async function credentialsStatus(): Promise<{ linkedin: boolean; ats: boolean; }>`** — Whether encrypted creds are present (for UI status, never returns the values).

#### `src/lib/security/crypto.ts`

- **`function isEncrypted(value: string | null | undefined): boolean`**
- **`function encryptSecret(plain: string): string`** — Encrypt → "enc:v1:<iv b64>:<tag b64>:<ciphertext b64>". Idempotent.
- **`function decryptSecret(value: string | null | undefined): string`** — Decrypt an "enc:v1:" blob. Plain (un-prefixed) input is returned as-is so the system keeps working during migration / for not-yet-encrypted values.

### `src/lib/auth`

#### `src/lib/auth/session.ts`

- **`async function createSession(): Promise<string>`**
- **`async function verifySession(token: string): Promise<boolean>`**
- **`async function getSession(): Promise<boolean>`**
- **`async function setSessionCookie(token: string)`**
- **`async function clearSession()`**

### `src/lib/logging`

#### `src/lib/logging/logger.ts`

- **class `Logger`**
  - **`static async log( level: LogLevel, category: string, message: string, details?: Record<string, unknown>, jobId?: string, applicationId?: string )`**
  - **`static info(category: string, message: string, details?: Record<string, unknown>, jobId?: string)`**
  - **`static error(category: string, message: string, details?: Record<string, unknown>, jobId?: string)`**
  - **`static warn(category: string, message: string, details?: Record<string, unknown>, jobId?: string)`**
  - **`static success(category: string, message: string, details?: Record<string, unknown>, jobId?: string)`**
  - **`static debug(category: string, message: string, details?: Record<string, unknown>)`**

### `src/lib/queue`

#### `src/lib/queue/job-queue.ts`

- **`const jobQueue = new JobQueue(…)`** — Singleton instance of `JobQueue` (see the class below).

### `src/lib/export`

#### `src/lib/export/excel.ts`

- **`async function generateJobsExcel(): Promise<Buffer>`**
- **`async function generateApplicationsExcel(): Promise<Buffer>`**

### `src/lib/utils.ts`

#### `src/lib/utils.ts`

- **`function cn(...inputs: ClassValue[])`**

### `src/middleware.ts`

#### `src/middleware.ts`

- **`async function middleware(request: NextRequest)`**

<!-- FNREF:END -->

## License

Private project.
