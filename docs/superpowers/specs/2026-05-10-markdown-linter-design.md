# Markdown Linter — Design

**Status:** Approved
**Date:** 2026-05-10

## Goal

Add a markdown linter to catch structural and safety issues in the 54+ `.md`
files in this repo. Wire it into the same gates as Biome, yamllint, and squawk:
`lint-staged` (auto-fix on staged files), the pre-commit full-repo gate, and CI.

## Tool

`markdownlint-cli2` (David Anson's `markdownlint` library, modern CLI). Selected
over alternatives because:

- It's the de-facto Node ecosystem standard, actively maintained.
- Single npx binary — no plugin orchestration like `remark-lint` would need.
- `--fix` covers most rules (whitespace, list markers, heading style).
- Fast: sub-second on this repo's scale, so adding it to the heavy pre-commit
  hook is essentially free.

Vale (prose style), `mado` (immature), and `markdownlint-cli` (superseded by
cli2) were considered and rejected.

## Configuration

### `.markdownlint-cli2.jsonc` (repo root)

```jsonc
{
  "config": {
    "default": true,
    "MD013": false, // line length — too noisy for prose
    "MD033": false, // inline HTML — used for <details>, badges
    "MD041": false, // first-line h1 — some files start with @-transclude
    "MD024": { "siblings_only": true } // duplicate headings OK across different sections
  },
  "ignores": [
    "node_modules/**", // dependency READMEs
    ".claude/**" // worktree noise
  ]
}
```

Rationale for each disabled rule:

- **MD013 (line length, default 80):** Prose wrapping is hand-managed in this
  repo's docs. Enabling produces hundreds of false positives.
- **MD033 (no inline HTML):** Existing docs use `<details>`/`<summary>` and
  occasional inline anchors. Hard requirement to keep them.
- **MD041 (first line must be h1):** Some docs start with `@~/.agents/AGENTS.md`
  transclusion or frontmatter-equivalent prefaces.
- **MD024 siblings_only:** Two `## Setup` sections under different parents are
  fine; only flag duplicates at the same nesting level.

Everything else in the default ruleset stays on, including:

- MD042 (no empty links)
- MD051 (link fragment validity)
- MD053 (link references defined)
- MD034 (no bare URLs)
- MD040 (fenced code blocks have language)
- MD007 (list indentation consistency)
- MD009 (no trailing whitespace)

### Ignored paths — rationale

- `node_modules/**`: dependency READMEs.
- `.claude/**`: worktree noise (this project places worktrees at
  `.claude/worktrees/<branch>`). Lint the source files, not their worktree copies.

## Integration

### package.json scripts

```json
"check:md": "markdownlint-cli2 \"**/*.md\"",
"check:md:fix": "markdownlint-cli2 --fix \"**/*.md\""
```

### lint-staged

Two changes:

1. **Add** a new entry for `.md` running `markdownlint-cli2 --fix`.
2. **Remove** `md` from the existing biome glob — Biome 2.4.10 silently ignores
   `.md` due to `--files-ignore-unknown=true`, so the inclusion is misleading.

Final state:

```json
"lint-staged": {
  "**/*.{ts,tsx,json,css,astro,html,vue}": [
    "biome check --write --no-errors-on-unmatched --files-ignore-unknown=true"
  ],
  "**/*.md": [
    "markdownlint-cli2 --fix"
  ],
  "supabase/migrations/*.sql": ["bash scripts/db/check-sql.sh"]
}
```

YAML linting in lint-staged was dropped on upstream `main` (commit `adfe00f2`)
when `check:yaml` in pre-commit moved to `yamllint . && actionlint` running
repo-wide — covering staged files transitively, so the lint-staged entry was
redundant.

### Pre-commit hook (`.githooks/pre-commit`)

Add `npm run check:md` to the full-repo check sequence, grouped with the other
lint checks:

```bash
echo "Running checks..."
bash "$HOME/code/family-memory/scripts/check-biome-rules.sh" biome.jsonc
npx biome ci . --error-on-warnings
npm run check:yaml
npm run check:md          # new
# ... rest unchanged (SAM validate, check:ts, check:knip, check:sql, test, test:e2e)
```

### CI — new workflow `.github/workflows/markdown.yml`

A dedicated workflow rather than folding into `noDeploy.yml`, because
`noDeploy.yml` deliberately uses `paths-ignore: ['**.md', 'docs/**']` to keep
docs-only changes from triggering the full ~5 min test-and-build job. Adding
markdown to that workflow would force removing the ignore and slow docs PRs
significantly. A standalone workflow runs in ~30 sec and is surgically scoped.

```yaml
name: Markdown
on:
  push:
    branches: [main]
    paths:
      - '**.md'
      - '.markdownlint-cli2.jsonc'
  workflow_dispatch:

concurrency:
  group: markdown-${{ github.ref }}
  cancel-in-progress: true

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6.0.2
      - uses: actions/setup-node@53b83947a5a98c8d113130e565377fae1a50d02f # v6.3.0
        with:
          node-version-file: .nvmrc
          cache: npm
          cache-dependency-path: package-lock.json
      - name: Install dependencies
        run: npm ci
      - name: Markdown lint
        run: npm run check:md
```

`noDeploy.yml`'s `paths-ignore` gets `.markdownlint-cli2.jsonc` added alongside
`**.md`, `docs/**`, and `LICENSE`, so config-only changes to the linter don't
trigger the full test-and-build pipeline.

## Layered defense

| Layer                         | Scope                  | Action                  |
|-------------------------------|------------------------|-------------------------|
| Editor (optional VS Code ext) | Per-file               | Inline diagnostics      |
| `lint-staged` (pre-commit)    | Staged `.md` only      | `--fix` (auto-rewrite)  |
| Pre-commit full gate          | All `.md` in repo      | Fail on any violation   |
| CI (`markdown.yml`)           | All `.md` in repo      | Fail on any violation   |

## One-time cleanup

After config is in place but before enabling the gates, run
`npm run check:md:fix` once to auto-fix the bulk of existing violations.
Manually resolve whatever auto-fix can't handle — typically broken link
references (MD053) or anchor mismatches (MD051). Commit the cleanup as a
separate commit from the tooling change so the diff is readable.

## Out of scope

- Vale or any prose-style linter (different category; not requested).
- Markdown linting via Biome (Biome doesn't support markdown yet; revisit if
  they add it).
- Removing the `**.md`/`docs/**` entries from `noDeploy.yml`'s `paths-ignore`
  (preserves docs-only PR speed); only `.markdownlint-cli2.jsonc` is added to
  the ignore list.
- Adding markdown linting to any of the Lambda/SAM deploy workflows (out of
  scope for these path filters).

## Acceptance criteria

1. `npm run check:md` runs cleanly on a fresh checkout of `main`.
2. Introducing a violation (e.g., `[broken](#nonexistent)`) and committing
   fails at the pre-commit gate.
3. Pushing a markdown-only commit to `main` triggers the `Markdown` workflow
   and nothing else from `noDeploy.yml`.
4. `npm run check:md:fix` rewrites auto-fixable issues without manual edits.
