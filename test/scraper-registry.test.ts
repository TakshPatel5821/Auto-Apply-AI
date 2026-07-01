import { describe, it, expect } from "vitest";
import { sourceForUrl, listSources } from "@/lib/scraping/registry";
import { leverCompanyFromUrl } from "@/lib/scraping/lever";
import { ashbyCompanyFromUrl } from "@/lib/scraping/ashby";
import { workableCompanyFromUrl } from "@/lib/scraping/workable";
import { recruiteeCompanyFromUrl } from "@/lib/scraping/recruitee";

describe("registry — URL routing (supports)", () => {
  const cases: [string, string][] = [
    ["https://jobs.lever.co/netflix/abc-123", "lever"],
    ["https://boards.greenhouse.io/stripe/jobs/456", "greenhouse"],
    ["https://jobs.ashbyhq.com/openai/role", "ashby"],
    ["https://acme.recruitee.com/o/backend-engineer", "recruitee"],
    ["https://apply.workable.com/acme/j/ABC123/", "workable"],
    ["https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite", "workday"],
    ["https://jobs.smartrecruiters.com/Visa/74000-engineer", "smartrecruiters"],
    ["https://remoteok.com/remote-jobs/123-dev", "remoteok"],
    ["https://remotive.com/remote-jobs/software-dev/x-123", "remotive"],
    ["https://weworkremotely.com/remote-jobs/acme-engineer", "weworkremotely"],
    ["https://news.ycombinator.com/item?id=123", "hackernews"],
    // Anything unrecognized falls through to the universal JSON-LD scraper.
    ["https://careers.randomstartup.com/jobs/eng", "generic"],
  ];
  for (const [url, id] of cases) {
    it(`${url} → ${id}`, () => {
      expect(sourceForUrl(url).id).toBe(id);
    });
  }
});

describe("registry — company token extraction", () => {
  it("lever", () => expect(leverCompanyFromUrl("https://jobs.lever.co/netflix/abc")).toBe("netflix"));
  it("ashby", () => expect(ashbyCompanyFromUrl("https://jobs.ashbyhq.com/OpenAI/x")).toBe("openai"));
  it("workable (subdomain)", () => expect(workableCompanyFromUrl("https://acme.workable.com/jobs")).toBe("acme"));
  it("workable (apply path)", () => expect(workableCompanyFromUrl("https://apply.workable.com/acme/j/X/")).toBe("acme"));
  it("recruitee", () => expect(recruiteeCompanyFromUrl("https://acme.recruitee.com/o/x")).toBe("acme"));
});

describe("registry — catalog", () => {
  it("exposes all expected searchable sources + the generic fallback", () => {
    const ids = listSources().map((s) => s.id);
    for (const id of [
      "greenhouse", "lever", "ashby", "smartrecruiters", "workable",
      "recruitee", "workday", "remoteok", "remotive", "weworkremotely", "hackernews", "generic",
    ]) {
      expect(ids).toContain(id);
    }
    // generic is per-URL only (no keyword search); the boards/feeds are searchable.
    const generic = listSources().find((s) => s.id === "generic")!;
    expect(generic.hasSearch).toBe(false);
    expect(listSources().find((s) => s.id === "lever")!.hasSearch).toBe(true);
  });
});
