import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { discoveryMonitor } from "@/lib/scraping/discovery-monitor";

// GET  /api/discovery/monitor  → current monitor status + recent alerts
// POST /api/discovery/monitor  { action: "start" | "stop", intervalMinutes?, platforms? }
//   Continuously rescrapes the configured sources; raises an ALERT for each
//   newly-posted job that matches (dedup is handled by the orchestrator).

export async function GET() {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(discoveryMonitor.status());
}

export async function POST(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const action = body.action as string | undefined;

  if (action === "stop") {
    return NextResponse.json(discoveryMonitor.stop());
  }
  if (action === "start") {
    const status = await discoveryMonitor.start({
      intervalMinutes: typeof body.intervalMinutes === "number" ? body.intervalMinutes : undefined,
      platforms: Array.isArray(body.platforms) ? body.platforms : undefined,
    });
    return NextResponse.json(status);
  }
  return NextResponse.json({ error: "action must be 'start' or 'stop'" }, { status: 400 });
}
