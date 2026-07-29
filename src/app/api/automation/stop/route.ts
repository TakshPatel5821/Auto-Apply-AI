import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { automationEngine } from "@/lib/automation/automation-engine";

export async function POST(_req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await automationEngine.stop();
  return NextResponse.json({ success: true, message: "Automation stopped" });
}
