# Tooling Setup

Local-machine setup notes for non-app tooling (CLI auth, dev email, prod DB access). These are setup-time references, not per-session conventions.

## Production Supabase

- Credentials in `.env.local`: `SUPABASE_URL_PROD`, `DATABASE_URL_PROD`, `SUPABASE_SECRET_KEY_PROD`
- Project ref: `japesagairjvvuebzpvr`
- **psql:** `psql "$DATABASE_URL_PROD"` (pooler on port 6543)
- Access token in `.env.local` as `SUPABASE_ACCESS_TOKEN`

## Vercel CLI

Authenticated via `npx vercel` to `jsollys-projects` scope. Useful commands:

```bash
npx vercel ls
npx vercel inspect <url> --logs
npx vercel env ls
```

## Cloudflare CLI

`wrangler` is installed globally. Auth uses Global API Key (`CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL` in `~/.zshrc`).

- Account: John Solly (`cloudflare@jsolly.com`)
- Account ID: `fe860aed6545e6e55e2808d66decf186`

## YAML linting

`npm run check:yaml` runs two tools — both required, both invoked from the pre-commit hook and CI:

- **yamllint** (Python) — rule-based YAML linter, configured via `.yamllint` (`extends: relaxed`, `line-length` disabled).
- **actionlint** (Go) — validates GitHub Actions semantics (expression syntax, action refs) and runs shellcheck on `run:` blocks. Surfaces things yamllint can't.

Install both via Homebrew:

```bash
brew install yamllint actionlint
```

CI installs them per-run (yamllint via `pipx`, actionlint via the upstream `download-actionlint.bash` script). Versions are pinned in `.github/workflows/noDeploy.yml` and `.github/actions/run-ci/action.yml` — bump them together if you upgrade locally.

## Dev Environment

### Prod dev-login account

`test@jsolly.com` with `DEFAULT_PASSWORD` env var. This is the only place a real inbox is allowed to appear by name; it exists as a row in production Supabase for interactive login during local dev against prod. **Not used by the test harness** — `tests/helpers/constants.ts:PRESERVED_TEST_EMAIL` is `preserved-test@example.com` (deliberately non-routable).

### Mailpit for dev email

`.env.local` sets `EMAIL_SMTP_HOST=localhost` and `EMAIL_SMTP_PORT=1025` so any email the dev server would otherwise send through SES lands in Mailpit at `http://localhost:54324` instead. Requires local Supabase running (`npm run db:start`).

`tests/run-vitest.ts` strips both env vars under plain `npm test` so unit tests stay on the in-process mock sender, and re-exports them when `--live=email` is passed.

## Worktrees

Worktrees live at `.claude/worktrees/<branch>/` — the location `EnterWorktree` defaults to. The directory is gitignored (`.gitignore` line 38). `EnterWorktree`'s base path is hardcoded; `worktree.baseRef` in `~/.claude/settings.json` only controls which branch is forked.

When adopting any tool that descends into worktrees and tries to load nested config (biome 2.x was the first case — `nested root configuration` startup error), add a root-anchored exclude. The canonical shape is in `biome.jsonc`:

- **Use `!.claude`, not `!**/.claude`.** The over-broad form silently turns `biome ci .` into a no-op when run from inside a worktree, which silently disables the pre-commit gate.
- **Mirror the alt-locations** (`!.worktrees`, `!worktrees`) — the `superpowers:using-git-worktrees` skill uses these names if `EnterWorktree` is unavailable.

Other tools to watch when adopted: eslint, jest, tsserver — anything with config-discovery that walks subdirectories.
