# Contributing

Thanks for taking the time to contribute. This document covers how to get set up
and what a mergeable change looks like.

## Code of Conduct

This project ships a [Code of Conduct](CODE_OF_CONDUCT.md). By participating you
agree to uphold it.

## Getting Set Up

**Prerequisites**: Node.js 20+, PostgreSQL 14+, and (optionally)
[Tectonic](https://tectonic-typesetting.github.io/) for local PDF compilation.

```bash
git clone https://github.com/TakshPatel5821/Auto-Apply-AI.git
cd Auto-Apply-AI
npm install

cp .env.example .env                          # fill in AUTH_SECRET + DATABASE_URL
cp config/resume.example.json config/resume.json   # your own résumé facts

npm run db:migrate
npm run dev
```

`config/resume.json` is gitignored. **Never commit real personal data** — no
names, phone numbers, addresses, or account handles, in source or in tests. Use
the placeholder style from `config/resume.example.json`.

## Development Workflow

1. Branch from `main`: `git checkout -b feat/short-description`
2. Make your change.
3. Run the full local check — all four must pass:

   ```bash
   npm run typecheck   # tsc --noEmit
   npm run lint        # eslint
   npm test            # vitest
   npm run build       # next build
   ```

4. Commit, push, and open a pull request.

CI runs the same four commands on every PR.

## Commit Messages

[Conventional Commits](https://www.conventionalcommits.org/):

```
feat(scraping): add Ashby board adapter
fix(apply): stop double-submitting Workday forms
docs(readme): document the Gmail OAuth setup
refactor(tailoring): split select-facts into scoring and ordering
test(url-guard): cover IPv6-mapped loopback
chore(deps): bump next to 15.5.22
```

Common scopes: `scraping`, `apply`, `tailoring`, `ats-screen`, `profile`, `gmail`,
`auth`, `ui`, `deps`.

## Code Style

The existing code has a consistent voice — match it rather than introducing a
new one.

- **TypeScript strict mode.** No `any` in new code; no `@ts-ignore` without a
  comment explaining why.
- **Comments explain *why*, not *what*.** The codebase favours a short block
  comment at the top of each module describing its role and the trade-offs
  behind it. Keep that up.
- **Formatting** is enforced by Prettier (`npm run format`) and `.editorconfig`.
- **Errors**: fail loudly on misconfiguration at startup; degrade quietly on a
  single bad job source, so one failing scraper never aborts a whole run.
- **Logging** goes through `Logger` (`src/lib/logging/logger.ts`), not
  `console.*`. Never log credentials, tokens, or full email bodies.

## Adding a Job Source

Scrapers are self-registering. To add one:

1. Create `src/lib/scraping/<source>.ts` extending the shared base scraper.
2. Register it in `src/lib/scraping/registry.ts` with the URL patterns it claims.
3. Add a parser test under `test/` using a saved HTML/JSON fixture — do not hit
   the live site in tests.
4. Respect `politeGet` from `src/lib/scraping/http-client.ts`: it handles
   per-domain rate limiting, backoff, and robots.txt.

## Testing

Tests are [Vitest](https://vitest.dev/) and target the **pure logic** modules —
no database, no network, no browser.

```bash
npm test              # once
npm run test:watch    # watch mode
```

Fixtures must not hardcode résumé-specific IDs; derive them from the FactBook
(see `src/lib/tailoring/__tests__/fixtures.ts`).

Please add tests for: new parsers, new classification rules, and any bug fix
(a regression test that fails before your change).

## Pull Requests

- Keep them focused — one concern per PR.
- Fill in the PR template; explain *why*, not just *what*.
- Update the README or `docs/` when you change behaviour or configuration.
- Add a `CHANGELOG.md` entry under `[Unreleased]`.

## Reporting Bugs

Open an issue with the bug template. Include your OS, Node version, the command
you ran, and the relevant log output — with secrets redacted.

Security issues go through [SECURITY.md](SECURITY.md), **not** the public tracker.
