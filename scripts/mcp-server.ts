// MCP server — the "MCP" half of Tsenta's agent surface. Exposes the job-agent
// engine as Model Context Protocol tools over stdio, so any MCP-capable client
// (Claude Desktop, an agent framework, etc.) can discover jobs, list them, apply,
// and drive the continuous monitor. Tools delegate to the shared agent core, so
// they behave identically to the CLI.
//
//   Run: npx tsx scripts/mcp-server.ts
//   Claude Desktop config → command: "npx", args: ["tsx", "<abs>/scripts/mcp-server.ts"]

// CRITICAL: MCP stdio uses STDOUT for the JSON-RPC protocol. The engine's Logger
// writes via console.log — route that to stderr so it can't corrupt the stream.
// This must run before any engine module is imported.
console.log = (...args: unknown[]) => console.error(...args);

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { discover, listJobs, applyToJob } from "@/lib/agent/core";
import { discoveryMonitor } from "@/lib/scraping/discovery-monitor";
import { listSources } from "@/lib/scraping/registry";
import { catalogStats } from "@/lib/scraping/company-catalog";
import { importCompanies } from "@/lib/scraping/board-prober";

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

const server = new McpServer({ name: "ai-job-agent", version: "1.0.0" });

server.tool(
  "discover",
  "Run one job-discovery pass across the configured ATS/board sources (Greenhouse, Lever, Ashby, Workday, …). Persists + scores new jobs and returns counts plus the ids of newly-found fit jobs.",
  {
    keywords: z.array(z.string()).optional().describe("Search keywords; defaults to saved settings"),
    locations: z.array(z.string()).optional().describe("Locations; defaults to saved settings"),
    platforms: z.array(z.string()).optional().describe("Source ids to search, e.g. ['greenhouse','workday']"),
    maxJobs: z.number().int().positive().optional().describe("Max jobs this pass (default 30)"),
  },
  async (args) => json(await discover(args)),
);

server.tool(
  "list_jobs",
  "List jobs currently in the database, best-match first.",
  {
    fit: z.boolean().optional().describe("Only fit jobs (matchScore ≤ 6)"),
    limit: z.number().int().positive().optional().describe("Max rows (default 25)"),
  },
  async (args) => json(await listJobs(args)),
);

server.tool(
  "apply",
  "Tailor a résumé + cover letter for one job and submit the application via the browser apply engine. Returns the outcome (submitted, or skipped-if-ineligible).",
  { jobId: z.string().describe("The job id (from list_jobs / discover)") },
  async ({ jobId }) => json(await applyToJob(jobId)),
);

server.tool(
  "monitor_start",
  "Start continuous discovery: rescrape on an interval and surface freshly-posted matching jobs.",
  {
    intervalMinutes: z.number().int().positive().optional().describe("Cycle interval, min 5 (default 30)"),
    platforms: z.array(z.string()).optional().describe("Source ids to monitor"),
  },
  async (args) => json(await discoveryMonitor.start(args)),
);

server.tool("monitor_stop", "Stop the continuous discovery monitor.", {}, async () => json(discoveryMonitor.stop()));

server.tool(
  "monitor_status",
  "Get the continuous-discovery monitor status, including recent new-match alerts.",
  {},
  async () => json(discoveryMonitor.status()),
);

server.tool(
  "sources",
  "List the available scraper sources and whether each supports keyword search.",
  {},
  async () => json(listSources()),
);

server.tool(
  "catalog_stats",
  "Show how many company board tokens the discovery catalog holds per source (built-in + imported).",
  {},
  async () => json(catalogStats()),
);

server.tool(
  "import_companies",
  "Scale discovery: probe company names against every ATS and append the validated boards to the catalog. Returns how many resolved/were added.",
  {
    names: z.array(z.string()).min(1).describe("Company names or slugs to probe (e.g. ['stripe','figma'])"),
    concurrency: z.number().int().positive().optional().describe("Parallel probes (default 4)"),
  },
  async ({ names, concurrency }) => json(await importCompanies(names, { concurrency })),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp] ai-job-agent server connected over stdio");
}

main().catch((e) => {
  console.error("[mcp] fatal:", e);
  process.exit(1);
});
