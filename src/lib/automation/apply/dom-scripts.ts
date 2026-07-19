// Pure in-browser scanners passed to page.evaluate(). They run in the page
// context, NOT Node — so they may only reference browser globals (document,
// window, CSS, HTML*Element) and their own arguments, never module scope or
// `this`. Extracted from the engine to keep the heavy DOM logic in one place.
//
// scanDetectFields is intentionally self-contained (every helper is nested) so
// it survives Function.prototype.toString() serialization into the browser AND
// can be unit-tested under linkedom by injecting `document`/`window` globals.

// The descriptor scanDetectFields returns for each field. Mirrors DetectedField
// in ../apply/types.ts (kept structurally compatible, not imported, so the
// function stays serializable).
export interface ScannedField {
  type: string;                     // normalized: text/email/select/radio/checkbox/textarea/date/range/aria-radio/aria-combobox…
  inputType?: string;               // the raw DOM input type (e.g. "date", "range", "tel")
  label: string;
  name?: string;
  required: boolean;
  options?: string[];               // select/radio/aria-radio option labels
  possibleDropdownOptions?: string[]; // datalist / aria listbox options scraped for matching
  selector: string;
  placeholder?: string;
  ariaLabel?: string;
  sectionHeading?: string;
  maxLength?: number;
  labelConfidence?: number;         // 0–1 confidence the resolved label is correct
}

// Detect all fillable fields within `scopeSel`: text/select/textarea inputs,
// native + ARIA radio groups, standalone checkboxes, date/range inputs, and
// ARIA comboboxes — each with a resolved label, a usable selector, classifier
// context (placeholder/aria/heading), and a label-confidence score. Traverses
// OPEN shadow roots so web-component forms (Workday, custom design systems) are
// no longer invisible.
export function scanDetectFields(scopeSel: string): ScannedField[] {
  const root: ParentNode = (document.querySelector(scopeSel) as ParentNode) || document.body;
  const results: ScannedField[] = [];

  const clean = (s?: string | null) => (s || "").replace(/\s+/g, " ").trim();

  // CSS.escape isn't present in every runtime (e.g. linkedom under test); fall
  // back to a conservative manual escape so selectors still build.
  const cssEscape = (s: string): string => {
    try {
      const C = (window as unknown as { CSS?: { escape?: (x: string) => string } }).CSS;
      if (C && typeof C.escape === "function") return C.escape(s);
    } catch { /* ignore */ }
    return s.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  };

  // Layout availability: headless DOMs used in unit tests (linkedom) have no
  // layout engine, so every rect is 0×0 and getComputedStyle is empty. Detect
  // that ONCE — visibility filtering then only applies in a real browser, while
  // tests still see every field.
  const hasLayout = (() => {
    try {
      const base = (document.body || document.documentElement) as Element | null;
      if (!base) return false;
      const r = base.getBoundingClientRect();
      return (r.width || r.height) > 0;
    } catch {
      return false;
    }
  })();

  const isVisible = (el: Element): boolean => {
    if (!hasLayout) return true;
    try {
      const style = window.getComputedStyle(el as HTMLElement);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    } catch {
      return true;
    }
  };

  // Collect every element matching `selector` under root AND inside any open
  // shadow root beneath it. A Set dedupes; a stack avoids recursion limits.
  const deepQueryAll = (selector: string): Element[] => {
    const acc = new Set<Element>();
    const stack: ParentNode[] = [root];
    while (stack.length) {
      const node = stack.pop()!;
      try {
        node.querySelectorAll(selector).forEach((el) => acc.add(el));
        node.querySelectorAll("*").forEach((el) => {
          const sr = (el as HTMLElement).shadowRoot;
          if (sr) stack.push(sr);
        });
      } catch { /* exotic node — skip */ }
    }
    return Array.from(acc);
  };

  // Find the closest matching ancestor/self for `el`, piercing shadow hosts.
  const closestDeep = (el: Element, selector: string): Element | null => {
    let cur: Element | null = el;
    while (cur) {
      if (cur.matches && cur.matches(selector)) return cur;
      const parent: Node | null = cur.parentNode;
      if (parent && (parent as ShadowRoot).host) {
        cur = (parent as ShadowRoot).host;          // hop out of a shadow root
      } else {
        cur = cur.parentElement;
      }
    }
    return null;
  };

  // Look up an element by id within the SAME root node as `el` (so labels inside
  // a shadow root resolve correctly — document.getElementById can't see them).
  const byId = (el: Element, id: string): Element | null => {
    if (!id) return null;
    const rootNode = el.getRootNode() as Document | ShadowRoot;
    try {
      return rootNode.querySelector(`#${cssEscape(id)}`);
    } catch {
      return null;
    }
  };

  // Resolve aria-labelledby → concatenated text of the referenced nodes.
  const ariaLabelledByText = (el: Element): string => {
    const ids = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    if (!ids.length) return "";
    return ids
      .map((id) => byId(el, id)?.textContent || "")
      .map(clean)
      .filter(Boolean)
      .join(" ");
  };

  // Resolve a label AND how confident we are in it (1.0 = explicit <label for>,
  // down to 0.3 for a name-attr fallback). The engine uses this to decide
  // whether to trust-fill or fill-and-verify.
  const getLabel = (el: Element): { text: string; confidence: number } => {
    const elId = (el as HTMLInputElement).id;
    if (elId) {
      const rootNode = el.getRootNode() as Document | ShadowRoot;
      let explicit: Element | null = null;
      try { explicit = rootNode.querySelector(`label[for="${cssEscape(elId)}"]`); } catch { explicit = null; }
      if (explicit) return { text: clean(explicit.textContent), confidence: 1 };
    }
    const wrap = el.closest("label");
    if (wrap) return { text: clean(wrap.textContent), confidence: 0.9 };
    const byLabelledBy = ariaLabelledByText(el);
    if (byLabelledBy) return { text: byLabelledBy, confidence: 0.8 };
    const parent = closestDeep(
      el,
      ".form-group, .jobs-easy-apply-form-element, [class*='field'], [class*='question'], [class*='select'], [class*='combobox'], fieldset, [data-automation-id], [role='group']"
    );
    if (parent) {
      const lbl = parent.querySelector(
        "label, legend, .label, h3, h4, [class*='label'], [class*='title'], [id*='label']"
      );
      if (lbl && lbl !== el) return { text: clean(lbl.textContent), confidence: 0.7 };
    }
    const aria = clean((el as HTMLInputElement).getAttribute("aria-label"));
    if (aria) return { text: aria, confidence: 0.5 };
    const placeholder = clean((el as HTMLInputElement).placeholder);
    if (placeholder) return { text: placeholder, confidence: 0.4 };
    const name = clean((el as HTMLInputElement).name);
    if (name) return { text: name, confidence: 0.3 };
    return { text: "", confidence: 0 };
  };

  // Nearest section heading ABOVE the field — only consulted by the classifier
  // when the field's own text is inconclusive, so it can't override a clear
  // label. Conservative: search within the closest section-like ancestor and
  // its preceding siblings.
  const getSectionHeading = (el: Element): string => {
    const HEAD = /^(H[1-4]|LEGEND)$/;
    let node: Element | null = el;
    for (let depth = 0; depth < 6 && node; depth++) {
      let sib: Element | null = node.previousElementSibling;
      while (sib) {
        if (HEAD.test(sib.tagName)) {
          const t = clean(sib.textContent);
          if (t && t.length < 120) return t;
        }
        const h = sib.querySelector?.("h1,h2,h3,h4,legend");
        const ht = clean(h?.textContent);
        if (ht && ht.length < 120) return ht;
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return "";
  };

  // Build a re-findable selector. Prefers #id (Playwright's CSS engine pierces
  // open shadow DOM, so an id inside a web component is still fillable), then
  // [name], then a stable attribute, then an nth-of-type fallback.
  const makeSelector = (el: Element): string => {
    const elId = (el as HTMLElement).id;
    if (elId) return `#${cssEscape(elId)}`;
    const name = (el as HTMLInputElement).name;
    if (name) return `[name="${cssEscape(name)}"]`;
    const auto = el.getAttribute("data-automation-id");
    if (auto) return `[data-automation-id="${cssEscape(auto)}"]`;
    const aria = el.getAttribute("aria-label");
    if (aria) return `${el.tagName.toLowerCase()}[aria-label="${aria.replace(/"/g, '\\"')}"]`;
    try {
      const tag = el.tagName.toLowerCase();
      const sameTag = Array.from((el.getRootNode() as Document | ShadowRoot).querySelectorAll(tag));
      const idx = sameTag.indexOf(el);
      if (idx >= 0) return `${tag}:nth-of-type(${idx + 1})`;
    } catch { /* ignore */ }
    return "";
  };

  // Scrape datalist options for an <input list="…">.
  const datalistOptions = (el: Element): string[] | undefined => {
    const listId = el.getAttribute("list");
    if (!listId) return undefined;
    const dl = byId(el, listId);
    if (!dl) return undefined;
    const opts = Array.from(dl.querySelectorAll("option"))
      .map((o) => clean((o as HTMLOptionElement).value || o.textContent))
      .filter(Boolean);
    return opts.length ? opts : undefined;
  };

  // ── Native inputs / selects / textareas ──────────────────────────────────────
  const NATIVE = deepQueryAll(
    'input:not([type="hidden"]):not([type="submit"]):not([type="file"]):not([type="button"]):not([type="image"]):not([type="radio"]):not([type="checkbox"]), textarea, select'
  );

  NATIVE.forEach((el) => {
    if (!isVisible(el)) return;

    const { text: label, confidence: labelConfidence } = getLabel(el);
    const selector = makeSelector(el);
    if (!selector) return;

    const rawType = (el as HTMLInputElement).type || "";
    const type = el.tagName === "SELECT"
      ? "select"
      : el.tagName === "TEXTAREA"
      ? "textarea"
      : rawType || "text";

    const options = el.tagName === "SELECT"
      ? Array.from((el as HTMLSelectElement).options).map((o) => (o.text || o.textContent || "").trim()).filter(Boolean)
      : undefined;

    results.push({
      type,
      inputType: el.tagName === "INPUT" ? rawType || "text" : undefined,
      label: label || `field_${results.length}`,
      name: (el as HTMLInputElement).name || undefined,
      required: (el as HTMLInputElement).required || el.getAttribute("aria-required") === "true" || false,
      options,
      possibleDropdownOptions: datalistOptions(el),
      selector,
      placeholder: clean((el as HTMLInputElement).placeholder) || undefined,
      ariaLabel: clean((el as HTMLInputElement).getAttribute("aria-label")) || undefined,
      sectionHeading: getSectionHeading(el) || undefined,
      maxLength: (el as HTMLInputElement).maxLength > 0 ? (el as HTMLInputElement).maxLength : undefined,
      labelConfidence,
    });
  });

  // ── Native radio groups (grouped by name) ─────────────────────────────────────
  // Group by name across the whole scope (fieldset is not required), so radios
  // split across <div>s still form one logical question.
  const radioByName = new Map<string, HTMLInputElement[]>();
  (deepQueryAll('input[type="radio"]') as HTMLInputElement[]).forEach((r) => {
    if (!isVisible(r)) return;
    const key = r.name || `__anon_${radioByName.size}`;
    const arr = radioByName.get(key) || [];
    arr.push(r);
    radioByName.set(key, arr);
  });

  radioByName.forEach((radios, name) => {
    if (!radios.length) return;
    const first = radios[0];
    // Label from the enclosing fieldset legend / group label, else the question
    // text nearest the group.
    const fs = closestDeep(first, "fieldset, [role='radiogroup'], [role='group'], .form-group, [class*='question'], [class*='field']");
    let label = "";
    if (fs) {
      const lg = fs.querySelector("legend, [class*='label'], [class*='title'], label");
      label = clean(lg?.textContent);
    }
    if (!label) label = getLabel(first).text;
    if (!label) return;

    const options = radios
      .map((r) => {
        const forLbl = r.id
          ? (() => { try { return (r.getRootNode() as Document | ShadowRoot).querySelector(`label[for="${cssEscape(r.id)}"]`); } catch { return null; } })()
          : null;
        return clean(forLbl?.textContent || r.closest("label")?.textContent || r.getAttribute("aria-label") || r.value);
      })
      .filter(Boolean);

    const groupSelector = first.name
      ? `input[type="radio"][name="${cssEscape(first.name)}"]`
      : makeSelector(first);
    if (!groupSelector) return;

    results.push({
      type: "radio",
      label,
      name: first.name || undefined,
      required: radios.some((r) => r.required) || false,
      options,
      selector: groupSelector,
      sectionHeading: getSectionHeading(first) || undefined,
      labelConfidence: 0.8,
    });
    void name;
  });

  // ── ARIA radio groups (div[role=radiogroup] with [role=radio] children) ───────
  deepQueryAll('[role="radiogroup"]').forEach((group) => {
    if (!isVisible(group)) return;
    const radios = Array.from(group.querySelectorAll('[role="radio"]'));
    if (!radios.length) return;

    const labelEl = group.querySelector("legend, label, [class*='label'], [class*='title']");
    let label = clean(group.getAttribute("aria-label")) || ariaLabelledByText(group) || clean(labelEl?.textContent);
    if (!label) label = getLabel(group).text;
    if (!label) return;

    const selector = makeSelector(group);
    if (!selector) return;

    const options = radios
      .map((r) => clean(r.getAttribute("aria-label") || r.textContent))
      .filter(Boolean);

    results.push({
      type: "aria-radio",
      label,
      required: group.getAttribute("aria-required") === "true",
      options,
      selector,
      sectionHeading: getSectionHeading(group) || undefined,
      labelConfidence: 0.8,
    });
  });

  // ── ARIA comboboxes with NO backing <input> (button + listbox pattern) ────────
  // Input-backed comboboxes (react-select etc.) are already captured above via
  // their inner <input>; here we only surface the pure-ARIA ones so the engine
  // can attempt an open→match→click, or safely pause.
  deepQueryAll('[role="combobox"]').forEach((cb) => {
    if (!isVisible(cb)) return;
    if (cb.tagName === "INPUT" || cb.querySelector("input, textarea")) return; // input-backed: handled already
    const { text: label, confidence } = getLabel(cb);
    if (!label) return;
    const selector = makeSelector(cb);
    if (!selector) return;

    // Listbox options are usually rendered only when open; scrape any present.
    const listId = cb.getAttribute("aria-controls") || cb.getAttribute("aria-owns") || "";
    const listbox = listId ? byId(cb, listId) : cb.parentElement?.querySelector('[role="listbox"]');
    const possible = listbox
      ? Array.from(listbox.querySelectorAll('[role="option"]')).map((o) => clean(o.textContent)).filter(Boolean)
      : [];

    results.push({
      type: "aria-combobox",
      label,
      required: cb.getAttribute("aria-required") === "true",
      possibleDropdownOptions: possible.length ? possible : undefined,
      selector,
      sectionHeading: getSectionHeading(cb) || undefined,
      labelConfidence: confidence,
    });
  });

  // ── Standalone checkboxes (e.g., "I agree to terms") ──────────────────────────
  (deepQueryAll('input[type="checkbox"]') as HTMLInputElement[]).forEach((cb) => {
    if (!isVisible(cb)) return;
    const { text: label, confidence } = getLabel(cb);
    const selector = makeSelector(cb);
    if (!selector || !label) return;
    results.push({
      type: "checkbox",
      label,
      name: cb.name || undefined,
      required: cb.required || false,
      selector,
      sectionHeading: getSectionHeading(cb) || undefined,
      labelConfidence: confidence,
    });
  });

  return results;
}

// Find the apply button on a LinkedIn page and tell us if it's Easy Apply.
// LinkedIn's external "Apply" control is a plain <a> (external-link icon),
// often WITHOUT role="button" — so we scan both <button> and <a> elements.
export function scanLinkedInApplyButton() {
  const norm = (s: string) => (s || "").replace(/\s+/g, " ").trim();
  const els = Array.from(document.querySelectorAll("button, a")) as HTMLElement[];

  for (const b of els) {
    if ((b as HTMLButtonElement).disabled) continue;
    // Visible only (skip 0-size / hidden controls).
    const rect = b.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;

    const aria = b.getAttribute("aria-label") || "";
    const text = norm(b.innerText + " " + aria);
    const lower = text.toLowerCase();

    const isApplyClass =
      b.classList.contains("jobs-apply-button") || !!b.closest(".jobs-apply-button");
    // Accessible name starts with "apply"/"easy apply", or it's the apply-button widget.
    const looksApply =
      isApplyClass || lower.startsWith("apply") || /\beasy apply\b/.test(lower);
    if (!looksApply) continue;
    // Exclude look-alikes (counts, AI helpers, save/share/alerts).
    if (/(save|share|follow|set alert|clicked apply|tailor|cover letter|match details|stand out|report)/.test(lower)) {
      continue;
    }

    // Build a usable selector.
    const tag = b.tagName.toLowerCase();
    const id = b.id ? `#${CSS.escape(b.id)}` : "";
    let selector = id;
    if (!selector && aria) selector = `${tag}[aria-label="${aria.replace(/"/g, '\\"')}"]`;
    if (!selector && isApplyClass) selector = ".jobs-apply-button";
    if (!selector) {
      const all = Array.from(document.querySelectorAll(tag));
      const idx = all.indexOf(b);
      if (idx >= 0) selector = `${tag}:nth-of-type(${idx + 1})`;
    }
    if (!selector) continue;

    return { selector, text: text.slice(0, 80), isEasyApply: /\beasy apply\b/.test(lower) };
  }
  return null;
}

// Self-healing click: find the best-matching visible button/link by text for an
// intent (regex serialized as {src, flags}), tag it for the caller to click,
// and return a durable selector when one can be built.
export function scanHealClick({ src, flags }: { src: string; flags: string }) {
  const rx = new RegExp(src, flags);
  const norm = (s: string) => (s || "").replace(/\s+/g, " ").trim();
  const els = Array.from(
    document.querySelectorAll<HTMLElement>(
      "button, a, input[type=submit], input[type=button], [role=button]"
    )
  );
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if ((el as HTMLButtonElement).disabled) continue;
    const label = norm(
      el.innerText ||
        (el as HTMLInputElement).value ||
        el.getAttribute("aria-label") ||
        ""
    );
    if (!label || !rx.test(label)) continue;
    // Build a durable selector for this element.
    let selector = "";
    const id = el.id;
    const aria = el.getAttribute("aria-label");
    const auto = el.getAttribute("data-automation-id");
    if (id) selector = `#${CSS.escape(id)}`;
    else if (auto) selector = `[data-automation-id="${auto}"]`;
    else if (aria) selector = `${el.tagName.toLowerCase()}[aria-label="${aria.replace(/"/g, '\\"')}"]`;
    // Mark the element so the caller can click it even without a selector.
    el.setAttribute("data-jobagent-heal", "1");
    return { selector, label: label.slice(0, 60) };
  }
  return null;
}
