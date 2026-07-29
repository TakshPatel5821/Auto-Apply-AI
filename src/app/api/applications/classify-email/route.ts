import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { claudeClassifyEmail } from "@/lib/ai/claude";
import { applyClassificationToApplication } from "@/lib/gmail/sync";

export const runtime = "nodejs";
export const maxDuration = 120;

// POST { emailText, apply?: boolean }
// Classifies a job-related email (interview / offer / rejection / etc.) and, if
// apply=true and it can match the email to an application by company, updates
// that application's status. v1 = paste an email; live Gmail/Outlook sync is a
// follow-up (needs OAuth credentials).
export async function POST(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { emailText, apply } = await req.json();
  if (!emailText || typeof emailText !== "string" || emailText.trim().length < 10) {
    return NextResponse.json({ error: "emailText is required" }, { status: 400 });
  }

  let result;
  try {
    result = await claudeClassifyEmail(emailText);
  } catch (e) {
    return NextResponse.json({ error: `Classification failed: ${String(e)}` }, { status: 500 });
  }

  // Try to apply the detected status to a matching application (shared with the
  // live Gmail sync so paste + auto-scan behave identically).
  const updated = apply ? await applyClassificationToApplication(result) : null;

  return NextResponse.json({ result, updated });
}
