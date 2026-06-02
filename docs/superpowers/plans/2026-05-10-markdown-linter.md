# Markdown Linter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-10-markdown-linter-design.md`

**Goal:** Add `markdownlint-cli2` as the markdown linter, wired into `lint-staged` (auto-fix on staged files), the pre-commit full-repo gate, and a dedicated CI workflow.

**Architecture:**

- Tool: `markdownlint-cli2` (devDependency), config at repo root.
- Pragmatic ruleset: defaults with MD013/MD033/MD041 disabled, MD024 in `siblings_only` mode.
- Layered defense: `lint-staged --fix` → pre-commit full gate → CI workflow.
- New `.github/workflows/markdown.yml` runs only on `**.md` changes; `noDeploy.yml` is untouched.

**Tech Stack:** `markdownlint-cli2`, npm, lint-staged, GitHub Actions.

**Ships as a single commit per project workflow** (no PRs). Per-task verification within the worktree; cleanup commit is separated from tooling commit for review clarity. Final integration via `/review-fix-push`.

---

## Phase 0 — Setup

### Task 0.1: Establish isolated worktree

**Files:** none (setup only)

- [ ] **Step 1: Create worktree**

Use the `superpowers:using-git-worktrees` skill (or `git worktree add`) to create an isolated workspace branched off `main` named `chore/markdown-linter`.

- [ ] **Step 2: Verify clean baseline**

Run from the worktree:

```bash
npm run check:ts
npm run check:biome
npm run check:yaml
```

Expected: all PASS (clean baseline before changes).

---

## Phase 1 — Install and configure markdownlint-cli2

### Task 1.1: Install dependency

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Install**

```bash
npm install --save-dev markdownlint-cli2
```

- [ ] **Step 2: Verify install**

```bash
npx markdownlint-cli2 --help | head -5
```

Expected: prints the CLI help banner (no errors). Confirm the installed version appears in `package.json` under `devDependencies`.

---

### Task 1.2: Create lint config

**Files:**

- Create: `.markdownlint-cli2.jsonc`

- [ ] **Step 1: Write config**

Create `.markdownlint-cli2.jsonc` at the repo root with this content:

```jsonc
{
  // Markdown lint configuration. Docs: https://github.com/DavidAnson/markdownlint-cli2
  // Rule reference: https://github.com/DavidAnson/markdownlint/blob/main/doc/Rules.md
  "config": {
    "default": true,
    "MD013": false,
    "MD033": false,
    "MD041": false,
    "MD024": { "siblings_only": true }
  },
  "ignores": [
    "node_modules/**",
    "dist/**",
    "test-results/**",
    ".claude/**",
    "CLAUDE.md"
  ]
}
```

- [ ] **Step 2: Verify config parses**

```bash
npx markdownlint-cli2 "README.md"
```

Expected: either exits 0 (clean) or prints rule violations for `README.md`. **Either is fine** — both confirm the config loaded. A "parse error" or "unknown rule" failure is the failure mode to look for.

---

### Task 1.3: Add npm scripts

**Files:**

- Modify: `package.json` (scripts block)

- [ ] **Step 1: Add scripts**

In the `scripts` object, alphabetically near the other `check:*` entries, add:

```json
"check:md": "markdownlint-cli2 \"**/*.md\"",
"check:md:fix": "markdownlint-cli2 --fix \"**/*.md\"",
```

- [ ] **Step 2: Verify both scripts execute**

```bash
npm run check:md
```

Expected: prints violations across the repo's existing markdown files and exits non-zero. **This is expected pre-cleanup** — Phase 2 handles it. Capture the violation count for reference (top of output):

```bash
npm run check:md 2>&1 | tail -3
```

---

## Phase 2 — One-time cleanup

> Cleanup happens **before** wiring the gates. If gates land first, the first commit after the wiring fails.

### Task 2.1: Auto-fix pass

**Files:** many `.md` files across the repo (rewritten in place by the fixer).

- [ ] **Step 1: Snapshot pre-fix state**

```bash
git status --short
```

Expected: only `package.json`, `package-lock.json`, `.markdownlint-cli2.jsonc` modified/created from Phase 1.

- [ ] **Step 2: Run auto-fix**

```bash
npm run check:md:fix
```

Expected: command exits 0 OR exits non-zero with the remaining un-fixable violations listed. Auto-fix rewrites whitespace, list markers, heading style, fenced code styling, etc.

- [ ] **Step 3: Inspect diff**

```bash
git diff --stat | tail -20
git diff -- '*.md' | head -100
```

Sanity-check that fixes look reasonable (no semantic content removed; only whitespace/formatting changes). If anything looks wrong, `git checkout -- <file>` to revert and investigate the specific rule.

---

### Task 2.2: Manual fixes for un-fixable violations

**Files:** whatever `npm run check:md` still reports.

- [ ] **Step 1: Identify remaining violations**

```bash
npm run check:md
```

Expected: either exits 0 (no manual fixes needed — skip to Step 3) or lists violations grouped by file with rule codes (e.g., `MD051/link-fragments`, `MD053/link-image-reference-definitions`).

- [ ] **Step 2: Fix each violation**

Common cases and resolutions:

- **MD051 (link fragments):** A link like `[X](#section)` points to a `#section` anchor that doesn't exist. Either fix the anchor target (heading slugs are lowercase-with-dashes) or update the link text/target.
- **MD053 (unused link references):** A `[label]: url` reference is defined but never used. Delete the orphan definition.
- **MD042 (no empty links):** `[text]()` with an empty URL. Fill in or remove.
- **MD025 (multiple h1):** Two `# Heading` lines at the top level in one file. Demote one to `##`.
- **MD040 (fenced code language):** ` ``` ` with no language tag. Add `bash`, `text`, `json`, etc.

Edit each file directly. Re-run `npm run check:md` after each fix until it exits 0.

- [ ] **Step 3: Verify clean state**

```bash
npm run check:md
```

Expected: exit 0, no output (or a single summary line).

- [ ] **Step 4: Commit cleanup separately**

This commit is intentionally separated from the tooling commit so the diff is reviewable.

```bash
git add -- '*.md'
git diff --cached --stat
```

Verify only `.md` files are staged. Then:

```bash
git commit -m "$(cat <<'EOF'
chore(docs): apply markdownlint auto-fixes + manual cleanup

Pre-emptive cleanup before wiring markdownlint-cli2 into lint-staged,
pre-commit, and CI gates. No semantic changes — whitespace, list
markers, heading style, fenced code language tags, and a handful of
broken link references.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — Wire the gates

### Task 3.1: Update lint-staged

**Files:**

- Modify: `package.json` (lint-staged block)

- [ ] **Step 1: Read current lint-staged block**

Current state (in `package.json`):

```json
"lint-staged": {
  "**/*.{ts,tsx,json,css,md,astro,html,vue}": [
    "biome check --write --no-errors-on-unmatched --files-ignore-unknown=true"
  ],
  ".github/**/*.{yml,yaml}": [
    "yamllint"
  ],
  "supabase/migrations/*.sql": [
    "bash scripts/db/check-sql.sh"
  ]
}
```

- [ ] **Step 2: Replace with new block**

Two changes — remove `md` from the biome glob (Biome 2.4.10 silently ignores `.md`; the inclusion is misleading), and add a new entry for `.md`:

```json
"lint-staged": {
  "**/*.{ts,tsx,json,css,astro,html,vue}": [
    "biome check --write --no-errors-on-unmatched --files-ignore-unknown=true"
  ],
  "**/*.md": [
    "markdownlint-cli2 --fix"
  ],
  ".github/**/*.{yml,yaml}": [
    "yamllint"
  ],
  "supabase/migrations/*.sql": [
    "bash scripts/db/check-sql.sh"
  ]
}
```

- [ ] **Step 3: Verify lint-staged still parses**

```bash
npx lint-staged --help | head -3
```

Expected: prints help (no JSON parse error from `package.json`).

---

### Task 3.2: Add to pre-commit hook

**Files:**

- Modify: `.githooks/pre-commit`

- [ ] **Step 1: Add `check:md` to the lint group**

In `.githooks/pre-commit`, locate the block that runs `npm run check:yaml`. After that line, add `npm run check:md`:

```bash
echo "Running checks..."
bash "$HOME/code/family-memory/scripts/check-biome-rules.sh" biome.jsonc
# Strict Biome gate: unresolved warnings or errors must block the commit.
npx biome ci . --error-on-warnings
npm run check:yaml
npm run check:md
if git diff --cached --name-only | grep -q '^aws/template\.yaml$'; then
  echo "Validating SAM template..."
  sam validate --lint --template-file aws/template.yaml
fi
npm run check:ts
npm run check:knip
npm run check:sql
npm run test
npm run test:e2e
```

- [ ] **Step 2: Verify hook is still executable**

```bash
ls -l .githooks/pre-commit
```

Expected: shows `-rwxr-xr-x` (executable bit preserved by the edit).

If not executable:

```bash
chmod +x .githooks/pre-commit
```

---

### Task 3.3: Add CI workflow

**Files:**

- Create: `.github/workflows/markdown.yml`

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/markdown.yml`:

```yaml
# CI gate — runs markdownlint-cli2 on the repo.
# Triggers only on markdown changes (or config changes) so docs-only pushes
# don't pull in the full test-and-build pipeline from noDeploy.yml.
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

- [ ] **Step 2: Verify YAML is well-formed**

```bash
npm run check:yaml
```

Expected: PASS (yamllint validates the new file alongside existing workflows).

---

## Phase 4 — Acceptance verification

> These verifications confirm each gate actually fires. Skipping them risks a silent no-op (e.g., a config typo that makes markdownlint pass everything).

### Task 4.1: Confirm `npm run check:md` is clean

**Files:** none (verification only)

- [ ] **Step 1: Run full check**

```bash
npm run check:md
```

Expected: exits 0, no violation output. This satisfies acceptance criterion #1 in the spec.

---

### Task 4.2: Confirm pre-commit gate catches a violation

**Files:** none (the test file is deleted after verification)

- [ ] **Step 1: Introduce a deliberate violation**

```bash
cat > /tmp/md-gate-test.md <<'EOF'
# Test

[broken](#nonexistent-anchor)

[unused]: https://example.com
EOF

cp /tmp/md-gate-test.md md-gate-test.md
git add md-gate-test.md
```

This creates a file with at least two violations: MD051 (broken anchor) and MD053 (unused reference).

- [ ] **Step 2: Attempt commit and verify failure**

```bash
git commit -m "test: should fail pre-commit"
```

Expected: commit aborts. Output should include the lint-staged auto-fix step (which may rewrite some violations but won't fix MD051/MD053), then `npm run check:md` failing on the remaining violations, then the red "Commit aborted" message from the hook's error handler.

If the commit succeeds, the gate is misconfigured — investigate before proceeding.

- [ ] **Step 3: Clean up test file**

```bash
git reset HEAD md-gate-test.md
rm md-gate-test.md
git status --short
```

Expected: working tree clean (or only the legitimate tooling changes remain).

---

### Task 4.3: Smoke test CI workflow path filter

**Files:** none (read-only inspection)

- [ ] **Step 1: Confirm the workflow file is in place**

```bash
ls -l .github/workflows/markdown.yml
git diff --stat main -- .github/workflows/
```

Expected: `markdown.yml` is the only new workflow file; `noDeploy.yml` is **not** modified (preserving the docs-only path-ignore behavior).

- [ ] **Step 2: Note for post-merge verification**

After this branch lands on `main`:

1. Push a markdown-only commit (e.g., a typo fix in a doc) and confirm the **Markdown** workflow runs and the `No Deploy` workflow does **not**.
2. Push a non-markdown commit (e.g., a TS change) and confirm `No Deploy` runs and **Markdown** does not.

Both halves of the path-filter behavior should be observable in the Actions tab.

---

## Phase 5 — Integration

### Task 5.1: Final review and merge

**Files:** none (workflow only)

- [ ] **Step 1: Review the full diff**

```bash
git log main..HEAD --oneline
git diff main..HEAD --stat
```

Expected: two commits — the cleanup commit (Phase 2) and the tooling commit (Phases 1, 3). Tooling diff is small: `package.json`, `package-lock.json`, `.markdownlint-cli2.jsonc`, `.githooks/pre-commit`, `.github/workflows/markdown.yml`.

- [ ] **Step 2: Integrate via `/review-fix-push`**

Run `/review-fix-push` per project convention to review, fix any flagged issues, commit any remaining changes, and push to `main`.
