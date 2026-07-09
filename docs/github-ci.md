# GitHub CI

<!-- ci-smoke: run.test.ts env cleanup fix 2026-06-28 -->

StockTextAlerts uses **GitHub Actions** for the full test battery, native GitHub auto-merge, and production code deploys. The local pre-commit hook runs the cheap checks only; unit tests, E2E, and deploy run in GitHub.

## Workflows

| Workflow | File | When | Purpose |
| --- | --- | --- | --- |
| **CI** | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | PRs, push to `main` (post-merge gate), merge queue, manual | Lint, workflow lint, types, Knip, markdown lint, lib boundaries, SQL, migration grants, Lambda bundle build, local Supabase bootstrap, unit tests, E2E (dev server), Astro build — run depth decided per-event by the gate step (see "Run gating") |
| **Auto Merge** | [`.github/workflows/auto-merge.yml`](../.github/workflows/auto-merge.yml) | PR open/sync/ready/labeled | Enables squash auto-merge **only** when the PR has label `ship-auto-merge` (added by `/ship`) |
| **Deploy** | [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) | Push to `main` (on merge), manual | Production Supabase migrations, Lambda code updates, live-provider check |

**Integration:** the canonical path is **branch → PR → CI-gated auto-merge** — push a branch, open a PR via `/ship` (which adds `ship-auto-merge` and arms auto-merge), and GitHub merges once the required `ci` check is green. Unlabeled third-party PRs do not auto-merge. Merging is **optimistic** (branch-up-to-date/strict is off); CI (full unit/E2E/build, which the pre-commit hook skips) then re-runs post-merge on `main` as the real green-together gate (see "Concurrent merges" below). `/ship`'s direct push to `main` is **break-glass only** — it bypasses the `ci` check via admin (see AGENTS.md). After a change lands on `main`, the deploy workflow applies production migrations plus Lambda code updates and Vercel's Git integration deploys the web tier. `npm run deploy:code` remains a local break-glass path, not the default release path.

## Local pre-commit gate

[`.git-hooks/pre-commit`](../.git-hooks/pre-commit) runs at commit time (via the shared fleet gate library):

- staged gitleaks, staged markdown lint, Node pin (merge/rebase + empty-commit skips)
- Lambda bundle build
- Biome, YAML, actionlint (**shellcheck** + **github-actionlint** are lockfile-pinned npm deps; `npm run check:actions` points actionlint at `node_modules/.bin/shellcheck` so SC* rules can't silently skip), Astro check, Knip, markdown lint (`check:md`), lib boundaries (`check:lib-boundaries`), Squawk, deploy-function coverage, migration grants (static)

**Not in pre-commit (GitHub CI only):** `db:doctor`, `check:db-privileges`, `npm test`, `npm run test:e2e`, Astro build. These need local Supabase/Docker on the runner — no Podman/Postgres required locally before commit. Bypass = `git commit -n` only; CI is the backstop. Local `npm test` / `test:e2e` are also **opt-in** in this repo (`ALLOW_LOCAL_DB_TESTS=1` or `npm run test:local`) so agents do not hit the shared stack by default — see `tests/README.md`. Fleet agent conventions live in `~/code/dotagents`.

**Pre-release (local opt-in, not CI):** `ALLOW_LOCAL_DB_TESTS=1 npm run test:e2e:preview` — production-build E2E on port 4323. Run before Astro/Vite config changes or when debugging Rolldown/CSS chunk issues.

## Required GitHub settings

After the first CI workflow run (so the check name appears):

1. **Settings → General → Pull Requests** — enable **Allow auto-merge**. (No need for "Always suggest updating pull request branches": with strict off, PRs don't have to be up to date to merge, so there's no per-PR *Update branch* click.)
2. **Settings → Labels** — ensure label **`ship-auto-merge`** exists (color optional). Restrict who can add it to maintainers if you want belt-and-suspenders beyond the workflow gate.
3. Protect `main` (branch protection rule or ruleset) so CI gates every merge:
   - **Require a pull request before merging** (0 approvals is fine solo) — makes branch+PR the path, so `ci` actually gates `main`
   - Require status check **`CI / ci`** to pass, **non-strict** (`required_status_checks.strict: false` — do *not* require branches up to date). Optimistic merge: the post-merge `main` CI run is the green-together gate instead (see "Concurrent merges"). Strict on a repo whose CI battery *also* runs post-merge would double-charge minutes; strict is dropped precisely because the post-merge run now carries the guarantee.
   - Block force-push and deletion
   - `enforce_admins` stays **off** so the owner keeps a break-glass `/ship` direct push (it bypasses these rules — emergency use only)
   - Enable merge queue when the repository plan/UI supports the `merge_queue` rule

The auto-merge workflow calls `gh pr merge --auto --squash` only when the PR has label `ship-auto-merge`; GitHub merges when all required checks pass.

The CI workflow listens for `merge_group` events so merge queue can validate the integrated commit before landing if the feature becomes available. As of 2026-06-28, GitHub rejects `merge_queue` through both REST and GraphQL for this private GitHub Team repository, and neither legacy branch protection nor repository rulesets expose the option in the UI. **Native merge queue requires GitHub Enterprise Cloud for private repos** — unavailable on Free/Pro/Team — so the `merge_group` wiring is forward-compat, not active.

## Concurrent merges

Branch+PR is the canonical path, so concurrent PRs are the normal case — here's how a broken `main` is caught.

The risk with two PRs in flight is a **semantic (logical) conflict**: each passes CI against an older `main`, but `main` breaks when both land (e.g. PR A renames a function, PR B adds a call to the old name — no textual conflict, both green, broken `main`). A merge queue is the canonical fix, but it's Enterprise-only here (above).

**The post-merge `main` CI run is the substitute.** Branch-up-to-date (`strict`) is **off** — requiring it forced every open PR to rebase-and-re-run the full ~13-min battery each time another PR merged (O(k²) churn under concurrency, and on a private repo every re-run costs Actions minutes). Instead, `ci.yml` runs on `push: [main]`, so the moment a merge lands the full battery runs against the actual combined tree:

1. PR #1 and PR #2 each auto-merge as soon as their **own** `ci` is green — no *Update branch* click, no cross-PR re-run.
2. On each merge, `ci` runs on the new `main` commit. If the combination broke, that run goes **red**.
3. A red `main` is fixed forward (a follow-up commit/PR); the deploy workflow's own guards (refuse-stale, refuse-infra) limit blast radius meanwhile.

This trades strict's **pre-merge** guarantee (a broken combination can't land) for a **post-merge** one (it lands, then is caught and fixed forward within one CI cycle) — the standard trunk-based optimistic-merge posture, matching this repo's fire-and-forward model. Cost is O(k) (one `main` run per merge) instead of strict's O(k²) rebase churn, so it scales as concurrency grows. Note: post-merge CI is a **canary**, not a deploy gate — `deploy.yml` fires in parallel on the same push, so a broken `main` can still deploy (the same posture Vercel's push-triggered web deploy already has); gate deploy on the `main` CI run only if that becomes a real problem.

**Upgrade path** when concurrent PRs become routine:

- **Kodiak** (free GitHub App): auto-updates branches and merges when green — the closest no-Enterprise equivalent of a merge queue if you ever want the pre-merge guarantee back without strict's manual *Update branch* clicks.
- Team growth → evaluate **Mergify/Graphite** (batching, priorities) or **GitHub Enterprise Cloud** for the native `merge_group` queue this CI is already wired for. Batching only pays off at high merge volume.

## Run gating

The first step of the `ci` job (`Gate — decide run depth` in `ci.yml`) decides how much of the battery each event actually needs. Two independent skips, both **fail-open** — any API error or ambiguity runs the full battery:

- **Tree-identity skip (push to `main`).** A squash merge whose base did not advance while the PR was open produces a `main` commit whose **tree** is byte-identical to the PR head tree the required `ci` check already validated — re-running the battery proves nothing, so the whole job passes in seconds. When the trees differ (another PR merged first — the only case the post-merge backstop exists for) the full battery runs. Direct (break-glass) pushes have no associated merged PR and always run everything. Net effect: the post-merge `main` run costs a full battery **only when merges actually race**.
- **Docs-only fast path (PRs).** A diff where every changed file matches `docs/**` or `*.md` runs the static checks (Biome, YAML/actionlint, types, Knip, markdown lint, lib boundaries, SQL, deploy-fn coverage, migration grants) and skips the Supabase/test/build steps — the required `ci` check passes in ~2 min instead of ~13. The allowlist is deliberately conservative: `package.json`, workflows, config, or anything ambiguous runs the full battery. The check context stays `ci`, so branch protection needs no change.

The gate needs no checkout — both decisions use only the event payload and the REST API — and writes its decision (`static`/`heavy` + reason) to the step summary of every run.

## CI environment

- **Runner:** `blacksmith-4vcpu-ubuntu-2404-arm` (Blacksmith ARM — ~37% cheaper per minute than x64; the battery is arch-neutral) with Docker (`DOCKER_HOST=unix:///var/run/docker.sock`). `deploy.yml` deliberately stays on x64 `blacksmith-4vcpu-ubuntu-2404` — it builds the Lambda artifact that ships to production; don't change artifact arch as a side effect of runner economics.
- **Supabase:** one background [`scripts/db/ci-bootstrap.sh`](../scripts/db/ci-bootstrap.sh) (start → write env → reset, with [`ci-db-retry.sh`](../scripts/db/ci-db-retry.sh) on transient registry throttle) so image pulls + migrate/seed overlap static checks / `sam build` / Playwright install; a wait step joins and loads `/tmp/ci-bootstrap.env` into `GITHUB_ENV`. `db:reset` also runs `check:db-privileges` + `check:option-catalog` (not standalone CI steps). Local DX still uses separate `db:start` / `db:reset`.
- **Playwright:** Chromium **headless shell** only (`npx playwright install --only-shell`). Browser binaries live on a Blacksmith **sticky disk** (`useblacksmith/stickydisk` → `~/.cache/ms-playwright`, keyed by OS+arch) so warm runs mount in ~3s instead of re-downloading. `install-deps` (apt) is runner-local — marker under `/tmp`, not the sticky disk — because apt packages don't travel with the mount (a sticky-disk marker caused warm E2E to skip apt and fail on missing `libatk`). Install is launched in the background right after the mount so a cold fill overlaps static checks / bootstrap; a wait step joins before E2E. Traces uploaded on failure from `.playwright-mcp/cli/`.
- **Caching:** `setup-node` npm cache stays on the upstream action — Blacksmith transparently redirects it to its colocated cache (the `useblacksmith/cache` / `setup-node` forks are archived). Playwright browsers use sticky disks instead of `actions/cache` (large binary artifact).
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

The deploy workflow is triggered directly by a `push` to `main` (i.e. on merge), **in parallel with** the post-merge `main` CI run — deploy is not gated on it (CI is the green-together canary; the deploy's own guards protect the release). A deploy for a **stale** commit (one `main` has already moved past via a newer push) is blocked by a main-tip check in the deploy workflow (`git ls-remote` tip vs the pushed `github.sha`); its `deploy-production` concurrency group (`cancel-in-progress: false`) serializes queued deploys.

When a merge lands on the current `main` tip:

1. Vercel's GitHub integration deploys the web tier from the landed `main` commit.
2. `aws/deploy-web.sh --deploy-ci` builds Lambda code, applies Supabase migrations, and updates existing Lambda code.
3. The workflow invokes `stocktextalerts-live-provider-check`.
4. A red deploy means production needs a forward-fix change; do not rerun manual production DDL outside the deploy workflow.

Infra changes (`aws/template.yaml`, `aws/deploy.sh`) still need `npm run deploy:infra` (full SAM, admin creds).
