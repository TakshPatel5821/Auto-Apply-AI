import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { generateJobsExcel, generateApplicationsExcel } from "@/lib/export/excel";

export async function GET(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type") || "jobs";

  let buffer: Buffer;
  let filename: string;

  if (type === "applications") {
    buffer = await generateApplicationsExcel();
    filename = `applications_${new Date().toISOString().slice(0, 10)}.xlsx`;
  } else {
    buffer = await generateJobsExcel();
    filename = `jobs_${new Date().toISOString().slice(0, 10)}.xlsx`;
  }

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
