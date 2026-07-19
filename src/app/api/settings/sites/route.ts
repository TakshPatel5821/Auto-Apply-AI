import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { CustomSite } from "@/types";
import { randomUUID } from "crypto";

function getSites(settings: { customSites: unknown } | null): CustomSite[] {
  if (!settings) return [];
  try {
    return (settings.customSites as CustomSite[]) || [];
  } catch {
    return [];
  }
}

export async function GET() {
  if (!(await getSession())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const settings = await prisma.userSettings.findUnique({ where: { userId: "local" } });
  return NextResponse.json({ sites: getSites(settings) });
}

export async function POST(req: NextRequest) {
  if (!(await getSession())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name, url, email, password, jobsUrl } = await req.json();
  if (!name || !url || !email || !password) {
    return NextResponse.json({ error: "name, url, email, and password are required" }, { status: 400 });
  }

  const settings = await prisma.userSettings.findUnique({ where: { userId: "local" } });
  const sites = getSites(settings);

  const newSite: CustomSite = {
    id: randomUUID(),
    name: name.trim(),
    url: url.trim(),
    email: email.trim(),
    password,
    jobsUrl: jobsUrl?.trim() || undefined,
    enabled: true,
  };

  sites.push(newSite);

  await prisma.userSettings.upsert({
    where: { userId: "local" },
    update: { customSites: sites as object[] },
    create: { userId: "local", customSites: sites as object[] },
  });

  return NextResponse.json({ site: newSite });
}

export async function PUT(req: NextRequest) {
  if (!(await getSession())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id, enabled, jobsUrl, selectors } = await req.json();
  const settings = await prisma.userSettings.findUnique({ where: { userId: "local" } });
  const sites = getSites(settings).map((s) => {
    if (s.id !== id) return s;
    return {
      ...s,
      ...(enabled !== undefined && { enabled }),
      ...(jobsUrl !== undefined && { jobsUrl }),
      ...(selectors !== undefined && { selectors }),
    };
  });

  await prisma.userSettings.update({
    where: { userId: "local" },
    data: { customSites: sites as object[] },
  });

  return NextResponse.json({ success: true });
}

export async function DELETE(req: NextRequest) {
  if (!(await getSession())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await req.json();
  const settings = await prisma.userSettings.findUnique({ where: { userId: "local" } });
  const sites = getSites(settings).filter((s) => s.id !== id);

  await prisma.userSettings.update({
    where: { userId: "local" },
    data: { customSites: sites as object[] },
  });

  return NextResponse.json({ success: true });
}
