# Job Application Automation Tool

**Automated job scraping, resume tailoring, CV generation, and application submission** — a full-stack Next.js + Playwright + Claude AI pipeline for intelligent job hunting.

## Overview

This tool automates the entire job application workflow:

1. **Scrape** job listings from LinkedIn, Indeed, Glassdoor, Greenhouse, and custom sites
2. **Analyze** each job against your resume using Claude AI — with an automatic **ATS keyword score** and visa/sponsorship detection
3. **Tailor** your resume and generate a **fact-checked, quality-gated** cover letter (both compiled to PDF)
4. **Generate** a single-page PDF CV via local LaTeX compilation
5. **Apply** intelligently on LinkedIn (Easy Apply + external forms) and 13+ ATS platforms
6. **Track** the full funnel and get **AI career guidance** from the jobs you've analyzed

**Key Innovations:**
- Resume tailoring uses a **fixed, hand-tuned LaTeX template** with only the Professional Summary AI-generated per job — guarantees 1-page output and 100% compilable PDFs.
- Cover letters pass a **deterministic quality gate** — achievement matching, ATS coverage, structure validation, and an **LLM fact-checker** — and regenerate until they're clean, so the letter never invents an experience you don't have.
- The apply engine **never fakes success** — it only reports "submitted" on a real confirmation; otherwise it pauses for you and **resumes automatically** once you fill the gap (no button press needed).
- It reads **email verification codes (OTP) straight from your Gmail** mid-apply, so login/verification walls don't stop the run.
- Anything you type during a pause is **captured to memory** and reused on future jobs — even when the same question is **worded differently** (semantic matching).

---

## Quick Start

### Prerequisites

- **Node.js** 18+
- **PostgreSQL** (local or cloud)
- **An AI provider** — Anthropic API (default), AWS Bedrock, or local **Ollama**
- **Playwright browsers** (`npx playwright install`)
- **Tectonic** (local LaTeX compiler) at `~/.job-agent-tools/`
- **(Optional) Google Cloud OAuth client** — for live Gmail OTP + status sync
- **Git**

### 1. Install & Setup

```bash
git clone <repo-url>
cd Application-automation-tool
npm install

# Install Playwright browsers (required for scraping + applying)
npx playwright install

# OPTIONAL — only if using the local Ollama provider
ollama pull qwen2.5:3b         # tailoring + Q&A model
ollama pull nomic-embed-text   # semantic memory matching (recommended)

# Sync the database schema
npx prisma db push
```

### 2. Configure `.env`

Copy `.env.example` to `.env` and fill it in. The essentials:

```bash
# Auth (single password gate — JWT in an httpOnly cookie)
AUTH_PASSWORD=your_secure_password
AUTH_SECRET=your_64_char_random_secret

# AI Provider — "anthropic" (default) | "bedrock" | "ollama"
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-6
# (Bedrock instead: AWS_REGION + AWS_BEARER_TOKEN_BEDROCK)
# (Ollama instead: OLLAMA_BASE_URL + OLLAMA_MODEL)

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/job_agent

# LinkedIn — used for Easy Apply email + external-form login when required
LINKEDIN_EMAIL=you@example.com
LINKEDIN_PASSWORD=your-password

# ATS account credentials (Workday / Greenhouse / etc.). Each company runs its
# OWN Workday tenant, so the engine signs in OR creates an account per tenant
# using these. Falls back to the LinkedIn values above if unset.
ATS_EMAIL=you@example.com
ATS_PASSWORD=your-password

# Gmail (optional) — auto-fetch OTP/verification codes + live status sync
GMAIL_CLIENT_ID=your_google_oauth_client_id
GMAIL_CLIENT_SECRET=your_google_oauth_client_secret
GMAIL_OAUTH_REDIRECT=http://localhost:3000/api/gmail/oauth/callback

# Application limits
AUTOMATION_MAX_APPLICATIONS_PER_DAY=30
AUTOMATION_AUTO_APPLY=false
```

> **Security:** Prefer **Settings → Credentials** (AES-256-GCM encrypted at rest) over plaintext `.env`. If you do use `.env`, keep it out of git (it's gitignored by default) and never share it. Fine for local single-user use.

### 3. Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Architecture

### Tech Stack

- **Frontend**: Next.js 15 (App Router), React 19, TailwindCSS (glass/aurora dark theme), Recharts
- **Backend**: TypeScript (strict), Next.js API routes
- **Database**: PostgreSQL + Prisma
- **AI**: Claude via Anthropic API (default), AWS Bedrock, or local Ollama; `nomic-embed-text` for semantic memory
- **Email**: Gmail API (OAuth2, read-only) via `googleapis`
- **Automation**: Playwright (persistent Edge/Chromium profile)
- **PDF**: Tectonic (local LaTeX compiler)
- **Tests**: Vitest

### Key Features

✅ **Multi-platform scraping** (LinkedIn, Indeed, Glassdoor)  
✅ **Profile Engine** (structured identity/contact/visa/education fields, deterministic form-fill, per-field lock)  
✅ **Confidence-based automation** (>95% auto-fill · 85–95% fill + verify · <85% pause for review)  
✅ **Compliance gating** (visa/EEO answers come only from your profile — never AI-guessed)  
✅ **Dropdown intelligence** (maps TX→Texas, MS→Master's, USA→United States, etc. with no AI)  
✅ **Encrypted credentials** (AES-256-GCM at rest — no plaintext passwords)  
✅ **AI-powered tailoring** (JD-specific summary + reordered skills/bullets, truth-checked)  
✅ **Fact-checked cover letters** (achievement matcher + ATS validator + structure check + **LLM fact-checker** + retry loop — regenerates until clean)  
✅ **ATS score analyzer** (keyword-match % + missing keywords + suggestions, auto-computed per job)  
✅ **Job fit scoring** (Technical / Experience / Education + overall match, in the ATS panel)  
✅ **H1B / CPT / OPT detection** (sponsorship + international-friendliness flagged per job)  
✅ **Funnel analytics** (response / interview / offer rates, application status charts)  
✅ **Local PDF compilation** (résumé **and** cover letter, ~2.5s each)  
✅ **LinkedIn Easy Apply** (sets email, uploads résumé, auto-submits)  
✅ **13+ ATS adapters** (Greenhouse, Lever, Workday, iCIMS, ADP, Taleo, Oracle Cloud, SmartRecruiters, Ashby, BambooHR, Jobvite, Workable, Dice) + generic fallback  
✅ **Workday auto-login / account creation** (per-tenant sign-in, else creates an account with `ATS_EMAIL`/`ATS_PASSWORD`)  
✅ **Generic login walls** (auto sign-in for Greenhouse candidate portal, Dice, etc.)  
✅ **Session pre-warm** (auto-mode logs into Greenhouse once per batch so every apply is pre-authenticated)  
✅ **Strict success detection** (only counts a confirmed submission — no false "submitted" from job-slug URLs)  
✅ **Multi-step form handling** (walks each section; never fakes a submit)  
✅ **Auto-takeover** (stops on unknown fields, auto-resumes when you fill them — no button)  
✅ **"I submitted it" confirmation** (tell the engine you finished a manual takeover so it isn't wrongly marked failed)  
✅ **Cover letter on demand** (pastes into text boxes or uploads PDF when a job asks)  
✅ **Robust checkboxes** (handles styled/hidden checkboxes; auto-ticks consent boxes)  
✅ **Semantic memory** (reuses your answers even when a question is worded differently)  
✅ **Self-correcting memory** (fixing a wrong answer overwrites the bad one, including near-duplicates)  
✅ **Memory lock + validation** (lock answers so AI can't change them; bad value↔field matches are rejected; one-click cleanup)  
✅ **Live Gmail integration** (OAuth2 read-only: auto-fetches **OTP/verification codes** mid-apply + scans your inbox to auto-update application statuses)  
✅ **Recruiter outreach** (AI-drafted connection note + message + follow-up per job)  
✅ **Interview prep workspace** (technical / behavioral-STAR / **system-design** questions, talking points, prep tips)  
✅ **AI career advisor** (skill-gap analysis + learning roadmap + target roles + salary insight, mined from the jobs you've analyzed)  
✅ **Email status detection** (paste — or auto-sync — an interview/offer/rejection email → classifies it and updates the application status)  
✅ **Manual status updates** (set interview/offer/rejected to keep funnel analytics accurate)  
✅ **Resume diff viewer** (see changes per job)  
✅ **Excel export** (job tracker)  
✅ **Manual review mode** (pause before applying)  
✅ **Pipeline overview dashboard** (at-a-glance funnel, stats, charts, recent executions)  
✅ **Modern glass UI** (frosted cards, aurora background, gradient accents)  
✅ **Screenshots** (every apply step, debugging)  

---

## Resume Template

Your résumé is defined in **`src/lib/automation/resume-template.ts`** — the single source of truth.

**Why this approach?**
- Always 1 page (tested in Overleaf)
- Always compilable
- AI focuses on job-specific summary
- No wasted tokens on rewriting education/experience

To update: edit `resume-template.ts`. The **Professional Summary** is swapped per job; everything else stays static.

---

## Cover Letter Quality Gate

Cover letters aren't trusted on the first try — they pass a **deterministic gate** before any PDF is compiled (`src/lib/cover-letter/quality.ts`, driven from `resume-tailor.ts`). Per attempt:

- **Achievement matching** — the most relevant *verified* claims for the job are selected deterministically (token overlap against required skills); the model must build the match paragraph from these, not invent its own.
- **ATS coverage** — fraction of the job's required skills that actually appear in the letter.
- **Structure validation** — length, company/role present, no placeholders / leftover section markers / duplicate paragraphs.
- **Hallucination check** — a regex guard (free) **plus an LLM fact-checker** that lists unsupported claims the regex can't catch.
- **Quality score** — one number from accuracy + ATS coverage; hallucinations are heavily penalized.

A letter is **accepted** only when it's structurally valid, has **zero hallucinations**, ATS coverage ≥ 70%, and clears the quality bar. Otherwise it regenerates — with the specific issues *and* the matched real achievements as guidance — up to `COVER_LETTER_MAX_ATTEMPTS` (default 3), keeping the best attempt.

---

## AI Provider Setup

The provider is selected with `AI_PROVIDER` (`anthropic` | `bedrock` | `ollama`). All three speak the same Messages API under the hood via `src/lib/ai/claude.ts`.

> **Model note:** `output_config.effort` and adaptive thinking are gated behind `MODEL_SUPPORTS_EFFORT` (`opus-4-[678]` / `sonnet-4-6`) — Haiku 4.5 / Sonnet 4.5 reject those params, so the code omits them automatically.

### Cloud: Anthropic API (default)

**Best for:** Simplest setup, best quality.

```bash
# In .env
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-6
```

### Local: Ollama + GPU

**Best for:** Privacy, no costs, GPU-accelerated (~25–30s/job on GTX 1650).

```bash
ollama serve
ollama pull qwen2.5:3b
ollama ps  # Verify: 100% GPU
```

**Hardware:**
- **4GB+ VRAM** (e.g., GTX 1650): qwen2.5:3b → ~25–30s/job
- **8GB+ VRAM** (e.g., RTX 3060): mistral:7b → ~10–15s/job
- **CPU-only**: ~60–90s/job (slow)

### Cloud: AWS Bedrock

**Best for:** Speed (~5s/job), cheap (~$1 per 100 jobs).

```bash
# In .env
AI_PROVIDER=bedrock
AWS_REGION=us-east-1
AWS_BEARER_TOKEN_BEDROCK=ABSK...your-key...
```

> **First-time Anthropic-on-Bedrock setup:** the old "Model access" page is retired — serverless models auto-enable on first invoke, but first-time Anthropic use requires submitting a one-time use-case form (Bedrock console → Model catalog → the model → *Open in playground* triggers it). After submitting, access is instant.

---

## Workflow

### Manual Review (Recommended)

```
Scrape → Analyze → Tailor → PDF → Review → Apply (when ready)
```

Dashboard shows tailored versions; click "Apply" when happy.

### Auto-Submit

```
Scrape → Analyze → Tailor → PDF → Auto-Apply
```

Set `AUTOMATION_AUTO_APPLY=true`. Daily limit: `AUTOMATION_MAX_JOBS`.

**Caution:** LinkedIn may rate-limit or flag high-volume auto-submit.

---

## How the Apply Engine Works

External job forms come in hundreds of layouts. Instead of trying to "train" a model on them, the engine combines a **pattern library of ATS adapters** with an **honest multi-step loop**:

1. **Detect the ATS** by URL (Greenhouse, Lever, Workday, iCIMS, ADP, etc.) → use that platform's known selectors. Unknown sites fall back to generic heuristics.
2. **Authenticate if needed** — login-gated platforms (Workday/ADP/Taleo) are signed into automatically. Any page that throws up a sign-in wall (e.g. Greenhouse candidate portal, Dice) is auto-logged-in with your stored ATS credentials. See Workday flow below.
3. **Walk each section** — fill fields, upload résumé, attach cover letter, click *Next* / *Save & Go to Next Section* until a real *Submit*.
4. **Confirm or pause** — success is reported **only** when a real confirmation page is detected. If a field is unknown, a button is missing, or the form won't advance, it **pauses**.
5. **Auto-takeover** — you fill the gap in the open browser; the engine detects your input (no Resume button needed), **captures it to memory**, and continues.

Adapters live in `src/lib/automation/ats-adapters.ts` — adding a platform is a single array entry.

> **Why this matters:** earlier versions reported "✓ submitted" even when nothing happened. The engine now never claims a submission it can't verify — success requires that we actually clicked a final **Submit** *and* see a confirmation-specific page (not just a URL/word that happens to contain "applied", like a job slug `…/applied-ai-engineer/`). An unconfirmed apply is marked **FAILED** so you can retry, never silently dropped.

### Login walls & session pre-warm

- **Generic login handler** — when any external apply page shows a sign-in wall, the engine fills email + password from your **encrypted ATS credentials** and submits. This covers the Greenhouse candidate portal (`my.greenhouse.io`), Dice, and similar. If it can't complete (2FA/captcha), it falls back to human takeover.
- **Session pre-warm** — at the start of an **auto-mode** batch, the engine logs into Greenhouse once (in both browser profiles it uses) so every Greenhouse application in that run is already authenticated. The session persists in the browser profile across runs.

### Workday (and other account-gated ATSes)

Every company runs its **own separate Workday tenant** — there is no universal Workday login. When the engine hits one it automatically:

1. Clicks into the application (Apply → *Apply Manually*)
2. **Tries to sign in** with `ATS_EMAIL` / `ATS_PASSWORD`
3. If no account exists on that tenant, **creates one** (email, password, confirm-password, terms)
4. Once authenticated, runs the normal multi-step form loop
5. Only falls back to **human takeover** if auth genuinely can't complete (email verification link, captcha, security question)

### When it pauses for you

During a takeover the dashboard shows two buttons:

- **✓ I submitted it** — you finished the application yourself; the engine trusts you and marks it **SUBMITTED** (fixes the case where a real submission can't be auto-detected).
- **Resume / Skip** — continue without claiming a submission (stays retryable).

It still auto-detects a real confirmation page on its own; the buttons are the fallback.

---

## ATS Score Analyzer

Every scraped job gets a **keyword-match %** automatically (no extra AI call — derived from the analyze step). It appears next to the match score in the Jobs table, color-coded (green ≥80, yellow ≥60, red below).

Click the **gauge icon** on any job for the deep dive:
- **Strong matches** — required keywords your résumé already has
- **Missing keywords** — what to add (only if you genuinely have the experience)
- **Suggestions** — concrete, ATS-aware tips

Matching is **deterministic** (keyword coverage against your résumé text), so the score is explainable — not a black box.

The panel also shows a **fit breakdown** — Technical (keyword coverage), Experience (your years vs. required), Education (your degree vs. required), and a weighted **Overall** — so you can prioritize which jobs to actually pursue.

---

## International Students (H1B / CPT / OPT)

Every scraped job is scanned for visa signals (from the description text):
- **Sponsors** / **No sponsor** badge on the job row
- `intlFriendlyScore` (0–10) for sorting toward visa-friendly roles
- CPT/OPT mentions detected

Detection is phrase-based and explainable (see `src/lib/matching/visa-detector.ts`). A "No sponsor" badge means the posting explicitly states it won't sponsor — useful to skip early. (A future version can cross-reference public H1B filing data.)

---

## Funnel Analytics

The **Analytics** tab tracks the full pipeline, not just "applied":

```
Applications → Submitted → Responses → Interviews → Offers
            response rate   interview rate   offer rate
```

Plus applications-per-day, jobs-by-source, match-score distribution, and a status funnel. Update an application's status (interview/offer/rejected) to keep the rates accurate.

---

## After You Apply

The pipeline doesn't stop at "Applied." Each application row has tools for the rest of the journey:

- **Recruiter outreach** (people icon) — AI drafts a LinkedIn connection note (<300 chars), a longer intro message, and a one-week follow-up, grounded in your real strengths. Optionally name the recruiter for personalization. One-click copy each.
- **Interview prep** (grad-cap icon) — generates likely **technical**, **behavioral (STAR)**, and **system-design** questions scaled to the role's seniority, plus why-you-fit talking points, questions to ask, and a prep checklist — all grounded in your résumé.
- **Email status detection** — paste an email you received (interview invite / assessment / offer / rejection), or let the **live Gmail sync** pull it in. The classifier labels it, suggests a reply, matches it to the application by company, and updates its status automatically.
- **Manual status dropdown** — set any application to interview/offer/rejected/etc. directly, keeping the funnel analytics honest.

See **[Gmail Integration](#gmail-integration-live)** below for the OTP auto-fetch + live inbox sync.

---

## Gmail Integration (Live)

Connect a Gmail account (OAuth2, **read-only** `gmail.readonly` scope) for two things:

1. **OTP / verification codes mid-apply** — when an apply hits an email-verification gate (Workday account creation, Greenhouse/Bloomerang security codes, etc.), the engine fetches the emailed code from Gmail and enters it automatically. Human takeover stays as the fallback. *(One-time codes are never saved to memory — they're single-use.)*
2. **Live inbox scan + auto-status** — periodically (and at the start of each automation batch) classifies incoming job mail and auto-updates the matching application's status. Manual "Scan now" and "Get latest code" buttons live on the **Gmail Inbox** panel (Applications tab).

### One-time setup

1. **Google Cloud Console** → create a project → enable the **Gmail API**.
2. **OAuth consent screen** → *External* (Testing mode is fine for single-user); add your Gmail under **Audience → Test users** (the new console splits test users onto their own page — skipping it causes `403 access_denied`).
3. **Credentials** → *Create OAuth client ID* → **Web application**, redirect URI `http://localhost:3000/api/gmail/oauth/callback`.
4. Put `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_OAUTH_REDIRECT` in `.env`, then click **Connect Gmail** in the app.

The refresh token is **encrypted at rest** (`UserSettings.encGmailRefreshToken`); only `gmail.readonly` is requested (a local sync cursor is kept instead of needing `modify`). Connect the *same inbox the apply engine fills into forms* so OTP and status mail land where the bot looks.

---

## Profile Engine & Field Accuracy

The **Profile** tab holds a structured source of truth — Identity, Contact, Immigration (work auth / sponsorship / CPT / OPT), Education, Professional. When filling a form, the engine resolves each field in this order:

```
Profile (deterministic) → Memory → Résumé shortcut → AI (open-ended only)
```

- **Deterministic structured fields** — name/email/phone/state/degree/visa never go to the AI, eliminating that source of hallucination and field-pollution.
- **Per-field lock** 🔒 — locked values can't be changed by AI or capture.
- **Dropdown intelligence** — `TX↔Texas`, `USA↔United States`, `MS↔Master's`, `authorized→Yes` matched deterministically against the dropdown's real options.
- **Compliance gating** — visa/EEO fields (work auth, sponsorship, gender, race, veteran, disability) are answered **only** from your profile. If a value isn't set, the engine **pauses** rather than letting the AI guess.
- **Auto-seed** — uploading a résumé fills blank profile fields (never overwrites locked ones). Or click **"Seed from résumé"** in the Profile tab.

### Confidence-based automation

Every fill carries a confidence score (profile-locked = 100%, memory ≈ 90%, résumé ≈ 85%, AI ≈ 60%):

| Confidence | Behavior |
|---|---|
| **≥ 95%** | Auto-fill |
| **85–95%** | Fill, then **read back to verify**; pause if it didn't land |
| **< 85%** | Leave blank and pause for your review |

This trades a little speed for accuracy — it won't blindly commit a low-trust guess.

---

## Security — Encrypted Credentials

Passwords are **encrypted at rest** (AES-256-GCM), not stored in plaintext.

- **Settings → Credentials** — enter LinkedIn / ATS email + password; they're encrypted before saving.
- **"Import from .env"** — one-click migrate existing plaintext `.env` credentials into the encrypted store.
- The encryption key lives in `~/.job-agent-tools/secret.key` (outside the repo, `chmod 600`), or via the `JOB_AGENT_SECRET_KEY` env var for ephemeral setups.
- At apply time the engine decrypts in-memory only; the encrypted store takes precedence over `.env` (which remains a fallback).

> This is **local** protection (the key is on the same machine) — a real upgrade over plaintext `.env` for a single-user install, not a substitute for a cloud secrets manager.

---

## Memory & Auto-Fill

The engine answers application questions from three sources, in order:
1. **Memory** — answers you've saved or it has captured before
2. **Résumé shortcuts** — name, email, phone, location, links
3. **Claude AI** — for free-text questions

Anything you fill manually during a pause is saved automatically. Four things make memory robust:

- **Semantic matching** — *"Are you authorized to work in the US?"* and *"Do you have US work authorization?"* resolve to the same saved answer (uses `nomic-embed-text` embeddings; falls back to exact-match if the model isn't installed).
- **Self-correction** — if a saved answer was wrong, just fix it in the form (or the **Memory** tab). Your correction overwrites the bad entry, including near-duplicate phrasings, so it won't resurface.
- **Value↔field validation** — automated captures are rejected when the value doesn't fit the field (e.g. an email can't be saved into a "Degree" or "Last Name" field, a phone can't land in "School"). This prevents the auto-capture pollution that used to spread one value across every field.
- **Lock** — click the 🔒 on any answer in the **Memory** tab to freeze it. Locked answers can't be changed by the AI, capture, or semantic correction — ideal for identity fields (First Name, Last Name, email, phone). Click any answer to edit it inline; use **"Clean up bad answers"** to purge existing mismatches in one click.

Standard consent checkboxes (terms/privacy/certify) are auto-ticked. Styled/hidden checkboxes are handled via label-click and JS-event fallbacks.

> **First-run tip:** open **Memory → "Clean up bad answers"**, then lock your core identity fields (First/Last Name, email, phone) so they stay correct forever.

---

## Troubleshooting

### "Executable doesn't exist … run npx playwright install"

**Fix:** Run `npx playwright install` once to download the browser binaries.

### "No Apply button found"

**Fix:** Manually log into LinkedIn in `~/.job-agent-profiles/linkedin`, stay logged in. The profile is persistent.

### Memory doesn't reuse differently-worded questions

**Fix:** Semantic matching needs the embedding model: `ollama pull nomic-embed-text`. Without it, only exact-match reuse works (the feature silently no-ops).

### Cover letter not uploaded on an old job

**Fix:** Jobs tailored before the cover-letter-PDF feature have no PDF — re-tailor the job. (Paste-in text boxes still work without a PDF.)

### Slow tailoring (>60s)

**Fix:** Switch to `qwen2.5:3b` (fits in 4GB VRAM) or use Bedrock.

### PDF won't compile

**Fix:** Ensure Tectonic is at `~/.job-agent-tools/tectonic.exe`. Check logs for LaTeX errors.

### Gmail "403 access_denied" when connecting

**Fix:** In the Google Cloud console, add your Gmail address under **OAuth consent screen → Audience → Test users**. The new console splits test users onto a separate page; if it's missing there, OAuth is denied even with a valid client ID.

### Database schema out of sync / column errors

**Fix:**
```bash
npx prisma db push      # Sync schema to the DB (adds new columns)
npx prisma generate     # Regenerate the client
```

---

## Performance & Costs

| Task | Cloud (Anthropic / Bedrock) | Ollama (Local) |
|---|---|---|
| Analyze + Tailor (1 job) | 5–10s | 25–30s |
| Cost (10 jobs) | ~$0.10 | $0.10–$0.20 (power) |
| **Total (10 jobs)** | ~2–3 min | ~4–5 min |

> The cover-letter quality gate may add 1–2 extra AI calls per job when a letter needs to regenerate.

---

## Project Structure

```
src/
├── app/
│   ├── globals.css           # Theme: aurora bg, .card-glass / .text-gradient utilities
│   ├── dashboard/            # Dashboard UI (tabs: Dashboard/Jobs/Applications/Analytics/
│   │                         #   Career/Profile/Resume/Memory/Settings)
│   └── api/                  # REST endpoints
│       ├── jobs/             #   ats-score, interview-prep, recruiter-message, …
│       ├── applications/     #   classify-email, status, apply, …
│       ├── automation/       #   start/stop/status (pause, resume, confirmSubmitted)
│       ├── gmail/            #   connect, oauth/callback, status, disconnect, sync, otp
│       ├── career/           #   AI career advice from analyzed jobs
│       └── memory/           #   CRUD + lock + cleanup
├── lib/
│   ├── ai/                   # claude.ts (anthropic/bedrock/ollama), ollama.ts,
│   │                         #   ats-analyzer.ts (scoring + fit)
│   ├── automation/           # apply-engine, ats-adapters, resume-tailor,
│   │                         #   resume-template, latex-compiler, automation-engine,
│   │                         #   scraper-status (human-takeover signals)
│   ├── cover-letter/         # quality.ts (achievement match + ATS + quality gate)
│   ├── gmail/                # client (OAuth2), fetch, otp (extractOtp), sync (inbox scan)
│   ├── matching/             # fast-filter, visa-detector (H1B/CPT/OPT)
│   ├── scraping/             # Job scrapers + orchestrator
│   ├── storage/              # memory.ts (semantic + lock + validation), file-manager
│   └── db/                   # Prisma client
├── components/dashboard/     # DashboardOverview (pipeline/stats/charts), JobsTable
│                             #   (ATS+fit panel, visa badge), ApplicationsTable, AnalyticsPanel,
│                             #   CareerAdvisorPanel, EmailClassifierPanel (Gmail inbox),
│                             #   RecruiterOutreachModal, InterviewPrepModal, ProfilePanel,
│                             #   AutomationControls, StatsCards
└── prisma/
    └── schema.prisma         # Job.atsKeywordScore / sponsorshipStatus / intlFriendlyScore,
                              #   CoverLetter.pdfPath, ApplicationMemory.locked,
                              #   UserSettings.encGmailRefreshToken, EmailEvent (inbox + dedupe)
```

**Key files:**
- `lib/automation/apply-engine.ts` — multi-step apply loop, Workday auto-auth, auto-takeover, OTP/email-verification handling, checkbox/cover-letter handling
- `lib/automation/ats-adapters.ts` — per-platform selectors (add new ATSes here)
- `lib/cover-letter/quality.ts` — achievement matcher, ATS validator, quality scorer, accept gate
- `lib/gmail/` — OAuth2 client + inbox fetch/parse + OTP extraction + live status sync
- `lib/ai/ats-analyzer.ts` — ATS keyword scoring + Technical/Experience/Education fit
- `lib/matching/visa-detector.ts` — sponsorship / CPT / OPT detection
- `lib/storage/memory.ts` — exact + semantic recall, self-correction, lock, value↔field validation
- `lib/automation/resume-template.ts` — your résumé (single source of truth)
- `app/globals.css` — shared visual language (`.card-glass`, `.text-gradient`, aurora bg)

---

## Key Design Decisions

### 1. Template-Based Resumes

Why: Reliable, cheaper, always 1 page. Tested in Overleaf.

Trade-off: Less variety per job. Offset by cover letter + AI summary.

### 2. Local LaTeX (Tectonic)

Why: Fast (~2.5s), offline, no browser automation.

Trade-off: Requires a one-time binary install (auto-downloaded to `~/.job-agent-tools/`).

### 3. Pluggable AI Provider

Why: One code path (`src/lib/ai/claude.ts`) speaks the Messages API to Anthropic, Bedrock, or Ollama. Default is the Anthropic API for quality + zero local setup; switch to Ollama for fully-private, no-cost local inference.

Trade-off: Cloud providers cost a little per job; Ollama needs a local GPU (CPU-only is slow).

### 4. Manual Review by Default

Why: Auto-apply to 50+/day risks LinkedIn rate-limits and flags.

Trade-off: Not fully hands-off. But integrated: dashboard shows tailored versions, you click "Apply" when happy.

---

## FAQ

**Q: Can I use this on my phone?**  
A: Not yet.

**Q: Will LinkedIn ban me?**  
A: Unlikely on manual mode (you click Apply). Auto-submit 50+/day might trigger rate-limits. Recommended: max 10–15/day auto.

**Q: What if a job fails to apply?**  
A: Check screenshots (in job folder) and logs. The engine pauses for unknown fields and resumes when you fill them; if it can't confirm a submission it marks the job FAILED (never a false "submitted") so you can retry.

**Q: It stopped mid-apply — do I have to click Resume?**  
A: No. Just fill the highlighted field(s) in the open browser; it detects your input and continues on its own. (The Resume button still works as a manual override.)

**Q: It paused on a Workday job and then I finished it myself — why did it say FAILED?**  
A: It can't always auto-detect a confirmation page. When you finish a takeover, click **"✓ I submitted it"** (not just Resume) so it records the application as submitted.

**Q: Does it really log into Workday for me?**  
A: Yes — it signs in, or creates an account on that company's tenant, using `ATS_EMAIL`/`ATS_PASSWORD`. If the tenant requires email verification or a captcha, it hands off to you, then you click "I submitted it".

**Q: Does it handle email verification codes (OTP)?**  
A: Yes, if you connect Gmail. When an apply emails a code (e.g. Workday account creation, Greenhouse/Bloomerang security codes), the engine reads it from your inbox and enters it automatically. Without Gmail connected, it pauses for human takeover instead. One-time codes are never saved to memory.

**Q: Is the Gmail access safe?**  
A: It's **read-only** (`gmail.readonly` scope) and the refresh token is encrypted at rest. The app stays in Google's "Testing" mode (single-user), and it only reads — it never sends or deletes mail.

**Q: A saved answer is wrong / the same value got into every field. How do I fix it?**  
A: Open the **Memory** tab → **"Clean up bad answers"** to purge mismatches, then click any answer to edit it and 🔒 **lock** your identity fields so they can't drift again. Typing a correction during an application also overwrites the bad entry (and similarly-worded duplicates).

**Q: How do I add support for a new ATS?**  
A: Add one entry to `src/lib/automation/ats-adapters.ts` with that platform's URL + button/file selectors.

**Q: How do I update my resume?**  
A: Edit `src/lib/automation/resume-template.ts` (single source of truth).

**Q: Where's my data?**  
A: All local in PostgreSQL. Screenshots + metadata in `./applications/`.

---

## Support

- **GitHub Issues**: Include job links, screenshots, error logs
- **Dashboard**: Settings → Report Issue (includes logs + metadata)

## Contributing

1. Fork
2. Create feature branch
3. Make changes, test locally
4. Submit PR

---

## License

MIT — Free for personal and commercial use.

---

**Happy hunting! 🚀**
