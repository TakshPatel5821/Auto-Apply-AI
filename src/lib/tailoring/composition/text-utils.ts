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

// Words that can't end a clean fragment: cutting right after one leaves a
// dangling clause ("...integrating hardware with.").
const DANGLING =
  /\s+(?:a|an|the|and|or|but|nor|with|without|of|for|to|in|on|at|by|from|into|onto|over|under|via|as|using|including|across|between|through|while|that|which|who|whose|its|their|our|my|your|his|her)$/i;

// Like truncate but with NO ellipsis and trailing punctuation stripped — for
// embedding a clean fragment inside another sentence ("Recent work: <clip>.").
// When it has to cut, it cuts at a word boundary and then drops any trailing
// connective words, so the fragment never ends mid-clause.
export function clip(s: string, max: number): string {
  const t = (s || "").trim();
  const strip = (x: string) => x.replace(/[.,;:]+$/, "").trim();
  if (t.length <= max) return strip(t);
  const cut = t.slice(0, max);
  let out = strip(cut.slice(0, Math.max(0, cut.lastIndexOf(" "))) || cut);
  let prev = "";
  while (out !== prev) {
    prev = out;
    out = strip(out.replace(DANGLING, ""));
  }
  return out;
}
