import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { catalogStats } from "@/lib/scraping/company-catalog";
import { importCompanies } from "@/lib/scraping/board-prober";

// GET  /api/discovery/catalog            → per-source board-token counts
// POST /api/discovery/catalog  { names } → probe company names, add validated boards
//   This is how discovery scales toward Tsenta's 50k boards: feed company names,
//   the prober resolves which ATS each uses and persists the hits to the catalog.

export async function GET() {
  if (!(await getSession())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ sources: catalogStats() });
}

export async function POST(req: NextRequest) {
  if (!(await getSession())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const names: string[] = Array.isArray(body.names)
    ? body.names
    : typeof body.names === "string"
      ? body.names.split(/[\n,]/).map((s: string) => s.trim()).filter(Boolean)
      : [];
  if (!names.length) {
    return NextResponse.json({ error: "Provide `names`: an array (or comma/newline-separated string) of company names" }, { status: 400 });
  }
  const result = await importCompanies(names, { concurrency: typeof body.concurrency === "number" ? body.concurrency : 4 });
  return NextResponse.json(result);
}
