import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { loadProfile, saveProfile, seedProfileFromActiveResume } from "@/lib/profile/profile-store";
import { FIELD_SPECS, Profile, ProfileField } from "@/lib/profile/profile";

// GET → { profile, specs } so the UI can render every known field with its
// current value/lock/confidence, even ones not yet set.
export async function GET() {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const profile = await loadProfile();
  return NextResponse.json({
    profile,
    specs: FIELD_SPECS.map((s) => ({
      key: s.key,
      label: s.label,
      category: s.category,
      kind: s.kind,
      compliance: !!s.compliance,
    })),
  });
}

// POST actions:
//   { action: "seed" }                         → seed from active résumé
//   { action: "set", key, value, locked? }     → set/update one field
//   { action: "lock", key, locked }            → toggle lock
//   { action: "delete", key }                  → remove a field
export async function POST(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await req.json();

  if (body.action === "seed") {
    const profile = await seedProfileFromActiveResume();
    return NextResponse.json({ profile });
  }

  const profile: Profile = await loadProfile();
  const spec = FIELD_SPECS.find((s) => s.key === body.key);

  if (body.action === "set") {
    if (!spec) return NextResponse.json({ error: "Unknown field key" }, { status: 400 });
    const prev = profile[body.key];
    const next: ProfileField = {
      value: String(body.value ?? ""),
      category: spec.category,
      kind: spec.kind,
      confidence: 1, // user-entered = authoritative
      locked: body.locked ?? prev?.locked ?? false,
    };
    profile[body.key] = next;
  } else if (body.action === "lock") {
    if (profile[body.key]) profile[body.key].locked = !!body.locked;
  } else if (body.action === "delete") {
    delete profile[body.key];
  } else {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  await saveProfile(profile);
  return NextResponse.json({ profile });
}
