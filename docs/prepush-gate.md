# The pre-push gate on `main`

The **pre-push gate** — `.git-hooks/pre-push` →
[`scripts/prepush.sh`](../scripts/prepush.sh) — runs the full battery on push to `main`, then
deploys (`aws/deploy-web.sh`: Supabase migrations → Lambda code). A failing check aborts the
push, so nothing ships ungated. The web tier deploys via Vercel's git integration, which
auto-builds `main` once the push lands.

## The gate (runs automatically on push to `main`)

```bash
git push origin main   # runs .git-hooks/pre-push → scripts/prepush.sh

# The same battery, to run by hand while iterating:
npx biome ci . --error-on-warnings
npm run check:yaml
npm run check:ts
npm run check:md
npm run check:knip
npm run check:sql
npm run check:migration-grants   # static: migrations grant EXECUTE on new functions
npm run check:db-privileges      # needs local Supabase up: grants match privilege-contract
npm run test
npm run test:e2e
```

(The production web build is not a gate step — Vercel builds `main` on its own
infrastructure after the push lands, with `VERCEL_PROJECT_PRODUCTION_URL` set by
the platform.)

The gate needs **local Supabase up** (`npm run db:start`) for `check:db-privileges`, `test`, and
`test:e2e`. See [docs/incidents/2026-04-ci-race.md](incidents/2026-04-ci-race.md) for why a bare
`npm test` isn't enough when changing the test harness or Supabase config.

## Live vendor-API health check

The live vendor-API health check runs as the scheduled `stocktextalerts-live-provider-check` Lambda (weekday mid-session, `aws/template.yaml`); failures fire `stocktextalerts-live-provider-check-lambda-errors` → shared-infra. Deploy and CI run in the local pre-push gate.

## When the full local stack matters most (iterate before pushing)

The gate always runs everything on push, but run it manually first when touching:

1. `tests/**` non-additively (moving/renaming, setup/teardown, helpers, vitest/playwright config).
2. `tests/run-vitest.ts`, `playwright.config.ts`, `tests/setup.ts`, `tests/helpers/live-api.ts`, or anything gating test behavior on env vars.
3. `supabase/config.toml` (service toggles, migration loader, SMTP settings).
4. `package.json` scripts the gate/deploy call (`test`, `test:e2e`, `build`).
5. Core build tooling: `astro.config.mjs`, `vitest.config.ts`, `tsconfig*.json`.
6. Any add/remove of a `@*/`-scoped dependency or dev↔runtime dep shift.

For pure `src/lib/**` or `src/pages/**` changes, local `npm test` / `npm run test:e2e` are enough
to iterate before the push runs the rest.
