import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { claudeClassifyEmail } from "@/lib/ai/claude";

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

  let updated: { id: string; company: string; status: string } | null = null;

  // Try to apply the detected status to a matching application.
  if (apply && result.newStatus && result.company) {
    const company = result.company.trim();
    const app = await prisma.application.findFirst({
      where: {
        userId: "local",
        job: { companyName: { contains: company, mode: "insensitive" } },
      },
      orderBy: { createdAt: "desc" },
      include: { job: { select: { companyName: true } } },
    });
    if (app) {
      await prisma.application.update({
        where: { id: app.id },
        data: { status: result.newStatus },
      });
      updated = { id: app.id, company: app.job.companyName, status: result.newStatus };
    }
  }

  return NextResponse.json({ result, updated });
}
