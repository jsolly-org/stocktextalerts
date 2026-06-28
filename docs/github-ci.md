# GitHub CI

<!-- ci-smoke: run.test.ts env cleanup fix 2026-06-28 -->

StockTextAlerts uses **GitHub Actions** for the full test battery, native GitHub auto-merge, and production code deploys. The local pre-push hook runs the cheap checks only; unit tests, E2E, and deploy run in GitHub.

## Workflows

| Workflow | File | When | Purpose |
| --- | --- | --- | --- |
| **CI** | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | PRs, merge queue, `main` pushes, manual | Lint, workflow lint, types, Knip, SQL, migration grants, Lambda bundle build, local Supabase bootstrap, unit tests, E2E, Astro build |
| **Auto Merge** | [`.github/workflows/auto-merge.yml`](../.github/workflows/auto-merge.yml) | PR open/sync/ready | Enables squash auto-merge on every non-draft same-repo PR |
| **Deploy** | [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) | Successful CI on `main`, manual | Production Supabase migrations, Lambda code updates, live-provider check |

After a PR merges to `main`, CI verifies the landed SHA, Vercel's GitHub integration deploys the web tier, and the deploy workflow applies production migrations plus Lambda code updates automatically. `npm run deploy:code` remains a local break-glass path, not the default release path.

## Local pre-push gate

[`.git-hooks/pre-push`](../.git-hooks/pre-push) still runs on push to `main` (via the shared fleet gate library):

- gitleaks, markdown lint on changed files, clean tree, Node pin
- Lambda bundle build
- Biome, YAML, actionlint, Astro check, Knip, Squawk, deploy-function coverage, migration grants (static)

**Not in pre-push (GitHub CI only):** `db:doctor`, `check:db-privileges`, `npm test`, `npm run test:e2e`, Astro build. These need local Supabase/Docker on the runner — no Podman/Postgres required locally before push.

## Required GitHub settings

After the first CI workflow run (so the check name appears):

1. **Settings → General → Pull Requests** — enable **Allow auto-merge**.
2. Protect `main` (branch protection rule or ruleset):
   - Require pull requests before merging
   - Require status check **`CI / ci`** to pass
   - Restrict direct pushes to `main` (recommended)
   - Enable merge queue when the repository plan/UI supports the `merge_queue` rule

The auto-merge workflow calls `gh pr merge --auto --squash`; GitHub merges when all required checks pass.

The CI workflow listens for `merge_group` events so merge queue can validate the integrated commit before landing if the feature becomes available. As of 2026-06-28, GitHub rejects `merge_queue` through both REST and GraphQL for this private GitHub Team repository, and neither legacy branch protection nor repository rulesets expose the option in the UI.

## CI environment

- **Runner:** `ubuntu-latest` with Docker (`DOCKER_HOST=unix:///var/run/docker.sock`)
- **Supabase:** `npm run db:start` → load keys from `supabase status` → `npm run db:reset`
- **Playwright:** Chromium only; traces uploaded on failure from `.playwright-mcp/cli/`
- **CI secrets:** No production credentials in the test job; vendor APIs are stubbed

## Production deploy environment

GitHub environment: **Production**

- Secret: `DATABASE_URL_PROD`
- Variable: `AWS_REGION`
- Variable: `AWS_DEPLOY_ROLE_ARN`
- Variable: `PRODUCTION_SITE_URL`

The deploy workflow uses GitHub OIDC to assume the scoped AWS `github-actions-deploy` role. Do not add long-lived AWS keys to GitHub.
Vercel production deployments are handled by the connected Vercel GitHub integration, so GitHub Actions does not need `VERCEL_TOKEN`, `VERCEL_ORG_ID`, or `VERCEL_PROJECT_ID`.
Because Vercel Git deployments start independently on `main` pushes, schema-affecting web changes should remain backward-compatible with the currently deployed database until the GitHub deploy workflow has applied migrations. Use the local break-glass `npm run deploy:code` path only when an explicitly ordered DB/Lambda/web release is required.

## Deploy after merge

The deploy workflow runs automatically after `CI` succeeds on `main`:

1. Vercel's GitHub integration deploys the web tier from the landed `main` commit.
2. `aws/deploy-web.sh --deploy-ci` builds Lambda code, applies Supabase migrations, and updates existing Lambda code.
3. The workflow invokes `stocktextalerts-live-provider-check`.
4. A red deploy means production needs a forward-fix PR; do not rerun manual production DDL outside the deploy workflow.

Infra changes (`aws/template.yaml`, `aws/deploy.sh`) still need `npm run deploy:infra` (full SAM, admin creds).
