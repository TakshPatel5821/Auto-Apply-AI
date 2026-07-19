// Content script: scrapes form-field context from the current page and overlays
// the Job Agent's classification on each field. READ-ONLY — it never types into
// or submits the form. Triggered by the popup's "Scan this page" button.

(() => {
  if (window.__jobAgentInspectorLoaded) return;
  window.__jobAgentInspectorLoaded = true;

  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

  // Resolve aria-labelledby → text of referenced nodes.
  function ariaLabelledByText(el) {
    const ids = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    if (!ids.length) return "";
    return ids.map((id) => document.getElementById(id)?.textContent || "").map(clean).filter(Boolean).join(" ");
  }

  function getLabel(el) {
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) return clean(lbl.textContent);
    }
    const wrap = el.closest("label");
    if (wrap) return clean(wrap.textContent);
    const byId = ariaLabelledByText(el);
    if (byId) return byId;
    const parent = el.closest(".form-group, [class*='field'], [class*='question'], fieldset, [data-automation-id]");
    if (parent) {
      const lbl = parent.querySelector("label, legend, .label, h3, h4, [class*='label'], [class*='title']");
      if (lbl && lbl !== el) return clean(lbl.textContent);
    }
    return clean(el.getAttribute("aria-label") || el.placeholder || el.name || "");
  }

  function getSectionHeading(el) {
    const HEAD = /^(H[1-4]|LEGEND)$/;
    let node = el;
    for (let depth = 0; depth < 6 && node; depth++) {
      let sib = node.previousElementSibling;
      while (sib) {
        if (HEAD.test(sib.tagName)) {
          const t = clean(sib.textContent);
          if (t && t.length < 120) return t;
        }
        const h = sib.querySelector && sib.querySelector("h1,h2,h3,h4,legend");
        const ht = clean(h && h.textContent);
        if (ht && ht.length < 120) return ht;
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return "";
  }

  function makeSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.name) return `[name="${CSS.escape(el.name)}"]`;
    return "";
  }

  function visible(el) {
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // Build the field-context list (mirrors the engine's detectFields signals).
  function scrapeFields() {
    const out = [];
    const seen = new Set();
    const push = (el, type, options) => {
      const selector = makeSelector(el);
      if (!selector || seen.has(selector)) return;
      seen.add(selector);
      out.push({
        selector,
        type,
        label: getLabel(el) || `field_${out.length}`,
        name: el.name || undefined,
        placeholder: clean(el.placeholder) || undefined,
        ariaLabel: clean(el.getAttribute("aria-label")) || undefined,
        sectionHeading: getSectionHeading(el) || undefined,
        options,
        required: !!el.required,
        _el: el,
      });
    };

    document
      .querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]), textarea, select')
      .forEach((el) => {
        if (!visible(el)) return;
        const type = el.tagName === "SELECT" ? "select" : el.tagName === "TEXTAREA" ? "textarea" : el.type || "text";
        const options = el.tagName === "SELECT"
          ? Array.from(el.options).map((o) => o.text.trim()).filter(Boolean)
          : undefined;
        push(el, type, options);
      });
    return out;
  }

  // ── Overlay badges ─────────────────────────────────────────────────────────
  const OVERLAY_ID = "__jobAgentInspectorOverlay";
  function clearOverlay() {
    document.getElementById(OVERLAY_ID)?.remove();
  }
  const COLORS = {
    profile: { bg: "#064e3b", fg: "#6ee7b7", txt: "from profile" }, 
    ai: { bg: "#1e3a8a", fg: "#93c5fd", txt: "AI draft" },
    pause: { bg: "#78350f", fg: "#fcd34d", txt: "asks you" },
  };

  function drawOverlay(fields, classified) {
    clearOverlay();
    const layer = document.createElement("div");
    layer.id = OVERLAY_ID;
    layer.style.cssText = "position:absolute;top:0;left:0;z-index:2147483647;pointer-events:none;";
    document.body.appendChild(layer);

    const bySelector = new Map(classified.map((c) => [c.selector, c]));
    for (const f of fields) {
      const c = bySelector.get(f.selector);
      if (!c || !f._el) continue;
      const r = f._el.getBoundingClientRect();
      const color = COLORS[c.outlook] || COLORS.pause;
      const badge = document.createElement("div");
      const lockIcon = c.sensitive ? "🔒 " : "";
      badge.textContent = `${lockIcon}${c.category} · ${color.txt}`;
      badge.style.cssText = [
        "position:absolute",
        `top:${r.top + window.scrollY - 16}px`,
        `left:${r.left + window.scrollX}px`,
        `background:${color.bg}`,
        `color:${color.fg}`,
        "font:600 10px/1.4 ui-monospace,monospace",
        "padding:1px 6px",
        "border-radius:4px 4px 0 0",
        "white-space:nowrap",
        "box-shadow:0 1px 3px rgba(0,0,0,.4)",
      ].join(";");
      layer.appendChild(badge);
      // Outline the field itself in the same color.
      f._el.style.outline = `2px solid ${color.bg}`;
      f._el.style.outlineOffset = "0px";
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.action === "clear") {
      clearOverlay();
      sendResponse({ ok: true });
      return;
    }
    if (msg?.action !== "scan") return;

    const fields = scrapeFields();
    if (fields.length === 0) {
      sendResponse({ ok: true, summary: { count: 0, fields: [] } });
      return;
    }
    // Strip the live DOM node before sending across the message boundary.
    const payload = fields.map(({ _el, ...rest }) => rest);

    chrome.runtime.sendMessage({ action: "classify", fields: payload }, (resp) => {
      if (!resp?.ok) {
        sendResponse({ ok: false, error: resp?.error || "classify failed" });
        return;
      }
      const classified = resp.data.fields || [];
      drawOverlay(fields, classified);
      const counts = classified.reduce((acc, c) => ((acc[c.outlook] = (acc[c.outlook] || 0) + 1), acc), {});
      sendResponse({ ok: true, summary: { count: classified.length, counts, fields: classified } });
    });
    return true; // async
  });
})();
