# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `config/resume.json` as the single source of truth for résumé facts, with a
  committed `config/resume.example.json` template and a validated loader
  (`src/lib/profile/resume-config.ts`). Personal data no longer lives in source.
- Login rate limiting: 5 attempts per 15 minutes, then a 15-minute lockout
  (`src/lib/auth/rate-limit.ts`).
- `AUTH_PASSWORD_HASH` support — store a bcrypt hash instead of a plaintext
  password. Generate one with `npm run auth:hash`.
- SSRF guard for user-supplied scrape URLs: protocol allow-list, DNS resolution,
  and rejection of private, loopback, link-local and cloud-metadata addresses
  (`src/lib/scraping/url-guard.ts`).
- Security headers: `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, `Permissions-Policy`; `poweredByHeader` disabled.
- GitHub Actions CI: typecheck, lint, test, build, dependency audit, and a
  Docker image build on `main`.
- Dependabot configuration with grouped updates for npm, Actions, and Docker.
- Community health files: `LICENSE` (MIT), `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue templates, and a PR template.
- Tooling configuration: ESLint 9 flat config, Prettier, `.editorconfig`,
  `.nvmrc`, `.dockerignore`.
- New npm scripts: `typecheck`, `verify`, `format`, `format:check`, `lint:fix`,
  `test:coverage`, `auth:hash`.
- Tests for the SSRF guard and the login rate limiter (37 new assertions).
- Docker healthcheck.

### Changed

- **BREAKING (configuration):** `AUTH_SECRET` is now required and must be at
  least 32 characters. The previous hardcoded fallback allowed anyone to forge a
  session cookie when the variable was unset.
- **BREAKING (configuration):** Résumé content moved out of
  `src/lib/automation/resume-template.ts` into `config/resume.json`. Copy
  `config/resume.example.json` and fill it in; without it the app runs on
  placeholder data.
- Login now compares passwords in constant time instead of with `===`.
- Session verification pins the JWT algorithm to HS256.
- `next.config.ts` emits `output: "standalone"` — the Dockerfile already copied
  `.next/standalone`, so the production image could not previously be built.
- Dockerfile no longer downloads Playwright browsers during the build (the
  runtime uses system Chromium), cutting several hundred MB and minutes of build
  time. Modernised `ENV` syntax and added a healthcheck.
- `docker-compose.yml` no longer ships a default Postgres password; all secrets
  come from the environment and services bind to `127.0.0.1`.
- README split into a focused landing page plus `docs/architecture.md` and
  `docs/function-reference.md`.
- Linting migrated from the deprecated `next lint` to the ESLint CLI with
  ESLint 9 flat config.
- `.gitignore` now covers `config/resume.json`, `.claude/settings.local.json`,
  key material, and coverage output.
- Tailoring test fixtures derive employer and achievement IDs from the FactBook
  instead of hardcoding one person's employers.

### Fixed

- `TAILOR_EFFORT` was defined to fix LaTeX-generation request timeouts but never
  passed to the API call; it is now wired up as documented.
- `hostOf(url)` result was computed but unused in `politeGet`, while
  `politeRequest` throttled on an out-of-scope variable.
- GitHub username is validated before reaching the API client.
- Unhandled promise rejection in the background multi-URL scrape path.

### Removed

- 17 unused dependencies: `socket.io`, `socket.io-client`, `winston`, `multer`,
  `@types/multer`, `iron-session`, `date-fns`, and 11 unused Radix packages.
  This eliminated the `ws` denial-of-service advisories entirely.
- Hardcoded personal data: name, email, phone, address, LinkedIn and GitHub
  handles, employers, projects, and education.
- Dead code: unused `DEGREE_RANK` constant, unused `fileName` binding, unused
  route handler parameters, and a stale `eslint-disable` directive.
- `.claude/settings.local.json` from version control (machine-specific paths).

### Security

- Removed the hardcoded `AUTH_SECRET` fallback that allowed session forgery.
- Upgraded `next`, `axios`, `adm-zip`, and `postcss`; removed dependencies
  carrying the high-severity `ws` advisories.
- Added npm `overrides` pinning patched transitive dependencies
  (`brace-expansion`, `sharp`, `dompurify`, `postcss`) whose parents had not yet
  released a fix. Runtime dependency advisories went from 17 (14 high) to
  2 moderate, and `npm audit --omit=dev --audit-level=high` now passes in CI.
  The remaining two are `uuid <11.1.1` inside `exceljs`, whose only "fix" is a
  major downgrade of `exceljs`; the flaw needs a caller-supplied `buf` argument
  to `v3`/`v5`/`v6`, which this codebase never does.
- Documented the threat model and known gaps in `SECURITY.md`.

> **Note for forks:** commits before this release still contain the original
> author's personal details in git history. A truly clean public history requires
> squashing or rewriting.

## [1.0.0] — 2026-05-26

### Added

- Initial implementation: job scraping across 13+ sources, résumé matching and
  scoring, FactBook-based truthful tailoring, LaTeX/PDF compilation, the
  Playwright apply engine with field classification and answer memory, the
  closed-loop ATS screening pipeline, Gmail OTP and status sync, the live
  dashboard, and Excel export.

[Unreleased]: https://github.com/TakshPatel5821/Auto-Apply-AI/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/TakshPatel5821/Auto-Apply-AI/releases/tag/v1.0.0
