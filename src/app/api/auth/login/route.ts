import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { createSession, setSessionCookie } from "@/lib/auth/session";
import { getOrCreateUser } from "@/lib/storage/memory";

export async function POST(req: NextRequest) {
  const { password } = await req.json();

  const storedPassword = process.env.AUTH_PASSWORD;
  if (!storedPassword) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const isValid = password === storedPassword;

  if (!isValid) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  await getOrCreateUser();

  const token = await createSession();
  await setSessionCookie(token);

  return NextResponse.json({ success: true });
}
