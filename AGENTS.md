## Purpose
New app with no users — optimize for simplicity and correctness over backwards compatibility. Prefer aggressively simplifying redesigns, even if breaking. Remove legacy code instead of preserving it.

## Commands
- `npm run build` — Production build
- `npm test` — Run Vitest tests
- `npm run test:e2e` — Playwright E2E tests
- `npm run check:ts` — TypeScript check
- `npm run check:biome` — Lint check
- `npm run fix` — Auto-fix lint issues
- `npm run db:reset` — Reset local Supabase DB
- `npm run db:gen-types` — Regenerate DB types
- `supabase migration new <name>` — Create a new migration file (auto-generates timestamp)

## CI Pipeline
The shared `.github/actions/run-ci` composite runs lint (Biome + typecheck), Supabase setup, tests, and build. It accepts `skip-lint`:
- **skip-lint** — When `'true'`, skips Biome and type check. Use when a separate lint job already covers them to avoid duplicate work.
- **Workflows:** `noDeploy` uses two jobs: a lightweight `lint` job for fast feedback, and `test-and-build` with `skip-lint: 'true'` so it does not rerun Biome/typecheck. The `deploy` workflow uses run-ci without skip-lint (single job, full pipeline).

## Supabase Migrations
- **Always** create migrations with `supabase migration new <name>` — never create files manually or rename timestamps.
- The CLI generates a precise timestamp (e.g., `20260209223746`). This timestamp is recorded in the remote `schema_migrations` table when `supabase db push` runs in CI. Renaming the file (e.g., to `20260209200000`) causes a mismatch that breaks CI.
- **Production is CI-only.** Do not run `supabase db push` against production from a local machine. Do not run `supabase link --project-ref` with the production project ref. Do not use MCP `apply_migration` against the production database. Do not execute DDL via the Supabase dashboard SQL editor.
- **Production migration path:** `supabase migration new <name>` → write SQL → commit → merge to `main` → CI runs `supabase db push`.
- MCP `apply_migration` is for iterating on the **local** Supabase database only.

## Local Dev Login
- Test user email: `test@jsolly.com` (defined in `scripts/data/users.json`)
- Password: the `DEFAULT_PASSWORD` value from `.env.local`
- Created by `supabase/seed.sql` (regenerated via `npm run db:gen-seed`)

## Guidelines
- [Code Style & Structure](.agents/code-style.md)
- [Error Handling & Validation](.agents/error-handling.md)
- [Tech Stack & Tools](.agents/tech-stack.md)
- [Testing](.agents/testing.md)
