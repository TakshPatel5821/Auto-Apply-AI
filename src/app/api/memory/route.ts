import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getAllMemories, saveAnswer, deleteMemory, updateMemory } from "@/lib/storage/memory";
import { MemoryCategory } from "@/types";

export async function GET(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const category = searchParams.get("category") as MemoryCategory | null;

  const memories = await getAllMemories(category || undefined);
  return NextResponse.json({ memories });
}

export async function POST(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { question, answer, category, platform } = await req.json();

  if (!question || !answer) {
    return NextResponse.json({ error: "question and answer required" }, { status: 400 });
  }

  await saveAnswer(question, answer, category || "GENERAL", platform);
  return NextResponse.json({ success: true });
}

export async function PUT(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, answer } = await req.json();
  if (!id || !answer) {
    return NextResponse.json({ error: "id and answer required" }, { status: 400 });
  }

  await updateMemory(id, answer);
  return NextResponse.json({ success: true });
}

export async function DELETE(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await req.json();
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  await deleteMemory(id);
  return NextResponse.json({ success: true });
}
