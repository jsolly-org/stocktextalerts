# Reproduce CI locally with Act

Run Act locally before pushing changes that affect CI, workflows, tests, or dev tooling — local `npm test` 20/20 passes have shipped CI-only races. See [docs/incidents/2026-04-ci-race.md](incidents/2026-04-ci-race.md) for one.

## Setup

- **Install**: `brew install act` (already installed; config in `.actrc`).
- **List jobs**: `act -l`.

## Common runs

- **Full test-and-build job locally** (composite action: migrations, npm test, test:e2e, build):

  ```bash
  npm run gha:local:test-build
  ```

  Uses `scripts/ci/run-local-actions.sh` → runs `noDeploy.yml`'s `test-and-build` job in a `catthehacker/ubuntu` container with the repo mounted. Matches CI's node version, Supabase CLI version, and exact step sequence.
- **Lint only**: `npm run gha:local:lint`.
- **Full E2E suite** (workflow_dispatch-gated job): `npm run gha:local:e2e`. Reproduces the deploy workflow's E2E step against `run-ci` without prod credentials. Skipped on normal pushes to `main` to keep CI fast; opt in via `workflow_dispatch` or this script.
- **Custom workflow or job**: `scripts/ci/run-local-actions.sh --workflow .github/workflows/<file>.yml --job <name>`.

## Limitations

- `Deploy Website` (`.github/workflows/deploy.yml`) is **not act-runnable by design**. It links the live Supabase project, pushes migrations, deploys to Vercel, and updates Lambda code with real credentials. `scripts/ci/run-local-actions.sh` explicitly rejects `--workflow .github/workflows/deploy.yml` to prevent half-run production side effects. To reproduce its CI parts locally, use `npm run gha:local:test-build` (same `run-ci` composite) and `npm run gha:local:e2e` (same Playwright step).
- Act needs `DOCKER_HOST` pointing at Podman's socket. The `~/.zshrc` block that runs `podman machine inspect` to resolve the socket path should already be exporting it; check with `echo "$DOCKER_HOST"` before running act. See [docs/local-supabase.md](local-supabase.md) for the export.
- **Podman VM needs ≥ 6144 MB of memory** for Vitest to complete without the in-VM OOM killer issuing `SIGKILL`. `scripts/ci/run-local-actions.sh` preflight-checks the VM and fails with the fix command if undersized. It also prunes stale `act-*` containers from prior runs that would otherwise keep the VM under memory pressure.
- Act containers run the host's native architecture (arm64 on Apple Silicon, amd64 on Linux/Intel CI runners). Forcing `linux/amd64` via `--container-architecture` made Playwright's headless Chromium crash under QEMU on M-series Macs (`qemu: uncaught target signal 5`), so it's intentionally omitted from `.actrc`. CI still runs amd64 natively on GitHub's Ubuntu runners, and `catthehacker/ubuntu:act-latest` ships both arches — local runs now ~2× faster than the amd64-forced setup.

## When to run it (checklist before `git push`)

1. Any change to `.github/workflows/**` or `.github/actions/**`.
2. Any change to `tests/**` that isn't purely additive (moving/renaming tests, changing setup/teardown, test helpers, vitest config, playwright config).
3. Any change to `tests/run-vitest.ts`, `playwright.config.ts`, `tests/setup.ts`, `tests/helpers/live-api.ts`, or anything else that gates test behavior on env vars.
4. Any change to `supabase/config.toml` (service toggles, migration loader, SMTP settings).
5. Any change to `package.json` scripts that CI calls (`test`, `test:ci`, `test:e2e`, `build`).
6. Any change to core build tooling: `astro.config.mjs`, `vitest.config.ts`, `tsconfig*.json`.
7. Any change that adds/removes a `@*/`-scoped dependency or shifts dev deps to runtime deps (or vice versa).

For pure `src/lib/**` or `src/pages/**` changes that don't touch any of the above, local `npm test` / `npm run test:e2e` are sufficient — act adds latency for no signal.
