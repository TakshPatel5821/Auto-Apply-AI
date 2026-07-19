import { describe, it, expect } from "vitest";
import { suggestCustomSelectors } from "@/lib/scraping/selector-suggester";

describe("suggestCustomSelectors — auto-generate a custom-site config", () => {
  it("finds the repeated job-card pattern and a title selector", () => {
    const html = `<ul class="results">
      <li class="job-card"><h3 class="title">Backend Engineer</h3><span class="company">Acme</span><a href="/j/1">View</a></li>
      <li class="job-card"><h3 class="title">Frontend Engineer</h3><span class="company">Acme</span><a href="/j/2">View</a></li>
      <li class="job-card"><h3 class="title">Data Scientist</h3><span class="company">Acme</span><a href="/j/3">View</a></li>
      <li class="job-card"><h3 class="title">Product Manager</h3><span class="company">Acme</span><a href="/j/4">View</a></li>
    </ul>`;
    const s = suggestCustomSelectors(html);
    expect(s.card).toBe("li.job-card");
    expect(s.cardCount).toBe(4);
    expect(s.title).toBe("h3");
    expect(s.link).toBe("a");
    expect(s.sampleTitles).toContain("Backend Engineer");
  });

  it("prefers a job-ish container over generic repeated wrappers", () => {
    const html = `<div class="sidebar"><a href="/x">x</a></div><div class="sidebar"><a href="/y">y</a></div><div class="sidebar"><a href="/z">z</a></div>
      <div class="posting"><h2>Role A</h2><a href="/a">a</a></div>
      <div class="posting"><h2>Role B</h2><a href="/b">b</a></div>
      <div class="posting"><h2>Role C</h2><a href="/c">c</a></div>`;
    const s = suggestCustomSelectors(html);
    expect(s.card).toBe("div.posting");
  });

  it("returns an empty suggestion when there's no repeated list", () => {
    const html = `<div><a href="/only">single</a></div>`;
    const s = suggestCustomSelectors(html);
    expect(s.card).toBeUndefined();
    expect(s.cardCount).toBe(0);
  });
});
