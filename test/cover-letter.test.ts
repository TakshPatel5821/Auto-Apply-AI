import { describe, it, expect } from "vitest";
import { stripGreetingClosing, validateCoverLetter } from "@/lib/automation/resume-tailor";
import { detectHallucinations, buildAllowlist } from "@/lib/ai/claude";

describe("stripGreetingClosing", () => {
  it("removes a leading 'Dear ...' greeting", () => {
    const out = stripGreetingClosing("Dear Hiring Manager,\n\nI am excited about Stripe.");
    expect(out.toLowerCase().startsWith("dear")).toBe(false);
    expect(out).toContain("excited about Stripe");
  });

  it("removes a trailing sign-off + name", () => {
    const out = stripGreetingClosing("Body paragraph here.\n\nSincerely,\nPatel Takshkumar");
    expect(out.toLowerCase()).not.toContain("sincerely");
    expect(out.toLowerCase()).not.toContain("patel");
    expect(out).toContain("Body paragraph here.");
  });

  it("leaves a clean body untouched", () => {
    const body = "First paragraph.\n\nSecond paragraph.";
    expect(stripGreetingClosing(body)).toBe(body);
  });
});

describe("validateCoverLetter", () => {
  const company = "Stripe";
  const role = "Technical Solutions Engineer";
  const keywords = ["Python", "APIs", "infrastructure", "debugging"];

  // ~300-word, clean, JD-matching body.
  const good = [
    "I have long admired Stripe's mission to grow the GDP of the internet, and the Technical Solutions Engineer role is exactly where I want to apply my skills. The focus on customer-facing infrastructure and developer experience maps closely to how I like to work: close to real systems, real APIs, and the developers who depend on them every day. The opportunity to help businesses build on Stripe rather than fight their payments stack is genuinely exciting to me, and it is the kind of high-leverage technical work I have been preparing for throughout my degree.",
    "In my internship I architected a Python data-acquisition platform that integrated multi-sensor hardware with real-time cloud pipelines, and I built PHP/MySQL backends with secure authentication, session management, and optimized queries. Debugging distributed data flows end to end, tracing failures across services, and designing clean, well-documented APIs for those systems is precisely the kind of infrastructure and integration work this role centers on. I am comfortable reading other people's code, reproducing tricky issues, and explaining the fix clearly.",
    "At Stripe I would help customers integrate quickly, diagnose subtle issues across services, and turn recurring support problems into better internal tools and documentation so the whole team scales. My background in Python, REST APIs, Linux/UNIX networking, and cloud architecture lets me move fluidly between application code and the underlying infrastructure, which is exactly what customer-facing technical work demands.",
    "Thank you for considering my application. I would welcome the chance to discuss how I can contribute to Stripe's solutions team, and I am available to interview at your convenience.",
  ].join("\n\n");

  it("passes a clean, specific, JD-matching letter", () => {
    const r = validateCoverLetter(good, company, role, keywords);
    expect(r.issues, `issues: ${JSON.stringify(r.issues)}`).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it("flags a greeting/closing left in the body", () => {
    const r = validateCoverLetter(`Dear Hiring Manager,\n\n${good}\n\nSincerely,\nPatel`, company, role, keywords);
    expect(r.valid).toBe(false);
    expect(r.issues.join(" ")).toMatch(/greeting|sign-off/i);
  });

  it("flags a too-short letter", () => {
    const r = validateCoverLetter("I want to work at Stripe as a Technical Solutions Engineer with Python and APIs.", company, role, keywords);
    expect(r.valid).toBe(false);
    expect(r.issues.join(" ")).toMatch(/too short/i);
  });

  it("flags a missing company name", () => {
    const r = validateCoverLetter(good.replace(/Stripe/g, "the company"), company, role, keywords);
    expect(r.issues.join(" ")).toMatch(/company/i);
  });

  it("flags placeholder text", () => {
    const r = validateCoverLetter(good.replace("Stripe's solutions team", "[COMPANY] solutions team"), company, role, keywords);
    expect(r.issues.join(" ")).toMatch(/placeholder/i);
  });

  it("flags too few job keywords", () => {
    const noKw = good.replace(/Python|APIs|infrastructure|debugging|Debugging/g, "things");
    const r = validateCoverLetter(noKw, company, role, keywords);
    expect(r.issues.join(" ")).toMatch(/key terms/i);
  });
});

describe("detectHallucinations", () => {
  // A realistic parsed résumé for the candidate.
  const resume = {
    rawText: "Patel Takshkumar. Python, PHP, MySQL, IoT, Azure AZ-900, Linux.",
    summary: "Software engineer with Python data pipelines and full-stack web experience.",
    skills: ["Python", "PHP", "JavaScript", "SQL"],
    technologies: ["MySQL", "Azure", "Linux", "Wireshark"],
    experience: [
      { company: "Brainy Bean Info Tech", title: "Software Developer Intern", bullets: ["Built Python IoT pipelines"] },
      { company: "Shubhkey Infotech", title: "Website Developer Intern", bullets: ["PHP/MySQL backend"] },
    ],
    projects: [{ name: "Face Recognition Bot", bullets: ["OpenCV"] }],
    education: [{ institution: "UT Arlington", degree: "M.S.", field: "Software Engineering" }],
  };
  const jd = "Senior Software Engineer at CVS Health. Work with Python, REST APIs, and cloud.";

  it("allowlist captures real employers + skills", () => {
    const a = buildAllowlist(resume);
    expect(a.companies).toContain("Brainy Bean Info Tech");
    expect(a.skills.map((s) => s.toLowerCase())).toContain("python");
  });

  it("flags a fabricated employer (XYZ Corp)", () => {
    const issues = detectHallucinations("In my current role at XYZ Corp, I built systems.", resume, jd, "CVS Health");
    expect(issues.join(" ")).toMatch(/XYZ Corp/i);
  });

  it("does NOT flag the target company or a real employer", () => {
    const issues = detectHallucinations(
      "During my time at Brainy Bean Info Tech I built pipelines, and I want to bring that to CVS Health.",
      resume, jd, "CVS Health"
    );
    expect(issues.filter((i) => /employer/i.test(i))).toEqual([]);
  });

  it("flags fabricated metrics (percentages not in résumé)", () => {
    const issues = detectHallucinations("I improved efficiency by 30% and reduced MTTR by 25%.", resume, jd, "CVS Health");
    expect(issues.join(" ")).toMatch(/30%/);
    expect(issues.join(" ")).toMatch(/25%/);
  });

  it("flags invented technologies not in résumé or JD (RPG, Angular)", () => {
    const issues = detectHallucinations("Experienced in RPG, IBM i, and Angular development.", resume, jd, "CVS Health");
    const j = issues.join(" ");
    expect(j).toMatch(/rpg/i);
    expect(j).toMatch(/angular/i);
  });

  it("does NOT flag technologies that ARE in the résumé or JD", () => {
    const issues = detectHallucinations("I use Python and MySQL, and I'm keen on REST APIs.", resume, jd, "CVS Health");
    expect(issues.filter((i) => /technology/i.test(i))).toEqual([]);
  });

  it("clean, accurate letter yields no issues", () => {
    const issues = detectHallucinations(
      "At Brainy Bean Info Tech I built Python data pipelines and PHP/MySQL backends, and I'd love to bring that to CVS Health.",
      resume, jd, "CVS Health"
    );
    expect(issues).toEqual([]);
  });
});
