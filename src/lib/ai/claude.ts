import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

export async function claudeComplete(
  prompt: string,
  systemPrompt?: string,
  maxTokens: number = 4096
): Promise<string> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: prompt },
  ];

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages,
  });

  const block = response.content[0];
  if (block.type !== "text") throw new Error("Unexpected response type");
  return block.text;
}

export async function claudeCompleteJSON<T>(
  prompt: string,
  systemPrompt?: string,
  maxTokens: number = 4096
): Promise<T> {
  const jsonSystemPrompt = `${systemPrompt || ""}

IMPORTANT: You must respond with ONLY valid JSON. No markdown, no explanation, no code blocks. Just raw JSON.`;

  const text = await claudeComplete(prompt, jsonSystemPrompt, maxTokens);

  const cleaned = text
    .replace(/^```json\n?/, "")
    .replace(/\n?```$/, "")
    .trim();

  return JSON.parse(cleaned) as T;
}

export async function claudeParseResume(resumeText: string) {
  const systemPrompt = `You are an expert resume parser. Extract all information from the resume and return structured JSON. Be thorough and accurate.`;

  const prompt = `Parse this resume and extract ALL information into the following JSON structure:

{
  "rawText": "full resume text",
  "skills": ["skill1", "skill2"],
  "experience": [
    {
      "company": "Company Name",
      "title": "Job Title",
      "location": "City, State",
      "startDate": "Month Year",
      "endDate": "Month Year or null",
      "current": false,
      "description": "role description",
      "bullets": ["bullet point 1", "bullet point 2"],
      "technologies": ["tech1", "tech2"]
    }
  ],
  "education": [
    {
      "institution": "University Name",
      "degree": "Bachelor of Science",
      "field": "Computer Science",
      "startDate": "Year",
      "endDate": "Year",
      "gpa": "3.8",
      "honors": ["honor1"],
      "courses": ["course1"]
    }
  ],
  "projects": [
    {
      "name": "Project Name",
      "description": "project description",
      "technologies": ["tech1", "tech2"],
      "url": "https://...",
      "github": "https://github.com/...",
      "bullets": ["achievement1"]
    }
  ],
  "achievements": ["achievement1", "achievement2"],
  "technologies": ["all unique technologies found"],
  "domains": ["web development", "machine learning", etc],
  "atsKeywords": ["keyword1", "keyword2"],
  "yearsOfExperience": 3.5,
  "summary": "professional summary",
  "contactInfo": {
    "name": "Full Name",
    "email": "email@example.com",
    "phone": "phone number",
    "linkedin": "linkedin url",
    "github": "github url",
    "portfolio": "portfolio url",
    "location": "City, State"
  }
}

RESUME TEXT:
${resumeText}`;

  return claudeCompleteJSON(prompt, systemPrompt, 8192);
}

export async function claudeAnalyzeJob(jobDescription: string) {
  const systemPrompt = `You are an expert job analyst. Extract all structured information from job descriptions.`;

  const prompt = `Analyze this job description and extract structured information:

{
  "requirements": ["requirement1", "requirement2"],
  "responsibilities": ["responsibility1"],
  "requiredSkills": ["skill1", "skill2"],
  "niceToHaveSkills": ["skill1"],
  "technologies": ["tech1", "tech2"],
  "experienceLevel": "entry|mid|senior|lead",
  "yearsRequired": 2,
  "isRemote": true,
  "requiresSponsorship": false,
  "benefits": ["benefit1"],
  "companySize": "startup|small|medium|large|enterprise",
  "domain": "fintech|healthtech|saas|etc",
  "atsKeywords": ["keyword1", "keyword2"],
  "salaryMin": 80000,
  "salaryMax": 120000
}

JOB DESCRIPTION:
${jobDescription}`;

  return claudeCompleteJSON(prompt, systemPrompt, 4096);
}

export async function claudeMatchJobToResume(
  jobDescription: string,
  resumeData: Record<string, unknown>
) {
  const systemPrompt = `You are an expert ATS and job matching specialist. Analyze how well a resume matches a job description.`;

  const prompt = `Score how well this resume matches the job description.

Return JSON:
{
  "matchScore": 7.5,
  "atsScore": 8.2,
  "confidenceLevel": 0.85,
  "requiredSkills": ["skill1"],
  "missingSkills": ["skill2"],
  "matchingSkills": ["skill3"],
  "matchReason": "Brief explanation of match quality",
  "recommendation": "apply|skip|strong_apply",
  "improvements": ["improvement suggestion 1"]
}

Scale: 1 (perfect match) to 10 (very poor match)

RESUME DATA:
${JSON.stringify(resumeData, null, 2)}

JOB DESCRIPTION:
${jobDescription}`;

  return claudeCompleteJSON(prompt, systemPrompt, 2048);
}

export async function claudeTailorResume(
  originalLatex: string,
  jobDescription: string,
  resumeData: Record<string, unknown>,
  jobAnalysis: Record<string, unknown>
) {
  const systemPrompt = `You are an expert resume writer and ATS optimization specialist. You tailor resumes to specific job descriptions while maintaining complete truthfulness. Never fabricate experience, skills, or achievements.`;

  const prompt = `Tailor this LaTeX resume for the specific job description.

RULES:
- NEVER fabricate or invent any experience, skills, companies, or achievements
- ONLY optimize existing truthful content
- Rewrite bullet points to better highlight relevant skills
- Optimize ATS keywords naturally
- Keep resume EXACTLY one page
- Maximize use of space with no visible empty areas
- Maintain professional LaTeX formatting

Return JSON:
{
  "latexContent": "complete tailored LaTeX code",
  "atsScore": 8.5,
  "keywordsAdded": ["keyword1", "keyword2"],
  "sectionsModified": ["experience", "skills"],
  "tailoringNotes": "What was changed and why"
}

ORIGINAL LATEX:
${originalLatex}

JOB DESCRIPTION:
${jobDescription}

JOB ANALYSIS:
${JSON.stringify(jobAnalysis, null, 2)}

RESUME DATA:
${JSON.stringify(resumeData, null, 2)}`;

  return claudeCompleteJSON(prompt, systemPrompt, 8192);
}

export async function claudeGenerateCoverLetter(
  jobDescription: string,
  companyName: string,
  jobTitle: string,
  resumeData: Record<string, unknown>
) {
  const systemPrompt = `You are an expert cover letter writer. Write compelling, personalized cover letters that highlight relevant experience truthfully.`;

  const prompt = `Write a professional cover letter for this job application.

Return JSON:
{
  "content": "Full cover letter text",
  "highlights": ["key points highlighted"],
  "tone": "formal|semi-formal|enthusiastic"
}

COMPANY: ${companyName}
JOB TITLE: ${jobTitle}

JOB DESCRIPTION:
${jobDescription}

CANDIDATE RESUME DATA:
${JSON.stringify(resumeData, null, 2)}`;

  return claudeCompleteJSON(prompt, systemPrompt, 4096);
}

export async function claudeAnswerQuestion(
  question: string,
  context: Record<string, unknown>,
  previousAnswers: { question: string; answer: string }[]
) {
  const systemPrompt = `You are helping a job applicant answer application screening questions. Always answer truthfully based on the candidate's actual experience and information.`;

  const prompt = `Answer this job application question truthfully based on the candidate's profile.

Return JSON:
{
  "answer": "the answer text",
  "confidence": 0.9,
  "category": "GENERAL|VISA_SPONSORSHIP|WORK_AUTHORIZATION|SALARY|EXPERIENCE|RELOCATION|DEMOGRAPHICS|AVAILABILITY",
  "notes": "any important notes about this answer"
}

QUESTION: ${question}

CANDIDATE PROFILE:
${JSON.stringify(context, null, 2)}

PREVIOUS ANSWERS (for consistency):
${JSON.stringify(previousAnswers, null, 2)}`;

  return claudeCompleteJSON(prompt, systemPrompt, 1024);
}

export async function claudeGenerateLatexResume(
  resumeData: Record<string, unknown>
) {
  const systemPrompt = `You are an expert LaTeX resume designer. Create professional, ATS-friendly, one-page LaTeX resumes.`;

  const prompt = `Create a complete, professional LaTeX resume from this data.

Requirements:
- Exactly one page
- ATS-friendly formatting
- Clean, modern design
- No empty space
- Overleaf-compatible
- Professional fonts (use standard LaTeX fonts)

Return JSON:
{
  "latexContent": "complete LaTeX code",
  "sections": ["sections included"]
}

RESUME DATA:
${JSON.stringify(resumeData, null, 2)}`;

  return claudeCompleteJSON(prompt, systemPrompt, 8192);
}
