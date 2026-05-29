import type Anthropic from "@anthropic-ai/sdk";
import { ollamaCompleteJSON, ollamaComplete } from "./ollama";

const USE_OLLAMA =
  !process.env.ANTHROPIC_API_KEY ||
  process.env.ANTHROPIC_API_KEY === "not-needed" ||
  process.env.AI_PROVIDER === "ollama";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";

// Effort controls thinking depth + overall token spend (GA on Opus 4.8 / Sonnet 4.6).
// Cheap extraction/scoring runs at "low"; rich generation passes "high".
type Effort = "low" | "medium" | "high";

let _clientPromise: Promise<Anthropic> | null = null;
async function getClient(): Promise<Anthropic> {
  if (!_clientPromise) {
    _clientPromise = (async () => {
      const { default: AnthropicSDK } = await import("@anthropic-ai/sdk");
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
    output_config: { effort },
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
    output_config: { effort },
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
// Single Claude call with prompt caching. Resume + system prompt are cached so
// every subsequent job in the same session reads them at ~10% cost.
// Replaces 3 separate calls (analyze + tailor + cover letter) with 1.

export interface FullTailorResult {
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

export async function claudeFullTailor(
  resumeData: Record<string, unknown>,
  originalLatex: string,
  jobDescription: string,
  jobTitle: string,
  companyName: string
): Promise<FullTailorResult> {
  // Ollama fallback: do 3 sequential calls (slower but works without API key)
  if (USE_OLLAMA) {
    const jobAnalysis = await claudeAnalyzeJob(jobDescription) as Record<string, unknown>;
    const tailored = await claudeTailorResume(originalLatex, jobDescription, resumeData, jobAnalysis) as {
      latexContent: string; atsScore: number; keywordsAdded?: string[]; sectionsModified?: string[]; tailoringNotes?: string;
    };
    const cl = await claudeGenerateCoverLetter(jobDescription, companyName, jobTitle, resumeData) as { content: string };
    return {
      tailoredLatex: tailored.latexContent || originalLatex,
      coverLetter: cl.content || "",
      atsScore: tailored.atsScore ?? 5,
      keywordsAdded: tailored.keywordsAdded || [],
      sectionsModified: tailored.sectionsModified || [],
      tailoringNotes: tailored.tailoringNotes || "",
      jobAnalysis: {
        atsKeywords: (jobAnalysis.atsKeywords as string[]) || [],
        requiredSkills: (jobAnalysis.requiredSkills as string[]) || [],
        technologies: (jobAnalysis.technologies as string[]) || [],
        experienceLevel: (jobAnalysis.experienceLevel as string) || "mid",
      },
    };
  }

  // Claude API path — single call with prompt caching
  const client = await getClient();
  const contactInfo = (resumeData.contactInfo as Record<string, string>) || {};
  const skills = (resumeData.skills as string[] || []).slice(0, 20).join(", ");
  const tech = (resumeData.technologies as string[] || []).slice(0, 20).join(", ");
  const yrs = resumeData.yearsOfExperience || 0;
  const candidateName = contactInfo.name || "Applicant";

  // Stream with .finalMessage() so longer outputs don't hit HTTP timeouts
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    system: [
      {
        type: "text",
        text: `You are an expert ATS resume tailor and cover letter writer.

STRICT RULES:
- NEVER fabricate experience, education, skills, or accomplishments
- Only rewrite, reorder, and emphasize content the candidate already has
- Inject the target keywords ONLY where they fit truthfully into existing bullets
- Keep resume to ONE page (no new sections, no padding)
- Use a professional, confident, concise tone
- Cover letter: 3 short paragraphs (hook → why-you-fit → close)
- Return ONLY a single JSON object — no markdown fences, no prose, no preamble`,
      },
      {
        type: "text",
        text: `CANDIDATE PROFILE (same for every job in this session):
Name: ${candidateName}
Email: ${contactInfo.email || ""}
Phone: ${contactInfo.phone || ""}
Location: ${contactInfo.location || ""}
LinkedIn: ${contactInfo.linkedin || ""}
GitHub: ${contactInfo.github || ""}

Skills: ${skills}
Technologies: ${tech}
Years of experience: ${yrs}

ORIGINAL LATEX RESUME (modify this to match each job):
\`\`\`latex
${originalLatex.slice(0, 4000)}
\`\`\``,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: `JOB POSTING — ${jobTitle} @ ${companyName}:

${jobDescription.slice(0, 3000)}

In ONE response, do all four:
1. Analyze the job → extract ATS keywords, required skills, technologies, experience level
2. Tailor the LaTeX resume → rewrite bullets, inject job keywords naturally, reorder skills to lead with relevant ones
3. Write a 3-paragraph cover letter personalised to this exact role and company
4. Score the tailored resume's ATS match (1 = perfect, 10 = poor)

Return ONLY this JSON object:
{
  "jobAnalysis": {
    "atsKeywords": ["..."],
    "requiredSkills": ["..."],
    "technologies": ["..."],
    "experienceLevel": "entry|mid|senior"
  },
  "tailoredLatex": "FULL LATEX CODE HERE",
  "coverLetter": "Dear Hiring Manager,\\n\\n[paragraph 1]\\n\\n[paragraph 2]\\n\\n[paragraph 3]\\n\\nSincerely,\\n${candidateName}",
  "atsScore": 7,
  "keywordsAdded": ["..."],
  "sectionsModified": ["experience", "skills"],
  "tailoringNotes": "brief description of what changed"
}`,
      },
    ],
  });

  const finalMessage = await stream.finalMessage();
  const textBlock = finalMessage.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response from Claude");
  }

  const parsed = JSON.parse(stripJsonFences(textBlock.text)) as FullTailorResult;

  // Log cache stats so user can see caching is working
  const usage = finalMessage.usage;
  if (usage) {
    const cacheHit = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const uncached = usage.input_tokens;
    // eslint-disable-next-line no-console
    console.log(
      `[claudeFullTailor] tokens: in=${uncached} cache_read=${cacheHit} cache_write=${cacheWrite} out=${usage.output_tokens}`
    );
  }

  return parsed;
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
