import { describe, it, expect } from "vitest";
import { extractJobsFromHtml } from "@/lib/scraping/generic-jsonld";

const URL = "https://careers.example.com/jobs/123";

describe("extractJobsFromHtml — JSON-LD", () => {
  const jsonLd = `
  <html><head><script type="application/ld+json">
  {
    "@context":"https://schema.org/","@type":"JobPosting",
    "title":"Senior Backend Engineer",
    "description":"<p>Build reliable APIs and mentor engineers.</p>",
    "datePosted":"2026-06-01","employmentType":"FULL_TIME",
    "hiringOrganization":{"@type":"Organization","name":"Acme Corp"},
    "jobLocation":{"@type":"Place","address":{"@type":"PostalAddress","addressLocality":"Austin","addressRegion":"TX","addressCountry":"US"}},
    "baseSalary":{"@type":"MonetaryAmount","currency":"USD","value":{"@type":"QuantitativeValue","minValue":120000,"maxValue":150000,"unitText":"YEAR"}},
    "identifier":{"@type":"PropertyValue","value":"REQ-123"}
  }
  </script></head><body><h1>Senior Backend Engineer</h1></body></html>`;

  it("extracts the core fields from a JobPosting", () => {
    const jobs = extractJobsFromHtml(jsonLd, URL);
    expect(jobs).toHaveLength(1);
    const j = jobs[0];
    expect(j.platform).toBe("jsonld");
    expect(j.jobTitle).toBe("Senior Backend Engineer");
    expect(j.companyName).toBe("Acme Corp");
    expect(j.location).toContain("Austin");
    expect(j.platformJobId).toBe("REQ-123");
    expect(j.salaryMin).toBe(120000);
    expect(j.salaryMax).toBe(150000);
    expect(j.description).toContain("Build reliable APIs");
  });

  it("finds a JobPosting nested in @graph", () => {
    const html = `<script type="application/ld+json">
      {"@context":"https://schema.org","@graph":[
        {"@type":"WebPage","name":"x"},
        {"@type":"JobPosting","title":"Data Scientist","hiringOrganization":{"name":"DataCo"},"description":"Train models"}
      ]}</script>`;
    const jobs = extractJobsFromHtml(html, URL);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].jobTitle).toBe("Data Scientist");
    expect(jobs[0].companyName).toBe("DataCo");
  });
});

describe("extractJobsFromHtml — microdata + heuristic", () => {
  it("parses schema.org microdata", () => {
    const html = `<div itemscope itemtype="https://schema.org/JobPosting">
      <h1 itemprop="title">Frontend Developer</h1>
      <div itemprop="hiringOrganization" itemscope itemtype="https://schema.org/Organization"><span itemprop="name">WebCo</span></div>
      <div itemprop="description">Build UIs with React and TypeScript.</div>
    </div>`;
    const jobs = extractJobsFromHtml(html, URL);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].platform).toBe("microdata");
    expect(jobs[0].jobTitle).toBe("Frontend Developer");
    expect(jobs[0].companyName).toBe("WebCo");
  });

  it("uses the heuristic only when the page clearly is a job", () => {
    const html = `<html><head><meta property="og:site_name" content="CoolCo">
      <title>Staff Engineer - CoolCo Careers</title></head>
      <body><h1>Staff Engineer</h1>
      <main>We are looking for a Staff Engineer to build distributed systems and mentor a team. Requirements: 8+ years of experience with backend services.</main>
      <a href="#">Apply now</a></body></html>`;
    const jobs = extractJobsFromHtml(html, "https://coolco.com/careers/staff-eng");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].platform).toBe("generic");
    expect(jobs[0].jobTitle).toContain("Staff Engineer");
  });

  it("returns nothing for a non-job page", () => {
    const html = `<html><head><title>About Us</title></head><body><h1>Our Story</h1><p>We make coffee.</p></body></html>`;
    expect(extractJobsFromHtml(html, "https://example.com/about")).toHaveLength(0);
  });
});
