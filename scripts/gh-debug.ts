// Diagnostic: shows exactly what GitHub returns for your account.
//   npx tsx scripts/gh-debug.ts <your-token>
// (token is only used to call GitHub; nothing is stored or sent anywhere else)
async function main() {
  const token = process.argv[2] || process.env.GITHUB_TOKEN;
  if (!token) {
    console.error("usage: npx tsx scripts/gh-debug.ts <github-token>");
    process.exit(1);
  }
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "gh-debug",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const meRes = await fetch("https://api.github.com/user", { headers });
  if (!meRes.ok) {
    console.error(`/user failed: ${meRes.status} ${await meRes.text()}`);
    process.exit(1);
  }
  const me = (await meRes.json()) as Record<string, unknown>;
  console.log("=== WHO AM I ===");
  console.log("login:", me.login);
  console.log("token scopes:", meRes.headers.get("x-oauth-scopes") || "(fine-grained / none)");
  console.log("public_repos:", me.public_repos);
  console.log("total_private_repos:", me.total_private_repos);
  console.log("owned_private_repos:", me.owned_private_repos);

  // Fetch via the same endpoint the app uses.
  const all: Record<string, unknown>[] = [];
  for (let p = 1; p <= 10; p++) {
    const r = await fetch(
      `https://api.github.com/user/repos?per_page=100&page=${p}&visibility=all&affiliation=owner,collaborator,organization_member&sort=pushed`,
      { headers }
    );
    if (!r.ok) { console.error(`/user/repos page ${p}: ${r.status} ${await r.text()}`); break; }
    const arr = (await r.json()) as Record<string, unknown>[];
    if (!Array.isArray(arr) || arr.length === 0) break;
    all.push(...arr);
    if (arr.length < 100) break;
  }

  const n = (f: (r: Record<string, unknown>) => boolean) => all.filter(f).length;
  console.log("\n=== /user/repos RETURNED ===");
  console.log("total:", all.length);
  console.log("  private:", n((r) => Boolean(r.private)), "| forks:", n((r) => Boolean(r.fork)), "| archived:", n((r) => Boolean(r.archived)));
  console.log("  owned by you:", n((r) => (r.owner as { login?: string })?.login === me.login));
  console.log("\n=== REPOS ===");
  for (const r of all) {
    const o = (r.owner as { login?: string })?.login;
    console.log(`- ${r.full_name} ${r.private ? "[private]" : "[public]"}${r.fork ? " [fork]" : ""}${r.archived ? " [archived]" : ""} owner=${o}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
