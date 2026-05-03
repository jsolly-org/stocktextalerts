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

## Dev Environment

### Prod dev-login account

`test@jsolly.com` with `DEFAULT_PASSWORD` env var. This is the only place a real inbox is allowed to appear by name; it exists as a row in production Supabase for interactive login during local dev against prod. **Not used by the test harness** — `tests/helpers/constants.ts:PRESERVED_TEST_EMAIL` is `preserved-test@example.com` (deliberately non-routable).

### Mailpit for dev email

`.env.local` sets `EMAIL_SMTP_HOST=localhost` and `EMAIL_SMTP_PORT=1025` so any email the dev server would otherwise send through SES lands in Mailpit at `http://localhost:54324` instead. Requires local Supabase running (`npm run db:start`).

`tests/run-vitest.ts` strips both env vars under plain `npm test` so unit tests stay on the in-process mock sender, and re-exports them when `--live=email` is passed.
