# Testing GitHub Actions Locally

This repo uses [`act`](https://github.com/nektos/act) to run GitHub Actions locally.

## Why this setup

- It runs the real workflow/jobs from `.github/workflows`, so local checks stay aligned with CI.
- It supports running a single job (`lint`, `test-and-build`) to keep feedback fast.
- It uses a generated pull request event payload so the shared migration guard in `.github/actions/run-ci` has expected event fields.

## 1) Install prerequisites

1. Install Docker Desktop (or Docker Engine).
2. Install `act`:

```bash
brew install act
```

## 2) Optional secrets

If a workflow needs secrets, copy and edit:

```bash
cp .act.secrets.example .act.secrets
```

`noDeploy.yml` does not require production secrets, but other workflows may.

## 3) Run local workflow checks

Run the full pull request workflow (`noDeploy.yml`):

```bash
npm run gha:local
```

Run a single job:

```bash
npm run gha:local:lint
npm run gha:local:test-build
```

Verbose mode:

```bash
scripts/ci/run-local-actions.sh --verbose
```

## Notes

- Defaults live in `.actrc` (runner image, architecture, container reuse).
- The script writes a temporary event file to `.tmp/act-event-pull_request.json`.
- If `origin/main` exists locally, the script uses `git merge-base` with `HEAD` as the PR base SHA; otherwise it falls back to `HEAD`.
