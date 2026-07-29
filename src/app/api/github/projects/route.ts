import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";

// GET → the imported GitHub project catalog (selected first, then most recent).
export async function GET() {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const projects = await prisma.githubProject.findMany({
    orderBy: [{ selected: "desc" }, { pushedAt: "desc" }],
  });
  return NextResponse.json({ projects });
}

// POST { id, selected?, name?, bullet? } → toggle a project's selection, or inline-
// edit its cleaned title / bullet.
export async function POST(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const id = String(body.id || "");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const data: { selected?: boolean; name?: string; bullet?: string } = {};
  if (typeof body.selected === "boolean") data.selected = body.selected;
  if (typeof body.name === "string" && body.name.trim()) data.name = body.name.trim();
  if (typeof body.bullet === "string" && body.bullet.trim()) data.bullet = body.bullet.trim();

  const project = await prisma.githubProject.update({ where: { id }, data });
  return NextResponse.json({ success: true, project });
}
