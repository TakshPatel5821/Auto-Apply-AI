import { NextRequest, NextResponse } from "next/server";
import { existsSync, unlinkSync } from "fs";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";

// Delete a resume. TailoredResume rows cascade-delete; applications keep their
// row (their optional resume/tailoredResume links are set null). If the deleted
// resume was active, the most recent remaining one is promoted to active so the
// app always has an active resume when any exist.
export async function POST(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = (await req.json().catch(() => ({}))) as { id?: string };
  if (!id) return NextResponse.json({ error: "missing id" }, { status: 400 });

  const existing = await prisma.resume.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  await prisma.resume.delete({ where: { id } });

  // Best-effort remove the stored file from disk.
  try {
    if (existing.originalPath && existsSync(existing.originalPath)) {
      unlinkSync(existing.originalPath);
    }
  } catch {
    /* non-fatal */
  }

  // If we deleted the active resume, promote the newest remaining one.
  if (existing.isActive) {
    const next = await prisma.resume.findFirst({
      where: { userId: existing.userId },
      orderBy: { createdAt: "desc" },
    });
    if (next) {
      await prisma.resume.update({ where: { id: next.id }, data: { isActive: true } });
    }
  }

  return NextResponse.json({ ok: true });
}
