const COLORS = {
  profile: "#064e3b",
  ai: "#1e3a8a",
  pause: "#78350f",
};
const COLOR_FG = {
  profile: "#6ee7b7",
  ai: "#93c5fd",
  pause: "#fcd34d",
};

const DEFAULT_HOST = "http://localhost:3000";

const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Deliver an action to every frame in the tab (the content script runs in all
// of them) and return one result per frame. Frames without our script — e.g.
// chrome-internal or PDF viewers — respond with lastError and yield null.
async function sendToAllFrames(action) {
  const tab = await activeTab();
  if (!tab?.id) return [{ ok: false, error: "no active tab" }];

  let frameIds = [0];
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
    if (frames?.length) frameIds = frames.map((f) => f.frameId);
  } catch {
    // webNavigation unavailable — fall back to the top frame only.
  }

  return Promise.all(
    frameIds.map(
      (frameId) =>
        new Promise((resolve) => {
          chrome.tabs.sendMessage(tab.id, { action }, { frameId }, (resp) => {
            if (chrome.runtime.lastError) resolve(null);
            else resolve(resp || null);
          });
        }),
    ),
  );
}

const isLoopback = (h) => h === "localhost" || h === "127.0.0.1" || h === "[::1]";

document.getElementById("scan").addEventListener("click", async () => {
  statusEl.textContent = "Scanning…";
  resultsEl.innerHTML = "";
  const results = await sendToAllFrames("scan");

  // Merge the per-frame summaries into one.
  const ok = results.filter((r) => r && r.ok && r.summary);
  const merged = { count: 0, counts: {}, fields: [] };
  for (const r of ok) {
    merged.count += r.summary.count || 0;
    for (const [k, v] of Object.entries(r.summary.counts || {})) {
      merged.counts[k] = (merged.counts[k] || 0) + v;
    }
    if (Array.isArray(r.summary.fields)) merged.fields.push(...r.summary.fields);
  }

  if (merged.count === 0) {
    // Surface a real error over "nothing found" if some frame failed.
    const err = results.find((r) => r && r.ok === false && r.error);
    statusEl.textContent = err ? `⚠ ${err.error}` : "No form fields found on this page.";
    return;
  }

  const parts = Object.entries(merged.counts).map(([k, v]) => `${v} ${k}`);
  statusEl.textContent = `${merged.count} fields — ${parts.join(", ")}`;

  for (const f of merged.fields) {
    const row = document.createElement("div");
    row.className = "row";
    const cat = document.createElement("span");
    cat.className = "cat";
    cat.textContent = (f.sensitive ? "🔒 " : "") + f.category;
    cat.style.background = COLORS[f.outlook] || COLORS.pause;
    cat.style.color = COLOR_FG[f.outlook] || COLOR_FG.pause;
    const lbl = document.createElement("span");
    lbl.className = "lbl";
    lbl.textContent = f.label;
    lbl.title = f.label;
    row.append(cat, lbl);
    resultsEl.appendChild(row);
  }
});

document.getElementById("clear").addEventListener("click", async () => {
  await sendToAllFrames("clear");
  resultsEl.innerHTML = "";
  statusEl.textContent = "Cleared.";
});

// ── Settings: configurable Job Agent app URL ─────────────────────────────────
const settingsEl = document.getElementById("settings");
const toggleEl = document.getElementById("settings-toggle");
const hostInput = document.getElementById("host");

toggleEl.addEventListener("click", () => {
  const open = settingsEl.classList.toggle("open");
  toggleEl.setAttribute("aria-expanded", String(open));
});

chrome.storage.sync.get({ host: DEFAULT_HOST }).then(({ host }) => {
  hostInput.value = host;
});

document.getElementById("save-host").addEventListener("click", async () => {
  const raw = hostInput.value.trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    statusEl.textContent = "⚠ Enter a full URL, e.g. http://localhost:3000";
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    statusEl.textContent = "⚠ URL must start with http:// or https://";
    return;
  }
  const host = url.origin;

  // Loopback origins are covered by the manifest; other hosts need a grant.
  if (!isLoopback(url.hostname)) {
    const granted = await chrome.permissions.request({ origins: [host + "/*"] });
    if (!granted) {
      statusEl.textContent = "⚠ Permission for that host was declined.";
      return;
    }
  }
  await chrome.storage.sync.set({ host });
  hostInput.value = host;
  statusEl.textContent = `Saved. Using ${host}`;
});
