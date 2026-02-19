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

## GH_AGENT_TOKEN (CI Secret)
Many workflows use `GH_AGENT_TOKEN` because `GITHUB_TOKEN` lacks the `workflows` permission. Without it, auto-merge, branch updates, and agent pushes that touch `.github/workflows/` will fail.

**Where to add:** Repository Settings → Secrets and variables → Actions → New repository secret → name: `GH_AGENT_TOKEN`.

**How to create:** Use a [Personal Access Token (classic)](https://github.com/settings/tokens) or [fine-grained token](https://github.com/settings/personal-access-tokens/new).

**Required permissions:**

| Token type   | Permissions |
|--------------|-------------|
| Classic PAT  | `repo` (full control of private repositories) |
| Fine-grained | `Contents: Read and write`, `Pull requests: Read and write`, `Workflows: Read and write`, `Issues: Read and write` |

Fine-grained: restrict to "Only select repositories" → this repo. Classic: no additional scopes beyond `repo`.

**Token lifecycle:**
- Set an expiration period appropriate for your security policy (recommended: 90 days).
- When the token expires, workflows will fail with authentication errors. Create a new token and update the repository secret.
- Consider setting a calendar reminder for token renewal.

## Guidelines
- [Code Style & Structure](.agents/code-style.md)
- [Error Handling & Validation](.agents/error-handling.md)
- [Tech Stack & Tools](.agents/tech-stack.md)
- [Testing](.agents/testing.md)
