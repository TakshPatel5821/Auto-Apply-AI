import type Anthropic from "@anthropic-ai/sdk";
import { ollamaCompleteJSON, ollamaComplete } from "./ollama";

// Provider selection. AI_PROVIDER ∈ "ollama" | "bedrock" | "anthropic".
// Falls back to ollama when no usable API key is present (local dev default).
const AI_PROVIDER =
  process.env.AI_PROVIDER ||
  (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== "not-needed"
    ? "anthropic"
    : "ollama");

const USE_OLLAMA = AI_PROVIDER === "ollama";
const USE_BEDROCK = AI_PROVIDER === "bedrock";

// On Bedrock the model IDs carry an "anthropic." prefix and Haiku 4.5 is the
// cheap/fast default; first-party defaults to Opus 4.8.
const MODEL =
  process.env.ANTHROPIC_MODEL ||
  (USE_BEDROCK ? "anthropic.claude-haiku-4-5" : "claude-opus-4-8");

// Effort controls thinking depth + overall token spend (GA on Opus 4.6+/Sonnet 4.6).
// Cheap extraction/scoring runs at "low"; rich generation passes "high".
type Effort = "low" | "medium" | "high";

// `effort` and adaptive thinking exist only on Opus 4.6+/Sonnet 4.6 — they 400 on
// Haiku 4.5 / Sonnet 4.5. Detect the model so the same request code works on both
// (Bedrock Haiku 4.5 → omit them; first-party Opus 4.8 → include them).
const MODEL_SUPPORTS_EFFORT = /opus-4-[678]|sonnet-4-6/.test(MODEL);

// Only attach output_config.effort on models that support it.
function effortConfig(effort: Effort): Record<string, unknown> {
  return MODEL_SUPPORTS_EFFORT ? { output_config: { effort } } : {};
}

// Resume tailoring is a bounded rewrite, not open-ended reasoning. "high" with
// adaptive thinking was running 5-10 min per job and hitting the SDK's 10-min
// request timeout (e.g. Oracle, Guidehouse). "medium" keeps quality strong for
// this task while staying well under the timeout. Set TAILOR_EFFORT=high to
// restore maximum polish. (Ignored on Haiku 4.5, which has no effort param.)
const TAILOR_EFFORT: Effort = (process.env.TAILOR_EFFORT as Effort) || "medium";

let _clientPromise: Promise<Anthropic> | null = null;
async function getClient(): Promise<Anthropic> {
  if (!_clientPromise) {
    _clientPromise = (async () => {
      const { default: AnthropicSDK } = await import("@anthropic-ai/sdk");
      if (USE_BEDROCK) {
        // Claude in Amazon Bedrock (Mantle) endpoint. The standard Anthropic
        // client supports it via baseURL + a bearer token passed as apiKey
        // (sent as the x-api-key header). No SigV4 / @anthropic-ai/bedrock-sdk
        // needed — that path can't use an ABSK bearer token in TypeScript.
        const region = process.env.AWS_REGION || "us-east-1";
        return new AnthropicSDK({
          apiKey: process.env.AWS_BEARER_TOKEN_BEDROCK || process.env.ANTHROPIC_API_KEY,
          baseURL: `https://bedrock-mantle.${region}.api.aws/anthropic`,
        });
      }
      return new AnthropicSDK({ apiKey: process.env.ANTHROPIC_API_KEY });
    })();
  }
  return _clientPromise;
}

function stripJsonFences(text: string): string {
  let t = text.trim();
  t = t.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start !== -1 && end !== -1) t = t.slice(start, end + 1);
  return t;
}

async function ai<T>(prompt: string, system: string, tokens = 1024, effort: Effort = "low"): Promise<T> {
  if (USE_OLLAMA) return ollamaCompleteJSON<T>(prompt, system, tokens);

  const client = await getClient();
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: tokens,
    ...effortConfig(effort),
    system: system + "\n\nRespond with ONLY valid JSON.",
    messages: [{ role: "user", content: prompt }],
  });
  const block = res.content[0];
  if (block.type !== "text") throw new Error("Bad response type");
  return JSON.parse(stripJsonFences(block.text)) as T;
}

// Streaming variant for long generations (full LaTeX résumés, etc.).
// Non-streaming requests hit the SDK's HTTP request timeout on slow/large
// outputs — streaming with .finalMessage() keeps the connection alive.
async function aiLong<T>(prompt: string, system: string, tokens: number, effort: Effort = "high"): Promise<T> {
  if (USE_OLLAMA) return ollamaCompleteJSON<T>(prompt, system, tokens);

  const client = await getClient();
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: tokens,
    ...effortConfig(effort),
    system: system + "\n\nRespond with ONLY valid JSON.",
    messages: [{ role: "user", content: prompt }],
  });
  const msg = await stream.finalMessage();
  const block = msg.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error("Bad response type");
  return JSON.parse(stripJsonFences(block.text)) as T;
}

export async function claudeComplete(prompt: string, system?: string, tokens?: number) {
  if (USE_OLLAMA) return ollamaComplete(prompt, system, tokens);
  const client = await getClient();
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: tokens || 1024,
    system,
    messages: [{ role: "user", content: prompt }],
  });
  const block = res.content[0];
  if (block.type !== "text") throw new Error("Bad response type");
  return block.text;
}

export async function claudeCompleteJSON<T>(prompt: string, system?: string, tokens?: number) {
  return ai<T>(prompt, system || "", tokens);
}

// ─── Resume Parse (sent in background, ~4000 chars max) ──────────────────────
export async function claudeParseResume(text: string) {
  return ai(
    `Extract resume data from this text. Return JSON:
{"name":"","email":"","phone":"","linkedin":"","github":"","summary":"2 sentences","skills":["skill"],"technologies":["tech"],"experience":[{"company":"","title":"","startDate":"","endDate":"","bullets":["achievement"]}],"education":[{"institution":"","degree":"","field":"","endDate":""}],"projects":[{"name":"","description":"","technologies":["tech"]}],"yearsOfExperience":0,"domains":["domain"],"atsKeywords":["kw"]}

RESUME (${text.length} chars):
${text.slice(0, 3500)}`,
    "You are a resume parser. Return valid JSON only.",
    2048
  );
}

// ─── Job Analysis ─────────────────────────────────────────────────────────────
export async function claudeAnalyzeJob(description: string) {
  return ai(
    `Extract from this job description. Return JSON:
{"requiredSkills":["skill"],"niceToHaveSkills":["skill"],"technologies":["tech"],"experienceLevel":"entry|mid|senior","yearsRequired":0,"isRemote":false,"atsKeywords":["kw"]}

JOB (first 1500 chars):
${description.slice(0, 1500)}`,
    "Job analyst. Return JSON only.",
    512
  );
}

// ─── Match Score (single job) ─────────────────────────────────────────────────
export async function claudeMatchJobToResume(
  description: string,
  resumeData: Record<string, unknown>
) {
  const skills = (resumeData.skills as string[] || []).slice(0, 15).join(", ");
  const tech = (resumeData.technologies as string[] || []).slice(0, 15).join(", ");

  return ai(
    `Score resume-job fit (1=perfect, 10=poor). Return JSON:
{"matchScore":5,"atsScore":5,"confidenceLevel":0.8,"requiredSkills":["skill"],"missingSkills":["skill"],"matchingSkills":["skill"],"matchReason":"brief"}

CANDIDATE SKILLS: ${skills}
CANDIDATE TECH: ${tech}
YRS EXP: ${resumeData.yearsOfExperience || 0}

JOB (first 800 chars):
${description.slice(0, 800)}`,
    "ATS scorer. Return JSON only.",
    256
  );
}

// ─── Batch Match (score 5 jobs in one call) ───────────────────────────────────
export async function claudeBatchMatchJobs(
  jobs: { id: string; title: string; company: string; description: string }[],
  resumeData: Record<string, unknown>
) {
  const skills = (resumeData.skills as string[] || []).slice(0, 12).join(", ");
  const tech = (resumeData.technologies as string[] || []).slice(0, 12).join(", ");

  const jobList = jobs
    .map((j, i) => `JOB ${i + 1} [${j.id}] ${j.title} @ ${j.company}:\n${j.description.slice(0, 400)}`)
    .join("\n\n");

  return ai<{ results: { id: string; matchScore: number; atsScore: number; matchingSkills: string[]; missingSkills: string[]; matchReason: string }[] }>(
    `Score each job against this candidate. Return JSON:
{"results":[{"id":"job_id","matchScore":5,"atsScore":5,"matchingSkills":["skill"],"missingSkills":["skill"],"matchReason":"brief"}]}

CANDIDATE: skills=${skills} | tech=${tech} | yrs=${resumeData.yearsOfExperience || 0}

${jobList}`,
    "ATS scorer. Score ALL jobs listed. Return JSON only with results array.",
    512
  );
}

// ─── Resume Tailoring ─────────────────────────────────────────────────────────
export async function claudeTailorResume(
  latex: string,
  description: string,
  resumeData: Record<string, unknown>,
  jobAnalysis: Record<string, unknown>
) {
  const keywords = (jobAnalysis.atsKeywords as string[] || []).slice(0, 8).join(", ");
  const required = (jobAnalysis.requiredSkills as string[] || []).slice(0, 8).join(", ");

  return ai(
    `Tailor this LaTeX resume for the job. Rules: NEVER invent experience. Only rewrite existing content. Add keywords naturally. Keep 1 page.

TARGET KEYWORDS: ${keywords}
REQUIRED SKILLS: ${required}

LATEX (first 2500 chars):
${latex.slice(0, 2500)}

JOB (first 600 chars):
${description.slice(0, 600)}

Return JSON:
{"latexContent":"FULL LATEX CODE","atsScore":7,"keywordsAdded":["kw"],"sectionsModified":["experience"],"tailoringNotes":"what changed"}`,
    "LaTeX resume tailor. Never fabricate. Return JSON only.",
    4096,
    "high"
  );
}

// ─── Cover Letter ─────────────────────────────────────────────────────────────
export async function claudeGenerateCoverLetter(
  description: string,
  company: string,
  title: string,
  resumeData: Record<string, unknown>
) {
  const info = (resumeData as { contactInfo?: Record<string, string> })?.contactInfo || {};
  const skills = (resumeData.skills as string[] || []).slice(0, 6).join(", ");

  return ai(
    `Write a short 3-paragraph cover letter.

CANDIDATE: ${info.name || "Applicant"} | skills: ${skills}
ROLE: ${title} at ${company}
JOB (first 500 chars): ${description.slice(0, 500)}

Return JSON:
{"content":"Dear Hiring Manager,\\n\\nParagraph 1...\\n\\nParagraph 2...\\n\\nSincerely,\\n${info.name || 'Applicant'}","tone":"professional"}`,
    "Cover letter writer. Return JSON only.",
    768,
    "medium"
  );
}

// ─── Answer screening question ────────────────────────────────────────────────
// Valid memory categories — keep in sync with the Prisma MemoryCategory enum.
const VALID_CATEGORIES = [
  "GENERAL",
  "VISA_SPONSORSHIP",
  "WORK_AUTHORIZATION",
  "SALARY",
  "EXPERIENCE",
  "RELOCATION",
  "DEMOGRAPHICS",
  "AVAILABILITY",
  "REFERENCES",
  "CUSTOM",
] as const;

// Coerce whatever the model returns into a valid enum value (defaults GENERAL).
export function normalizeCategory(raw: unknown): string {
  const s = String(raw || "").toUpperCase().trim();
  // Models sometimes echo the whole "A|B|C" list — take the first valid token.
  for (const token of s.split(/[|,/\s]+/)) {
    if ((VALID_CATEGORIES as readonly string[]).includes(token)) return token;
  }
  return "GENERAL";
}

// Phase 6: the open-ended question engine. The apply engine only calls this for
// genuinely open-ended (essay) fields — every deterministic/sensitive field is
// answered from the structured profile, never here. The answer is GROUNDED in
// the candidate's profile + résumé facts + the job description, with hard
// safeguards (no invented experience, no false certifications, no unsolicited
// visa talk) and a respected length limit.
export interface OpenEndedContext {
  // Pre-formatted structured candidate facts (from the Profile Engine).
  profileFacts?: string;
  jobDescription?: string;
  companyName?: string;
  jobTitle?: string;
  // Character limit from the field's maxlength (0/undefined = no hard limit).
  maxLength?: number;
}

export async function claudeAnswerQuestion(
  question: string,
  context: Record<string, unknown>,
  previousAnswers: { question: string; answer: string }[],
  opts: OpenEndedContext = {}
): Promise<{ answer: string; category: string }> {
  const recent = previousAnswers.slice(-3).map((a) => `${a.question}: ${a.answer}`).join(" | ");
  const contact = (context.contactInfo as Record<string, string>) || {};

  // Prefer the structured profile facts; fall back to résumé-derived basics.
  const resumeFacts = [
    contact.name && `Name: ${contact.name}`,
    contact.location && `Location: ${contact.location}`,
    context.yearsOfExperience && `Years of experience: ${context.yearsOfExperience}`,
    Array.isArray(context.skills) && (context.skills as string[]).length
      ? `Skills: ${(context.skills as string[]).slice(0, 15).join(", ")}`
      : "",
    typeof context.summary === "string" && context.summary
      ? `Summary: ${(context.summary as string).slice(0, 400)}`
      : "",
  ].filter(Boolean).join("\n");
  const facts = [opts.profileFacts, resumeFacts].filter(Boolean).join("\n") || "No specific facts available";

  // Effective length budget: honor the field's maxlength, else a sane default.
  const limit = opts.maxLength && opts.maxLength > 0 ? Math.min(opts.maxLength, 1500) : 600;
  const charBudget = Math.max(120, limit - 20); // leave headroom under the cap
  const tokenBudget = Math.min(700, Math.max(96, Math.ceil(charBudget / 3)));

  const role = [opts.jobTitle, opts.companyName].filter(Boolean).join(" at ");
  const jd = (opts.jobDescription || "").replace(/\s+/g, " ").trim().slice(0, 1500);

  const system =
    "You write answers to OPEN-ENDED job-application questions on behalf of a candidate. " +
    "Hard rules you must never break: " +
    "(1) Truthful — use ONLY the candidate facts provided; never invent experience, employers, job titles, metrics, or skills. " +
    "(2) Never claim a certification, degree, clearance, or award that isn't in the facts. " +
    "(3) Never mention visa, sponsorship, immigration, or work authorization unless the question explicitly asks about it. " +
    "(4) Write in the first person, professional and specific to the role/company — no fluff, no clichés, no placeholders. " +
    "(5) Stay within the character limit. (6) Do not repeat the question. " +
    "Output a single JSON object only — never echo the example values.";

  const raw = (await ai(
    `Answer the ONE question below for this candidate.

CANDIDATE FACTS:
${facts}
${role ? `\nROLE: ${role}` : ""}
${jd ? `\nJOB CONTEXT (for relevance only — do not copy verbatim):\n${jd}` : ""}

RECENT ANSWERS (for consistency): ${recent || "None"}

QUESTION TO ANSWER: "${question}"

LENGTH LIMIT: about ${charBudget} characters maximum. Be concise.

Pick the single best category from: GENERAL, VISA_SPONSORSHIP, WORK_AUTHORIZATION, SALARY, EXPERIENCE, RELOCATION, DEMOGRAPHICS, AVAILABILITY, REFERENCES, CUSTOM.

Reply with ONLY a JSON object in this exact shape, replacing the example values with your real answer:
{"answer": "<your actual answer to the question>", "category": "<ONE category word>"}`,
    system,
    tokenBudget
  )) as { answer?: unknown; category?: unknown };

  let answer = String(raw?.answer ?? "").trim();
  // Guard against the model echoing the placeholder/example verbatim.
  if (/^<.*>$/.test(answer) || /your (actual )?answer/i.test(answer) || answer.toLowerCase() === "concise answer") {
    answer = "";
  }
  // Enforce the hard character limit, trimming at a sentence/word boundary.
  if (answer && opts.maxLength && opts.maxLength > 0 && answer.length > opts.maxLength) {
    answer = trimToLength(answer, opts.maxLength);
  }
  return { answer, category: normalizeCategory(raw?.category) };
}

// Trim text to <= max chars, preferring the last sentence end, then last space.
function trimToLength(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastStop = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "));
  if (lastStop >= max * 0.6) return slice.slice(0, lastStop + 1).trim();
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trim();
}

// ─── Generate LaTeX from scratch ──────────────────────────────────────────────
export async function claudeGenerateLatexResume(data: Record<string, unknown>) {
  const info = (data as { contactInfo?: Record<string, string> })?.contactInfo || {};
  const skills = (data.skills as string[] || []).slice(0, 15).join(", ");
  const exp = JSON.stringify((data.experience as object[] || []).slice(0, 2));
  const edu = JSON.stringify((data.education as object[] || []).slice(0, 1));

  return aiLong(
    `Create a complete 1-page LaTeX resume.

NAME: ${info.name || "Candidate"} | EMAIL: ${info.email} | PHONE: ${info.phone} | LOCATION: ${info.location}
LINKEDIN: ${info.linkedin} | GITHUB: ${info.github}
SKILLS: ${skills}
EXPERIENCE: ${exp}
EDUCATION: ${edu}

Return JSON: {"latexContent":"\\\\documentclass[10pt]{article}...FULL LATEX...\\\\end{document}","sections":["experience","skills","education"]}`,
    "LaTeX resume creator. Return JSON only.",
    3000,
    TAILOR_EFFORT
  );
}

// ─── Interview Preparation ────────────────────────────────────────────────────
export interface InterviewPrep {
  technicalQuestions: { question: string; guidance: string }[];
  behavioralQuestions: { question: string; star: string }[];
  systemDesignQuestions: { question: string; guidance: string }[];
  companyTalkingPoints: string[];
  questionsToAsk: string[];
  prepTips: string[];
}

export async function claudeInterviewPrep(
  resumeData: Record<string, unknown>,
  jobDescription: string,
  jobTitle: string,
  companyName: string
): Promise<InterviewPrep> {
  const contactInfo = (resumeData.contactInfo as Record<string, string>) || {};
  const skills = (resumeData.skills as string[] || []).slice(0, 20).join(", ");
  const tech = (resumeData.technologies as string[] || []).slice(0, 20).join(", ");
  const exp = JSON.stringify((resumeData.experience as object[] || []).slice(0, 3));
  const yrs = resumeData.yearsOfExperience || 0;

  return aiLong<InterviewPrep>(
    `Create focused interview prep for this candidate and this exact role. Ground every
suggested answer in the candidate's REAL experience below — never invent experience.

CANDIDATE: ${contactInfo.name || "Applicant"} | ${yrs} yrs experience
SKILLS: ${skills}
TECHNOLOGIES: ${tech}
EXPERIENCE: ${exp}

ROLE: ${jobTitle} @ ${companyName}
JOB DESCRIPTION (first 2000 chars):
${jobDescription.slice(0, 2000)}

Return ONLY this JSON:
{
  "technicalQuestions": [{"question": "a likely technical question for this role", "guidance": "how to approach it, and which of the candidate's actual skills/projects to reference"}],
  "behavioralQuestions": [{"question": "a behavioral question", "star": "a concise STAR-format answer drafted from the candidate's real experience"}],
  "systemDesignQuestions": [{"question": "a system-design / architecture question appropriate to this role's level", "guidance": "the key components, trade-offs, and approach to discuss"}],
  "companyTalkingPoints": ["specific reason this candidate fits this role/company"],
  "questionsToAsk": ["a smart, specific question for the candidate to ask the interviewer"],
  "prepTips": ["a concrete prep action tailored to this role"]
}
Provide 5-6 technical questions, 4-5 behavioral questions, 2-3 system-design questions (scale them to the role's seniority; for junior roles keep them light), and 3-4 items in each list.`,
    "You are an expert technical interview coach. Never fabricate the candidate's experience. Return JSON only.",
    4096,
    "high"
  );
}

// ─── Career Advisor ───────────────────────────────────────────────────────────
export interface CareerAdvice {
  summary: string;
  strengths: string[];
  skillGaps: { skill: string; demand: string; why: string }[];
  roadmap: { step: number; title: string; detail: string }[];
  targetRoles: string[];
  salaryInsight: string;
}

export async function claudeCareerAdvice(
  profile: { name: string; years: number; skills: string[]; technologies: string[] },
  demand: {
    topGaps: { skill: string; count: number }[];
    topStrengths: { skill: string; count: number }[];
    commonTitles: string[];
    jobsAnalyzed: number;
    salaryRange: string;
  }
): Promise<CareerAdvice> {
  return aiLong<CareerAdvice>(
    `Assess this candidate's market positioning using REAL demand data from ${demand.jobsAnalyzed} jobs they scraped. Be specific, practical, and honest.

CANDIDATE: ${profile.name} | ${profile.years} yrs experience
HAS SKILLS: ${profile.skills.slice(0, 25).join(", ")}
HAS TECH: ${profile.technologies.slice(0, 25).join(", ")}

MARKET DEMAND (derived from their scraped jobs):
- Most-requested skills they are MISSING: ${demand.topGaps.map((g) => `${g.skill}(${g.count})`).join(", ") || "none detected"}
- Their in-demand strengths: ${demand.topStrengths.map((s) => `${s.skill}(${s.count})`).join(", ") || "none detected"}
- Common role titles: ${demand.commonTitles.join(", ") || "n/a"}
- Salary range observed: ${demand.salaryRange || "n/a"}

Return ONLY this JSON:
{
  "summary": "2-3 sentence honest assessment of where they stand",
  "strengths": ["a specific in-demand strength they already have"],
  "skillGaps": [{"skill": "", "demand": "high|medium|low", "why": "why it matters for their target roles"}],
  "roadmap": [{"step": 1, "title": "what to learn or do", "detail": "how to do it and roughly how long"}],
  "targetRoles": ["a role type they're well-positioned for now"],
  "salaryInsight": "1-2 sentences on realistic salary positioning"
}
Give 4-6 prioritized skillGaps and a 4-6 step roadmap.`,
    "You are a candid, practical career advisor for software and tech job seekers. Return JSON only.",
    3000,
    "high"
  );
}

// ─── Recruiter Outreach ───────────────────────────────────────────────────────
export interface RecruiterOutreach {
  connectionNote: string; // <300 chars, for a LinkedIn connection request
  message: string;        // longer follow-up / InMail
  followUp: string;       // short nudge if no reply after ~1 week
}

export async function claudeRecruiterMessage(
  profile: { name: string; years: number; skills: string[] },
  job: { jobTitle: string; companyName: string; description?: string },
  recruiterName?: string
): Promise<RecruiterOutreach> {
  return aiLong<RecruiterOutreach>(
    `Write recruiter-outreach messages for this candidate about a specific role. Warm, specific, and concise — never generic or desperate. Reference 1-2 real strengths. Do NOT fabricate experience.

CANDIDATE: ${profile.name} | ${profile.years} yrs | strengths: ${profile.skills.slice(0, 8).join(", ")}
ROLE: ${job.jobTitle} @ ${job.companyName}
RECRUITER: ${recruiterName || "the recruiter/hiring manager"}
${job.description ? `JOB (first 800 chars): ${job.description.slice(0, 800)}` : ""}

Return ONLY this JSON:
{
  "connectionNote": "a LinkedIn connection request note UNDER 300 characters, friendly and specific",
  "message": "a 90-130 word message expressing genuine interest, citing 1-2 relevant strengths, and a clear soft ask (a quick chat)",
  "followUp": "a 2-3 sentence polite follow-up to send if there's no reply after a week"
}`,
    "You are an expert at warm, effective professional outreach. Return JSON only.",
    1200,
    "low"
  );
}

// ─── Email / Application-status classification ────────────────────────────────
export interface EmailClassification {
  category: "INTERVIEW" | "ASSESSMENT" | "OFFER" | "REJECTION" | "RECRUITER" | "OTHER";
  company: string | null;     // best guess at the company the email is about
  newStatus:
    | "INTERVIEW_SCHEDULED"
    | "OFFER_RECEIVED"
    | "REJECTED"
    | "CONFIRMED"
    | null;                    // suggested application status, or null if N/A
  summary: string;            // one-line summary
  suggestedReply: string;     // a short, appropriate reply the user can send
}

export async function claudeClassifyEmail(emailText: string): Promise<EmailClassification> {
  return ai<EmailClassification>(
    `Classify this job-related email and extract what matters. Be conservative — if unsure, use OTHER and null status.

EMAIL (first 2500 chars):
${emailText.slice(0, 2500)}

Return ONLY this JSON:
{
  "category": "INTERVIEW|ASSESSMENT|OFFER|REJECTION|RECRUITER|OTHER",
  "company": "the company name if identifiable, else null",
  "newStatus": "INTERVIEW_SCHEDULED|OFFER_RECEIVED|REJECTED|CONFIRMED, or null if not applicable",
  "summary": "one concise sentence describing the email",
  "suggestedReply": "a short, professional reply the candidate could send (2-4 sentences)"
}`,
    "You classify job-application emails accurately and conservatively. Return JSON only.",
    700
  );
}
