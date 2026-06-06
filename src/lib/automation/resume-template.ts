// ─── Canonical résumé template (data-driven) ─────────────────────────────────
// The user's hand-tuned, Overleaf-tested résumé. It compiles to ONE page with
// only standard packages. The content lives as STRUCTURED DATA below (single
// source of truth); the renderer reproduces the exact layout.
//
// Per-job tailoring touches only:
//   • the Professional Summary (always),
//   • optionally the SKILL ORDER (a permutation of the real skills), and
//   • optionally the EXPERIENCE/PROJECT bullets (a REWORDING of the real ones).
// All overrides are validated upstream (no invented skills, bullets truth-checked)
// and the result is re-checked to still be one page — otherwise we fall back to
// the canonical content here. So a bad tailor can never fabricate or overflow.
//
// To change your résumé content, edit the data below.

// Escape characters that are special in LaTeX.
export function escapeTex(t: string): string {
  return (t || "").replace(
    /[&%$#_{}]/g,
    (m) => ({ "&": "\\&", "%": "\\%", $: "\\$", "#": "\\#", _: "\\_", "{": "\\{", "}": "\\}" }[m] as string)
  );
}

// A neutral baseline summary — diff baseline + fallback if the AI summary is empty.
export const BASE_SUMMARY =
  "Software Engineer pursuing an M.S. in Software Engineering at UT Arlington with hands-on experience building Python data pipelines, IoT systems, and full-stack web applications. Skilled in cloud (Azure AZ-900), Linux/UNIX, and secure, real-time software delivery.";

// ── Structured résumé content (the real, canonical facts) ─────────────────────
// Headings are raw LaTeX (they contain \textbf/\hfill/\href/\textit). Bullets and
// skill items are PLAIN text and get escaped at render time.

export interface ResumeEntry { heading: string; bullets: string[] }
export interface SkillGroup { label: string; items: string[] }

export const RESUME_EXPERIENCE: ResumeEntry[] = [
  {
    heading:
      "\\textbf{Brainy Bean Info Tech}, Gujarat, India \\hfill Jan 2023 -- Apr 2023\\\\\n\\textit{Software Developer Intern}",
    bullets: [
      "Architected a Python-based IoT data acquisition system integrating multi-sensor hardware with real-time cloud pipelines tracking temperature, humidity, air quality, and atmospheric pressure.",
      "Developed Python/SQL backend pipelines and Tableau/Excel dashboards for live sensor data visualization and remote monitoring.",
      "Applied TCP/IP networking, Wireshark traffic analysis, and secure communication protocols on Linux/UNIX for reliable system operation.",
    ],
  },
  {
    heading:
      "\\textbf{Shubhkey Infotech}, Ahmedabad, India \\hfill Jan 2024 -- Apr 2024\\\\\n\\textit{Website Developer Intern}",
    bullets: [
      "Developed PHP/MySQL backend modules with secure authentication, session management, and input validation; optimized database queries to improve performance and reliability.",
      "Implemented secure user authentication to protect against common web vulnerabilities.",
      "Collaborated with team members to review code quality and enhance overall backend performance.",
    ],
  },
];

export const RESUME_PROJECTS: ResumeEntry[] = [
  {
    heading: "\\textbf{Face Recognition Bot} $|$ \\textit{Python, OpenCV}",
    bullets: [
      "Built a real-time face detection and recognition system using Python and computer vision for security and attendance applications; implemented image processing pipelines for feature extraction and identity matching.",
    ],
  },
  {
    heading: "\\textbf{Advanced Voice Assistant} $|$ \\textit{Python, NLP, Speech APIs}",
    bullets: [
      "Developed an AI-powered voice assistant with speech recognition and text-to-speech APIs supporting natural language commands with low-latency real-time response.",
    ],
  },
  {
    heading: "\\textbf{OurHappyTrip} $|$ \\textit{PHP, MySQL (Independently Built)}",
    bullets: [
      "Independently designed and launched a full-stack car booking platform with role-based authentication, owning the full lifecycle from database schema design to deployment.",
    ],
  },
  {
    heading: "\\textbf{Live Weather App} $|$ \\textit{HTML, JavaScript -- github.com/TakshPatel5821}",
    bullets: [
      "Responsive weather app fetching real-time API data to display temperature, humidity, and forecasts based on user location.",
    ],
  },
];

export const RESUME_SKILLS: SkillGroup[] = [
  { label: "Programming", items: ["Python", "Java", "PHP", "JavaScript", "Shell Scripting", "SQL"] },
  { label: "Web & IoT", items: ["HTML", "CSS", "MySQL", "REST APIs", "IoT Sensor Integration", "Real-Time Data Processing", "Cloud Connectivity"] },
  { label: "Cloud (Azure)", items: ["Azure Architecture & Services", "Compute", "Storage", "Identity & Security", "IaaS", "PaaS", "SaaS (AZ-900)"] },
  { label: "Networking & Security", items: ["TCP/IP", "Linux/UNIX", "Wireshark", "Penetration Testing", "Vulnerability Assessment", "PowerShell"] },
  { label: "Tools", items: ["Git", "GitHub", "Tableau", "Excel", "Power Query", "Microsoft Office Suite"] },
];

const CERTIFICATIONS: string[] = [
  "Microsoft Azure Fundamentals (AZ-900) --- All modules completed (May 2026): Cloud Concepts, Architecture, Compute, Storage, Identity & Access, Networking, Cost Management, Governance, Monitoring.",
  "Microsoft Learn Achievements: Cloud Computing, Cloud Service Types, Benefits of Cloud Services, Core Azure Components, Azure Cost Management --- all passed.",
];

// Per-job overrides. Each is optional; missing entries fall back to canonical.
export interface ResumeOverrides {
  experienceBullets?: string[][]; // per experience entry, in order
  projectBullets?: string[][];    // per project entry, in order
  skills?: string[][];            // per skill group, reordered items
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
{\\Large\\bfseries Patel Takshkumar Girishbhai}\\\\[2pt]
{\\small +1~(214)-883-2966 ~|~ \\href{mailto:takshpatel051102@gmail.com}{takshpatel051102@gmail.com} ~|~ Arlington, TX ~|~ \\href{https://github.com/TakshPatel5821}{github.com/TakshPatel5821}}\\\\
\\par}
\\vspace{4pt}

% SUMMARY
\\section*{Professional Summary}
${safeSummary}

% EDUCATION
\\section*{Education}
\\textbf{University of Texas at Arlington}, Arlington, TX \\hfill Aug 2024 -- May 2026\\\\
\\textit{M.S. in Software Engineering}\\\\[2pt]
\\textbf{Gandhinagar Institute of Technology}, Gujarat, India \\hfill Aug 2020 -- Jun 2024\\\\
\\textit{B.E. in Computer Engineering}

% EXPERIENCE
\\section*{Professional Experience}
${renderEntries(RESUME_EXPERIENCE, overrides?.experienceBullets)}

% PROJECTS
\\section*{Projects}
${renderEntries(RESUME_PROJECTS, overrides?.projectBullets)}

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
