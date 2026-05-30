import type Anthropic from "@anthropic-ai/sdk";
import { ollamaCompleteJSON, ollamaComplete } from "./ollama";
import { buildResumeLatex } from "@/lib/automation/resume-template";

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
export async function claudeAnswerQuestion(
  question: string,
  context: Record<string, unknown>,
  previousAnswers: { question: string; answer: string }[]
) {
  const recent = previousAnswers.slice(-3).map((a) => `${a.question}: ${a.answer}`).join(" | ");

  return ai(
    `Answer this job application question truthfully and briefly.

QUESTION: "${question}"
CONTEXT: ${recent || "No prior answers"}

Return JSON: {"answer":"concise answer","category":"GENERAL|VISA_SPONSORSHIP|WORK_AUTHORIZATION|SALARY|EXPERIENCE|RELOCATION|AVAILABILITY"}`,
    "Job application answerer. Return JSON only.",
    128
  );
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
  companyName: string
): Promise<FullTailorResult> {
  const contactInfo = (resumeData.contactInfo as Record<string, string>) || {};
  const skills = (resumeData.skills as string[] || []).slice(0, 20).join(", ");
  const tech = (resumeData.technologies as string[] || []).slice(0, 20).join(", ");
  const yrs = resumeData.yearsOfExperience || 0;
  const candidateName = contactInfo.name || "Patel Takshkumar Girishbhai";

  const systemRules = `You are an expert ATS resume tailor and cover letter writer.

STRICT RULES:
- NEVER fabricate experience, education, skills, or accomplishments
- Only emphasize content the candidate already has
- The PROFESSIONAL SUMMARY is the only part of the resume that changes — write it as plain text (no markdown, no LaTeX), 2-3 sentences, ~55 words max, weaving in the job's most relevant keywords truthfully
- Cover letter: 3 short paragraphs (hook → why-you-fit → close)
- Return ONLY a single JSON object — no markdown fences, no prose, no preamble`;

  const candidateProfile = `CANDIDATE PROFILE (same for every job this session):
Name: ${candidateName}
Skills: ${skills}
Technologies: ${tech}
Years of experience: ${yrs}
Background: M.S. Software Engineering (UT Arlington, May 2026); Python data pipelines & IoT systems; PHP/MySQL & full-stack web development; Azure AZ-900; Linux/UNIX, TCP/IP, Wireshark, security. Only claim skills/experience consistent with this profile.`;

  const userPrompt = `JOB POSTING — ${jobTitle} @ ${companyName}:

${jobDescription.slice(0, 3000)}

Do all of the following for this candidate:
1. Analyze the job → ATS keywords, required skills, technologies, experience level (entry|mid|senior).
2. Write a tailored PROFESSIONAL SUMMARY (plain text, 2-3 sentences, ~55 words) for THIS role using only the candidate's real skills.
3. Write a 3-paragraph cover letter personalised to this exact role and company.
4. Score the resume's ATS match for this job (1 = perfect, 10 = poor).

Return ONLY this JSON object (no markdown fences):
{
  "jobAnalysis": {"atsKeywords":["..."],"requiredSkills":["..."],"technologies":["..."],"experienceLevel":"entry|mid|senior"},
  "tailoredSummary": "2-3 sentence plain-text summary",
  "coverLetter": "Dear Hiring Manager,\\n\\n[p1]\\n\\n[p2]\\n\\n[p3]\\n\\nSincerely,\\n${candidateName}",
  "atsScore": 5,
  "keywordsAdded": ["..."],
  "tailoringNotes": "what you emphasised"
}`;

  // Ollama fallback (local) — single JSON completion.
  if (USE_OLLAMA) {
    const raw = await ollamaCompleteJSON<Record<string, unknown>>(
      userPrompt,
      `${systemRules}\n\n${candidateProfile}`,
      2000
    );
    return buildTailorResult(raw);
  }

  // Claude / Bedrock path — streaming + prompt caching.
  // adaptive thinking + effort only exist on Opus 4.6+/Sonnet 4.6 — omit on
  // Haiku 4.5 (Bedrock default), which would otherwise 400.
  const client = await getClient();
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 2000,
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
  "companyTalkingPoints": ["specific reason this candidate fits this role/company"],
  "questionsToAsk": ["a smart, specific question for the candidate to ask the interviewer"],
  "prepTips": ["a concrete prep action tailored to this role"]
}
Provide 5-6 technical questions, 4-5 behavioral questions, and 3-4 items in each list.`,
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
