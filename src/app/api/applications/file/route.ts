import { NextRequest, NextResponse } from "next/server";
import { readFileSync, existsSync } from "fs";
import { isAbsolute, join, extname } from "path";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";

// Stream a stored PDF for an application so the UI can preview/compare it:
//   type=resume   → the tailored résumé PDF
//   type=cover    → the cover-letter PDF
//   type=original → the originally uploaded résumé file (the "base" side)
// Paths are stored relative to the project root, so resolve before reading.
function resolve(p?: string | null): string | null {
  if (!p) return null;
  const abs = isAbsolute(p) ? p : join(process.cwd(), p);
  return existsSync(abs) ? abs : null;
}

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".txt": "text/plain",
  ".tex": "text/plain",
};

export async function GET(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const id = req.nextUrl.searchParams.get("id");
  const type = (req.nextUrl.searchParams.get("type") || "resume").toLowerCase();
  if (!id) return NextResponse.json({ error: "missing id" }, { status: 400 });

  const app = await prisma.application.findUnique({
    where: { id },
    include: {
      tailoredResume: { select: { pdfPath: true } },
      coverLetter: { select: { pdfPath: true } },
      resume: { select: { originalPath: true } },
    },
  });
  if (!app) return NextResponse.json({ error: "not found" }, { status: 404 });

  const rawPath =
    type === "cover" ? app.coverLetter?.pdfPath :
    type === "original" ? app.resume?.originalPath :
    app.tailoredResume?.pdfPath;

  const filePath = resolve(rawPath);
  if (!filePath) {
    return NextResponse.json({ error: `no ${type} file available` }, { status: 404 });
  }

  try {
    const buf = readFileSync(filePath);
    const mime = MIME[extname(filePath).toLowerCase()] || "application/octet-stream";
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": mime,
        "Content-Disposition": `inline; filename="${type}${extname(filePath)}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "could not read file" }, { status: 500 });
  }
}
