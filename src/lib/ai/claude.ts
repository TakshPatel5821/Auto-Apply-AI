import type Anthropic from "@anthropic-ai/sdk";
import { ollamaCompleteJSON, ollamaComplete } from "./ollama";
import { buildResumeLatex, RESUME_EXPERIENCE, RESUME_PROJECTS, RESUME_SKILLS } from "@/lib/automation/resume-template";

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

// ─── Defensive coercion helpers ──────────────────────────────────────────────
// The model occasionally returns a field as a nested object/array instead of the
// expected scalar. Writing such a value to disk crashes with ERR_INVALID_ARG_TYPE,
// which aborts the whole tailor → CV → apply pipeline. These keep it robust.

function asString(val: unknown): string {
  if (typeof val === "string") return val;
  if (val == null) return "";
  if (Array.isArray(val)) return val.filter((v): v is string => typeof v === "string").join("\n\n");
  if (typeof val === "object") {
    return Object.values(val as Record<string, unknown>)
      .filter((v): v is string => typeof v === "string")
      .join("\n\n");
  }
  return String(val);
}

function asStringArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.filter((v): v is string => typeof v === "string");
  return [];
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

// ─── Combined tailor + analyze + cover letter (FAST path) ────────────────────
// One model call returns a job-tailored SUMMARY + cover letter + ATS analysis.
// The résumé itself is the fixed, page-tested template (see resume-template.ts);
// only the Professional Summary is swapped in. This is far more reliable than
// asking the model to emit a whole LaTeX document (which overflowed pages and
// produced uncompilable output). System prompt + candidate profile are cached.

export interface FullTailorResult {
  tailoredSummary: string;
  tailoredLatex: string;
  coverLetter: string;
  atsScore: number;
  keywordsAdded: string[];
  sectionsModified: string[];
  tailoringNotes: string;
  jobAnalysis: {
    atsKeywords: string[];
    requiredSkills: string[];
    technologies: string[];
    experienceLevel: string;
  };
}

// Turn a parsed model response into a FullTailorResult, building the final LaTeX
// from the fixed template + tailored summary. Defensive about field shapes.
function buildTailorResult(raw: Record<string, unknown>): FullTailorResult {
  const ja = (raw.jobAnalysis as Record<string, unknown>) || {};
  const tailoredSummary = asString(raw.tailoredSummary) || asString(raw.summary);
  const sectionsModified = asStringArray(raw.sectionsModified);
  if (!sectionsModified.length) sectionsModified.push("summary");
  return {
    tailoredSummary,
    tailoredLatex: buildResumeLatex(tailoredSummary),
    coverLetter: asString(raw.coverLetter),
    atsScore: typeof raw.atsScore === "number" ? raw.atsScore : 5,
    keywordsAdded: asStringArray(raw.keywordsAdded),
    sectionsModified,
    tailoringNotes: asString(raw.tailoringNotes),
    jobAnalysis: {
      atsKeywords: asStringArray(ja.atsKeywords),
      requiredSkills: asStringArray(ja.requiredSkills),
      technologies: asStringArray(ja.technologies),
      experienceLevel: asString(ja.experienceLevel) || "mid",
    },
  };
}

export async function claudeFullTailor(
  resumeData: Record<string, unknown>,
  jobDescription: string,
  jobTitle: string,
  companyName: string,
  feedback?: string[]
): Promise<FullTailorResult> {
  const contactInfo = (resumeData.contactInfo as Record<string, string>) || {};
  const skills = (resumeData.skills as string[] || []).slice(0, 20).join(", ");
  const tech = (resumeData.technologies as string[] || []).slice(0, 20).join(", ");
  const yrs = resumeData.yearsOfExperience || 0;
  const candidateName = contactInfo.name || "the candidate";

  const systemRules = `You are an expert ATS resume tailor and cover letter writer.

STRICT RULES:
- NEVER fabricate experience, education, skills, or accomplishments. Only emphasize what the candidate already has.
- The summary and the cover letter MUST be consistent with EACH OTHER and with the candidate's real background.
- PROFESSIONAL SUMMARY: plain text (no markdown/LaTeX), 2-3 sentences (~55 words), weaving in the job's most relevant keywords truthfully.
- COVER LETTER — specific to THIS job, never generic boilerplate. Write ONLY the
  body paragraphs (NO "Dear ..." and NO "Sincerely"/sign-off — those are added
  automatically; including them is an error). 250-450 words, EXACTLY four short
  paragraphs in this order:
    1) OPENING — why THIS company and role specifically: reference the company's
       product / mission / domain and what the role focuses on (from the posting).
    2) MATCH — 2-3 CONCRETE achievements or projects from the candidate's real
       background that map directly to the posting's top requirements; weave in
       the posting's actual key skills/terminology. Include real metrics ONLY if
       present in the profile — never invent numbers.
    3) VALUE — what the candidate will concretely deliver in THIS role.
    4) CLOSING — brief thank-you + interest in an interview.
  Mention the company name and the role title explicitly. No clichés ("I am
  writing to apply", "I am a hard worker"), no filler, no placeholders, no
  fabrication. coverLetter MUST be a single string (paragraphs separated by \\n\\n).
- Return ONLY a single JSON object — no markdown fences, no prose, no preamble`;

  const allow = buildAllowlist(resumeData);
  const allowedEmployers = allow.companies.length ? allow.companies.join("; ") : "(none parsed — do NOT name any employer)";

  const candidateProfile = `CANDIDATE PROFILE (same for every job this session):
Name: ${candidateName}
Skills: ${skills}
Technologies: ${tech}
Years of experience: ${yrs}
Background: M.S. Software Engineering (UT Arlington, May 2026); Python data pipelines & IoT systems; PHP/MySQL & full-stack web development; Azure AZ-900; Linux/UNIX, TCP/IP, Wireshark, security.

HARD FACTUAL CONSTRAINTS (anti-hallucination — violating these makes the letter unusable):
- ONLY these employers may be named: ${allowedEmployers}. Never invent a company, e.g. "XYZ Corp".
- ONLY claim skills/technologies the candidate actually has (the Skills/Technologies above). Do NOT name other technologies to stuff keywords (e.g. RPG, IBM i, Angular, GCP) unless they are listed.
- NEVER state a numeric metric or percentage (e.g. "improved efficiency by 30%", "reduced MTTR by 25%") — the candidate's résumé has no such numbers. Describe impact qualitatively instead.
- Never invent degrees, certifications, job titles, or projects. The ONLY new name allowed is the target company being applied to.`;

  const feedbackBlock = feedback && feedback.length
    ? `\n\nThe previous attempt was rejected for these problems — FIX them this time:\n- ${feedback.slice(0, 6).join("\n- ")}\n`
    : "";

  const userPrompt = `JOB POSTING — ${jobTitle} @ ${companyName}:

${jobDescription.slice(0, 3000)}
${feedbackBlock}
Do all of the following for this candidate:
1. Analyze the job → ATS keywords, required skills, technologies, experience level (entry|mid|senior).
2. Write a tailored PROFESSIONAL SUMMARY (plain text, 2-3 sentences, ~55 words) for THIS role using only the candidate's real skills.
3. Write the cover letter BODY (paragraphs only — no greeting, no sign-off),
   250-450 words in the four-paragraph OPENING/MATCH/VALUE/CLOSING structure from
   the rules above, grounded in the posting's requirements + the candidate's real
   achievements, and naturally including the posting's key skills/terminology.
4. Score the resume's ATS match for this job (1 = perfect, 10 = poor).

Return ONLY this JSON object (no markdown fences):
{
  "jobAnalysis": {"atsKeywords":["..."],"requiredSkills":["..."],"technologies":["..."],"experienceLevel":"entry|mid|senior"},
  "tailoredSummary": "2-3 sentence plain-text summary",
  "coverLetter": "[OPENING]\\n\\n[MATCH]\\n\\n[VALUE]\\n\\n[CLOSING]",
  "atsScore": 5,
  "keywordsAdded": ["..."],
  "tailoringNotes": "what you emphasised"
}`;

  // Ollama fallback (local) — single JSON completion.
  if (USE_OLLAMA) {
    const raw = await ollamaCompleteJSON<Record<string, unknown>>(
      userPrompt,
      `${systemRules}\n\n${candidateProfile}`,
      1600
    );
    return buildTailorResult(raw);
  }

  // Claude / Bedrock path — streaming + prompt caching.
  // adaptive thinking + effort only exist on Opus 4.6+/Sonnet 4.6 — omit on
  // Haiku 4.5 (Bedrock default), which would otherwise 400.
  const client = await getClient();
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 2200,
    ...(MODEL_SUPPORTS_EFFORT ? { thinking: { type: "adaptive" as const } } : {}),
    ...effortConfig(TAILOR_EFFORT),
    system: [
      { type: "text", text: systemRules },
      { type: "text", text: candidateProfile, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: userPrompt }],
  });

  const finalMessage = await stream.finalMessage();
  const textBlock = finalMessage.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response from Claude");
  }

  const raw = JSON.parse(stripJsonFences(textBlock.text)) as Record<string, unknown>;

  const usage = finalMessage.usage;
  if (usage) {
    // eslint-disable-next-line no-console
    console.log(
      `[claudeFullTailor] tokens: in=${usage.input_tokens} cache_read=${usage.cache_read_input_tokens ?? 0} out=${usage.output_tokens}`
    );
  }

  return buildTailorResult(raw);
}

// ─── Alignment / quality gate ────────────────────────────────────────────────
// After tailoring, verify the SUMMARY and COVER LETTER (a) align with each
// other, (b) fit the job role, and (c) only use skills/experience the candidate
// actually has (their base résumé) — and that the cover letter is specific, not
// generic filler. Returns a score + issues so the caller can regenerate both
// when it's not good enough. Cheap call (low effort, small tokens).
export interface AlignmentResult {
  score: number;       // 0-10 (10 = perfectly aligned + specific)
  aligned: boolean;    // score >= 7
  issues: string[];    // concrete problems to fix on regeneration
}

export async function checkTailorAlignment(
  tailoredSummary: string,
  coverLetter: string,
  jobTitle: string,
  companyName: string,
  jobDescription: string,
  resumeData: Record<string, unknown>
): Promise<AlignmentResult> {
  const skills = (resumeData.skills as string[] || []).slice(0, 25).join(", ");
  const tech = (resumeData.technologies as string[] || []).slice(0, 25).join(", ");
  const baseSummary = typeof resumeData.summary === "string" ? resumeData.summary : "";

  const system =
    "You are a strict reviewer of tailored job-application materials. Judge whether the SUMMARY and COVER LETTER: " +
    "(1) are consistent with EACH OTHER; (2) fit the target job role; (3) ONLY use skills/experience present in the candidate's résumé facts (flag ANY fabrication or claim not supported by them); " +
    "(4) are specific to this role/company and not generic filler; (5) contain no leftover placeholders or a wrong/missing name. " +
    "Score 0-10 (10 = aligned, truthful, specific). Return ONLY JSON.";

  const prompt = `TARGET ROLE: ${jobTitle} @ ${companyName}
JOB POSTING (excerpt):
${(jobDescription || "").slice(0, 1500)}

CANDIDATE RÉSUMÉ FACTS (the source of truth — nothing may go beyond these):
Skills: ${skills}
Technologies: ${tech}
Base summary: ${baseSummary.slice(0, 400)}

TAILORED SUMMARY:
${tailoredSummary}

COVER LETTER:
${coverLetter}

Return ONLY this JSON: {"score": 0-10, "issues": ["short, concrete problems to fix"]}`;

  try {
    const raw = (await ai(prompt, system, 400, "low")) as { score?: unknown; issues?: unknown };
    const score = typeof raw.score === "number" ? raw.score : Number(raw.score) || 0;
    const issues = asStringArray(raw.issues);
    return { score, aligned: score >= 7, issues };
  } catch {
    // If the check itself fails, don't block the pipeline — treat as aligned.
    return { score: 10, aligned: true, issues: [] };
  }
}

// ─── Hallucination guard ──────────────────────────────────────────────────────
// The #1 risk in a generated cover letter is FABRICATION — inventing employers,
// metrics, technologies, degrees. Recruiters reject for that. We build an
// allow-list from the candidate's real parsed résumé and then (a) feed it to the
// model as a hard constraint and (b) verify the output against it, rejecting +
// regenerating anything that names something off-list.

export interface Allowlist {
  corpus: string;       // lowercased résumé text — the source of truth
  companies: string[];  // real employers
  skills: string[];     // real skills + technologies
}

export function buildAllowlist(resumeData: Record<string, unknown>): Allowlist {
  const arr = (k: string): Record<string, unknown>[] =>
    Array.isArray(resumeData[k]) ? (resumeData[k] as Record<string, unknown>[]) : [];
  const strArr = (k: string): string[] =>
    Array.isArray(resumeData[k]) ? (resumeData[k] as unknown[]).map(String).filter(Boolean) : [];

  const exp = arr("experience");
  const proj = arr("projects");
  const edu = arr("education");
  const companies = exp.map((e) => String(e.company || "")).filter(Boolean);
  const skills = [...strArr("skills"), ...strArr("technologies")].filter(Boolean);

  const parts: string[] = [];
  if (typeof resumeData.rawText === "string") parts.push(resumeData.rawText);
  if (typeof resumeData.summary === "string") parts.push(resumeData.summary);
  for (const e of exp) {
    parts.push(String(e.company || ""), String(e.title || ""), String(e.description || ""));
    if (Array.isArray(e.bullets)) parts.push(...(e.bullets as unknown[]).map(String));
  }
  for (const p of proj) {
    parts.push(String(p.name || ""), String(p.description || ""));
    if (Array.isArray(p.bullets)) parts.push(...(p.bullets as unknown[]).map(String));
  }
  for (const e of edu) parts.push(String(e.institution || ""), String(e.degree || ""), String(e.field || ""));
  parts.push(...skills, ...companies);

  return { corpus: parts.join(" \n ").toLowerCase(), companies, skills };
}

// Curated technology tokens — only these are checked, to avoid false positives
// on ordinary words.
const TECH_TOKENS = [
  "java", "python", "php", "javascript", "typescript", "c++", "c#", ".net", "golang", "ruby", "rust",
  "kotlin", "swift", "scala", "perl", "react", "angular", "vue", "svelte", "node", "express", "django",
  "flask", "spring", "laravel", "rails", "mysql", "postgres", "postgresql", "mongodb", "redis", "oracle",
  "aws", "azure", "gcp", "google cloud", "kubernetes", "docker", "terraform", "jenkins", "kafka", "spark",
  "hadoop", "graphql", "grpc", "rpg", "cobol", "ibm i", "as/400", "mainframe", "sas", "tableau", "power bi",
  "salesforce", "snowflake", "elasticsearch", "rabbitmq",
];

function tokenRegex(tok: string): RegExp {
  const esc = tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9#+])${esc}(?![a-z0-9#+])`, "i");
}

// Returns concrete "remove X" issues for anything the letter states that is not
// supported by the résumé (or, for technologies, also not in the job posting).
export function detectHallucinations(
  letter: string,
  resumeData: Record<string, unknown>,
  jobDescription: string,
  targetCompany: string
): string[] {
  const issues: string[] = [];
  const { corpus, companies } = buildAllowlist(resumeData);
  const text = letter || "";
  const lower = text.toLowerCase();
  const jd = (jobDescription || "").toLowerCase();
  const corpusNoSpace = corpus.replace(/\s+/g, "");

  // 1) Fabricated metrics: any percentage or N× multiplier not in the résumé.
  const metrics = text.match(/\b\d{1,3}(?:\.\d+)?\s?%|\b\d+(?:\.\d+)?x\b/gi) || [];
  for (const m of metrics) {
    if (!corpusNoSpace.includes(m.replace(/\s+/g, "").toLowerCase())) {
      issues.push(`remove the fabricated metric "${m.trim()}" — it is not in your résumé`);
    }
  }

  // 2) Fabricated employer: an employment phrase naming a company not in the résumé.
  const allowedCompanies = [...companies.map((c) => c.toLowerCase()), (targetCompany || "").toLowerCase()].filter(Boolean);
  const empRe =
    /(?:my (?:current|previous|recent|former)?\s*(?:role|position|job|tenure|time|work)\s+(?:at|with)|currently (?:working )?(?:at|with)|while (?:at|with)|during my time at|in my role at)\s+([A-Z][\w&.\-]*(?:\s+[A-Z][\w&.\-]*){0,3})/g;
  let m: RegExpExecArray | null;
  while ((m = empRe.exec(text))) {
    const org = m[1].trim();
    const ol = org.toLowerCase();
    const ok = allowedCompanies.some((c) => c && (ol.includes(c) || c.includes(ol))) || corpus.includes(ol);
    if (!ok) issues.push(`remove the fabricated employer "${org}" — it is not in your résumé`);
  }

  // 3) Invented / overstuffed technologies: named in the letter but in NEITHER
  //    the résumé NOR the job posting.
  for (const tok of TECH_TOKENS) {
    const re = tokenRegex(tok);
    if (re.test(lower) && !re.test(corpus) && !re.test(jd)) {
      issues.push(`remove the technology "${tok}" — it is not in your résumé or the job posting`);
    }
  }

  return [...new Set(issues)];
}

// ─── Résumé content tailoring: reorder skills + REWORD bullets ────────────────
// Operates on the canonical template content (the real, hand-tuned résumé). The
// model may only REORDER skills (same items) and REWORD bullets to mirror the
// posting — never add facts/metrics/tools/employers. Output is validated +
// truth-checked + 1-page-enforced by the caller before it's used.
export interface ResumeContentTailor {
  reorderedSkills: string[][];   // per skill group, same items reordered
  experienceBullets: string[][]; // per experience entry, same count, reworded
  projectBullets: string[][];    // per project entry, reworded
}

export async function claudeTailorResumeContent(
  jobDescription: string,
  jobTitle: string,
  companyName: string
): Promise<ResumeContentTailor> {
  const expBlock = RESUME_EXPERIENCE
    .map((e, i) => `[${i}]\n${e.bullets.map((b) => `- ${b}`).join("\n")}`)
    .join("\n");
  const projBlock = RESUME_PROJECTS
    .map((p, i) => `[${i}] ${p.heading.replace(/\\textbf\{|\}|\\textit\{|\$\|\$/g, "").trim()}\n${p.bullets.map((b) => `- ${b}`).join("\n")}`)
    .join("\n");
  const skillBlock = RESUME_SKILLS
    .map((g, i) => `[${i}] ${g.label}: ${g.items.join(", ")}`)
    .join("\n");

  const system =
    "You REWORD and REORDER an existing résumé to mirror a job posting. You MUST NOT add, remove, or invent any fact, metric, number, employer, technology, or skill. " +
    "Every reworded bullet must remain fully supported by the original bullet — only the wording changes to echo the posting's terminology. " +
    "For each experience/project entry return the SAME number of bullets (reworded). For each skill group return the SAME items, only reordered so the posting's most relevant come first (never add or drop an item). Return ONLY JSON.";

  const prompt = `TARGET ROLE: ${jobTitle} @ ${companyName}
JOB POSTING (excerpt):
${(jobDescription || "").slice(0, 2000)}

EXPERIENCE BULLETS (reword each; same count; no new facts/metrics/tools):
${expBlock}

PROJECT BULLETS (reword each; same count; no new facts/metrics/tools):
${projBlock}

SKILL GROUPS (reorder items within each group; SAME items, none added/removed):
${skillBlock}

Return ONLY this JSON (arrays in the same order/length as above):
{
  "experienceBullets": [["reworded bullet", "..."], ["..."]],
  "projectBullets": [["..."], ["..."], ["..."], ["..."]],
  "reorderedSkills": [["..."], ["..."], ["..."], ["..."], ["..."]]
}`;

  try {
    const raw = (await ai(prompt, system, 2000, "low")) as Record<string, unknown>;
    const mat = (v: unknown): string[][] =>
      Array.isArray(v) ? v.map((row) => asStringArray(row)) : [];
    return {
      reorderedSkills: mat(raw.reorderedSkills),
      experienceBullets: mat(raw.experienceBullets),
      projectBullets: mat(raw.projectBullets),
    };
  } catch {
    // Any failure → no overrides; the caller keeps the canonical résumé.
    return { reorderedSkills: [], experienceBullets: [], projectBullets: [] };
  }
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
    "high"
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
