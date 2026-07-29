import { describe, it, expect } from "vitest";
import { sourceForUrl } from "@/lib/scraping/registry";
import { parseWorkdayUrl } from "@/lib/scraping/workday";

describe("workday — URL routing", () => {
  const urls = [
    "https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite",
    "https://salesforce.wd12.myworkdayjobs.com/en-US/External_Career_Site/job/California/Engineer_JR123",
  ];
  for (const url of urls) {
    it(`${url} → workday`, () => expect(sourceForUrl(url).id).toBe("workday"));
  }
});

describe("workday — parseWorkdayUrl", () => {
  it("parses a board URL with locale", () => {
    const b = parseWorkdayUrl("https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite");
    expect(b).toMatchObject({
      host: "nvidia.wd5.myworkdayjobs.com",
      tenant: "nvidia",
      site: "NVIDIAExternalCareerSite",
      locale: "en-US",
    });
    expect(b?.externalPath).toBeUndefined();
  });

  it("parses a board URL without a locale segment", () => {
    const b = parseWorkdayUrl("https://nike.wd1.myworkdayjobs.com/nike");
    expect(b).toMatchObject({ tenant: "nike", site: "nike", locale: "en-US" });
  });

  it("extracts externalPath from an individual job URL", () => {
    const b = parseWorkdayUrl(
      "https://salesforce.wd12.myworkdayjobs.com/en-US/External_Career_Site/job/California/Engineer_JR123"
    );
    expect(b?.site).toBe("External_Career_Site");
    expect(b?.externalPath).toBe("/job/California/Engineer_JR123");
  });

  it("returns null for non-Workday URLs", () => {
    expect(parseWorkdayUrl("https://jobs.lever.co/netflix/abc")).toBeNull();
    expect(parseWorkdayUrl("not a url")).toBeNull();
  });
});
