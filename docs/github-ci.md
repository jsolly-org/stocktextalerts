# GitHub CI

<!-- ci-smoke: trivial marker for auto-merge integration test (2026-06-28) -->

StockTextAlerts uses **GitHub Actions** for the full test battery and **native GitHub auto-merge** for landing PRs. The local pre-push hook runs the cheap checks only; unit tests and E2E run in CI.

## Workflows

| Workflow | File | When | Purpose |
|----------|------|------|---------|
| **CI** | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | PRs, merge queue, manual | Lint, types, Knip, SQL, migration grants, Lambda bundle build, local Supabase bootstrap, unit tests, E2E, Astro build |
| **Auto Merge** | [`.github/workflows/auto-merge.yml`](../.github/workflows/auto-merge.yml) | PR open/sync/ready | Enables squash auto-merge on every non-draft same-repo PR |

Deploy is **not** part of CI. After a PR merges to `main`, run `npm run deploy:code` (or `/ship`) from a credentialed machine.

## Local pre-push gate

[`.git-hooks/pre-push`](../.git-hooks/pre-push) still runs on push to `main` (via the shared fleet gate library):

- gitleaks, markdown lint on changed files, clean tree, Node pin
- deploy creds preflight, Lambda bundle build
- Biome, YAML, Astro check, Knip, Squawk, deploy-function coverage, migration grants (static)

**Not in pre-push (GitHub CI only):** `db:doctor`, `check:db-privileges`, `npm test`, `npm run test:e2e`, Astro build. These need local Supabase/Docker on the runner — no Podman/Postgres required locally before push.

## Required GitHub settings

After the first CI workflow run (so the check name appears):

1. **Settings → General → Pull Requests** — enable **Allow auto-merge**.
2. Protect `main` (branch protection rule or ruleset):
   - Require pull requests before merging
   - Require status check **`CI / ci`** to pass
   - Restrict direct pushes to `main` (recommended)

The auto-merge workflow calls `gh pr merge --auto --squash`; GitHub merges when all required checks pass.

Optional later: enable **merge queue** on `main`. The CI workflow already listens for `merge_group` events.

## CI environment

- **Runner:** `ubuntu-latest` with Docker (`DOCKER_HOST=unix:///var/run/docker.sock`)
- **Supabase:** `npm run db:start` → load keys from `supabase status` → `npm run db:reset`
- **Playwright:** Chromium only; traces uploaded on failure from `.playwright-mcp/cli/`
- **Secrets:** No production credentials in CI; vendor APIs are stubbed

## Deploy after merge

```bash
npm run deploy:code   # after HEAD == origin/main
```

Infra changes (`aws/template.yaml`, `aws/deploy.sh`) still need `npm run deploy:infra` (full SAM, admin creds).
