# GitHub CI

<!-- ci-smoke: run.test.ts env cleanup fix 2026-06-28 -->

StockTextAlerts uses **GitHub Actions** for the full test battery, native GitHub auto-merge, and production code deploys. The local pre-push hook runs the cheap checks only; unit tests, E2E, and deploy run in GitHub.

## Workflows

| Workflow | File | When | Purpose |
| --- | --- | --- | --- |
| **CI** | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | PRs, merge queue, manual | Lint, workflow lint, types, Knip, SQL, migration grants, Lambda bundle build, local Supabase bootstrap, unit tests, E2E (dev server), Astro build |
| **Auto Merge** | [`.github/workflows/auto-merge.yml`](../.github/workflows/auto-merge.yml) | PR open/sync/ready/labeled | Enables squash auto-merge **only** when the PR has label `ship-auto-merge` (added by `/ship`) |
| **Deploy** | [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) | Push to `main` (on merge), manual | Production Supabase migrations, Lambda code updates, live-provider check |

**Integration:** the canonical path is **branch → PR → CI-gated auto-merge** — push a branch, open a PR via `/ship` (which adds `ship-auto-merge` and arms auto-merge), and GitHub merges once the required strict `ci` check is green. Unlabeled third-party PRs do not auto-merge. This keeps CI (full unit/E2E/build, which the pre-push hook skips) a real gate on `main` (see "Concurrent merges" below). `/ship`'s direct push to `main` is **break-glass only** — it bypasses the `ci` check via admin (see AGENTS.md). After a change lands on `main`, the deploy workflow applies production migrations plus Lambda code updates and Vercel's Git integration deploys the web tier. `npm run deploy:code` remains a local break-glass path, not the default release path.

## Local pre-push gate

[`.git-hooks/pre-push`](../.git-hooks/pre-push) still runs on push to `main` (via the shared fleet gate library):

- gitleaks, markdown lint on changed files, clean tree, Node pin
- Lambda bundle build
- Biome, YAML, actionlint, Astro check, Knip, Squawk, deploy-function coverage, migration grants (static)

**Not in pre-push (GitHub CI only):** `db:doctor`, `check:db-privileges`, `npm test`, `npm run test:e2e`, Astro build. These need local Supabase/Docker on the runner — no Podman/Postgres required locally before push. Local `npm test` / `test:e2e` are also **opt-in** in this repo (`ALLOW_LOCAL_DB_TESTS=1` or `npm run test:local`) so agents do not hit the shared stack by default — see `tests/README.md`. Fleet agent conventions live in `~/code/dotagents`.

**Pre-release (local opt-in, not CI):** `ALLOW_LOCAL_DB_TESTS=1 npm run test:e2e:preview` — production-build E2E on port 4323. Run before Astro/Vite config changes or when debugging Rolldown/CSS chunk issues.

## Required GitHub settings

After the first CI workflow run (so the check name appears):

1. **Settings → General → Pull Requests** — enable **Allow auto-merge** and **Always suggest updating pull request branches** (makes the one-click "Update branch" prominent when a concurrent PR goes out-of-date).
2. **Settings → Labels** — ensure label **`ship-auto-merge`** exists (color optional). Restrict who can add it to maintainers if you want belt-and-suspenders beyond the workflow gate.
3. Protect `main` (branch protection rule or ruleset) so CI gates every merge:
   - **Require a pull request before merging** (0 approvals is fine solo) — makes branch+PR the path, so `ci` actually gates `main`
   - Require status check **`CI / ci`** to pass, **strict** (branches up to date before merging)
   - Block force-push and deletion
   - `enforce_admins` stays **off** so the owner keeps a break-glass `/ship` direct push (it bypasses these rules — emergency use only)
   - Enable merge queue when the repository plan/UI supports the `merge_queue` rule

The auto-merge workflow calls `gh pr merge --auto --squash` only when the PR has label `ship-auto-merge`; GitHub merges when all required checks pass.

The CI workflow listens for `merge_group` events so merge queue can validate the integrated commit before landing if the feature becomes available. As of 2026-06-28, GitHub rejects `merge_queue` through both REST and GraphQL for this private GitHub Team repository, and neither legacy branch protection nor repository rulesets expose the option in the UI. **Native merge queue requires GitHub Enterprise Cloud for private repos** — unavailable on Free/Pro/Team — so the `merge_group` wiring is forward-compat, not active.

## Concurrent merges

Branch+PR is the canonical path, so concurrent PRs are the normal case — here's why two in flight can't break `main`.

The risk with two PRs in flight is a **semantic (logical) conflict**: each passes CI against an older `main`, but `main` breaks when both land (e.g. PR A renames a function, PR B adds a call to the old name — no textual conflict, both green, broken `main`). A merge queue is the canonical fix, but it's Enterprise-only here (above).

**Strict required checks are the native substitute, and they're already on.** Branch protection requires the `CI / ci` check with **strict mode** (`required_status_checks.strict: true` — "require branches up to date before merging"). GitHub processes merges sequentially and re-checks strictness at merge time, so:

1. PR #1 (up to date, green) auto-merges.
2. PR #2 is now **out-of-date**; GitHub refuses to merge it. Its auto-merge waits.
3. Click **Update branch** on PR #2 → it rebases onto the new `main` → `ci` re-runs against the combined tree → auto-merge completes only if still green.

So a second concurrent PR **cannot silently land an untested combined SHA**. The cost is one manual *Update branch* click per stalled PR (GitHub's `--auto` merge does not auto-update branches); the **Always suggest updating pull request branches** setting (above) makes it one click. This catches only conflicts the test suite exercises — strict mode buys merge-queue-grade *safety* at low concurrency, not merge-queue *throughput*.

**Upgrade path** when concurrent PRs become routine:

- Automate the *Update branch* step with a `push: main` workflow running `gh pr update-branch` on open auto-merge PRs — but it **must** use a PAT or GitHub App token, not the default `GITHUB_TOKEN`, or the branch update won't trigger a fresh `ci` run (loop-prevention) and you'd auto-merge an unvalidated SHA.
- Or adopt **Kodiak** (free GitHub App): auto-updates branches and merges when green — the closest no-Enterprise equivalent of a merge queue.
- Team growth → evaluate **Mergify/Graphite** (batching, priorities) or **GitHub Enterprise Cloud** for the native `merge_group` queue this CI is already wired for. Batching only pays off at high merge volume.

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

The deploy workflow is triggered directly by a `push` to `main` (i.e. on merge). CI no longer re-runs on `main` — the PR's strict required `ci` check already validated the to-be-landed tree, so the post-merge re-run was redundant and was dropped to save Actions minutes. A deploy for a **stale** commit (one `main` has already moved past via a newer push) is blocked by a main-tip check in the deploy workflow (`git ls-remote` tip vs the pushed `github.sha`); its `deploy-production` concurrency group (`cancel-in-progress: false`) serializes queued deploys.

When a merge lands on the current `main` tip:

1. Vercel's GitHub integration deploys the web tier from the landed `main` commit.
2. `aws/deploy-web.sh --deploy-ci` builds Lambda code, applies Supabase migrations, and updates existing Lambda code.
3. The workflow invokes `stocktextalerts-live-provider-check`.
4. A red deploy means production needs a forward-fix change; do not rerun manual production DDL outside the deploy workflow.

Infra changes (`aws/template.yaml`, `aws/deploy.sh`) still need `npm run deploy:infra` (full SAM, admin creds).
