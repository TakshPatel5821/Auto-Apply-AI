# Job Application Automation Tool

**Automated job scraping, resume tailoring, CV generation, and application submission** — a full-stack Next.js + Playwright + Claude AI pipeline for intelligent job hunting.

## Overview

This tool automates the entire job application workflow:

1. **Scrape** job listings from LinkedIn, Indeed, Glassdoor, and custom sites
2. **Analyze** each job against your resume using Claude AI
3. **Tailor** your resume and generate a cover letter for each job
4. **Generate** a single-page PDF CV via local LaTeX compilation
5. **Apply** intelligently on LinkedIn (Easy Apply + external forms) and other platforms

**Key Innovation:** Resume tailoring uses a **fixed, hand-tuned LaTeX template** with only the Professional Summary AI-generated per job — guarantees 1-page output and 100% compilable PDFs.

---

## Quick Start

### Prerequisites

- **Node.js** 18+
- **PostgreSQL** (local or cloud)
- **Ollama** (for local GPU-accelerated AI) OR **AWS Bedrock** (cloud)
- **Git**

### 1. Install & Setup

```bash
git clone <repo-url>
cd Application-automation-tool
npm install

# For Ollama (local AI)
ollama pull qwen2.5:3b
```

### 2. Configure `.env`

```bash
# AI Provider
AI_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434/v1
OLLAMA_MODEL=qwen2.5:3b

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/job_agent

# Application limits
AUTOMATION_MAX_JOBS=20
AUTOMATION_AUTO_APPLY=false
```

### 3. Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Architecture

### Tech Stack

- **Frontend**: Next.js 15, React 19, TailwindCSS
- **Backend**: TypeScript, Next.js API routes
- **Database**: PostgreSQL + Prisma
- **AI**: Claude (Ollama or AWS Bedrock)
- **Automation**: Playwright
- **PDF**: Tectonic (local LaTeX compiler)

### Key Features

✅ **Multi-platform scraping** (LinkedIn, Indeed, Glassdoor)  
✅ **AI-powered tailoring** (summary + cover letter per job)  
✅ **Local PDF compilation** (~2.5s/job)  
✅ **LinkedIn Easy Apply** (auto-submit)  
✅ **External form filling** (Workday, Greenhouse, custom ATSs)  
✅ **Memory system** (save Q&A answers, reuse across jobs)  
✅ **Resume diff viewer** (see changes per job)  
✅ **Excel export** (job tracker)  
✅ **Manual review mode** (pause before applying)  
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

## AI Provider Setup

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

**Best for:** Speed (~5s/job), better quality, cheap (~$1 per 100 jobs).

```bash
# AWS Console: Bedrock → Model access → Enable Claude Haiku 4.5

# In .env
AI_PROVIDER=bedrock
AWS_REGION=us-east-1
AWS_BEARER_TOKEN_BEDROCK=ABSK...your-key...
```

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

## Troubleshooting

### "No Apply button found"

**Fix:** Manually log into LinkedIn in `~/.job-agent-profiles/linkedin`, stay logged in. The profile is persistent.

### Slow tailoring (>60s)

**Fix:** Switch to `qwen2.5:3b` (fits in 4GB VRAM) or use Bedrock.

### PDF won't compile

**Fix:** Ensure Tectonic is at `~/.job-agent-tools/tectonic.exe`. Check logs for LaTeX errors.

### Database migration fails

**Fix:**
```bash
npx prisma migrate reset   # Resets DB (loses data)
npx prisma migrate deploy  # For production
```

---

## Performance & Costs

| Task | Ollama (Local) | Bedrock (AWS) |
|---|---|---|
| Analyze + Tailor (1 job) | 25–30s | 5–10s |
| Cost (10 jobs) | $0.10–$0.20 (power) | ~$0.10 |
| **Total (10 jobs)** | ~4–5 min | ~2–3 min |

---

## Project Structure

```
src/
├── app/                      # Next.js App Router
│   ├── (dashboard)/          # UI pages
│   └── api/                  # REST endpoints
├── lib/
│   ├── ai/                   # Claude, Ollama, Bedrock
│   ├── automation/           # Tailoring, PDF, apply
│   ├── scraping/             # Job scrapers
│   └── db/                   # Prisma ORM
└── prisma/
    ├── schema.prisma         # Data model
    └── migrations/           # DB changes
```

---

## Key Design Decisions

### 1. Template-Based Resumes

Why: Reliable, cheaper, always 1 page. Tested in Overleaf.

Trade-off: Less variety per job. Offset by cover letter + AI summary.

### 2. Local LaTeX (Tectonic)

Why: Fast (~2.5s), offline, no browser automation.

Trade-off: Requires binary install. Simple: `ollama pull qwen2.5:3b`-style.

### 3. Ollama by Default

Why: Privacy, no API costs, GPU-accelerated.

Trade-off: Requires local GPU. CPU-only is slow.

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
A: Check screenshots (in job folder) and logs. Most: form structure changed, required field we can't fill, or not logged in.

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
