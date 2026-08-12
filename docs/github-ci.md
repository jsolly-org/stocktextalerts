# GitHub CI

<!-- ci-smoke: run.test.ts env cleanup fix 2026-06-28 -->

StockTextAlerts uses **GitHub Actions** for the full test battery, native GitHub auto-merge, and production code deploys. The local pre-commit hook runs the cheap checks only; unit tests, E2E, and deploy run in GitHub.

> **Forks / public contributors:** this document describes *this* repository’s wiring. CI runners use Blacksmith labels, auto-merge arms for same-repo non-Dependabot PRs, and an optional janitor workflow drains Dependabot/self PRs. Forks without Blacksmith should switch `runs-on` to `ubuntu-latest` (see [self-hosting.md](self-hosting.md) → Fork notes). Fork PRs and Dependabot PRs do not auto-merge (janitor may arm Dependabot via `gh` after prep). Production bootstrap secrets live in [self-hosting.md](self-hosting.md).

## Workflows

| Workflow | File | When | Purpose |
| --- | --- | --- | --- |
| **CI** | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | PRs, push to `main` (post-merge gate), merge queue, manual | Lint, workflow lint, types, Knip, markdown lint, lib boundaries, SQL, migration grants, Lambda bundle build, local Supabase bootstrap, sharded unit tests, sharded E2E (dev server), Astro build — run depth decided per-event by the gate job (see "Run gating") |
| **Auto Merge** | [`.github/workflows/auto-merge.yml`](../.github/workflows/auto-merge.yml) | PR open/sync/ready | When `REPO_AUTOMATION_TOKEN` is set, defers merge to CI `merge-pr`; otherwise arms GitHub `--auto` with `GITHUB_TOKEN` (degraded). Skips forks and Dependabot |
| **Post-merge bot dispatch** | [`.github/workflows/post-merge-bot.yml`](../.github/workflows/post-merge-bot.yml) | PR closed on `main` (bot merges only) | Best-effort fallback; `GITHUB_TOKEN` merges often suppress this event too (observed on #647). |
| **Ensure main CI** | [`.github/workflows/ensure-main-ci.yml`](../.github/workflows/ensure-main-ci.yml) | Cron every 10 min + manual | Safety net: if main tip has no green/in-flight CI, `workflow_dispatch` CI. Unblocks Deploy after bot auto-merges when the PAT path was not used. |
| **Deploy** | [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) | After green CI on `main` (`workflow_run`), or manual `workflow_dispatch` | Production Supabase migrations, Lambda code updates, live-provider check — gated on green main CI |
| **Janitor** | [`.github/workflows/janitor.yml`](../.github/workflows/janitor.yml) | Cron noon + 5pm Eastern, manual | Provider-swappable agent pass (`scripts/janitor/`) that drains authorized Dependabot/self PRs and issues — default provider Cursor. Repo secrets: `CURSOR_API_KEY`, `REPO_AUTOMATION_TOKEN` (shared PAT for janitor push + CI squash-merge; Contents + PRs + Issues + Actions write; non-admin). Optional: `ANTHROPIC_API_KEY` / `CODEX_API_KEY` when swapping `JANITOR_PROVIDER` |

**Integration:** the canonical path is **branch → PR → CI-gated auto-merge** — push a branch, open a PR, and GitHub merges once the required `ci` check is green. Auto-merge arms automatically for same-repo non-Dependabot PRs (including bare `gh pr create` from agents). Fork PRs never auto-merge; Dependabot stays off until janitor arms via `gh` after prep. Drafts are skipped — open a draft (or `gh pr merge --disable-auto`) to hold a PR out of the merge path. Merging is **optimistic** (branch-up-to-date/strict is off); CI then re-runs post-merge on `main` as the real green-together gate (see "Concurrent merges" below). After a change lands on `main` and **main CI is green**, the Deploy workflow applies production migrations plus Lambda code updates; Vercel's Git integration deploys the web tier on the push. `npm run deploy:code` remains a local break-glass path, not the default release path.

## Local pre-commit gate

[`.git-hooks/pre-commit`](../.git-hooks/pre-commit) runs at commit time (via the shared fleet gate library):

- staged gitleaks, staged markdown lint, Node pin (merge/rebase + empty-commit skips)
- Lambda bundle build
- Biome, YAML, actionlint (**shellcheck** + **github-actionlint** are lockfile-pinned npm deps; `npm run check:actions` points actionlint at `node_modules/.bin/shellcheck` so SC* rules can't silently skip), Astro check, Knip, markdown lint (`check:md`), lib boundaries (`check:lib-boundaries`), Squawk, deploy-function coverage, migration grants (static)

**Not in pre-commit (GitHub CI only):** `db:doctor`, `check:db-privileges`, `npm test`, `npm run test:e2e`, Astro build. These need local Supabase/Docker on the runner — no Podman/Postgres required locally before commit. Bypass = `git commit -n` only; CI is the backstop. Local `npm test` / `test:e2e` are also **opt-in** in this repo (`ALLOW_LOCAL_DB_TESTS=1` or `npm run test:local`) so agents do not hit the shared stack by default — see `tests/README.md`.

**Pre-release (local opt-in, not CI):** `ALLOW_LOCAL_DB_TESTS=1 npm run test:e2e:preview` — production-build E2E on port 4323. Run before Astro/Vite config changes or when debugging Rolldown/CSS chunk issues.

## Known CI flakes

Re-run these rather than changing application code:

- `docker: toomanyrequests` during Reset database / Start Supabase is Docker Hub's anonymous pull limit. `gh run rerun <id> --failed` usually lands on a runner with a different IP. A durable fix requires human-owned `DOCKERHUB_TOKEN` credentials and a login step in `ci.yml`.
- `db:doctor` auth 502 or `auth container not inspectable; recreating stack` is usually slow GoTrue startup.
- `tests/e2e/registration-approval.e2e.spec.ts` can flake on Mailpit/GoTrue email-redirect timing. **Now measurable, and currently not firing:** 18 consecutive e2e jobs passed it in 14.8-19.6s (per-test history landed with the Playwright JUnit reporter). Check before re-running on faith: `blacksmith jobs tests <job_id> --limit 0 --format json | jq '.tests[] | select(.test_suite | test("registration-approval"))'`. If it starts failing again, that is new signal rather than the documented background rate.

## Required GitHub settings

After the first CI workflow run (so the check name appears):

1. **Settings → General → Pull Requests** — enable **Allow auto-merge**. (No need for "Always suggest updating pull request branches": with strict off, PRs don't have to be up to date to merge, so there's no per-PR *Update branch* click.)
2. Protect `main` (branch protection rule or ruleset) so CI gates every merge:
   - **Require a pull request before merging** (0 approvals is fine solo) — makes branch+PR the path, so `ci` actually gates `main`
   - Require status check **`CI / ci`** to pass, **non-strict** (`required_status_checks.strict: false` — do *not* require branches up to date). Optimistic merge: the post-merge `main` CI run is the green-together gate instead (see "Concurrent merges"). Strict on a repo whose CI battery *also* runs post-merge would double-charge minutes; strict is dropped precisely because the post-merge run now carries the guarantee.
   - Block force-push and deletion
   - `enforce_admins` stays **off** so the owner keeps a break-glass `/ship` direct push (it bypasses these rules — emergency use only)
   - Enable merge queue when the repository plan/UI supports the `merge_queue` rule

**Shared automation secret:** `REPO_AUTOMATION_TOKEN` (repo Actions secret; org-level secret optional). Prefer a **classic** PAT with `repo` (non-admin), or a **fine-grained** PAT whose **Resource owner is `jsolly-org`** (not personal `jsolly`) with Contents + Pull requests (+ Issues/Actions for janitor) write and expiry ≤366 days (org lifetime policy; merge is Contents-gated). A FG token scoped only to personal repos can read this public repo but cannot merge. Used by janitor (checkout/push/`gh`) and by CI's `merge-pr` job (squash-merge after green `ci`). That merge is attributed to the PAT user, so `push` → main CI → Deploy runs normally. Local agents may keep the same value under `JSOLLY_ORG_REPO_AUTOMATION_TOKEN` in `.env.local`; workflows still read `secrets.REPO_AUTOMATION_TOKEN`. Rotate the Actions secret with `JSOLLY_ORG_REPO_SECRETS_ADMIN` (repo Secrets write; Resource owner `jsolly-org`) — do not put Secrets write on the automation token.

When `REPO_AUTOMATION_TOKEN` is set, [`.github/workflows/auto-merge.yml`](../.github/workflows/auto-merge.yml) skips GitHub `--auto` and CI `merge-pr` squash-merges after the required `ci` check. When unset, auto-merge falls back to `GITHUB_TOKEN` `--auto`; those lands are `github-actions[bot]` and suppress workflow runs (observed on #647). [`.github/workflows/ensure-main-ci.yml`](../.github/workflows/ensure-main-ci.yml) remains the safety net. Human merges still use the normal `push` → CI path.

The CI workflow listens for `merge_group` events so merge queue can validate the integrated commit before landing if the feature becomes available. As of 2026-06-28, GitHub rejects `merge_queue` through both REST and GraphQL for this private GitHub Team repository, and neither legacy branch protection nor repository rulesets expose the option in the UI. **Native merge queue requires GitHub Enterprise Cloud for private repos** — unavailable on Free/Pro/Team — so the `merge_group` wiring is forward-compat, not active.

## Concurrent merges

Branch+PR is the canonical path, so concurrent PRs are the normal case — here's how a broken `main` is caught.

The risk with two PRs in flight is a **semantic (logical) conflict**: each passes CI against an older `main`, but `main` breaks when both land (e.g. PR A renames a function, PR B adds a call to the old name — no textual conflict, both green, broken `main`). A merge queue is the canonical fix, but it's Enterprise-only here (above).

**The post-merge `main` CI run is the substitute.** Branch-up-to-date (`strict`) is **off** — requiring it forced every open PR to rebase-and-re-run the full ~13-min battery each time another PR merged (O(k²) churn under concurrency, and on a private repo every re-run costs Actions minutes). Instead, `ci.yml` runs on `push: [main]`, so the moment a merge lands the full battery runs against the actual combined tree:

1. PR #1 and PR #2 each auto-merge as soon as their **own** `ci` is green — no *Update branch* click, no cross-PR re-run.
2. On each merge, `ci` runs on the new `main` commit. If the combination broke, that run goes **red**.
3. A red `main` is fixed forward (a follow-up commit/PR). **Deploy does not run** until main CI is green (`workflow_run`), so a broken tip cannot ship Lambdas/migrations.

This trades strict's **pre-merge** guarantee (a broken combination can't land) for a **post-merge** one (it lands, then is caught and fixed forward within one CI cycle) — the standard trunk-based optimistic-merge posture, matching this repo's fire-and-forward model. Cost is O(k) (one `main` run per merge) instead of strict's O(k²) rebase churn, so it scales as concurrency grows. **Deploy is gated on green main CI** (same trigger shape as the jsolly aws-sam fleet). Vercel's push-triggered web deploy can still race ahead of that gate — keep schema-affecting web changes backward-compatible until migrations land.

**Upgrade path** when concurrent PRs become routine:

- **Kodiak** (free GitHub App): auto-updates branches and merges when green — the closest no-Enterprise equivalent of a merge queue if you ever want the pre-merge guarantee back without strict's manual *Update branch* clicks.
- Team growth → evaluate **Mergify/Graphite** (batching, priorities) or **GitHub Enterprise Cloud** for the native `merge_group` queue this CI is already wired for. Batching only pays off at high merge volume.

## Run gating

The first job (`gate` in `ci.yml`) decides how much of the battery each event actually needs. Two independent skips, both **fail-open** — any API error or ambiguity runs the full battery:

- **Tree-identity skip (push to `main`).** A squash merge whose base did not advance while the PR was open produces a `main` commit whose **tree** is byte-identical to the PR head tree the required `ci` check already validated — re-running the battery proves nothing, so the whole job passes in seconds. When the trees differ (another PR merged first — the only case the post-merge backstop exists for) the full battery runs. Direct (break-glass) pushes have no associated merged PR and always run everything. Net effect: the post-merge `main` run costs a full battery **only when merges actually race**.
- **Docs-only fast path (PRs).** A diff where every changed file matches `docs/**` or `*.md` runs the static checks (Biome, YAML/actionlint, types, Knip, markdown lint, lib boundaries, SQL, deploy-fn coverage, migration grants) and skips the Supabase/test/build steps — the required `ci` check passes in ~2 min instead of ~13. The allowlist is deliberately conservative: `package.json`, workflows, config, or anything ambiguous runs the full battery. The check context stays `ci`, so branch protection needs no change.

The gate needs no checkout — both decisions use only the event payload and the REST API — and writes its decision (`static`/`heavy` + reason) to the step summary of every run. Branch protection still requires the stable **`CI / ci`** context: the expensive work happens in fan-out jobs, and a final tiny job named `ci` aggregates their results and fails closed on any unexpected skip/fail/cancel.

## CI environment

- **Runner:** `blacksmith-4vcpu-ubuntu-2404-arm` (Blacksmith ARM — ~37% cheaper per minute than x64; the battery is arch-neutral) with Docker (`DOCKER_HOST=unix:///var/run/docker.sock`). `deploy.yml` deliberately stays on x64 `blacksmith-4vcpu-ubuntu-2404` — it builds the Lambda artifact that ships to production; don't change artifact arch as a side effect of runner economics.
- **Fan-out shape:** full code-affecting runs split into independent jobs: `static checks` (lint/types/Knip/SQL/static migration grants + Lambda bundle), `unit tests` (Vitest, 1 shard), `e2e tests` (Playwright, 1 shard), `app build`, and the final required `ci` aggregator. Parallelism now lives *inside* each job rather than across shards: Vitest runs test files concurrently and Playwright runs 2 workers. Each job still has its own runner-local Supabase stack. Branch protection is unaffected: it requires the `ci` aggregator, not shard names.
- **Shard-count budget:** a shard trades runner minutes for wall-clock, and each one re-pays the full setup cost, so the right count moves whenever setup or the suite does. Measured with `blacksmith jobs steps` across three consecutive runs after the run-scoped dev server landed: the unit job is ~87s setup + ~87s tests = **174-182s**, and the e2e job is ~81s setup + ~140s tests = **~221s** (`static checks` 107s, `app build` 63s). **E2E is now the sole critical path**, ~45s above unit, so unit sharding cannot move the run at all and e2e is the only job where wall-clock work pays. Setup is now roughly half of each test job, so a second unit shard would buy ~44s of wall-clock for ~87s of extra runner time. This repo optimizes cost (CI is ~94% of its Actions spend), so both stay at 1; on e2e, more Playwright workers on the existing runner is the cheaper experiment than a shard that re-pays setup. History: 6 shards (~75% setup) -> 4 -> 2 (node_modules sticky disk + seed-only bootstrap, setup ~154s -> ~83s) -> **1** (parallel test files, unit suite ~330s -> 130s; 2 Playwright workers, e2e ~208s -> 131s) -> run-scoped dev server (dropped a per-file `astro dev stop` across ~184 files; unit tests ~130s -> ~87s, serial pass 39.6s -> 15.2s). **Re-measure before changing a shard count** (`blacksmith jobs steps <job_id>`): the ceiling is `max(static, unit, e2e, app build)`, and more shards also mean more concurrent Supabase stacks pulling from `public.ecr.aws`, which is what [`ci-db-retry.sh`](../scripts/db/ci-db-retry.sh) exists to absorb.
- **Supabase:** each unit/E2E shard runs one background [`scripts/db/ci-bootstrap.sh`](../scripts/db/ci-bootstrap.sh) (start → write env → seed, with [`ci-db-retry.sh`](../scripts/db/ci-db-retry.sh) on transient registry throttle); a wait step joins and loads `/tmp/ci-bootstrap.env` into `GITHUB_ENV`. The seed step also runs `check:db-privileges` + `check:option-catalog` (not standalone CI steps). Local DX still uses separate `db:start` / `db:reset`. The bootstrap prints `ci-bootstrap: db:start Ns + seed-only Ns = Ns total` so a finished run shows whether the time went to registry pulls or to seeding; the tail-only log view otherwise hides `supabase start`'s pull output.
- **Seed-only bootstrap (no second migration pass):** `supabase start` already applies every file in `supabase/migrations` when it creates the database: a cold start leaves `supabase_migrations.schema_migrations` complete. `db:reset` then dropped that database and replayed the identical set purely so the seed could land on a known-clean DB (CI generates the gitignored `supabase/seed.sql` *after* start, so start has nothing to seed from). On an ephemeral runner the DB is already known-clean, so [`ci-seed-fresh.ts`](../scripts/db/ci-seed-fresh.ts) (`npm run db:ci-seed`) does only what the replay was for (generate seed → apply seed → `db:gen-types` (opt-in) → privilege + option-catalog checks), dropping ~40s per shard. It verifies the stack really is freshly started (every migration applied, `assets`/`auth.users` empty) and exits `3` otherwise, and `ci-bootstrap.sh` then falls back to a full `db:reset`; the fallback is always safe because a reset drops whatever the fast path left behind. Anything that seeds rows in a migration, or a CLI that stops migrating on start, degrades to today's behavior instead of building a half-populated DB. **`db:reset` remains the only supported local reseed**: a long-lived local stack is never "freshly started".
- **Container-pull budget:** the bootstrap's dominant cost is pulling and booting the Supabase stack once per shard (~1.25 GiB compressed across seven containers), so the stack is kept to what the battery actually uses: `studio`, `realtime`, `edge_runtime`, `analytics`, and `storage` are disabled in [`supabase/config.toml`](../supabase/config.toml), each with zero call sites. **The remaining big pull is `supabase/postgres` (~770 MiB compressed) in every heavy job on every run.** It is what the measured 54-70s "Wait for Supabase bootstrap" step is mostly spending, which makes it the single largest non-test cost in both test jobs. No workflow change avoids that one; it needs Blacksmith [Docker container caching](https://docs.blacksmith.sh/blacksmith-caching/docker-container-caching), enabled per-org by filing a support issue from the Blacksmith dashboard. That should also retire the `docker: toomanyrequests` flake below.
- **Playwright:** Chromium **headless shell** only (`npx playwright install --only-shell`). Browser binaries live on a Blacksmith **sticky disk** (`useblacksmith/stickydisk` → `~/.cache/ms-playwright`, keyed by OS+arch) so warm runs mount in ~3s instead of re-downloading. Chromium `install-deps` (apt) is runner-local — marker under `/tmp`, not the sticky disk — because apt packages don't travel with the mount (a sticky-disk marker caused warm E2E to skip apt and fail on missing `libatk`). Install is launched in the background right after the mount so a cold fill overlaps each E2E shard's Supabase bootstrap; a wait step joins before E2E. Traces uploaded on failure from `.playwright-mcp/cli/`.
- **Caching:** `setup-node` npm cache stays on the upstream action, since Blacksmith transparently redirects it to its colocated cache (the `useblacksmith/cache` / `setup-node` forks are archived). Playwright browsers and `node_modules` use **sticky disks** instead of `actions/cache`: both are large binary trees where a tarball download + extract costs more than it saves, while a sticky disk hot-mounts in ~3s with no extraction. `node_modules` (1.1 GB unpacked) is keyed by OS+arch only, *not* by lockfile hash, because a hashed key hands every dependency bump an empty disk. [`scripts/ci-npm-install.sh`](../scripts/ci-npm-install.sh) instead stamps the lockfile hash inside the disk and reruns `npm ci` (~19s) whenever it or `node_modules/.bin/tsx` is missing, so a hit is exactly the tree `npm ci` would have produced. The npm cache stays on `setup-node` as the miss-path accelerator.
- **postgres-meta image:** `db:gen-types` (the tail of `db:ci-seed` / `db:reset`) shells out to a one-shot `public.ecr.aws/supabase/postgres-meta` container that `supabase start` never creates, so its ~99 MB image was pulled cold at the end of every heavy job (~20s on the critical path, several hundred pulls/month). Two mitigations: shards that never read the regenerated file set `DB_RESET_SKIP_GEN_TYPES=1` (only unit shard 1 does, for the "generated types are checked in" assertion), and [`ci-prewarm-postgres-meta.sh`](../scripts/db/ci-prewarm-postgres-meta.sh) starts the pull in the background at the top of the bootstrap for the shard that still needs it, so it overlaps start + seed. The tag is read from `supabase services`, never hardcoded, so a CLI bump can't silently prewarm a stale image.
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

The Deploy workflow runs via `workflow_run` after **successful CI on `main`** (triggering event `push`, or `workflow_dispatch` from post-merge-bot after a `GITHUB_TOKEN` merge), plus human `workflow_dispatch` break-glass. It does **not** fire in parallel with a still-running/red main CI. A deploy for a **stale** commit (one `main` has already moved past) is blocked by a main-tip check (`git ls-remote` tip vs the CI `head_sha`); its `deploy-production` concurrency group (`cancel-in-progress: false`) serializes queued deploys.

When a merge lands on the current `main` tip:

1. Vercel's GitHub integration deploys the web tier from the landed `main` commit (independent of Actions Deploy).
2. Main CI runs (push or bot-dispatched). On green, Deploy starts.
3. `aws/deploy-web.sh --deploy-ci` builds Lambda code, applies Supabase migrations, and updates existing Lambda code.
4. The workflow invokes `stocktextalerts-live-provider-check` (untagged post-deploy invoke — quote expectations follow the current market session; weekday schedules at 08:00 / 12:00 / 17:30 ET pass a `window` Input for pre / regular / after).
5. A red Deploy means production needs a forward-fix change; do not rerun manual production DDL outside the deploy workflow. `/ship` babysits Deploy and fails the ship if Deploy stays red.

Infra changes (`aws/template.yaml`, `aws/deploy.sh`) still need `npm run deploy:infra` (full SAM, admin creds) for new resources and config (timeout/memory/env/IAM). Pure infra-only commits skip migrations + Lambda code update + live-provider check (workflow stays green) and still run the infra-drift check so a forgotten manual infra deploy fails closed on Timeout/MemorySize. Mixed commits that also change app code still run migrations + Lambda code updates. The infra-drift check only fail-closes on Timeout/MemorySize drift — env/IAM/schedule still need the manual infra deploy. After every successful code deploy, the live-provider-check Lambda must return `{ ok: true, releaseId }` matching the deployed commit SHA (12 chars) — that assert is what proves the uploaded bundle is live (proxy for the shared stamp across all functions).
