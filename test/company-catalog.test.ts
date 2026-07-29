import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { companiesFor, catalogStats, addCompanies, loadExternalCatalog } from "@/lib/scraping/company-catalog";

// Point the external catalog at a throwaway temp file for each test.
let tmpFile: string;
beforeEach(() => {
  tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "catalog-")), "company-catalog.json");
  process.env.COMPANY_CATALOG_PATH = tmpFile;
});
afterEach(() => {
  try { fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.COMPANY_CATALOG_PATH;
});

describe("company-catalog", () => {
  it("exposes built-in board tokens per source", () => {
    expect(companiesFor("greenhouse").length).toBeGreaterThan(10);
    expect(companiesFor("greenhouse")).toContain("stripe");
    expect(companiesFor("ashby")).toContain("openai");
  });

  it("lowercases slugs and dedupes", () => {
    addCompanies({ greenhouse: ["NewCo", "newco", "newco"] });
    const gh = companiesFor("greenhouse");
    expect(gh.filter((t) => t === "newco")).toHaveLength(1);
    expect(gh).not.toContain("NewCo");
  });

  it("only persists genuinely new tokens", () => {
    // "stripe" is already built-in → not added; "uniqco" is new.
    const res = addCompanies({ greenhouse: ["stripe", "uniqco"] });
    expect(res.perSource.greenhouse).toBe(1);
    expect(res.added).toBe(1);
    expect(loadExternalCatalog().greenhouse).toEqual(["uniqco"]);
  });

  it("merges external file into companiesFor and stats", () => {
    addCompanies({ lever: ["coolstartup"] });
    expect(companiesFor("lever")).toContain("coolstartup");
    const lever = catalogStats().find((s) => s.sourceId === "lever")!;
    expect(lever.external).toBe(1);
    expect(lever.total).toBe(lever.builtin + lever.external);
  });

  it("keeps Workday board URLs verbatim (not lowercased)", () => {
    const url = "https://Acme.wd1.myworkdayjobs.com/en-US/Careers";
    addCompanies({ workday: [url] });
    expect(companiesFor("workday")).toContain(url);
  });
});
