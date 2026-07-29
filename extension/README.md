# Job Agent — Field Inspector (browser extension)

A **read-only DOM understanding assistant** for the Job Agent. It scrapes the form
fields on any job-application page and shows how the agent would handle each one —
**autofill from your profile**, **AI draft** (open-ended only), or **pause and ask
you** (sensitive/legal/unknown). It never types into or submits a form.

It uses the *same* classifier the apply engine uses (via `POST /api/extension/scan`),
so what you see is what the automation would actually do.

## Why it exists
The hard part of auto-applying isn't clicking — it's understanding what each blank
is asking. This extension surfaces that understanding so you can trust (or correct)
the automation before relying on it.

## Install (load unpacked)
1. Start the Job Agent app locally: `npm run dev` (defaults to `localhost:3000`).
2. Open `edge://extensions` (or `chrome://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select this `extension/` folder.
5. Pin the extension, open a job-application page, click the icon → **Scan this page**.

### Pointing at a different app URL
The extension talks to `localhost:3000` out of the box. To use another host or
port, open the popup, click **⚙**, enter the full app URL (e.g.
`http://localhost:4000`), and **Save**. Non-loopback hosts prompt for a one-time
permission grant. The setting syncs across your signed-in browsers.

## What the badges mean
| Color  | Outlook      | Meaning                                                        |
|--------|--------------|----------------------------------------------------------------|
| green  | from profile | A saved profile value would autofill this field.               |
| blue   | AI draft     | Open-ended — AI may draft an answer (you review it).           |
| amber  | asks you     | Sensitive/legal or unrecognized — the agent pauses for you. 🔒 |

## Scope
- **No autofill, no submit.** This is an inspector only (Phase 3).
- Only field *metadata* (labels, types, options) is sent to your local app —
  never values you've typed.
- **Coverage:** scans the top page, open shadow DOM, and **all iframes**
  (same- and cross-origin — the script runs in every frame and the popup merges
  the results), including `about:blank`/`srcdoc` frames used by some ATS embeds.
