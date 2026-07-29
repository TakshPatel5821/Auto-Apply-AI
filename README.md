# AI Job Application Agent

[![CI](https://github.com/TakshPatel5821/Auto-Apply-AI/actions/workflows/ci.yml/badge.svg)](https://github.com/TakshPatel5821/Auto-Apply-AI/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](.nvmrc)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](tsconfig.json)

A full-stack, **single-user, local-first** AI job-application assistant. It scrapes jobs, scores them against your résumé, tailors a résumé and cover letter from your *real* facts (no hallucination), compiles them to PDF, auto-applies across 13+ ATS platforms with a human-in-the-loop safety net, and tracks everything — including reading application OTP codes and status emails straight from your Gmail.

> **Scope.** Designed to run on **your own machine** for **just you** (`userId` is hardcoded to `"local"` throughout). It is not multi-tenant SaaS. See [SECURITY.md](SECURITY.md#threat-model--read-this-before-deploying) before exposing it to a network.

---

## Table of Contents

- [Screenshots](#screenshots)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Commands](#commands)
- [Deployment](#deployment)
- [Project Structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

---

## Screenshots

> _Screenshots pending. Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md)._

| Dashboard | Job matching |
| --- | --- |
| _`docs/images/dashboard.png`_ | _`docs/images/jobs.png`_ |

| Résumé diff | Apply run |
| --- | --- |
| _`docs/images/resume-diff.png`_ | _`docs/images/apply.png`_ |

---

## Features

- **Scrapes** jobs from LinkedIn, Indeed, Greenhouse company boards, and arbitrary custom sites.
- **Scores** each job against your résumé with a fast keyword filter, then a Claude/OpenAI/Ollama match score, plus ATS-keyword, visa/sponsorship, and experience-level signals.
- **Tailors** a per-job summary and cover letter from a strict **FactBook** built from your canonical résumé — the LLM *selects* facts, deterministic templates *write* the prose, so a skill you don't have **cannot** be claimed.
- **Compiles** a one-page LaTeX résumé and cover letter to PDF locally (Tectonic) or via Overleaf.
- **Screens** the application as an employer's ATS would, in a closed loop that re-features your real-but-underweighted skills until accept — or an honest reject with a "skills to learn" list.
- **Auto-applies** with Playwright across 13+ ATS templates: LinkedIn Easy Apply, Workday (auto sign-in/account-create), Greenhouse, Lever, iCIMS, and more — with strict success detection and a human-takeover fallback that never fakes a submission.
- **Remembers** your answers (semantic + exact match), learns corrections as negative memory, and auto-fills repeat questions while never guessing on sensitive or legal fields.
- **Reads Gmail** (read-only OAuth) to auto-enter emailed OTP/verification codes mid-apply and to scan your inbox and auto-update application statuses (interview / offer / rejection).
- **Tracks** everything: live dashboard, analytics, logs, screenshots, Excel export, and per-field decision audit trails.

### Design principle: truthful tailoring

The tailoring pipeline never lets the model free-write your résumé. Your real facts live in `config/resume.json` and are compiled into an immutable **FactBook**. The LLM may only *choose which facts to surface and in what order*; the prose comes from deterministic templates, and validation gates reject any output that names a skill, employer, or achievement not in the FactBook. A bad model response degrades to the canonical résumé — it can never fabricate.

---

## Tech Stack

| Layer | Technology |
| --- | --- |
| Framework | Next.js 15 (App Router, Turbopack), React 19, TypeScript 5.7 (strict) |
| Styling | Tailwind CSS 3, Radix UI primitives, lucide-react |
| Database | PostgreSQL + Prisma 5 |
| AI | Anthropic Claude, OpenAI, or local Ollama (pluggable provider) |
| Automation | Playwright (Chromium) |
| Documents | LaTeX via Tectonic (local) or Overleaf; `pdf-parse` / `mammoth` for ingest |
| Email | Gmail API (read-only OAuth2) |
| Testing | Vitest (222 tests), linkedom for DOM fixtures |
| Tooling | ESLint 9 (flat config), Prettier, Docker, GitHub Actions |

---

## Architecture

```
Scrape ──► Score ──► Tailor ──► Screen ──► Apply ──► Track
  │          │         │          │          │         │
sources   fast      FactBook   ATS loop   Playwright  Gmail
registry  filter    + gates    (accept/    + field    sync +
          + LLM     + LaTeX     reject)    memory     analytics
```

Five core flows, the folder layout, every module's role, and the data model are documented in **[docs/architecture.md](docs/architecture.md)**. Per-function detail lives in **[docs/function-reference.md](docs/function-reference.md)**.

---

## Quick Start

### Requirements

| Requirement | Version | Notes |
| --- | --- | --- |
| Node.js | ≥ 20 | See [`.nvmrc`](.nvmrc) |
| PostgreSQL | ≥ 14 | Or use the bundled Docker Compose service |
| An AI provider | — | Anthropic, OpenAI, **or** local Ollama (no key needed) |
| Tectonic | optional | Local LaTeX → PDF; falls back to Overleaf |
| Gmail OAuth | optional | For OTP auto-entry and status sync |

### Install

```bash
git clone https://github.com/TakshPatel5821/Auto-Apply-AI.git
cd Auto-Apply-AI
npm install
npx playwright install chromium
```

### Configure

```bash
cp .env.example .env
cp config/resume.example.json config/resume.json
```

Then, at minimum:

1. **Generate a session secret** and put it in `.env` as `AUTH_SECRET`:
   ```bash
   openssl rand -base64 48
   ```
2. **Set a dashboard password** (stored as a bcrypt hash):
   ```bash
   npm run auth:hash
   ```
   Paste the printed `AUTH_PASSWORD_HASH=...` line into `.env`.
3. **Point `DATABASE_URL`** at your Postgres instance.
4. **Add an AI key** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) *or* set `AI_PROVIDER=ollama`.
5. **Fill in `config/resume.json`** with your real résumé facts. This file is gitignored — it is the single source of truth the tailor is allowed to draw from.

### Run

```bash
npm run db:migrate      # create the schema
npm run db:seed         # optional: local user + defaults
npm run dev
```

Open <http://localhost:3000> and log in with your password.

---

## Configuration

All settings live in `.env` — [`.env.example`](.env.example) documents every variable with defaults. The essentials:

| Variable | Required | Purpose |
| --- | --- | --- |
| `AUTH_SECRET` | ✅ | Signs the session JWT. Minimum 32 chars, **no default** — the app refuses to start a session without it. |
| `AUTH_PASSWORD_HASH` | ✅¹ | bcrypt hash of the dashboard password (`npm run auth:hash`). |
| `AUTH_PASSWORD` | ✅¹ | Plaintext fallback, compared in constant time. Prefer the hash. |
| `DATABASE_URL` | ✅ | PostgreSQL connection string. |
| `AI_PROVIDER` | ✅ | `anthropic` \| `openai` \| `ollama`. |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | ² | Provider credentials. |
| `OLLAMA_BASE_URL` | ² | For fully local inference — no API key required. |
| `RESUME_CONFIG_PATH` | | Override the location of `config/resume.json`. |
| `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` | | Enables OTP auto-entry and inbox status sync. |
| `LINKEDIN_COOKIE` | | The `li_at` cookie — safer than storing credentials. |
| `SCRAPER_DOMAIN_GAP_MS` | | Minimum ms between requests to the same host (default `1100`). Raise it if you get rate-limited. |
| `AUTOMATION_AUTO_APPLY` | | Leave `false` until you trust the output. |
| `AUTOMATION_REQUIRE_APPROVAL` | | Leave `true` for human-in-the-loop review. |

¹ One of the two is required. ² At least one provider must be reachable.

**Credentials for ATS sites** are best entered through **Settings → Credentials** in the app: they're encrypted at rest with AES-256-GCM rather than sitting in plaintext `.env`.

### Your résumé config

`config/resume.json` holds your contact details, education, experience, projects, skills, and certifications. It is **gitignored** — the committed [`config/resume.example.json`](config/resume.example.json) is a placeholder template that the app falls back to so a fresh clone boots and all tests run.

Because everything the tailor can say is derived from this file, keeping it accurate *is* the quality control.

---

## Commands

```bash
npm run dev            # Dev server (Turbopack)
npm run build          # Production build (standalone output)
npm run start          # Production server

npm run verify         # typecheck + lint + test — run this before pushing
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
npm run lint:fix       # eslint --fix
npm run format         # prettier --write
npm test               # vitest, run once
npm run test:watch     # vitest watch
npm run test:coverage  # vitest with coverage

npm run db:generate    # prisma generate
npm run db:push        # push schema (dev)
npm run db:migrate     # create + apply a migration
npm run db:studio      # Prisma Studio
npm run db:seed        # seed local user + defaults

npm run agent          # CLI agent
npm run mcp            # MCP server (stdio)
npm run auth:hash      # generate AUTH_PASSWORD_HASH
```

---

## Deployment

### Docker Compose (recommended)

```bash
cp .env.example .env      # set AUTH_SECRET, POSTGRES_PASSWORD, AI keys
docker compose up --build
```

Postgres and the app both bind to `127.0.0.1` only. Your `config/resume.json` is mounted read-only into the container.

For GPU-accelerated local inference:

```bash
docker compose --profile gpu up
docker compose exec ollama ollama pull qwen2.5:7b
```

(Requires the NVIDIA Container Toolkit. Set `OLLAMA_BASE_URL=http://ollama:11434/v1` and `AI_PROVIDER=ollama`.)

### Manual

```bash
npm ci
npm run build
npm run start
```

The build emits a standalone server at `.next/standalone/server.js`.

> **Do not expose this app directly to the internet.** It drives a real browser, reads your email, and holds your ATS credentials. Run it on localhost or behind a VPN with an authenticating reverse proxy. See [SECURITY.md](SECURITY.md).

---

## Project Structure

```
Auto-Apply-AI/
├── config/              # Résumé facts (resume.json — gitignored; .example.json committed)
├── data/                # Company catalog + seed lists
├── docs/                # Architecture, function reference, multi-user spec
├── extension/           # Chrome extension: read-only field inspector
├── prisma/              # Schema, migrations, seed
├── public/              # Static assets
├── scripts/             # CLI agent, MCP server, password hasher, dev utilities
├── src/
│   ├── app/             # Next.js App Router — pages + API routes
│   ├── components/      # Dashboard UI + Radix-based primitives
│   ├── lib/
│   │   ├── ai/          # Claude / OpenAI / Ollama providers + ATS analyzer
│   │   ├── ats-screen/  # Closed-loop employer-side screening
│   │   ├── auth/        # Session JWT + login rate limiting
│   │   ├── automation/  # Apply engine, field classifier, LaTeX compiler
│   │   ├── db/          # Prisma client singleton
│   │   ├── gmail/       # OAuth client, OTP extraction, inbox sync
│   │   ├── matching/    # Fast filter, keywords, visa detection
│   │   ├── profile/     # Profile store, résumé config, dropdown intelligence
│   │   ├── scraping/    # Per-source scrapers, registry, HTTP client, SSRF guard
│   │   ├── security/    # AES-256-GCM credential encryption
│   │   ├── storage/     # File manager + answer memory
│   │   └── tailoring/   # FactBook, selection, composition, validation, rendering
│   └── middleware.ts    # Route protection
└── test/                # Vitest suites + HTML fixtures
```

Full module-by-module detail: **[docs/architecture.md](docs/architecture.md)**.

---

## Troubleshooting

<details>
<summary><b>The app won't start: "AUTH_SECRET must be set…"</b></summary>

By design — there is no fallback secret, because a hardcoded default in a public repo would let anyone forge a session cookie. Generate one:

```bash
openssl rand -base64 48
```

and set it as `AUTH_SECRET` in `.env`.
</details>

<details>
<summary><b>My generated résumé shows someone else's details</b></summary>

You're running on the committed placeholder. Copy the template and fill in your own facts:

```bash
cp config/resume.example.json config/resume.json
```
</details>

<details>
<summary><b>Autofill leaves fields blank on Workday / iCIMS / embedded Greenhouse</b></summary>

The engine scans every frame (`page.frames()`) and open shadow roots, so this is usually resolved. Check `Application.fieldDecisions` (persisted at each checkpoint): each record shows the field's frame, `labelConfidence`, decision path (`profile` / `memory` / `AI`), and why it paused.
</details>

<details>
<summary><b>A field paused that I expected to be filled</b></summary>

Sensitive categories (visa, EEO, veteran, disability, salary) are **never guessed**. Set them in **Settings → Profile** (locked) so they autofill. Ambiguous non-sensitive dropdowns use a fallback ladder; a remaining pause means no safe option matched.
</details>

<details>
<summary><b>A scraper source returns nothing</b></summary>

ATS boards are company-scoped — set **preferred companies** in Settings. Defaults are curated but can go stale; bad tokens 404 and are skipped. For feeds, check the logs for `429`/`403` backoff. `GET /api/jobs/scrape` shows which sources are live.
</details>

<details>
<summary><b>"Add job by URL" found no job</b></summary>

The page had no JSON-LD/microdata and wasn't clearly a posting. Try the board URL rather than a wrapper page, or add it as a **custom site** and use the selector picker.

If the URL was *rejected* rather than empty, the SSRF guard blocked it — private, loopback, and cloud-metadata addresses are not fetchable by design.
</details>

<details>
<summary><b>Rate-limited or IP blocked</b></summary>

Increase `SCRAPER_DOMAIN_GAP_MS`. The generic scraper obeys `robots.txt`; disallowed URLs are logged and skipped.
</details>

<details>
<summary><b>Locked out after failed logins</b></summary>

Five failures in 15 minutes triggers a 15-minute lockout. The limiter is in-memory, so restarting the server clears it.
</details>

<details>
<summary><b>PDF compilation fails</b></summary>

Install [Tectonic](https://tectonic-typesetting.github.io/) and either put it on your `PATH`, drop it in `~/.job-agent-tools/`, or set `TECTONIC_PATH`. The first run downloads a LaTeX package bundle; after that it's offline and takes ~3s.
</details>

---

## FAQ

**Is this multi-user?**
No. `userId` is hardcoded to `"local"` and there is no per-user data isolation. A design sketch for multi-tenancy lives in [docs/multi-user-spec.md](docs/multi-user-spec.md).

**Can it invent experience I don't have?**
No. That is the core design constraint. The model may only select from the FactBook built out of `config/resume.json`, and validation gates reject output referencing anything outside it.

**Does it submit applications without me?**
Only if you set `AUTOMATION_AUTO_APPLY=true`. The default is human-in-the-loop: the engine prepares everything and pauses for your approval. When it cannot complete a form safely it hands over to you rather than faking a submission.

**Do I need an API key?**
No — set `AI_PROVIDER=ollama` and run a local model. Quality varies with the model you choose.

**What does it do with my Gmail?**
Read-only (`gmail.readonly` scope). It extracts OTP/verification codes during an apply run and classifies status emails. The refresh token is encrypted at rest and never logged.

**Is scraping these sites allowed?**
The generic scraper honours `robots.txt` and rate-limits per domain. You are responsible for complying with the terms of service of any site you point it at.

**Why LaTeX?**
Deterministic one-page output. The renderer reproduces a hand-tuned layout exactly, and page-count is verified after compile — a tailored résumé that overflows falls back to the canonical version.

---

## Roadmap

- [ ] Content-Security-Policy with per-request nonces
- [ ] CSRF tokens on state-changing routes
- [ ] Persisted run state so automation survives a restart (currently in-memory singletons)
- [ ] Job queue to replace the in-process engine, enabling multiple replicas
- [ ] Multi-user support ([spec](docs/multi-user-spec.md))
- [ ] Screenshots and a short demo recording
- [ ] Integration tests for the apply engine against recorded ATS fixtures
- [ ] Coverage reporting in CI
- [ ] Structured JSON logging with redaction
- [ ] More ATS adapters (Taleo, SuccessFactors, Jobvite)

---

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) — it covers setup, the commit convention, code style, and how to add a new job source.

Before pushing:

```bash
npm run verify
```

Please **never commit real personal data** — no names, phone numbers, addresses, or account handles in source, tests, or fixtures.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

---

## Security

Found a vulnerability? **Do not open a public issue.** Follow the process in [SECURITY.md](SECURITY.md), which also documents the threat model, how secrets are handled, and known gaps.

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

---

## License

[MIT](LICENSE) © Taksh Patel
