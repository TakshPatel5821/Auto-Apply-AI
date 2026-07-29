import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { importGithubProjects } from "@/lib/github/import";
import { ghAuthInfo } from "@/lib/github/client";
import { Logger } from "@/lib/logging/logger";

// Falls back to GITHUB_USERNAME so the repo ships no personal default. The UI
// always sends an explicit username; this only covers direct API calls.
const DEFAULT_USER = process.env.GITHUB_USERNAME || "";

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

  // GitHub usernames are alphanumeric with single hyphens, max 39 chars. Validate
  // before it reaches the API client so a crafted value can't shape the URL path.
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/.test(username)) {
    return NextResponse.json(
      { error: "Provide a valid GitHub username (or set GITHUB_USERNAME)." },
      { status: 400 }
    );
  }

  try {
    let authenticatedAs: string | null = null;
    let ownedRepos = 0;
    let warning: string | undefined;
    if (token) {
      const info = await ghAuthInfo(token);
      if (!info.login) {
        return NextResponse.json({ error: "GitHub token invalid or expired — double-check it." }, { status: 400 });
      }
      authenticatedAs = info.login;
      ownedRepos = info.ownedRepos;
      if (info.scopes.length > 0 && !info.scopes.includes("repo")) {
        warning = "Token is missing the 'repo' scope, so only public repos imported. Use a classic token with the 'repo' box ticked.";
      }
    }
    const { projects, stats } = await importGithubProjects(username, token, { includeForks });
    // Token couldn't see most of the account's repos → almost always a fine-grained
    // token without 'All repositories' access (or a classic token without 'repo').
    if (token && !warning && ownedRepos > 0 && stats.fetched < ownedRepos - 2) {
      warning = `GitHub returned only ${stats.fetched} of your ~${ownedRepos} repos — your token can't see your private ones. Use a CLASSIC token with the 'repo' scope, or a fine-grained token with Repository access = All repositories.`;
    }
    return NextResponse.json({ success: true, count: projects.length, stats, authenticatedAs, ownedRepos, warning, projects });
  } catch (e) {
    await Logger.error("GITHUB", `Fetch failed for ${username}: ${e}`);
    return NextResponse.json(
      { error: `GitHub fetch failed: ${e instanceof Error ? e.message : e}` },
      { status: 500 }
    );
  }
}
