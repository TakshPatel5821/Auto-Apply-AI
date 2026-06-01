import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";

const ALLOWED = [
  "PENDING",
  "APPROVED",
  "IN_PROGRESS",
  "SUBMITTED",
  "CONFIRMED",
  "INTERVIEW_SCHEDULED",
  "OFFER_RECEIVED",
  "REJECTED",
  "FAILED",
  "WITHDRAWN",
];

// POST { applicationId, status } → manually set an application's status
// (keeps the funnel analytics accurate).
export async function POST(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { applicationId, status } = await req.json();
  if (!applicationId || !ALLOWED.includes(status)) {
    return NextResponse.json({ error: "applicationId and a valid status are required" }, { status: 400 });
  }

  await prisma.application.update({
    where: { id: applicationId },
    data: { status },
  });

  return NextResponse.json({ success: true });
}
