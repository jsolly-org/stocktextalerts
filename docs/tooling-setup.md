# Tooling Setup

Local development tooling, Astro 7 workflow notes, and pointers for production access.

## Astro 7

This project runs **Astro 7** with **Vite 8** (Rolldown bundler). Vercel builds use the same pipeline with no extra config.

### Compiler and HTML defaults

- **Rust compiler** (default in v7): unclosed tags fail the build; invalid HTML nesting is no longer auto-corrected. Run `npm run build` after template changes.
- **`compressHTML: "jsx"`** (default): adjacent inline elements may lose implicit spaces. Fix with explicit `{" "}` or valid markup rather than disabling globally.

### Dev server lock (Astro 7)

Astro 7 writes a project dev lock (`.astro/dev.json`) when the dev server runs. Test runners call `astro dev stop` before starting servers to avoid collisions.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Dev server at <http://localhost:4321> |
| `npm run dev:stop` | Stop background dev server / clear lock |
| `astro dev status` | Show running dev server PID and URL |
| `astro dev logs` | Tail background dev server logs |

### Port map (dev and tests)

| Port | Use |
| --- | --- |
| **4321** | Default `npm run dev` |
| **4322** | Playwright E2E (`npm run test:e2e`) |
| **4323** | Production preview (`npm run preview`, `npm run test:e2e:preview`) |
| **4325** | Vitest HTTP integration tests |

Preview builds swap `@astrojs/node` via `ASTRO_ADAPTER=node` because the Vercel adapter does not support `astro preview`. The Vite build pipeline matches production; only the serving layer differs.

## Mailpit (local email)

When `EMAIL_SMTP_HOST` is set (default `localhost` in `.env.local`), outbound email routes to Mailpit bundled with local Supabase.

- **SMTP:** port from `EMAIL_SMTP_PORT` (default `1025`)
- **Web UI:** Supabase API port + 3 (default <http://127.0.0.1:54324>)

Unit tests strip `EMAIL_SMTP_HOST` to avoid SMTP + fake-timer deadlocks. E2E and `MODE=test` dev keep Mailpit routing.

See [tests/README.md](../tests/README.md) for the full test email policy.

## Worktrees

Manual `git worktree add` runs `.git-hooks/post-checkout`, which calls `npm run worktree:provision` (copies `.env.local`, `npm ci`, mise). It does **not** run `db:bootstrap` — use `npm run worktree:init` for a first run that also seeds the shared local Supabase stack.

All worktrees share one local Supabase instance and serialize tests via `<git-common-dir>/test.lock`; `.env.local` keeps the shared default ports rather than receiving worktree-specific patches. Never symlink `node_modules` between worktrees — Vite's `server.fs.allow` rejects the symlinked checkout with 403 responses.

To retire an old per-worktree Supabase stack, preview `npm run db:collapse-worktree-stacks`; add `-- --apply` only after reviewing the dry run.

Biome excludes `.claude`, `.worktrees`, and `worktrees` at the repo root only (not `**/.claude`) so `biome ci .` works from inside a worktree checkout.

## Production Supabase (read-only inspection)

Use your hosted project’s connection string (`DATABASE_URL_PROD` / `SUPABASE_URL_PROD` in local templates or the GitHub `Production` environment). Project ref looks like `<supabase-project-ref>`. Use read-only tooling when verifying schema or row counts — never apply migrations or DDL outside the GitHub deploy workflow.

Agents must not run `supabase db push` or production writes without explicit user approval. See [self-hosting.md](self-hosting.md) for bootstrap.

## Vercel CLI (optional)

Install globally: `npm i -g vercel`. Link the project for `vercel env pull` and deployment inspection. Production web deploys are GitHub-managed; CLI is mainly for env sync and debugging.
