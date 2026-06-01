import { NextRequest, NextResponse } from "next/server";
import {
  classifyField,
  isSensitive,
  aiMayAnswer,
  type FieldContext,
} from "@/lib/automation/field-classifier";
import { resolveField } from "@/lib/profile/profile";
import { loadProfile } from "@/lib/profile/profile-store";

// ─── Phase 3: browser-extension DOM understanding endpoint ────────────────────
// The extension is a READ-ONLY assistant, not the submitter. It scrapes the form
// fields on a job page and posts their context here; we run the SAME classifier
// the apply engine uses (single source of truth) and tell it, per field:
//   - the category + whether AI may answer it + whether it's sensitive/legal
//   - whether the structured profile already has a value (so it would autofill)
// The extension overlays this so a human can SEE what would happen before relying
// on the automation. No auth: localhost dev helper, only field metadata is sent.

interface IncomingField extends FieldContext {
  selector?: string;
}

export async function POST(req: NextRequest) {
  let body: { fields?: IncomingField[] };
  try {
    body = await req.json();
  } catch {
    return cors(NextResponse.json({ error: "invalid JSON" }, { status: 400 }));
  }
  const fields = Array.isArray(body.fields) ? body.fields : [];

  // Best-effort profile lookup so we can flag fields that would autofill.
  const profile = await loadProfile().catch(() => ({}));

  const classified = fields.map((f) => {
    const cls = classifyField(f);
    const resolution = resolveField(f.label || "", profile);
    const hasProfileValue = !!resolution?.field?.value?.trim();
    return {
      selector: f.selector,
      label: f.label,
      category: cls.category,
      domKind: cls.domKind,
      isYesNo: cls.isYesNo,
      sensitive: isSensitive(cls.category),
      aiAllowed: aiMayAnswer(cls.category),
      profileKey: resolution?.spec.key ?? null,
      hasProfileValue,
      // What the engine would do at a glance:
      //   profile  → autofilled from your saved profile
      //   ai       → AI may draft (open-ended)
      //   pause    → you'll be asked (sensitive/unknown, no saved value)
      outlook: hasProfileValue
        ? "profile"
        : isSensitive(cls.category)
        ? "pause"
        : aiMayAnswer(cls.category)
        ? "ai"
        : "pause",
    };
  });

  return cors(NextResponse.json({ count: classified.length, fields: classified }));
}

// The extension's fetch is cross-origin (job site → localhost), so allow it.
export async function OPTIONS() {
  return cors(new NextResponse(null, { status: 204 }));
}

function cors(res: NextResponse): NextResponse {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return res;
}
