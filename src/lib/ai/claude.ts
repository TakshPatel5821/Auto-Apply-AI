import { ollamaCompleteJSON, ollamaComplete } from "./ollama";

const USE_OLLAMA =
  !process.env.ANTHROPIC_API_KEY ||
  process.env.ANTHROPIC_API_KEY === "not-needed" ||
  process.env.AI_PROVIDER === "ollama";

async function ai<T>(prompt: string, system: string, tokens = 1024): Promise<T> {
  if (USE_OLLAMA) return ollamaCompleteJSON<T>(prompt, system, tokens);

  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const res = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
    max_tokens: tokens,
    system: system + "\n\nRespond with ONLY valid JSON.",
    messages: [{ role: "user", content: prompt }],
  });
  const block = res.content[0];
  if (block.type !== "text") throw new Error("Bad response type");
  return JSON.parse(block.text.replace(/^```json\n?/, "").replace(/\n?```$/, "")) as T;
}

export async function claudeComplete(prompt: string, system?: string, tokens?: number) {
  if (USE_OLLAMA) return ollamaComplete(prompt, system, tokens);
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const res = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
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
    4096
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
    768
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

// ─── Generate LaTeX from scratch ──────────────────────────────────────────────
export async function claudeGenerateLatexResume(data: Record<string, unknown>) {
  const info = (data as { contactInfo?: Record<string, string> })?.contactInfo || {};
  const skills = (data.skills as string[] || []).slice(0, 15).join(", ");
  const exp = JSON.stringify((data.experience as object[] || []).slice(0, 2));
  const edu = JSON.stringify((data.education as object[] || []).slice(0, 1));

  return ai(
    `Create a complete 1-page LaTeX resume.

NAME: ${info.name || "Candidate"} | EMAIL: ${info.email} | PHONE: ${info.phone} | LOCATION: ${info.location}
LINKEDIN: ${info.linkedin} | GITHUB: ${info.github}
SKILLS: ${skills}
EXPERIENCE: ${exp}
EDUCATION: ${edu}

Return JSON: {"latexContent":"\\\\documentclass[10pt]{article}...FULL LATEX...\\\\end{document}","sections":["experience","skills","education"]}`,
    "LaTeX resume creator. Return JSON only.",
    3000
  );
}
