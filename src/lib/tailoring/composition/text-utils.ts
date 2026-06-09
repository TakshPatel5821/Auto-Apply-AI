// Deterministic text helpers for the composition layer. No LLM, no randomness —
// the same selection always yields the same prose.

// "A" → "A"; "A, B" → "A and B"; "A, B, C" → "A, B, and C" (Oxford comma).
export function humanList(items: string[]): string {
  const xs = items.filter((s) => s && s.trim().length > 0);
  if (xs.length === 0) return "";
  if (xs.length === 1) return xs[0];
  if (xs.length === 2) return `${xs[0]} and ${xs[1]}`;
  return `${xs.slice(0, -1).join(", ")}, and ${xs[xs.length - 1]}`;
}

// Lowercase only the first character (so a verb-initial achievement flows after
// "I "). Leaves acronyms/proper nouns later in the string untouched.
export function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

// Trim to <= max chars at a word boundary, appending an ASCII ellipsis only when
// actually truncated. ASCII (not "…") so it is safe in the résumé LaTeX.
export function truncate(s: string, max: number): string {
  const t = (s || "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[.,;:]+$/, "") + "...";
}
