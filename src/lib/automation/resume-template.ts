// ─── Canonical résumé template (data-driven) ─────────────────────────────────
// Renders the hand-tuned, Overleaf-tested one-page résumé from the STRUCTURED
// résumé config (config/resume.json — see lib/profile/resume-config.ts). The
// config is the single source of truth for content; this module owns only the
// LaTeX layout, which compiles to ONE page with standard packages.
//
// Per-job tailoring touches only:
//   • the Professional Summary (always),
//   • optionally the SKILL ORDER (a permutation of the real skills), and
//   • optionally the EXPERIENCE/PROJECT bullets (a REWORDING of the real ones).
// All overrides are validated upstream (no invented skills, bullets truth-checked)
// and the result is re-checked to still be one page — otherwise we fall back to
// the canonical content here. So a bad tailor can never fabricate or overflow.
//
// To change your résumé content, edit config/resume.json — never this file.

import { loadResumeConfig } from "@/lib/profile/resume-config";

// Escape characters that are special in LaTeX.
export function escapeTex(t: string): string {
  return (t || "").replace(
    /[&%$#_{}]/g,
    (m) => ({ "&": "\\&", "%": "\\%", $: "\\$", "#": "\\#", _: "\\_", "{": "\\{", "}": "\\}" }[m] as string)
  );
}

// ── Structured résumé content (the real, canonical facts) ─────────────────────
// Headings are raw LaTeX (they contain \textbf/\hfill/\href/\textit). Bullets and
// skill items are PLAIN text and get escaped at render time. The heading shape is
// load-bearing: facts/load-facts.ts parses name/role/dates back out of it.

export interface ResumeEntry { heading: string; bullets: string[] }
export interface SkillGroup { label: string; items: string[] }

const config = loadResumeConfig();

// A neutral baseline summary — diff baseline + fallback if the AI summary is empty.
export const BASE_SUMMARY = config.baseSummary;

// "Company, Location \hfill Start -- End" + italic role on the next line.
export const RESUME_EXPERIENCE: ResumeEntry[] = config.experience.map((e) => ({
  heading:
    `\\textbf{${escapeTex(e.company)}}${e.location ? `, ${escapeTex(e.location)}` : ""}` +
    ` \\hfill ${escapeTex(e.start)} -- ${escapeTex(e.end)}\\\\\n\\textit{${escapeTex(e.title)}}`,
  bullets: e.bullets,
}));

// "Project Name $|$ Tech stack".
export const RESUME_PROJECTS: ResumeEntry[] = config.projects.map((p) => ({
  heading: `\\textbf{${escapeTex(p.name)}}${p.tech ? ` $|$ \\textit{${escapeTex(p.tech)}}` : ""}`,
  bullets: p.bullets,
}));

export const RESUME_SKILLS: SkillGroup[] = config.skills.map((g) => ({
  label: g.label,
  items: g.items,
}));

const CERTIFICATIONS: string[] = config.certifications;

// Per-job overrides. Each is optional; missing entries fall back to canonical.
export interface ResumeOverrides {
  experienceBullets?: string[][]; // per experience entry, in order
  projectBullets?: string[][];    // per project entry, in order
  skills?: string[][];            // per skill group, reordered items
  projects?: ResumeEntry[];       // full replacement of the Projects section (e.g. selected GitHub projects + canonical)
}

function renderBullets(bullets: string[]): string {
  return `\\begin{itemize}\n${bullets.map((b) => `  \\item ${escapeTex(b)}`).join("\n")}\n\\end{itemize}`;
}

function renderEntries(entries: ResumeEntry[], overrides?: string[][]): string {
  return entries
    .map((e, i) => {
      const b = overrides?.[i];
      const bullets = Array.isArray(b) && b.length ? b : e.bullets;
      return `${e.heading}\n${renderBullets(bullets)}`;
    })
    .join("\n\\vspace{2.5pt}\n");
}

function renderSkills(overrides?: string[][]): string {
  const lines = RESUME_SKILLS.map((g, i) => {
    const items = overrides?.[i]?.length ? overrides[i] : g.items;
    return `  \\item \\textbf{${escapeTex(g.label)}:} ${items.map((s) => escapeTex(s)).join(", ")}`;
  });
  return `\\begin{itemize}\n${lines.join("\n")}\n\\end{itemize}`;
}

// A bare URL like "github.com/foo" needs a scheme to be clickable in the PDF.
function withScheme(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

// The centred contact line: phone | email | location | github | linkedin.
// Spaces inside the phone become LaTeX non-breaking spaces so it never wraps.
function renderContactLine(): string {
  const { phone, email, location, github, linkedin } = config.contact;
  const parts = [
    escapeTex(phone).replace(/ /g, "~"),
    `\\href{mailto:${escapeTex(email)}}{${escapeTex(email)}}`,
    escapeTex(location),
  ];
  if (github) parts.push(`\\href{${withScheme(github)}}{${escapeTex(github)}}`);
  if (linkedin) parts.push(`\\href{${withScheme(linkedin)}}{${escapeTex(linkedin)}}`);
  return parts.join(" ~|~ ");
}

// Education entries, newest first, matching the canonical two-line-per-school layout.
function renderEducation(): string {
  return config.education
    .map(
      (e) =>
        `\\textbf{${escapeTex(e.school)}}${e.location ? `, ${escapeTex(e.location)}` : ""}` +
        ` \\hfill ${escapeTex(e.start)} -- ${escapeTex(e.end)}\\\\\n\\textit{${escapeTex(e.degree)}}`
    )
    .join("\\\\[2pt]\n");
}

// Build the full résumé LaTeX from the canonical data + (optional) per-job
// overrides. With no overrides this reproduces the hand-tuned one-page layout.
export function buildResumeLatex(summary: string, overrides?: ResumeOverrides): string {
  const safeSummary = escapeTex((summary || BASE_SUMMARY).trim());
  return `\\documentclass[letterpaper,10pt]{article}
\\usepackage[top=0.45in,bottom=0.45in,left=0.5in,right=0.5in]{geometry}
\\usepackage{enumitem}
\\usepackage{titlesec}
\\usepackage[hidelinks]{hyperref}
\\usepackage[T1]{fontenc}
\\pagestyle{empty}
\\setlength{\\parindent}{0pt}
\\setlength{\\parskip}{0.9pt}
\\titleformat{\\section}{\\normalsize\\bfseries\\raggedright}{}{0em}{}[\\vspace{0.5pt}\\hrule\\vspace{2.5pt}]
\\titlespacing*{\\section}{0pt}{5.5pt}{2.5pt}
\\setlist[itemize]{leftmargin=1.3em,topsep=1.2pt,itemsep=1pt,parsep=0pt,partopsep=0pt}
\\begin{document}

% HEADER
{\\centering
{\\Large\\bfseries ${escapeTex(config.contact.fullName)}}\\\\[2pt]
{\\small ${renderContactLine()}}\\\\
\\par}
\\vspace{4pt}

% SUMMARY
\\section*{Professional Summary}
${safeSummary}

% EDUCATION
\\section*{Education}
${renderEducation()}

% EXPERIENCE
\\section*{Professional Experience}
${renderEntries(RESUME_EXPERIENCE, overrides?.experienceBullets)}

% PROJECTS
\\section*{Projects}
${renderEntries(overrides?.projects ?? RESUME_PROJECTS, overrides?.projectBullets)}

% SKILLS
\\section*{Technical Skills}
${renderSkills(overrides?.skills)}

% CERTIFICATIONS
\\section*{Certifications \\& Training}
\\begin{itemize}
${CERTIFICATIONS.map((c) => `  \\item ${escapeTex(c)}`).join("\n")}
\\end{itemize}

\\end{document}`;
}
