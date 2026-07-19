/**
 * Headless agent CLI — the "CLI surface" half of Tsenta's MCP/CLI offering.
 *
 * Drives the SAME engine the web app uses (orchestrator, tailoring, ApplyEngine),
 * talking directly to the shared database. Runs in its own process, so it works
 * headless (cron, a server box, or piped into another agent) without the Next.js
 * server running.
 *
 *   npx tsx scripts/agent-cli.ts discover --keywords "react,node" --platforms greenhouse,lever,workday --max 30
 *   npx tsx scripts/agent-cli.ts jobs --fit --limit 20
 *   npx tsx scripts/agent-cli.ts apply <jobId>
 *   npx tsx scripts/agent-cli.ts watch --interval 30
 *
 * Or via the npm alias:  npm run agent -- discover --max 20
 */

import { prisma } from "@/lib/db/prisma";
import { discoveryMonitor } from "@/lib/scraping/discovery-monitor";
import { listSources } from "@/lib/scraping/registry";
import { discover, listJobs, applyToJob } from "@/lib/agent/core";
import { notifyDesktop } from "@/lib/agent/notify";
import { catalogStats } from "@/lib/scraping/company-catalog";
import { importCompanies } from "@/lib/scraping/board-prober";
import { readFileSync, existsSync } from "fs";

// ── tiny arg parser: positional args + --key value / --key=value / --flag ──────
function parseArgs(argv: string[]): { _: string[]; opts: Record<string, string | boolean> } {
  const _: string[] = [];
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        opts[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          opts[a.slice(2)] = next;
          i++;
        } else {
          opts[a.slice(2)] = true;
        }
      }
    } else {
      _.push(a);
    }
  }
  return { _, opts };
}

const list = (v: string | boolean | undefined): string[] =>
  typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
const num = (v: string | boolean | undefined): number | undefined =>
  typeof v === "string" ? parseInt(v, 10) : undefined;

// ── commands ───────────────────────────────────────────────────────────────────
async function cmdDiscover(opts: Record<string, string | boolean>) {
  const platforms = list(opts.platforms);
  console.log(`▶ discover: [${platforms.join(", ") || "default"}] kw=[${list(opts.keywords).join(", ") || "settings"}] max=${num(opts.max) ?? 30}`);
  const res = await discover({
    keywords: list(opts.keywords),
    locations: list(opts.locations),
    platforms,
    maxJobs: num(opts.max),
  });
  for (const id of res.fitJobIds) console.log(`  ✓ fit job ${id}`);
  console.log(`done — ${res.newCount} new | ${res.fitCount} fit | ${res.notFitCount} not fit`);
}

async function cmdJobs(opts: Record<string, string | boolean>) {
  const jobs = await listJobs({ fit: Boolean(opts.fit), limit: num(opts.limit) });
  if (!jobs.length) return console.log("No jobs found. Run `discover` first.");
  for (const j of jobs) {
    console.log(`[${j.matchScore.toString().padStart(2)}/10] ${j.status.padEnd(9)} ${j.jobTitle} @ ${j.companyName} (${j.platform}) — ${j.location || "?"}  ${j.id}`);
  }
}

async function cmdApply(jobId: string) {
  if (!jobId) return console.error("usage: apply <jobId>");
  console.log(`▶ tailoring + submitting ${jobId}…`);
  const res = await applyToJob(jobId);
  console.log(res.message);
}

async function cmdWatch(opts: Record<string, string | boolean>) {
  const interval = num(opts.interval) ?? 30;
  await discoveryMonitor.start({ intervalMinutes: interval, platforms: list(opts.platforms) });
  console.log(`👀 watching every ${interval}m — Ctrl+C to stop. New matches fire a desktop notification:`);
  const seen = new Set<string>();
  // Poll the monitor's in-process alert buffer; desktop-notify anything new.
  setInterval(() => {
    for (const a of [...discoveryMonitor.status().recentAlerts].reverse()) {
      if (seen.has(a.jobId)) continue;
      seen.add(a.jobId);
      notifyDesktop(`New match (${a.matchScore}/10)`, `${a.jobTitle} @ ${a.companyName}`);
    }
  }, 5000);
  await new Promise(() => {}); // keep the process alive until killed
}

async function cmdCatalog() {
  const stats = catalogStats();
  let total = 0;
  for (const s of stats) {
    total += s.total;
    console.log(`${s.sourceId.padEnd(16)} ${String(s.total).padStart(6)}  (builtin ${s.builtin} + imported ${s.external})`);
  }
  console.log(`${"TOTAL".padEnd(16)} ${String(total).padStart(6)} board tokens`);
}

async function cmdImport(opts: Record<string, string | boolean>) {
  // Names come from --slugs a,b,c  or  --file path (one name per line / CSV first column).
  let names: string[] = list(opts.slugs);
  if (typeof opts.file === "string") {
    if (!existsSync(opts.file)) {
      console.error(`File not found: ${opts.file}`);
      console.error(`(cwd: ${process.cwd()}) — pass a path to a text/CSV file with one company name per line.`);
      console.error(`A starter list ships with the repo: --file data/companies.seed.txt`);
      return;
    }
    const raw = readFileSync(opts.file, "utf-8");
    // Skip blank lines and #comments; take the first CSV column as the name.
    names = names.concat(
      raw.split(/\r?\n/).map((l) => l.split(",")[0].trim()).filter((l) => l && !l.startsWith("#"))
    );
  }
  if (!names.length) return console.error("usage: import-companies --slugs a,b,c  |  --file data/companies.seed.txt");
  console.log(`▶ probing ${names.length} companies across ATSes (this hits live APIs, politely)…`);
  const res = await importCompanies(names, {
    concurrency: num(opts.concurrency) ?? 4,
    onProgress: (d, t) => { if (d % 10 === 0 || d === t) process.stdout.write(`\r  probed ${d}/${t}`); },
  });
  process.stdout.write("\n");
  console.log(`done — ${res.resolved}/${res.probed} resolved · ${res.boardsFound} boards found · ${res.added} new added`);
  for (const [src, n] of Object.entries(res.perSource)) console.log(`  +${n} ${src}`);
}

function cmdHelp() {
  console.log(`agent-cli — headless job-application agent

commands:
  discover [--keywords a,b] [--platforms x,y] [--locations a,b] [--max N]   one scrape pass
  jobs [--fit] [--limit N]                                                  list jobs in the DB
  apply <jobId>                                                             tailor + submit one job
  watch [--interval MIN] [--platforms x,y]                                  continuous discovery (foreground)
  sources                                                                   list available scraper sources
  catalog                                                                   show company-catalog board counts per source
  import-companies [--slugs a,b,c] [--file f] [--concurrency N]             probe company names → add validated boards
  help

examples:
  npx tsx scripts/agent-cli.ts discover --platforms greenhouse,lever,workday --max 30
  npx tsx scripts/agent-cli.ts jobs --fit
  npx tsx scripts/agent-cli.ts apply ckxyz123
  npx tsx scripts/agent-cli.ts import-companies --slugs stripe,figma,vercel,notion`);
}

async function main() {
  const { _, opts } = parseArgs(process.argv.slice(2));
  const cmd = _[0] || "help";
  try {
    switch (cmd) {
      case "discover": await cmdDiscover(opts); break;
      case "jobs": await cmdJobs(opts); break;
      case "apply": await cmdApply(_[1]); break;
      case "watch": await cmdWatch(opts); return; // never resolves
      case "sources":
        for (const s of listSources()) console.log(`${s.id.padEnd(16)} ${s.kind.padEnd(8)} ${s.hasSearch ? "searchable" : "url-only"}  ${s.label}`);
        break;
      case "catalog": await cmdCatalog(); break;
      case "import-companies": case "import": await cmdImport(opts); break;
      case "help": default: cmdHelp(); break;
    }
  } finally {
    if (cmd !== "watch") await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("agent-cli error:", e);
  process.exit(1);
});
