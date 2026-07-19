import { prisma } from "@/lib/db/prisma";
import { claudeCompleteJSON } from "@/lib/ai/claude";
import type { JobAnalysis } from "../types";

// Analysis is pure with respect to the job — cache by jobId so retries (e.g. a
// selectFacts re-run) never re-pay for it.
const analysisCache = new Map<string, JobAnalysis>();

const SYSTEM =
  "You are a JD parser. You read a job description and return a JSON object exactly " +
  "matching the schema. You do not write prose. You do not invent fields. If a field " +
  "is not in the JD, leave it empty or 0.";

// Title tokens that flag a senior-level posting. The senior gate is a senior-
// *title* gate, so seniority is derived deterministically from the title only —
// a small model happily dumps body words ("lead", or even "junior") into
// seniorityFlags, which would falsely trip the gate.
const SENIORITY_TOKENS = [
  "senior", "sr", "lead", "staff", "principal", "director",
  "architect", "vp", "head of", "chief",
];

function asStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.map((v) => String(v).trim()).filter(Boolean);
}

const LEVELS = ["intern", "entry", "mid", "senior"] as const;
function asLevel(val: unknown): JobAnalysis["experienceLevel"] {
  const s = String(val || "").toLowerCase().trim();
  return (LEVELS as readonly string[]).includes(s) ? (s as JobAnalysis["experienceLevel"]) : "mid";
}

function asInt(val: unknown): number {
  const n = typeof val === "number" ? val : parseInt(String(val), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// Deterministic seniority detection from the title (word-boundary, so "lead"
// does not match "leadership" and "sr" does not match inside another word).
function titleSeniorityFlags(jobTitle: string): string[] {
  const t = jobTitle.toLowerCase();
  const flags = new Set<string>();
  for (const tok of SENIORITY_TOKENS) {
    const re = new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(t)) flags.add(tok);
  }
  return [...flags];
}

function buildUserPrompt(companyName: string, jobTitle: string, jobDescription: string): string {
  return `<job>
<company>${companyName}</company>
<title>${jobTitle}</title>
<description>
${jobDescription}
</description>
</job>

Return ONE JSON object:

{
  "requiredSkills": ["string", ...],     // mandatory technologies/skills, normalized lowercase
  "niceToHaveSkills": ["string", ...],
  "requiredYears": 0,                     // integer; 0 if not stated
  "experienceLevel": "intern|entry|mid|senior",
  "atsKeywords": ["string", ...],         // 10–20 high-signal terms, exact casing from JD
  "domainTags": ["string", ...],          // e.g. "healthcare", "aerospace", "fintech", "automotive"
  "seniorityFlags": ["string", ...]       // ["senior"] if title contains senior/sr/lead/staff/principal/director/architect/vp/head/chief
}`;
}

export async function analyzeJob(jobId: string): Promise<JobAnalysis> {
  const cached = analysisCache.get(jobId);
  if (cached) return cached;

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new Error(`analyzeJob: job ${jobId} not found`);

  // ONE LLM call. claudeCompleteJSON parses strictly and throws on parse failure
  // — we intentionally do not retry silently.
  const raw = (await claudeCompleteJSON<Record<string, unknown>>(
    buildUserPrompt(job.companyName, job.jobTitle, job.description),
    SYSTEM,
    700
  )) as Record<string, unknown>;

  // Seniority is title-derived only (the LLM's body-level guesses are noisy).
  const seniorityFlags = titleSeniorityFlags(job.jobTitle);

  const analysis: JobAnalysis = {
    jobId,
    companyName: job.companyName,
    jobTitle: job.jobTitle,
    jobDescription: job.description,
    requiredSkills: asStringArray(raw.requiredSkills),
    niceToHaveSkills: asStringArray(raw.niceToHaveSkills),
    requiredYears: asInt(raw.requiredYears),
    experienceLevel: asLevel(raw.experienceLevel),
    atsKeywords: asStringArray(raw.atsKeywords),
    domainTags: asStringArray(raw.domainTags),
    seniorityFlags,
  };

  analysisCache.set(jobId, analysis);
  return analysis;
}
