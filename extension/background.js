// Service worker: the only place allowed to make the cross-origin call to the
// local Job Agent app (content scripts are bound by page CORS). It forwards the
// scraped field list to the classifier API and returns the result.

const ENDPOINTS = [
  "http://localhost:3000/api/extension/scan",
  "http://127.0.0.1:3000/api/extension/scan",
];

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.action !== "classify") return;

  (async () => {
    let lastErr = "no endpoint";
    for (const url of ENDPOINTS) {
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
        lastErr = String(e);
      }
    }
    sendResponse({ ok: false, error: `Could not reach the Job Agent app (${lastErr}). Is it running on localhost:3000?` });
  })();

  return true; // keep the message channel open for the async sendResponse
});
