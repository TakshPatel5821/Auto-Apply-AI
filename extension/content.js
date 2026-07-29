// Content script: scrapes form-field context from the current page and overlays
// the Job Agent's classification on each field. READ-ONLY — it never types into
// or submits the form. Triggered by the popup's "Scan this page" button.
//
// Runs in every frame (manifest `all_frames`). Each frame is self-contained: it
// scrapes only its own document (+ open shadow DOM) and draws its own overlay in
// its own document, so cross-origin iframes are covered too — the popup fans the
// scan out to every frame and merges the results.

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

  const FIELD_SELECTOR =
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]), textarea, select';

  // Build this frame's field-context list (mirrors the engine's detectFields
  // signals). Walks the frame's own document plus any open shadow roots. Child
  // iframes are NOT descended — each frame runs its own copy of this script and
  // reports its own fields, which the popup merges.
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

    const collect = (el) => {
      if (!visible(el)) return;
      const type = el.tagName === "SELECT" ? "select" : el.tagName === "TEXTAREA" ? "textarea" : el.type || "text";
      const options = el.tagName === "SELECT"
        ? Array.from(el.options).map((o) => o.text.trim()).filter(Boolean)
        : undefined;
      push(el, type, options);
    };

    const walk = (root) => {
      root.querySelectorAll(FIELD_SELECTOR).forEach(collect);
      // Descend into open shadow roots (same document, same coordinate space).
      root.querySelectorAll("*").forEach((el) => {
        if (el.shadowRoot) walk(el.shadowRoot);
      });
    };

    walk(document);
    return out;
  }

  // ── Overlay badges ─────────────────────────────────────────────────────────
  const OVERLAY_ID = "__jobAgentInspectorOverlay";
  // Track everything we mutate so clearOverlay can fully undo it: the inline
  // outline styles we set on fields, and the badge↔field pairs we reposition.
  let outlined = []; // { el, prevOutline, prevOffset }
  let anchored = []; // { el, badge }
  let repositionRAF = 0;

  function reposition() {
    repositionRAF = 0;
    for (const { el, badge } of anchored) {
      const r = el.getBoundingClientRect();
      badge.style.top = `${r.top + window.scrollY - 16}px`;
      badge.style.left = `${r.left + window.scrollX}px`;
    }
  }
  function scheduleReposition() {
    if (repositionRAF) return;
    repositionRAF = requestAnimationFrame(reposition);
  }

  function clearOverlay() {
    document.getElementById(OVERLAY_ID)?.remove();
    // Restore the fields' original inline outline so we leave no trace on the page.
    for (const { el, prevOutline, prevOffset } of outlined) {
      el.style.outline = prevOutline;
      el.style.outlineOffset = prevOffset;
    }
    outlined = [];
    anchored = [];
    if (repositionRAF) {
      cancelAnimationFrame(repositionRAF);
      repositionRAF = 0;
    }
    window.removeEventListener("scroll", scheduleReposition, true);
    window.removeEventListener("resize", scheduleReposition);
  }
  const COLORS = {
    profile: { bg: "#064e3b", fg: "#6ee7b7", txt: "from profile" }, 
    ai: { bg: "#1e3a8a", fg: "#93c5fd", txt: "AI draft" },
    pause: { bg: "#78350f", fg: "#fcd34d", txt: "asks you" },
  };

  function drawOverlay(fields, classified) {
    clearOverlay();
    if (!document.body) return; // some frame documents have no body to overlay
    const layer = document.createElement("div");
    layer.id = OVERLAY_ID;
    layer.style.cssText = "position:absolute;top:0;left:0;z-index:2147483647;pointer-events:none;";
    document.body.appendChild(layer);

    const bySelector = new Map(classified.map((c) => [c.selector, c]));
    for (const f of fields) {
      const c = bySelector.get(f.selector);
      if (!c || !f._el) continue;
      const el = f._el;
      const r = el.getBoundingClientRect();
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
      anchored.push({ el, badge });

      // Outline the field itself in the same color, remembering the prior inline
      // value so clearOverlay can restore it exactly.
      outlined.push({ el, prevOutline: el.style.outline, prevOffset: el.style.outlineOffset });
      el.style.outline = `2px solid ${color.bg}`;
      el.style.outlineOffset = "0px";
    }

    // Keep badges pinned to their fields as the page scrolls or reflows.
    window.addEventListener("scroll", scheduleReposition, true);
    window.addEventListener("resize", scheduleReposition);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.action === "clear") {
      clearOverlay();
      sendResponse({ ok: true });
      return;
    }
    if (msg?.action !== "scan") return;

    let fields;
    try {
      fields = scrapeFields();
    } catch (e) {
      sendResponse({ ok: false, error: `scan failed: ${e?.message || e}` });
      return;
    }
    if (fields.length === 0) {
      sendResponse({ ok: true, summary: { count: 0, counts: {}, fields: [] } });
      return;
    }
    // Strip the live DOM node before sending across the message boundary.
    const payload = fields.map(({ _el, ...rest }) => rest);

    try {
      chrome.runtime.sendMessage({ action: "classify", fields: payload }, (resp) => {
        // A sleeping service worker or reloaded extension surfaces here, not as `resp`.
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        if (!resp?.ok) {
          sendResponse({ ok: false, error: resp?.error || "classify failed" });
          return;
        }
        const classified = resp.data?.fields || [];
        try {
          drawOverlay(fields, classified);
        } catch (e) {
          // Overlay is best-effort; still report the classification result.
          console.warn("[JobAgent] overlay draw failed:", e);
        }
        const counts = classified.reduce((acc, c) => ((acc[c.outlook] = (acc[c.outlook] || 0) + 1), acc), {});
        sendResponse({ ok: true, summary: { count: classified.length, counts, fields: classified } });
      });
    } catch (e) {
      // Extension context invalidated (e.g. after a reload) throws synchronously.
      sendResponse({ ok: false, error: `messaging unavailable: ${e?.message || e}` });
      return;
    }
    return true; // async
  });
})();
