import type { FactBook, JobAnalysis } from "../types";

// Escape text for LaTeX. Backslash first, then the special characters.
function escapeLatex(s: string): string {
  return (s || "")
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([&%$#_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

// Drop links equal except for protocol / "www." / a trailing slash so the header
// never prints the same URL twice.
function dedupeLinks(items: (string | undefined | null)[]): string[] {
  const norm = (s: string) =>
    s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const v = (item || "").trim();
    if (!v) continue;
    const key = norm(v);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

// A professional cover-letter layout that mirrors the résumé: centered name +
// contact header, today's date, recipient block, a single greeting, the 3 body
// paragraphs (already clean — composeLetter emits no greeting/sign-off/labels),
// and a single sign-off. Contact comes from the FactBook candidate.
export function renderLetterLatex(letter: string, facts: FactBook, analysis: JobAnalysis): string {
  const c = facts.candidate;
  const name = escapeLatex(c.fullName || "Applicant");
  const contactLine = [c.phone, c.email, c.location]
    .filter(Boolean)
    .map((s) => escapeLatex(s as string))
    .join(" $|$ ");
  const linkLine = dedupeLinks([c.github, c.linkedin]).map((s) => escapeLatex(s)).join(" $|$ ");

  const date = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  const paragraphs = (letter || "")
    .split(/\n\s*\n/)
    .map((p) => escapeLatex(p.replace(/\s*\n\s*/g, " ").trim()))
    .filter(Boolean)
    .join("\n\n");

  const header = [`{\\LARGE\\bfseries ${name}}`];
  if (contactLine) header.push(contactLine);
  if (linkLine) header.push(linkLine);

  const L: string[] = [
    "\\documentclass[11pt]{article}",
    "\\usepackage[margin=1in]{geometry}",
    "\\usepackage{parskip}",
    "\\setlength{\\parskip}{0.7em}",
    "\\pagestyle{empty}",
    "\\begin{document}",
    "",
    "{\\centering",
    header.join("\\\\[3pt]\n"),
    "\\par}",
    "\\vspace{1.4em}",
    "",
    escapeLatex(date),
    "",
    "Hiring Manager\\\\",
    `${escapeLatex(analysis.companyName)}\\\\`,
    `Re: ${escapeLatex(analysis.jobTitle)}`,
    "",
    "Dear Hiring Manager,",
    "",
    paragraphs,
    "",
    "\\vspace{0.6em}",
    "Sincerely,\\\\[1.4em]",
    name,
    "",
    "\\end{document}",
  ];
  return L.join("\n");
}
