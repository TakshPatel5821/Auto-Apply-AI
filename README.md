# AI Job Application Agent

A fully automated, private AI-powered job application system that scrapes jobs, tailors resumes, generates cover letters, and applies to positions automatically.

## Features

- **AI Resume Parsing** — Upload PDF, DOCX, TEX, or Overleaf ZIP exports
- **Multi-Platform Job Scraping** — LinkedIn, Indeed, Greenhouse, Lever, and more
- **AI Job Matching** — Scored 1–10 with ATS compatibility analysis
- **AI Resume Tailoring** — Optimizes keywords and bullet points per job, never fabricates
- **Cover Letter Generation** — Personalized letters for each position
- **Overleaf Integration** — Compiles LaTeX resumes to PDF automatically
- **Auto-Apply Engine** — Fills forms, answers questions, uploads files
- **Application Memory** — Remembers answers to repeated screening questions
- **Excel/CSV Export** — Spreadsheet with all job data and file paths
- **Single-User Dashboard** — Private, localhost-first web interface

## Quick Start

### 1. Prerequisites

- Node.js 20+
- PostgreSQL 14+
- Playwright (installed automatically)

### 2. Clone and Install

```bash
git clone <repo>
cd ai-job-agent
npm install
npx playwright install chromium
```

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and set:

```env
AUTH_PASSWORD=your_secure_password
AUTH_SECRET=minimum_32_character_random_string
DATABASE_URL=postgresql://postgres:password@localhost:5432/job_agent
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...          # optional, Claude is primary
LINKEDIN_COOKIE=li_at_...      # optional but recommended
OVERLEAF_EMAIL=you@email.com   # optional for PDF compilation
OVERLEAF_PASSWORD=yourpass
JOB_SEARCH_KEYWORDS=Software Engineer,Frontend Engineer
JOB_SEARCH_LOCATIONS=Remote,New York
```

### 4. Database Setup

```bash
npx prisma migrate dev --name init
npx prisma db seed
```

### 5. Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and enter your AUTH_PASSWORD.

---

## Docker (Recommended)

```bash
cp .env.example .env
# Edit .env with your API keys

docker-compose up -d
```

This starts:
- PostgreSQL on port 5432
- App on port 3000

---

## Getting Your LinkedIn Cookie

1. Log into LinkedIn in Chrome
2. Open DevTools → Application → Cookies → linkedin.com
3. Copy the value of `li_at`
4. Paste into `LINKEDIN_COOKIE` in `.env`

This allows scraping without a username/password login.

---

## Application Flow

```
1. Upload Resume (PDF/DOCX/TEX/ZIP)
      ↓
2. AI Parses Resume → Extracts skills, experience, tech stack
      ↓
3. Scrape Jobs (LinkedIn, Indeed, etc.)
      ↓
4. AI Scores Each Job (1-10 match score)
      ↓
5. AI Tailors Resume for Top Matches
      ↓  (optional Overleaf PDF compilation)
6. AI Generates Cover Letter
      ↓
7. Auto-Apply Engine fills forms & submits
      ↓
8. Memory System saves answered questions
      ↓
9. Excel export with all data
```

---

## Dashboard Sections

| Tab | Description |
|-----|-------------|
| **Jobs** | All scraped jobs with match scores, filter/sort, tailor/apply buttons |
| **Applications** | Submitted applications with status tracking |
| **Resume** | Uploaded resumes and parsed skills |
| **Memory** | Saved application Q&A answers |
| **Settings** | Search keywords, locations, auto-apply toggle |

**Automation Controls (sidebar):**
- `Manual Mode` — Tailors resumes, you review and approve each application
- `Full Auto Mode` — Scrapes, tailors, and applies automatically

---

## File Organization

All generated files are stored in:

```
applications/
  CompanyName_RoleName_YYYYMMDD/
    tailored_resume.tex
    tailored_resume.pdf     (if Overleaf configured)
    cover_letter.tex
    cover_letter.pdf
    job_description.txt
    metadata.json
    screenshot_*.png

  resumes/
    resume_<uuid>.pdf
```

---

## Scoring System

| Score | Meaning |
|-------|---------|
| 1–3 | Excellent match — apply immediately |
| 4–5 | Good match — worth applying |
| 6–7 | Fair match — optional |
| 8–10 | Weak match — skip |

---

## AI Resume Rules

The AI **will**:
- Rewrite bullet points to highlight relevant skills
- Reorder and emphasize matching experience
- Add job-specific ATS keywords organically
- Optimize for one-page format with no empty space

The AI **will not**:
- Fabricate any experience, skills, or companies
- Invent projects or achievements
- Lie about education or certifications

---

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `AUTH_PASSWORD` | Yes | Dashboard login password |
| `AUTH_SECRET` | Yes | JWT signing secret (32+ chars) |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `ANTHROPIC_API_KEY` | Yes | Claude API key |
| `OPENAI_API_KEY` | No | OpenAI fallback |
| `LINKEDIN_COOKIE` | Recommended | li_at cookie for scraping |
| `OVERLEAF_EMAIL` | Optional | For PDF compilation |
| `OVERLEAF_PASSWORD` | Optional | For PDF compilation |
| `JOB_SEARCH_KEYWORDS` | Optional | Comma-separated (default: Software Engineer) |
| `JOB_SEARCH_LOCATIONS` | Optional | Comma-separated (default: Remote) |
| `BLACKLIST_COMPANIES` | Optional | Companies to skip |
| `AUTOMATION_MAX_APPLICATIONS_PER_DAY` | Optional | Safety limit (default: 30) |

---

## Development Commands

```bash
npm run dev          # Start development server
npm run build        # Production build
npm run db:studio    # Open Prisma Studio (DB viewer)
npm run db:seed      # Seed common application answers
npm run db:migrate   # Run database migrations
```

---

## Notes

- **Rate Limiting** — Built-in random delays between requests (2–8 seconds)
- **Anti-Detection** — Browser fingerprinting protection, realistic user agents
- **Daily Limits** — Configurable max applications per day
- **Blacklist** — Skip specific companies via BLACKLIST_COMPANIES env var
- **Spam Detection** — Auto-filters MLM/pyramid scheme postings
- **Duplicate Detection** — Tracks platform job IDs to avoid re-scraping
