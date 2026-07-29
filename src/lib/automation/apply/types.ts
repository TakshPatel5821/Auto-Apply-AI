// Shared types + small data-access helpers for the apply engine. Kept separate
// from the engine class so the flow modules can import them without pulling in
// the whole engine.

import { existsSync } from "fs";
import { join, isAbsolute } from "path";
import type { ElementHandle } from "playwright";
import { prisma } from "@/lib/db/prisma";

// Element handle type as returned by page.$$ — used for OTP input detection.
export type OtpHandle = ElementHandle<SVGElement | HTMLElement>;

// The application row + the relations the apply flow needs, loaded once per run.
export async function getApplicationWithRelations(id: string) {
  return prisma.application.findUnique({
    where: { id },
    include: {
      job: true,
      tailoredResume: { select: { pdfPath: true, texPath: true } },
      coverLetter: { select: { pdfPath: true, content: true } },
      resume: { select: { parsedData: true } },
    },
  });
}

export type ApplicationWithRelations = Awaited<ReturnType<typeof getApplicationWithRelations>>;

export interface DetectedField {
  type: string;
  label: string;
  name?: string;
  required: boolean;
  options?: string[];
  selector: string;
  // Phase 3: richer context signals so the classifier understands the blank.
  placeholder?: string;
  ariaLabel?: string;
  sectionHeading?: string;
  // Phase 6: the field's character limit (maxlength), for open-ended answers.
  maxLength?: number;
  // Hardening: the raw DOM input type (date/range/tel…), options scraped from a
  // <datalist> or ARIA listbox, and how confident we are in the resolved label.
  inputType?: string;
  possibleDropdownOptions?: string[];
  labelConfidence?: number;
  // Which browser frame this field lives in (assigned by the engine after a
  // cross-frame scan). Undefined / "" means the main frame. Used so the engine
  // fills inside the iframe that actually owns the form (Workday, iCIMS, …).
  frameKey?: string;
}

// Phase 9: a single per-field decision for the debug/replay view.
export interface FieldDecisionRecord {
  t: string;
  step: number;
  label: string;
  category: string;
  domKind: string;
  source: string | null;       // profile[x] | memory | resume | AI | consent | prefilled
  confidence: number | null;
  decision: string;            // filled | verified | pause | reject | skip | consent | prefilled
  valuePreview: string | null; // truncated; "‹hidden›" for sensitive categories
  reason: string | null;
  // Hardening: detection confidence in the resolved label, and which frame the
  // field lived in ("" / null = main frame, else "idx|url") — both aid debugging
  // the cross-frame + shadow-DOM detection.
  labelConfidence?: number | null;
  frame?: string | null;
}

// Résumé PDF paths are stored relative to the project root ("applications/..").
// existsSync on a relative path is cwd-dependent, so resolve to absolute first.
export function resolveResumePath(p?: string | null): string | null {
  if (!p) return null;
  const abs = isAbsolute(p) ? p : join(process.cwd(), p);
  return existsSync(abs) ? abs : null;
}
