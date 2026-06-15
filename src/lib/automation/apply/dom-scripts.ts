// Pure in-browser scanners passed to page.evaluate(). They run in the page
// context, NOT Node — so they may only reference browser globals (document,
// window, CSS, HTML*Element) and their own arguments, never module scope or
// `this`. Extracted from the engine to keep the heavy DOM logic in one place.

// Detect all fillable fields within `scopeSel`: text/select/textarea inputs,
// radio groups (by fieldset), and standalone checkboxes — each with a resolved
// label, a usable selector, and classifier context (placeholder/aria/heading).
export function scanDetectFields(scopeSel: string) {
  const root = document.querySelector(scopeSel) || document.body;
  const results: Array<{
    type: string;
    label: string;
    name?: string;
    required: boolean;
    options?: string[];
    selector: string;
    placeholder?: string;
    ariaLabel?: string;
    sectionHeading?: string;
    maxLength?: number;
  }> = [];

  const clean = (s?: string | null) => (s || "").replace(/\s+/g, " ").trim();

  // Resolve aria-labelledby → concatenated text of the referenced nodes.
  const ariaLabelledByText = (el: Element): string => {
    const ids = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    if (!ids.length) return "";
    return ids
      .map((id) => document.getElementById(id)?.textContent || "")
      .map(clean)
      .filter(Boolean)
      .join(" ");
  };

  const getLabel = (el: Element): string => {
    const elId = (el as HTMLInputElement).id;
    if (elId) {
      const lbl = document.querySelector(`label[for="${CSS.escape(elId)}"]`);
      if (lbl) return clean(lbl.textContent);
    }
    const wrap = el.closest("label");
    if (wrap) return clean(wrap.textContent);
    const byId = ariaLabelledByText(el);
    if (byId) return byId;
    const parent = el.closest(
      ".form-group, .jobs-easy-apply-form-element, [class*='field'], [class*='question'], fieldset, [data-automation-id]"
    );
    if (parent) {
      const lbl = parent.querySelector("label, legend, .label, h3, h4, [class*='label'], [class*='title']");
      if (lbl && lbl !== el) return clean(lbl.textContent);
    }
    return clean(
      (el as HTMLInputElement).getAttribute("aria-label") ||
      (el as HTMLInputElement).placeholder ||
      (el as HTMLInputElement).name ||
      ""
    );
  };

  // Nearest section heading ABOVE the field — only consulted by the
  // classifier when the field's own text is inconclusive, so it can't
  // override a clear label. Conservative: search within the closest
  // section-like ancestor and its preceding siblings.
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

  const makeSelector = (el: Element): string => {
    const elId = (el as HTMLInputElement).id;
    if (elId) return `#${CSS.escape(elId)}`;
    const name = (el as HTMLInputElement).name;
    if (name) return `[name="${name}"]`;
    return "";
  };

  const inputs = root.querySelectorAll(
    'input:not([type="hidden"]):not([type="submit"]):not([type="file"]):not([type="button"]):not([type="image"]), textarea, select'
  );

  inputs.forEach((el) => {
    const htmlEl = el as HTMLElement;
    // Skip completely invisible (display:none, visibility:hidden)
    const style = window.getComputedStyle(htmlEl);
    if (style.display === "none" || style.visibility === "hidden") return;

    // Allow elements that might be scrolled out of view (still need width/height)
    const rect = htmlEl.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const label = getLabel(el);
    const selector = makeSelector(el);
    if (!selector) return;

    const type = el.tagName === "SELECT"
      ? "select"
      : el.tagName === "TEXTAREA"
      ? "textarea"
      : (el as HTMLInputElement).type || "text";

    const options = el.tagName === "SELECT"
      ? Array.from((el as HTMLSelectElement).options).map((o) => o.text.trim()).filter(Boolean)
      : undefined;

    results.push({
      type,
      label: label || `field_${results.length}`,
      name: (el as HTMLInputElement).name || undefined,
      required: (el as HTMLInputElement).required || false,
      options,
      selector,
      placeholder: clean((el as HTMLInputElement).placeholder) || undefined,
      ariaLabel: clean((el as HTMLInputElement).getAttribute("aria-label")) || undefined,
      sectionHeading: getSectionHeading(el) || undefined,
      maxLength: (el as HTMLInputElement).maxLength > 0 ? (el as HTMLInputElement).maxLength : undefined,
    });
  });

  // Radio groups
  const fieldsets = root.querySelectorAll("fieldset");
  fieldsets.forEach((fs) => {
    const legend = clean(fs.querySelector("legend")?.textContent);
    const radios = Array.from(fs.querySelectorAll('input[type="radio"]'));
    if (radios.length === 0) return;

    const label = legend || clean(fs.querySelector("[class*='label']")?.textContent) || "";
    if (!label) return;

    const options = radios.map((r) => {
      const rid = (r as HTMLInputElement).id;
      const lbl = rid ? document.querySelector(`label[for="${CSS.escape(rid)}"]`)?.textContent?.trim() : "";
      return lbl || (r as HTMLInputElement).value;
    }).filter(Boolean);

    const firstRadio = radios[0] as HTMLInputElement;
    const groupSelector = firstRadio.name ? `input[type="radio"][name="${firstRadio.name}"]` : "";

    if (groupSelector) {
      results.push({
        type: "radio",
        label,
        name: firstRadio.name,
        required: false,
        options,
        selector: groupSelector,
        // The legend IS the question; surface it as section heading too.
        sectionHeading: getSectionHeading(fs) || undefined,
      });
    }
  });

  // Standalone checkboxes (e.g., "I agree to terms")
  const checkboxes = root.querySelectorAll('input[type="checkbox"]');
  checkboxes.forEach((cb) => {
    const label = getLabel(cb);
    const selector = makeSelector(cb);
    if (!selector || !label) return;
    results.push({
      type: "checkbox",
      label,
      name: (cb as HTMLInputElement).name,
      required: false,
      selector,
      sectionHeading: getSectionHeading(cb) || undefined,
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
