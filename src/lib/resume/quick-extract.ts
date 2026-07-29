// Instant regex-based extraction — runs before AI, no latency

export interface QuickExtract {
  name: string;
  email: string;
  phone: string;
  linkedin: string;
  github: string;
  skills: string[];
  technologies: string[];
  yearsOfExperience: number;
}

const TECH_KEYWORDS = [
  "javascript","typescript","python","java","c++","c#","go","golang","rust","ruby","php","swift","kotlin",
  "react","nextjs","next.js","vue","angular","svelte","html","css","tailwind","bootstrap",
  "node","nodejs","express","fastapi","django","flask","spring","rails","laravel",
  "postgresql","mysql","mongodb","redis","sqlite","dynamodb","cassandra","elasticsearch",
  "aws","gcp","azure","docker","kubernetes","terraform","ci/cd","github actions","jenkins",
  "graphql","rest","grpc","websocket","kafka","rabbitmq","nginx","linux",
  "git","jest","pytest","selenium","playwright","figma","jira","agile","scrum",
  "machine learning","tensorflow","pytorch","pandas","numpy","scikit","llm","openai",
  "sql","nosql","prisma","typeorm","sequelize","supabase","firebase",
];

export function quickExtract(text: string): QuickExtract {
  const lower = text.toLowerCase();

  // Email
  const emailMatch = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
  const email = emailMatch ? emailMatch[0] : "";

  // Phone
  const phoneMatch = text.match(/(\+?1?\s?)?(\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/);
  const phone = phoneMatch ? phoneMatch[0].trim() : "";

  // LinkedIn
  const linkedinMatch = text.match(/linkedin\.com\/in\/[\w-]+/i);
  const linkedin = linkedinMatch ? `https://${linkedinMatch[0]}` : "";

  // GitHub
  const githubMatch = text.match(/github\.com\/[\w-]+/i);
  const github = githubMatch ? `https://${githubMatch[0]}` : "";

  // Name: first non-empty line that looks like a name
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  let name = "";
  for (const line of lines.slice(0, 5)) {
    // Name-like: 2–4 words, no special chars except hyphen/apostrophe
    if (/^[A-Z][a-z]+(\s[A-Z][a-zA-Z'-]+){1,3}$/.test(line) && !line.includes("@")) {
      name = line;
      break;
    }
  }

  // Technologies: scan for known keywords. Keywords contain regex metacharacters
  // (C++, C#, .NET, F#), so we must escape ALL of them — escaping only "." left
  // "/\bc++\b/" which throws "Nothing to repeat". \b also fails around symbols
  // (no word boundary between "+" and a space), so we use token-aware lookarounds
  // that treat letters/digits/+/#/. as part of a token.
  const found = new Set<string>();
  for (const kw of TECH_KEYWORDS) {
    try {
      const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Boundary set excludes "." so a trailing sentence period ("React.")
      // still matches, while ".NET"/"Node.js" keep their dots (matched literally).
      const pattern = new RegExp(`(?<![a-z0-9#+])${esc}(?![a-z0-9#+])`, "i");
      if (pattern.test(lower)) found.add(kw);
    } catch {
      // A malformed keyword must never break resume upload — fall back to a
      // plain case-insensitive substring check.
      if (lower.includes(kw.toLowerCase())) found.add(kw);
    }
  }
  const technologies = Array.from(found);

  // Years of experience: look for "X years" patterns
  let yearsOfExperience = 0;
  const yearMatches = text.matchAll(/(\d+(?:\.\d+)?)\+?\s*years?\s*(?:of\s*)?(?:experience|exp)/gi);
  for (const m of yearMatches) {
    const y = parseFloat(m[1]);
    if (y > yearsOfExperience && y < 40) yearsOfExperience = y;
  }
  // Fallback: count date ranges in experience section
  if (yearsOfExperience === 0) {
    const dateRanges = text.matchAll(/(20\d\d)\s*[-–]\s*(20\d\d|present|current)/gi);
    let totalYears = 0;
    const now = new Date().getFullYear();
    for (const m of dateRanges) {
      const start = parseInt(m[1]);
      const end = m[2].toLowerCase().includes("present") || m[2].toLowerCase().includes("current")
        ? now
        : parseInt(m[2]);
      if (!isNaN(start) && !isNaN(end) && end >= start && end - start < 15) {
        totalYears += end - start;
      }
    }
    yearsOfExperience = Math.min(totalYears, 20);
  }

  // Skills: extract from "Skills:" section lines
  const skills: string[] = [];
  const skillsSection = text.match(/skills?[:\s]*([^\n]{10,200})/i);
  if (skillsSection) {
    const raw = skillsSection[1];
    const extracted = raw
      .split(/[,|•·/]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 1 && s.length < 40 && !/^\d/.test(s));
    skills.push(...extracted.slice(0, 20));
  }
  // Also add techs as skills if skills is thin
  if (skills.length < 5) {
    skills.push(...technologies.slice(0, 15));
  }

  return { name, email, phone, linkedin, github, skills: [...new Set(skills)], technologies, yearsOfExperience };
}
