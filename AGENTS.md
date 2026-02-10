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
- **Never** apply migrations directly via the Supabase dashboard SQL editor. All schema changes must go through migration files in this repo so CI stays in sync.

## Guidelines
- [Code Style & Structure](.agents/code-style.md)
- [Error Handling & Validation](.agents/error-handling.md)
- [Tech Stack & Tools](.agents/tech-stack.md)
- [Testing](.agents/testing.md)
