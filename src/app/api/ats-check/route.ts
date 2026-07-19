import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { analyzeATS } from "@/lib/ai/ats-analyzer";

// Standalone ATS checker: paste ANY job description + ANY résumé/CV text and get
// a keyword-coverage ATS score. No DB job, no stored résumé — purely ad-hoc.
//   POST { jobDescription, cvText }
export async function POST(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const jobDescription = String(body.jobDescription || "").trim();
  const cvText = String(body.cvText || "").trim();

  if (!jobDescription || !cvText) {
    return NextResponse.json({ error: "Both a job description and your CV text are required." }, { status: 400 });
  }

  try {
    // analyzeATS extracts the JD's keywords (one LLM call) and matches them
    // deterministically against the résumé corpus — here the corpus is the raw
    // pasted CV text (resumeData.rawText).
    const analysis = await analyzeATS({ rawText: cvText }, jobDescription);
    return NextResponse.json({ success: true, analysis });
  } catch (e) {
    return NextResponse.json(
      { error: `ATS check failed: ${e instanceof Error ? e.message : e}` },
      { status: 500 }
    );
  }
}
