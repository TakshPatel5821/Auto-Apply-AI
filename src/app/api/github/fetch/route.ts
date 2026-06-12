import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { importGithubProjects } from "@/lib/github/import";
import { ghAuthInfo } from "@/lib/github/client";
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
  const includeForks = Boolean(body.includeForks);

  try {
    let authenticatedAs: string | null = null;
    let warning: string | undefined;
    if (token) {
      const info = await ghAuthInfo(token);
      if (!info.login) {
        return NextResponse.json({ error: "GitHub token invalid or expired — double-check it." }, { status: 400 });
      }
      authenticatedAs = info.login;
      if (info.scopes.length > 0 && !info.scopes.includes("repo")) {
        warning = "Token is missing the 'repo' scope, so only public repos imported. Regenerate a classic token with the 'repo' box ticked.";
      }
    }
    const { projects, stats } = await importGithubProjects(username, token, { includeForks });
    return NextResponse.json({ success: true, count: projects.length, stats, authenticatedAs, warning, projects });
  } catch (e) {
    await Logger.error("GITHUB", `Fetch failed for ${username}: ${e}`);
    return NextResponse.json(
      { error: `GitHub fetch failed: ${e instanceof Error ? e.message : e}` },
      { status: 500 }
    );
  }
}
