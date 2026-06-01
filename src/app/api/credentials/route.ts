import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { saveCredentials, credentialsStatus, migratePlaintextCredentials } from "@/lib/security/credentials";

// GET → presence only (never returns secret values).
export async function GET() {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ status: await credentialsStatus() });
}

// POST:
//   { action: "migrate" }                              → pull .env creds into encrypted store
//   { linkedinEmail?, linkedinPassword?, atsEmail?, atsPassword? } → save encrypted
export async function POST(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await req.json();

  if (body.action === "migrate") {
    const migrated = await migratePlaintextCredentials();
    return NextResponse.json({ success: true, migrated, status: await credentialsStatus() });
  }

  await saveCredentials({
    linkedinEmail: body.linkedinEmail,
    linkedinPassword: body.linkedinPassword,
    atsEmail: body.atsEmail,
    atsPassword: body.atsPassword,
  });
  return NextResponse.json({ success: true, status: await credentialsStatus() });
}
