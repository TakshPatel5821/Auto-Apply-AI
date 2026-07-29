import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";

// Delete an application. With deleteJob=true, also removes the job (the whole
// "company" entry) — its application/tailored/cover-letter rows cascade away.
// Otherwise just the application is removed and the job stays in the job list.
export async function POST(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { applicationId, deleteJob } = (await req.json().catch(() => ({}))) as {
    applicationId?: string;
    deleteJob?: boolean;
  };
  if (!applicationId) return NextResponse.json({ error: "missing applicationId" }, { status: 400 });

  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { id: true, jobId: true },
  });
  if (!app) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (deleteJob) {
    // Deleting the job cascades to its application + tailored résumé + cover letter.
    await prisma.job.delete({ where: { id: app.jobId } });
  } else {
    await prisma.application.delete({ where: { id: applicationId } });
  }

  return NextResponse.json({ ok: true });
}
