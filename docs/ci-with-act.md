# CI before push to main

There is no separate GitHub Actions test workflow on `main`. **`.git-hooks/pre-commit`** runs the same checks as **[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)** via the shared **[`run-ci`](../.github/actions/run-ci)** composite (lint, typecheck, migration-grant lint, Supabase + DB-privilege check, unit tests, E2E, build). Push to `main` runs deploy, which repeats that guard then ships to production.

## Local guard (run before every commit)

```bash
# Hooks install once per clone (package.json prepare sets core.hooksPath)
git commit   # runs .git-hooks/pre-commit

# Or run the same stack manually:
bash .agents/scripts/check-biome-rules.sh biome.jsonc
npx biome ci . --error-on-warnings
npm run check:yaml
npm run check:md
npm run check:ts
npm run check:knip
npm run check:sql
npm run check:migration-grants   # static: migrations grant EXECUTE on new functions
npm run check:db-privileges      # needs local Supabase up: grants match privilege-contract
npm run test
npm run test:e2e
npm run build
```

See [docs/incidents/2026-04-ci-race.md](incidents/2026-04-ci-race.md) for why local-only `npm test` is not enough when changing workflows, test harness, or Supabase config.

## GitHub workflows on `main`

| Workflow | When |
| --- | --- |
| `deploy.yml` | Every push — `run-ci` + production Supabase/Vercel/Lambda |
| `live-provider-tests.yml` | Scheduled + manual — live vendor APIs (not in pre-commit) |
| `fleet-lock-guard.yml` | Push when `.agents/**` changes |

`deploy.yml` is **not** runnable with [act](https://github.com/nektos/act); it uses production credentials. Reproduce its CI steps locally with the commands above.

## When to run the full local stack (checklist before `git push`)

1. Any change to `.github/workflows/**` or `.github/actions/**`.
2. Any change to `tests/**` that isn't purely additive (moving/renaming tests, changing setup/teardown, test helpers, vitest config, playwright config).
3. Any change to `tests/run-vitest.ts`, `playwright.config.ts`, `tests/setup.ts`, `tests/helpers/live-api.ts`, or anything else that gates test behavior on env vars.
4. Any change to `supabase/config.toml` (service toggles, migration loader, SMTP settings).
5. Any change to `package.json` scripts that deploy calls (`test`, `test:ci`, `test:e2e`, `build`).
6. Any change to core build tooling: `astro.config.mjs`, `vitest.config.ts`, `tsconfig*.json`.
7. Any change that adds/removes a `@*/`-scoped dependency or shifts dev deps to runtime deps (or vice versa).

For pure `src/lib/**` or `src/pages/**` changes that don't touch any of the above, local `npm test` / `npm run test:e2e` are sufficient.
