// Service worker: the only place allowed to make the cross-origin call to the
// Job Agent app (content scripts are bound by page CORS). It forwards the
// scraped field list to the classifier API and returns the result.
//
// The base URL is configurable from the popup (stored in chrome.storage.sync);
// it defaults to the local dev server. A non-loopback host requires the user to
// grant host permission, which the popup requests when they save it.

const DEFAULT_HOST = "http://localhost:3000";
const SCAN_PATH = "/api/extension/scan";

// Build the ordered list of endpoints to try for a given base URL. For the
// default loopback host we try both spellings, since one may be firewalled.
function endpointsFor(host) {
  const base = (host || DEFAULT_HOST).replace(/\/+$/, "");
  const urls = [base + SCAN_PATH];
  if (base === "http://localhost:3000") urls.push("http://127.0.0.1:3000" + SCAN_PATH);
  return urls;
}

async function getHost() {
  try {
    const { host } = await chrome.storage.sync.get({ host: DEFAULT_HOST });
    return host || DEFAULT_HOST;
  } catch {
    return DEFAULT_HOST;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.action !== "classify") return;

  (async () => {
    const host = await getHost();
    const endpoints = endpointsFor(host);
    let lastErr = "no endpoint";
    for (const url of endpoints) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fields: msg.fields || [] }),
        });
        if (!res.ok) { lastErr = `HTTP ${res.status}`; continue; }
        const data = await res.json();
        sendResponse({ ok: true, data });
        return;
      } catch (e) {
        lastErr = e?.message || String(e);
      }
    }
    sendResponse({ ok: false, error: `Could not reach the Job Agent app at ${host} (${lastErr}). Is it running?` });
  })();

  return true; // keep the message channel open for the async sendResponse
});
