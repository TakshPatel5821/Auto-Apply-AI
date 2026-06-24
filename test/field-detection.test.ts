import { describe, it, expect } from "vitest";
import { parseHTML } from "linkedom";
import { scanDetectFields, type ScannedField } from "@/lib/automation/apply/dom-scripts";

// scanDetectFields runs in the page (browser) via page.evaluate, but it only
// touches DOM globals — so we can exercise it under linkedom by injecting
// `document`/`window` as globals. linkedom has no layout engine, so the scanner's
// layout-availability guard treats every element as visible (exactly what we want
// for a deterministic, browser-free unit test of the detection logic itself).
function withGlobals<T>(bodyHtml: string, fn: (doc: Document) => T): T {
  const { document, window } = parseHTML(`<!DOCTYPE html><html><body>${bodyHtml}</body></html>`);
  const g = globalThis as unknown as { document?: unknown; window?: unknown };
  const saved = { document: g.document, window: g.window };
  g.document = document;
  g.window = window;
  try {
    return fn(document as unknown as Document);
  } finally {
    g.document = saved.document;
    g.window = saved.window;
  }
}

const detect = (html: string): ScannedField[] => withGlobals(html, () => scanDetectFields("body"));
const byLabel = (fields: ScannedField[], label: string) => fields.find((f) => f.label === label);

describe("scanDetectFields — core inputs", () => {
  it("resolves an explicit <label for> at full confidence", () => {
    const fields = detect(`<label for="fn">First Name</label><input id="fn" name="first">`);
    const f = byLabel(fields, "First Name");
    expect(f).toBeTruthy();
    expect(f!.selector).toBe("#fn");
    expect(f!.labelConfidence).toBe(1);
  });

  it("falls back to placeholder with lower confidence", () => {
    const fields = detect(`<input id="x" placeholder="Your email">`);
    const f = fields.find((ff) => ff.selector === "#x");
    expect(f!.label).toBe("Your email");
    expect(f!.labelConfidence).toBeLessThan(0.5);
  });

  it("captures select options", () => {
    const fields = detect(
      `<label for="st">State</label><select id="st"><option>Select…</option><option>Texas</option><option>Ohio</option></select>`
    );
    const f = byLabel(fields, "State")!;
    expect(f.type).toBe("select");
    expect(f.options).toContain("Texas");
  });

  it("exposes the raw inputType for date inputs", () => {
    const fields = detect(`<label for="d">Start Date</label><input type="date" id="d">`);
    const f = byLabel(fields, "Start Date")!;
    expect(f.inputType).toBe("date");
  });

  it("scrapes <datalist> options into possibleDropdownOptions", () => {
    const fields = detect(
      `<label for="br">Browser</label><input id="br" list="brs"><datalist id="brs"><option value="Chrome"></option><option value="Firefox"></option></datalist>`
    );
    const f = byLabel(fields, "Browser")!;
    expect(f.possibleDropdownOptions).toEqual(["Chrome", "Firefox"]);
  });

  it("ignores hidden/submit/file inputs", () => {
    const fields = detect(
      `<input type="hidden" name="csrf"><input type="submit" value="Go"><input type="file" id="cv">`
    );
    // file inputs are handled elsewhere; the standard scan should skip these three
    expect(fields.find((f) => f.name === "csrf")).toBeFalsy();
    expect(fields.find((f) => f.selector === "#cv")).toBeFalsy();
  });
});

describe("scanDetectFields — grouped + ARIA controls", () => {
  it("groups native radios by name (no fieldset required)", () => {
    const fields = detect(
      `<fieldset><legend>Authorized to work?</legend>
        <label for="ay">Yes</label><input type="radio" id="ay" name="auth" value="yes">
        <label for="an">No</label><input type="radio" id="an" name="auth" value="no">
      </fieldset>`
    );
    const radio = fields.find((f) => f.type === "radio");
    expect(radio).toBeTruthy();
    expect(radio!.label).toBe("Authorized to work?");
    expect(radio!.options).toEqual(["Yes", "No"]);
    // one logical question, not two separate radio descriptors
    expect(fields.filter((f) => f.type === "radio").length).toBe(1);
  });

  it("detects an ARIA radiogroup (div[role=radiogroup])", () => {
    const fields = detect(
      `<div role="radiogroup" id="rg" aria-label="Preferred shift">
        <div role="radio" aria-label="Morning"></div>
        <div role="radio" aria-label="Evening"></div>
      </div>`
    );
    const f = fields.find((ff) => ff.type === "aria-radio");
    expect(f).toBeTruthy();
    expect(f!.label).toBe("Preferred shift");
    expect(f!.options).toEqual(["Morning", "Evening"]);
    expect(f!.selector).toBe("#rg");
  });

  it("detects a pure ARIA combobox (button + listbox, no inner input)", () => {
    const fields = detect(
      `<span id="cl">Country</span>
       <div role="combobox" id="cb" aria-labelledby="cl" aria-controls="lb"></div>
       <ul role="listbox" id="lb"><li role="option">United States</li><li role="option">Canada</li></ul>`
    );
    const f = fields.find((ff) => ff.type === "aria-combobox");
    expect(f).toBeTruthy();
    expect(f!.label).toBe("Country");
    expect(f!.possibleDropdownOptions).toEqual(["United States", "Canada"]);
  });

  it("does NOT treat an input-backed combobox as aria-combobox (its inner input is detected instead)", () => {
    const fields = detect(
      `<div role="combobox"><label for="ci">City</label><input id="ci"></div>`
    );
    expect(fields.find((f) => f.type === "aria-combobox")).toBeFalsy();
    expect(byLabel(fields, "City")).toBeTruthy();
  });

  it("detects a standalone consent checkbox", () => {
    const fields = detect(`<label for="ag">I agree to the terms</label><input type="checkbox" id="ag">`);
    const f = fields.find((ff) => ff.type === "checkbox");
    expect(f!.label).toBe("I agree to the terms");
  });
});

describe("scanDetectFields — shadow DOM", () => {
  it("sees inputs inside an open shadow root", () => {
    const fields = withGlobals("", (doc) => {
      const host = doc.createElement("div");
      doc.body.appendChild(host);
      const el = host as unknown as { attachShadow?: (init: { mode: string }) => { innerHTML: string } };
      if (typeof el.attachShadow !== "function") return null; // test DOM can't do shadow — skip
      const sr = el.attachShadow({ mode: "open" });
      sr.innerHTML = `<label for="s1">Shadow Field</label><input id="s1">`;
      return scanDetectFields("body");
    });
    if (fields === null) return; // environment without shadow DOM support
    expect(fields.some((f) => f.label === "Shadow Field")).toBe(true);
  });
});
