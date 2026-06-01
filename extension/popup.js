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

const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function send(action) {
  return new Promise(async (resolve) => {
    const tab = await activeTab();
    if (!tab?.id) return resolve({ ok: false, error: "no active tab" });
    chrome.tabs.sendMessage(tab.id, { action }, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(resp || { ok: false, error: "no response" });
      }
    });
  });
}

document.getElementById("scan").addEventListener("click", async () => {
  statusEl.textContent = "Scanning…";
  resultsEl.innerHTML = "";
  const resp = await send("scan");
  if (!resp.ok) {
    statusEl.textContent = `⚠ ${resp.error}`;
    return;
  }
  const { count, counts, fields } = resp.summary;
  if (count === 0) {
    statusEl.textContent = "No form fields found on this page.";
    return;
  }
  const parts = Object.entries(counts || {}).map(([k, v]) => `${v} ${k}`);
  statusEl.textContent = `${count} fields — ${parts.join(", ")}`;

  for (const f of fields) {
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
  await send("clear");
  resultsEl.innerHTML = "";
  statusEl.textContent = "Cleared.";
});
