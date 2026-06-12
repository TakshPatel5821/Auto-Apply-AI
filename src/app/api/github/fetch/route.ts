import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { importGithubProjects } from "@/lib/github/import";
import { Logger } from "@/lib/logging/logger";

const DEFAULT_USER = "TakshPatel5821";

// POST { username?, token? } → scan the user's GitHub, clean each repo (+ README)
// into a presentable project entry, upsert them, and return the catalog.
export async function POST(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const username = String(body.username || DEFAULT_USER).trim();
  const token = body.token ? String(body.token).trim() : undefined;

  try {
    const projects = await importGithubProjects(username, token);
    return NextResponse.json({ success: true, count: projects.length, projects });
  } catch (e) {
    await Logger.error("GITHUB", `Fetch failed for ${username}: ${e}`);
    return NextResponse.json(
      { error: `GitHub fetch failed: ${e instanceof Error ? e.message : e}` },
      { status: 500 }
    );
  }
}
