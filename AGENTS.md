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

## GitHub Actions / CI
- **Workflow concurrency:** Workflows that run on `pull_request` or `push` should use `concurrency` to avoid stale runs on rapid commits.
- **Group naming:** Use `group: <workflow-name>-${{ github.head_ref || github.ref }}` for PR/branch-scoped workflows (e.g. `noDeploy`) so different branches run in parallel; use `group: <workflow-name>` for branch-push-only workflows (e.g. `update-open-pr-branches`) where a single group is sufficient.
- **cancel-in-progress:** Set `cancel-in-progress: true` so new runs cancel in-progress ones in the same group, preventing outdated results and wasted CI time.
- See `.github/actions/` READMEs for composite actions (run-precommit-checks, run-ci with skip-lint, agent-run-queue-and-ratelimit) and post-dev-push flow.

## Guidelines
- [Code Style & Structure](.agents/code-style.md)
- [Error Handling & Validation](.agents/error-handling.md)
- [Tech Stack & Tools](.agents/tech-stack.md)
- [Testing](.agents/testing.md)
