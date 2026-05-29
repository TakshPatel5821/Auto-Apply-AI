# AI Job Application Automation Tool

This project is a private, local-first job application automation dashboard. It helps a single user upload a resume, scrape job listings, score each job against the resume, generate tailored resume and cover letter files, track applications, and optionally submit applications through a browser automation flow.

The app is built with Next.js, TypeScript, Prisma, PostgreSQL, Playwright, Tailwind CSS, and AI providers such as Anthropic Claude, OpenAI, and Ollama.

## What This Program Does

The main goal of the program is to automate repetitive job search work while keeping the user in control.

It can:

- Upload and parse resumes from PDF, DOC, DOCX, TEX, TXT, and ZIP sources.
- Extract resume skills, technologies, contact details, experience, education, and ATS keywords.
- Scrape jobs from LinkedIn, Indeed, and custom configured job sites.
- Filter jobs quickly before spending AI tokens.
- Score jobs against the active resume.
- Generate a tailored LaTeX resume for each matching job.
- Generate a cover letter for each matching job.
- Compile tailored LaTeX resumes through Overleaf unless disabled.
- Create application folders with resume, cover letter, job description, metadata, and screenshots.
- Track jobs, applications, logs, settings, saved answers, and resumes in PostgreSQL.
- Export job and application data to Excel.
- Fill application forms through Playwright in manual or auto mode.
- Save answers to repeated application questions so future applications can reuse them.

## High-Level Workflow

```text
1. User logs in to the dashboard.
2. User uploads a resume.
3. The app saves the resume file locally.
4. The app extracts resume text.
5. A quick local parser extracts basic skills/contact data immediately.
6. Claude runs a deeper resume parse in the background.
7. User starts scraping or full automation.
8. LinkedIn, Indeed, and custom site scrapers collect jobs.
9. Each job is checked for duplicates, spam, blacklist rules, and skill match.
10. Fit jobs are saved and streamed into the automation queue.
11. Claude scores each fit job against the active resume.
12. Claude tailors the resume and writes a cover letter.
13. Files are saved under applications/.
14. Overleaf can compile the resume PDF in the background.
15. Manual mode leaves applications pending for review.
16. Auto mode uses Playwright to open forms, fill fields, upload the resume, and submit.
17. Logs, dashboard stats, memory answers, and Excel trackers are updated.
```

## Tech Stack

- **Next.js 15**: Web app, dashboard pages, and API routes.
- **React 19**: Dashboard components.
- **TypeScript**: Main application language.
- **Prisma**: Database schema and database client.
- **PostgreSQL**: Persistent storage.
- **Playwright**: Browser automation for scraping and applying.
- **Anthropic Claude**: Resume parsing, job matching, resume tailoring, cover letters, and form answers.
- **OpenAI**: Optional fallback helper.
- **Ollama**: Optional local completion and embedding support.
- **ExcelJS**: Excel export.
- **Tailwind CSS**: Styling.

## Project Structure

```text
.
├── applications/                 # Generated resumes, cover letters, metadata, screenshots, Excel tracker
├── prisma/
│   ├── schema.prisma             # Database models
│   ├── seed.ts                   # Seeds local user/settings/memory data
│   └── migrations/               # Prisma migrations
├── src/
│   ├── app/                      # Next.js pages and API routes
│   ├── components/               # Dashboard and UI components
│   ├── lib/                      # Core backend logic
│   │   ├── ai/                   # Claude, OpenAI, Ollama helpers
│   │   ├── auth/                 # Login session helpers
│   │   ├── automation/           # Automation engine, apply engine, Overleaf, resume tailoring
│   │   ├── db/                   # Prisma client
│   │   ├── export/               # Excel exports
│   │   ├── logging/              # Database logger
│   │   ├── matching/             # Fast local job filter
│   │   ├── queue/                # Generic in-memory job queue
│   │   ├── resume/               # Resume text extraction and parsing
│   │   ├── scraping/             # LinkedIn, Indeed, custom scraper, orchestrator
│   │   └── storage/              # File saving and answer memory
│   ├── middleware.ts             # Route protection
│   └── types/                    # Shared TypeScript interfaces
├── Dockerfile
├── docker-compose.yml
├── package.json
└── README.md
```

## Setup

### Requirements

- Node.js 20 or newer
- PostgreSQL 14 or newer
- npm
- Playwright browser dependencies

### Install

```bash
git clone https://github.com/TakshPatel5821/ai-job-agent.git
cd ai-job-agent
npm install
npx playwright install chromium
```

### Configure Environment

Copy the example environment file:

```bash
cp .env.example .env
```

Important variables:

```env
AUTH_PASSWORD=your_dashboard_password
AUTH_SECRET=minimum_32_character_random_secret
DATABASE_URL=postgresql://postgres:password@localhost:5432/job_agent

ANTHROPIC_API_KEY=your_claude_key
ANTHROPIC_MODEL=claude-opus-4-8
OPENAI_API_KEY=optional_openai_key

# Optional local fallback: if ANTHROPIC_API_KEY is empty, or AI_PROVIDER=ollama,
# all AI work runs locally through Ollama instead of Claude.
AI_PROVIDER=
OLLAMA_BASE_URL=http://localhost:11434/v1

LINKEDIN_COOKIE=optional_linkedin_li_at_cookie

OVERLEAF_EMAIL=optional_overleaf_email
OVERLEAF_PASSWORD=optional_overleaf_password
SKIP_OVERLEAF=false

JOB_SEARCH_KEYWORDS=Software Engineer,Frontend Engineer
JOB_SEARCH_LOCATIONS=Remote,New York
BLACKLIST_COMPANIES=Company One,Company Two
AUTOMATION_MAX_APPLICATIONS_PER_DAY=20

# Optional: re-enable the slow Ollama semantic pre-filter during analysis.
# Off by default — Claude scores fit jobs directly, which is much faster.
USE_SEMANTIC_FILTER=false
```

Notes:

- `ANTHROPIC_MODEL` defaults to `claude-opus-4-8`. Set `claude-sonnet-4-6` for a cheaper, faster option — the same `effort` and adaptive-thinking behavior applies.
- If `ANTHROPIC_API_KEY` is empty (or `AI_PROVIDER=ollama`), every AI helper falls back to local Ollama models.

### Database

```bash
npm run db:migrate
npm run db:seed
```

### Run Locally

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

## Docker

```bash
docker-compose up -d
```

The Docker setup starts:

- PostgreSQL on port `5432`
- Next.js app on port `3000`

### GPU acceleration (optional, local AI)

The Claude API is the default brain and needs no GPU. If you want to run the
**local Ollama fallback** on a GPU, an opt-in `gpu` profile adds an Ollama
service that reserves the host's NVIDIA GPU:

```bash
docker compose --profile gpu up -d        # starts postgres + app + ollama
docker compose exec ollama ollama pull qwen2.5:7b   # pull a model once
```

Then point the app at it (in `.env`):

```env
AI_PROVIDER=ollama
OLLAMA_BASE_URL=http://ollama:11434/v1
```

Requirements: an NVIDIA GPU plus the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
on the host. Ollama auto-detects and uses the reserved GPU — no extra config.
Running Ollama natively (outside Docker) already uses your GPU automatically;
the profile is only for the containerized setup.

## Available Scripts

```bash
npm run dev          # Start Next.js development server
npm run build        # Build production app
npm run start        # Start production app
npm run lint         # Run Next lint command
npm run db:generate  # Generate Prisma client
npm run db:push      # Push Prisma schema without creating migration
npm run db:migrate   # Run Prisma migrations in development
npm run db:studio    # Open Prisma Studio
npm run db:seed      # Seed database
```

## Dashboard

The dashboard lives in `src/app/dashboard/page.tsx`.

Main visible areas:

- **Stats cards**: totals for jobs, applications, interviews, and match data.
- **Quick setup panel**: helps save common keywords and experience levels.
- **Automation controls**: starts, pauses, resumes, or stops automation, and toggles which job sources (LinkedIn, Indeed) to scrape. The choice is saved to settings and restored on reload.
- **Jobs table**: shows scraped jobs, match score, status, platform, and links.
- **Applications table**: shows generated or submitted applications, with a per-row diff button (base vs tailored résumé).
- **Analytics tab**: Recharts dashboards — applications per day, match-score distribution, jobs by source, and an application status funnel.
- **Resume upload**: uploads a resume and shows parse status.
- **Logs console**: live automation logs streamed over Server-Sent Events (no manual refresh).

The dashboard updates in real time over SSE (`/api/stream`): automation state, stats, and logs push as they happen; the jobs/applications tables refresh automatically when their counts change.
- **Custom sites panel**: manages additional sites to scrape.
- **Memory tab**: stores answers for repeated application questions.
- **Settings tab**: stores search keywords, locations, platforms, limits, and preferences.

## API Routes

All protected API routes call `getSession()` before doing work.

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/auth/login` | `POST` | Checks `AUTH_PASSWORD` and creates a session cookie. |
| `/api/auth/logout` | `POST` | Clears the session cookie. |
| `/api/resume/upload` | `POST` | Saves resume, extracts text, quick-parses it, and starts deep AI parse. |
| `/api/resume/upload` | `GET` | Lists uploaded resumes. |
| `/api/resume/status` | `GET` | Returns parse status for a resume. |
| `/api/jobs/scrape` | `POST` | Starts scraping in the background. |
| `/api/jobs/match` | `POST` | Runs AI matching for jobs against a resume. |
| `/api/jobs/list` | `GET` | Lists jobs for the dashboard. |
| `/api/automation/start` | `POST` | Starts the full automation engine. |
| `/api/automation/status` | `GET` | Returns current engine state, stats, and logs. |
| `/api/automation/status` | `PUT` | Pauses or resumes the automation engine. |
| `/api/automation/stop` | `POST` | Stops the automation engine. |
| `/api/dashboard/stats` | `GET` | Returns dashboard statistics. |
| `/api/settings` | `GET` | Reads user settings. |
| `/api/settings` | `POST` | Creates or updates user settings. |
| `/api/settings/sites` | `GET` | Lists custom sites. |
| `/api/settings/sites` | `POST` | Adds a custom site. |
| `/api/settings/sites` | `PUT` | Updates a custom site. |
| `/api/settings/sites` | `DELETE` | Deletes a custom site. |
| `/api/memory` | `GET` | Lists saved form answers. |
| `/api/memory` | `POST` | Saves a new answer. |
| `/api/memory` | `PUT` | Updates an answer. |
| `/api/memory` | `DELETE` | Deletes an answer. |
| `/api/export` | `GET` | Exports job or application data to Excel. |

## Main Code Flow

### 1. Authentication

Files:

- `src/lib/auth/session.ts`
- `src/middleware.ts`
- `src/app/api/auth/login/route.ts`
- `src/app/api/auth/logout/route.ts`

Important functions:

- `createSession()`: creates a signed session token.
- `verifySession(token)`: verifies a session token.
- `getSession()`: checks the current request cookies.
- `setSessionCookie(token)`: stores the session token.
- `clearSession()`: removes the session cookie.
- `middleware(request)`: redirects unauthenticated users away from protected pages.

### 2. Resume Upload and Parsing

Files:

- `src/app/api/resume/upload/route.ts`
- `src/lib/resume/parser.ts`
- `src/lib/resume/quick-extract.ts`
- `src/lib/ai/claude.ts`

Important functions:

- `saveUploadedResume(buffer, originalName)`: saves the uploaded resume under `applications/resumes/`.
- `extractTextFromFile(filePath)`: chooses the correct extractor by file extension.
- `extractTextFromPDF(filePath)`: extracts text from PDFs using `pdf-parse`.
- `extractTextFromDOCX(filePath)`: extracts text from DOC/DOCX using `mammoth`.
- `extractTextFromTex(filePath)`: strips common LaTeX commands to recover text.
- `extractLatexFromZip(zipPath)`: finds a `.tex` file inside a ZIP export.
- `quickExtract(text)`: uses local pattern matching for fast skills/contact extraction.
- `deepParseInBackground(resumeId, rawText)`: starts full AI parsing without blocking upload response.
- `claudeParseResume(text)`: asks Claude to produce structured resume data.

How it works:

1. The upload API receives a form field named `resume`.
2. The file is written to disk.
3. Text is extracted locally.
4. `quickExtract()` returns immediate partial data.
5. A `Resume` row is created in the database.
6. `deepParseInBackground()` calls Claude and updates the same row later.

### 3. Job Scraping

Files:

- `src/lib/scraping/scraping-orchestrator.ts`
- `src/lib/scraping/base-scraper.ts`
- `src/lib/scraping/linkedin.ts`
- `src/lib/scraping/indeed.ts`
- `src/lib/scraping/custom-scraper.ts`
- `src/lib/scraping/greenhouse.ts`

Important classes and functions:

- `ScrapingOrchestrator.startScraping(config, resumeId, onFitJob)`: coordinates all scraping.
- `ScrapingOrchestrator.analyzeAndScoreJobs(resumeId)`: runs deeper AI scoring for scraped fit jobs.
- `LinkedInScraper.scrapeJobs(...)`: scrapes LinkedIn job results.
- `IndeedScraper.scrapeJobs(...)`: scrapes Indeed job results.
- `CustomScraper.scrapeJobs(site)`: scrapes user-configured custom sites.
- `filterScoreToMatchScore(score)`: converts a 0-100 local filter score to the app's 1-10 score.
- `queueExcelWrite()`: updates `applications/jobs_tracker.xlsx` without overlapping writes.
- `isCompanyBlacklisted(company)`: checks `BLACKLIST_COMPANIES`.
- `isSpamJob(job)`: rejects obvious spam or MLM postings.

How it works:

1. The orchestrator creates a `ScrapingSession`.
2. Each platform scraper emits `ScrapedJob` objects.
3. The orchestrator checks duplicate jobs by platform ID or URL.
4. It runs `fastFilter()` before AI calls.
5. New jobs are saved in the `Job` table.
6. Fit jobs are handed to `onFitJob`, which lets full automation process them immediately.
7. The Excel tracker is refreshed.

### 4. Fast Job Filtering

File:

- `src/lib/matching/fast-filter.ts`

Important function:

- `fastFilter(jobTitle, jobDescription, candidateSkills, candidateTech, searchKeywords, options)`

What it does:

- Rejects spam and MLM-like job descriptions.
- Rejects jobs that do not offer sponsorship when sponsorship is required.
- Rejects very senior or executive roles when they are a poor fit.
- Gives a boost for intern, junior, new grad, and entry-level terms.
- Checks search keyword matches.
- Checks common tech keyword overlap.
- Returns:
  - `score`: 0-100 where higher is better.
  - `skip`: whether to skip the job.
  - `reason`: human-readable explanation.
  - `matchedKeywords`: matched skills and keywords.
  - `missingKeywords`: search terms not found.

The app then converts this to the database `matchScore`, where lower is better:

| Fast score | Match score |
| --- | --- |
| 80-100 | 2 |
| 60-79 | 4 |
| 40-59 | 6 |
| 20-39 | 8 |
| 0-19 | 10 |

### 5. Automation Engine

File:

- `src/lib/automation/automation-engine.ts`

Important class:

- `AutomationEngine`

Important methods:

- `getState()`: returns current automation status for the dashboard.
- `start(config)`: starts the full scrape, analyze, tailor, and optional apply workflow.
- `stop()`: requests stop and marks the engine as not running.
- `pause()`: pauses queue processing.
- `resume()`: resumes queue processing and clears human-wait status.
- `enqueueJob(jobId)`: adds a fit job to the internal queue.
- `runQueue()`: processes queued fit jobs one at a time.
- `waitForQueue()`: waits for all queued jobs to finish.
- `processJob(jobId)`: performs AI analysis, tailoring, application creation, and optional auto-apply.
- `getApplicationsToday()`: enforces daily application limits.
- `saveExcelTracker()`: writes `applications/jobs_tracker.xlsx`.

The automation engine uses a streaming pipeline. That means scraping does not need to finish before tailoring starts. As soon as a scraper finds a fit job, that job is queued for AI analysis and tailoring.

The queue is intentionally serial because Overleaf and browser application flows should not run in parallel.

### 6. AI Matching, Tailoring, and Form Answers

File:

- `src/lib/ai/claude.ts`

Important functions:

- `claudeComplete(prompt, system, tokens)`: plain Claude completion helper.
- `claudeCompleteJSON(prompt, system, tokens)`: Claude helper for JSON output.
- `claudeParseResume(text)`: turns resume text into structured resume data.
- `claudeAnalyzeJob(description)`: analyzes a job description.
- `claudeMatchJobToResume(description, resumeData)`: scores one job against one resume.
- `claudeBatchMatchJobs(jobs, resumeData)`: scores multiple jobs in batches.
- `claudeTailorResume(resumeData, jobDescription, jobTitle, companyName)`: creates tailored resume content.
- `claudeGenerateCoverLetter(resumeData, jobDescription, jobTitle, companyName)`: creates a cover letter.
- `claudeAnswerQuestion(question, resumeData, answeredQuestions)`: answers application form questions.
- `claudeFullTailor(resumeData, originalLatex, jobDescription, jobTitle, companyName)`: combines analysis, resume tailoring, and cover letter generation.
- `claudeGenerateLatexResume(data)`: creates base LaTeX resume content from parsed resume data.

The helpers default to model `claude-opus-4-8` (override with `ANTHROPIC_MODEL`). Cheap calls (parsing, scoring, form answers) run at low `effort` to save tokens, while generation calls (tailoring, cover letters, base LaTeX) run at higher effort and stream the response so long outputs do not hit request timeouts. When no Anthropic key is configured, all of these fall back to local Ollama models.

### 7. Resume Tailoring

File:

- `src/lib/automation/resume-tailor.ts`

Important functions:

- `tailorResumeForJob(resumeId, jobId)`: main tailoring entry point.
- `generateCoverLetterTex(content, company, jobTitle, candidateName)`: wraps cover letter text in a LaTeX letter document.

How `tailorResumeForJob()` works:

1. Loads the selected resume and job from Prisma.
2. Marks the job as `TAILORING`.
3. Gets an existing LaTeX resume or generates a base LaTeX resume through Claude.
4. Calls `claudeFullTailor()` to produce:
   - tailored LaTeX resume
   - cover letter
   - ATS score
   - keywords added
   - sections modified
   - tailoring notes
5. Creates a job-specific folder under `applications/`.
6. Saves:
   - `tailored_resume.tex`
   - `cover_letter.tex`
   - `job_description.txt`
   - `metadata.json`
7. Starts Overleaf PDF compilation in the background unless `SKIP_OVERLEAF=true`.
8. Creates `TailoredResume` and `CoverLetter` database rows.
9. Marks the job as `TAILORED`.

### 8. Overleaf PDF Compilation

File:

- `src/lib/automation/overleaf.ts`

Important functions:

- `compileLatexToPDF(latexContent, outputDir)`: public wrapper for PDF compilation.
- `compileLatexToPDFInner(latexContent, outputDir)`: performs the browser-based Overleaf work.
- `getSavedProjectId()`: reads cached Overleaf project ID.
- `saveProjectId(id)`: saves reusable Overleaf project ID.

The app can use Overleaf to compile generated LaTeX into a PDF. If this is not configured, set:

```env
SKIP_OVERLEAF=true
```

The tailored `.tex` files are still saved even if PDF compilation is skipped.

### 9. Apply Engine

File:

- `src/lib/automation/apply-engine.ts`

Important class:

- `ApplyEngine`

Important methods:

- `applyToJob(applicationId)`: public entry point for submitting one application.
- `init(platform)`: starts a persistent Playwright browser profile.
- `cleanup()`: closes the browser context.
- `applyLinkedIn(application)`: handles LinkedIn application flow.
- `findLinkedInApplyButton()`: detects LinkedIn apply or Easy Apply buttons.
- `runEasyApplyFlow(application, buttonSelector)`: handles LinkedIn Easy Apply modal steps.
- `runExternalApplyFlow(application, buttonSelector)`: handles LinkedIn external apply links.
- `applyExternalSite(application)`: handles non-LinkedIn application URLs.
- `fillExternalForm(application)`: detects and fills generic external application forms.
- `detectFields(scope)`: finds visible inputs, textareas, selects, radio groups, and checkboxes.
- `fillVisibleFields(application, scope)`: fills all detected fields in a page or modal.
- `fillField(field, application)`: chooses an answer source and fills one field.
- `shortcutFromResume(label, resumeData)`: answers obvious contact fields without AI.
- `applyAnswer(field, answer)`: writes an answer into text, select, radio, checkbox, or textarea fields.
- `uploadResumeIfVisible(application)`: uploads the tailored PDF when a file input exists.
- `clickSubmitButton()`: finds common submit buttons.
- `detectSuccessPage()`: checks for success or confirmation text.
- `dismissPopups()`: closes cookie banners, dialogs, and common popups.
- `waitForHumanInput(fieldLabel, fieldSelector, category, platform)`: pauses for the user when the app cannot answer a field safely.
- `takeStepScreenshot(folderPath, label)`: saves screenshots during application steps.

The apply engine uses saved memory first, resume shortcuts second, and Claude third. If it still cannot answer, it pauses and waits for the user to fill the field manually.

### 10. Application Memory

File:

- `src/lib/storage/memory.ts`

Important functions:

- `hashQuestion(question)`: normalizes and hashes a form question.
- `findAnswer(question, platform?)`: finds a saved answer for a repeated question.
- `saveAnswer(question, answer, category, platform?)`: creates or updates a saved answer.
- `getAllMemories(category?)`: lists saved answers.
- `deleteMemory(id)`: deletes a saved answer.
- `updateMemory(id, answerText)`: updates answer text.
- `getOrCreateUser()`: ensures the local user exists.

Memory categories include:

- `GENERAL`
- `VISA_SPONSORSHIP`
- `WORK_AUTHORIZATION`
- `SALARY`
- `EXPERIENCE`
- `RELOCATION`
- `DEMOGRAPHICS`
- `AVAILABILITY`
- `REFERENCES`
- `CUSTOM`

### 11. File Storage

File:

- `src/lib/storage/file-manager.ts`

Important functions:

- `ensureDir(dirPath)`: creates a directory if missing.
- `initStorageDirs()`: creates base app storage directories.
- `getApplicationFolder(companyName, jobTitle, date?)`: creates a safe folder name for one job.
- `saveUploadedResume(buffer, originalName)`: stores uploaded resume files.
- `saveFile(folderPath, fileName, content)`: writes a string or buffer.
- `saveApplicationFiles(folderPath, files)`: writes resume, cover letter, job description, and metadata files.
- `savePDF(folderPath, fileName, pdfBuffer)`: writes a PDF buffer.
- `saveScreenshot(folderPath, screenshot, label?)`: writes a screenshot.
- `getFileSize(filePath)`: returns file size or `0`.
- `fileExists(filePath)`: checks if a file exists.
- `readFile(filePath)`: reads a text file.
- `listApplicationFolders()`: lists generated application folders.
- `getAbsolutePath(relativePath)`: resolves a path from the project root.

Generated files are stored like this:

```text
applications/
├── jobs_tracker.xlsx
├── resumes/
│   └── resume_<uuid>.<ext>
└── Company_Role_YYYYMMDD/
    ├── tailored_resume.tex
    ├── tailored_resume.pdf
    ├── cover_letter.tex
    ├── job_description.txt
    ├── metadata.json
    └── screenshot_*.png
```

### 12. Excel Export

File:

- `src/lib/export/excel.ts`

Important functions:

- `generateJobsExcel()`: builds an Excel workbook containing job data, match data, application status, and file paths.
- `generateApplicationsExcel()`: builds an Excel workbook focused on submitted or generated applications.
- `computeFitLabel(matchScore, status)`: converts score/status into a readable fit label.

The automation and scraping pipelines save `applications/jobs_tracker.xlsx` as work progresses.

### 13. Logging

File:

- `src/lib/logging/logger.ts`

Important class:

- `Logger`

Common methods:

- `Logger.debug(category, message, details?)`
- `Logger.info(category, message, details?)`
- `Logger.warn(category, message, details?)`
- `Logger.error(category, message, details?)`
- `Logger.success(category, message, details?)`

Logs are saved in the `AutomationLog` table and shown in the dashboard.

## Database Models

The database schema is in `prisma/schema.prisma`.

Main models:

- `User`: local user record. This app currently uses the single user ID `local`.
- `UserSettings`: search settings, enabled job sources (`enabledPlatforms`), auto-apply settings, blacklist, preferred tech, and custom sites.
- `Resume`: uploaded resume files and parsed resume data.
- `TailoredResume`: generated LaTeX/PDF resume versions tied to a job.
- `CoverLetter`: generated cover letters tied to a job.
- `Job`: scraped job listings, match score, status, and job metadata.
- `Application`: application record connected to a job, resume, tailored resume, and cover letter.
- `ApplicationMemory`: saved answers for repeated form questions.
- `AutomationLog`: structured logs shown in the dashboard.
- `ScrapingSession`: summary of each scraping run.

Important enums:

- `JobStatus`: `FOUND`, `ANALYZED`, `TAILORING`, `TAILORED`, `APPLYING`, `APPLIED`, `INTERVIEWING`, `OFFERED`, `REJECTED`, `WITHDRAWN`, `SKIPPED`, `FAILED`
- `ApplicationStatus`: `PENDING`, `APPROVED`, `IN_PROGRESS`, `SUBMITTED`, `CONFIRMED`, `FAILED`, `REJECTED`, `INTERVIEW_SCHEDULED`, `OFFER_RECEIVED`, `WITHDRAWN`
- `MemoryCategory`: categories for saved application answers.
- `LogLevel`: `DEBUG`, `INFO`, `WARN`, `ERROR`, `SUCCESS`

## Manual Mode vs Auto Mode

### Manual Mode

Manual mode still scrapes jobs, scores them, tailors resumes, generates cover letters, and creates `Application` records.

The application status is left as:

```text
PENDING
```

This mode is best when you want to review each application before submission.

### Auto Mode

Auto mode does everything manual mode does, then calls:

```ts
ApplyEngine.applyToJob(application.id)
```

The browser opens visibly, fills forms, uploads files when available, and submits if it can complete the flow.

Daily limits are checked with:

```ts
AutomationEngine.getApplicationsToday()
```

## Scoring Meaning

This project uses a lower-is-better `matchScore`.

| Score | Meaning |
| --- | --- |
| 1-3 | Strong fit |
| 4-5 | Good fit |
| 6 | Borderline fit |
| 7-8 | Weak fit |
| 9-10 | Skip or very poor fit |

Fit jobs are generally jobs with:

```text
matchScore <= 6
```

## Custom Sites

Custom sites are stored in `UserSettings.customSites`.

Each site follows the `CustomSite` type:

```ts
interface CustomSite {
  id: string;
  name: string;
  url: string;
  email: string;
  password: string;
  jobsUrl?: string;
  enabled: boolean;
}
```

The dashboard manages them through `/api/settings/sites`.

## Data and Privacy Notes

- Resume files and generated application files are stored locally under `applications/`.
- Database data is stored in your PostgreSQL instance.
- AI parsing and generation send resume and job content to the configured AI provider.
- Browser automation uses persistent local browser profiles under the user's home directory.
- LinkedIn scraping can use `LINKEDIN_COOKIE` instead of a username/password login.

## Common Development Tasks

### Reset and Recreate Database

Use with care because this can delete local data depending on the command you run.

```bash
npm run db:migrate
npm run db:seed
```

### Skip Overleaf During Testing

```env
SKIP_OVERLEAF=true
```

This keeps tailoring fast and saves `.tex` files only.

### Limit Scraping Volume

Use the dashboard controls or pass `maxJobsToScrape` to `/api/automation/start`.

### Export Data

Use the dashboard export action or call `/api/export`.

The generated tracker is also saved here:

```text
applications/jobs_tracker.xlsx
```

## Important Implementation Details

- The automation engine is a singleton exported as `automationEngine`.
- The scraping orchestrator is a singleton exported as `scrapingOrchestrator`.
- The apply engine is exported as `applyEngine`, but the automation engine creates its own `ApplyEngine` instance internally.
- `userId` is usually hardcoded as `local`, so this is a single-user application.
- Scraping and automation calls are started in the background from API routes.
- Fit jobs can be processed while scraping is still running.
- Overleaf PDF compilation is asynchronous; the database is updated when the PDF path becomes available.
- Application memory avoids repeated AI calls for common screening questions.
- If the apply engine cannot answer a form field, it sets `scraperStatus.waitingForUser = true` and waits for the user to resume from the dashboard.

## Safety Notes

Automated job applications can submit real forms on real websites. Use manual mode first, review generated files, and keep daily limits low until the behavior matches what you want.

Some job boards restrict scraping or automation. Make sure your usage follows the terms of the sites you access.
