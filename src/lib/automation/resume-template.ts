// ─── Canonical résumé template ───────────────────────────────────────────────
// This is the user's hand-tuned, Overleaf-tested LaTeX résumé. It compiles to
// EXACTLY one page and uses only standard packages (geometry, enumitem,
// titlesec, hyperref, fontenc) so any LaTeX engine renders it reliably.
//
// Per the proven JobKit approach: every job reuses this exact template and ONLY
// the Professional Summary paragraph is AI-tailored to the posting. The rest
// (education, experience, projects, skills, certs) stays static. This guarantees
// a compilable, single-page résumé every time — unlike asking the model to
// rewrite the whole document, which overflowed pages and produced broken LaTeX.
//
// To change your résumé content, edit THIS file (it's the single source of truth).

// Escape characters that are special in LaTeX. Matches the tested JobKit logic.
export function escapeTex(t: string): string {
  return (t || "").replace(
    /[&%$#_{}]/g,
    (m) => ({ "&": "\\&", "%": "\\%", $: "\\$", "#": "\\#", _: "\\_", "{": "\\{", "}": "\\}" }[m] as string)
  );
}

// A neutral baseline summary — used as the diff baseline and as a fallback if the
// AI summary is empty. Tailoring replaces this with a job-specific version.
export const BASE_SUMMARY =
  "Software Engineer pursuing an M.S. in Software Engineering at UT Arlington with hands-on experience building Python data pipelines, IoT systems, and full-stack web applications. Skilled in cloud (Azure AZ-900), Linux/UNIX, and secure, real-time software delivery.";

// Build the full résumé LaTeX, injecting the (already plain-text) summary.
export function buildResumeLatex(summary: string): string {
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
\\textbf{Brainy Bean Info Tech}, Gujarat, India \\hfill Jan 2023 -- Apr 2023\\\\
\\textit{Software Developer Intern}
\\begin{itemize}
  \\item Architected a Python-based IoT data acquisition system integrating multi-sensor hardware with real-time cloud pipelines tracking temperature, humidity, air quality, and atmospheric pressure.
  \\item Developed Python/SQL backend pipelines and Tableau/Excel dashboards for live sensor data visualization and remote monitoring.
  \\item Applied TCP/IP networking, Wireshark traffic analysis, and secure communication protocols on Linux/UNIX for reliable system operation.
\\end{itemize}
\\vspace{2.5pt}
\\textbf{Shubhkey Infotech}, Ahmedabad, India \\hfill Jan 2024 -- Apr 2024\\\\
\\textit{Website Developer Intern}
\\begin{itemize}
  \\item Developed PHP/MySQL backend modules with secure authentication, session management, and input validation; optimized database queries to improve performance and reliability.
  \\item Implemented secure user authentication to protect against common web vulnerabilities.
  \\item Collaborated with team members to review code quality and enhance overall backend performance.
\\end{itemize}

% PROJECTS
\\section*{Projects}
\\textbf{Face Recognition Bot} $|$ \\textit{Python, OpenCV}
\\begin{itemize}
  \\item Built a real-time face detection and recognition system using Python and computer vision for security and attendance applications; implemented image processing pipelines for feature extraction and identity matching.
\\end{itemize}
\\vspace{2.5pt}
\\textbf{Advanced Voice Assistant} $|$ \\textit{Python, NLP, Speech APIs}
\\begin{itemize}
  \\item Developed an AI-powered voice assistant with speech recognition and text-to-speech APIs supporting natural language commands with low-latency real-time response.
\\end{itemize}
\\vspace{2.5pt}
\\textbf{OurHappyTrip} $|$ \\textit{PHP, MySQL (Independently Built)}
\\begin{itemize}
  \\item Independently designed and launched a full-stack car booking platform with role-based authentication, owning the full lifecycle from database schema design to deployment.
\\end{itemize}
\\vspace{2.5pt}
\\textbf{Live Weather App} $|$ \\textit{HTML, JavaScript -- github.com/TakshPatel5821}
\\begin{itemize}
  \\item Responsive weather app fetching real-time API data to display temperature, humidity, and forecasts based on user location.
\\end{itemize}

% SKILLS
\\section*{Technical Skills}
\\begin{itemize}
  \\item \\textbf{Programming:} Python, Java, PHP, JavaScript, Shell Scripting, SQL
  \\item \\textbf{Web \\& IoT:} HTML, CSS, MySQL, REST APIs, IoT Sensor Integration, Real-Time Data Processing, Cloud Connectivity
  \\item \\textbf{Cloud (Azure):} Azure Architecture \\& Services, Compute, Storage, Identity \\& Security, IaaS, PaaS, SaaS (AZ-900)
  \\item \\textbf{Networking \\& Security:} TCP/IP, Linux/UNIX, Wireshark, Penetration Testing, Vulnerability Assessment, PowerShell
  \\item \\textbf{Tools:} Git, GitHub, Tableau, Excel, Power Query, Microsoft Office Suite
\\end{itemize}

% CERTIFICATIONS
\\section*{Certifications \\& Training}
\\begin{itemize}
  \\item Microsoft Azure Fundamentals (AZ-900) --- All modules completed (May 2026): Cloud Concepts, Architecture, Compute, Storage, Identity \\& Access, Networking, Cost Management, Governance, Monitoring.
  \\item Microsoft Learn Achievements: Cloud Computing, Cloud Service Types, Benefits of Cloud Services, Core Azure Components, Azure Cost Management --- all passed.
\\end{itemize}

\\end{document}`;
}
