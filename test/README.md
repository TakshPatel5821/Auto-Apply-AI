# Tests (Phase 10)

Regression tests for the form-understanding pipeline. Run with:

```bash
npm test          # one-off
npm run test:watch
```

## Unit tests (vitest, no browser/DB)
These cover the pure logic that decides what gets filled — the accuracy-critical
parts from the roadmap:

| File | Covers |
|------|--------|
| `field-classifier.test.ts` | field classification (17 categories), do-not-AI + sensitive policy, confidence gates (`decideFill`), value validation (email-in-name, prose-in-yes/no, etc.) |
| `dropdown-intelligence.test.ts` | scored dropdown matching: exact / state-abbr / country-alias / degree-level / yes-no synonyms, ambiguity detection, placeholder skipping |
| `profile.test.ts` | `resolveField` label→spec mapping (pronouns-before-gender, government-official→compliance, salary/citizenship sensitive), résumé seeding |

A regression these caught: "Email Address" was being classified as `address`
(the address pattern matched the word "address" first) — now contact wins.

## Fake ATS fixtures (manual / extension)
`fixtures/*.html` are standalone application forms. Open one in the browser with
the **Field Inspector** extension loaded (see `extension/`) and click *Scan this
page* to visually confirm classification:

- `eeo-compliance-form.html` — every sensitive field should show 🔒 *asks you*
  (amber) until its profile value is set; only the essay is *AI draft* (blue).
- `dropdown-heavy-form.html` — state/country/degree/yes-no should resolve to the
  correct option when the profile has a value.
