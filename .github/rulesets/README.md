# Branch rulesets

Importable [GitHub rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets)
for the default branch.

> These files are **not** applied automatically. GitHub does not read rulesets
> from the repository — they live in repository settings. These are checked in so
> the configuration is reviewable and reproducible, and so a fork can adopt the
> same protection in two clicks.

## Importing

**Settings → Rules → Rulesets → New ruleset → Import a ruleset** → upload the JSON.

Pick **one** — they both target the default branch, and overlapping rulesets are
additive (the most restrictive wins), so enabling both just gives you
`main-strict` with confusing provenance.

## Which one?

### `main-protection.json` — start here

For a solo maintainer. Protects against the destructive mistakes without adding
any day-to-day friction:

| Rule | Effect |
| --- | --- |
| `deletion` | `main` cannot be deleted |
| `non_fast_forward` | No force-pushes — history cannot be rewritten or destroyed |
| `required_linear_history` | No merge commits; keeps history readable |

You can still push directly to `main`. Nothing slows you down.

### `main-strict.json` — once you have collaborators

Everything above, plus:

| Rule | Effect |
| --- | --- |
| `pull_request` | Changes must go through a PR. **0 approvals required**, so a solo maintainer is not locked out — the PR exists to run CI and give a review surface, not to block you |
| `required_status_checks` | CI must pass before merge |

Required checks are pinned to the two CI jobs that run on pull requests:

- `Lint, typecheck, test & build`
- `Dependency audit`

**The `Docker image builds` job is deliberately excluded.** It is gated on
`if: github.event_name == 'push'`, so it never runs on a pull request. Requiring
it would leave every PR waiting forever on a check that cannot report.

`strict_required_status_checks_policy: true` additionally requires a branch to be
up to date with `main` before merging.

## Bypass actors

Both files ship with `"bypass_actors": []` — **nobody can bypass, including you.**

That is deliberate for `main-protection`: the whole point is that `main` cannot
be force-pushed by accident. If you genuinely need to rewrite history, disable
the ruleset, do it, and re-enable.

If you would rather keep an escape hatch, add one after importing:
**Edit ruleset → Bypass list → Add bypass → Repository admin**. Doing it in the
UI avoids hand-writing actor IDs.

## Verifying it works

After importing `main-protection`, this should be rejected:

```bash
git push --force origin main
# remote: error: GH013: Repository rule violations found
```

## Related settings (not rulesets)

Worth enabling in **Settings → Code security**, especially given this repository's
history:

- **Secret scanning** — alerts on committed credentials
- **Push protection** — blocks the push before a secret lands
- **Dependabot alerts / security updates** — pairs with `.github/dependabot.yml`
