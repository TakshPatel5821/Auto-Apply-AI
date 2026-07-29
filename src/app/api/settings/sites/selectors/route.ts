import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { CustomSite } from "@/types";
import { politeGet } from "@/lib/scraping/http-client";
import { suggestCustomSelectors } from "@/lib/scraping/selector-suggester";
import { CustomScraper } from "@/lib/scraping/custom-scraper";

// Visual selector-picker support:
//   { action: "suggest", url }   → auto-generate card/title/link selectors from
//                                  the jobs page's HTML (the "point at the cards"
//                                  step, done heuristically).
//   { action: "preview", site }  → run the custom scraper with a candidate
//                                  config and return the first jobs it extracts,
//                                  so the user can verify before saving.
export async function POST(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "suggest");

  if (action === "suggest") {
    const url = String(body.url || "").trim();
    if (!/^https?:\/\//i.test(url)) {
      return NextResponse.json({ error: "A valid http(s) `url` is required" }, { status: 400 });
    }
    const html = await politeGet<string>(url, { responseType: "text", respectRobots: true, timeout: 20000 });
    if (!html || typeof html !== "string") {
      return NextResponse.json({ error: "Could not fetch that page (blocked, offline, or robots-disallowed)" }, { status: 502 });
    }
    return NextResponse.json({ suggestion: suggestCustomSelectors(html) });
  }

  if (action === "preview") {
    const site = body.site as CustomSite | undefined;
    if (!site?.url) {
      return NextResponse.json({ error: "A `site` object with at least a url is required" }, { status: 400 });
    }
    const jobs = await new CustomScraper().scrapeJobs(site).catch(() => []);
    return NextResponse.json({
      count: jobs.length,
      sample: jobs.slice(0, 5).map((j) => ({ jobTitle: j.jobTitle, companyName: j.companyName, location: j.location, url: j.url })),
    });
  }

  return NextResponse.json({ error: `Unknown action "${action}"` }, { status: 400 });
}
