## Cursor Cloud Setup

### System Dependencies

- **Node.js 24** — required (`.nvmrc`). Use `source ~/.nvm/nvm.sh && nvm use 24` before any npm command.
- **Docker** — required for local Supabase. Start the daemon with `sudo dockerd &>/tmp/dockerd.log &`.
  Avoid `chmod 666 /var/run/docker.sock`; prefer either:
  - running Docker commands with `sudo`, or
  - adding your user to the `docker` group (`sudo usermod -aG docker "$USER"`), then re-login.
  Docker is configured with `fuse-overlayfs` storage driver and `iptables-legacy` for the nested container environment.

### Service Startup Sequence

1. Start Docker daemon (see above)
2. `npm run db:start` — starts ~15 Supabase containers (Postgres, Auth, PostgREST, Studio, Mailpit, etc.)
3. `npm run db:reset` — generates seed, applies migrations, seeds DB, regenerates TypeScript types
4. `npm run dev` — starts Astro dev server at `http://localhost:4321`

### Key Local URLs

| Service | URL |
|---------|-----|
| Astro dev server | http://localhost:4321 |
| Supabase Studio | http://127.0.0.1:54323 |
| Mailpit (email) | http://127.0.0.1:54324 |

### Gotchas

- The `.env.local` file must exist before running tests or the dev server. Copy from `env.example` and fill in Supabase keys from `supabase status` output. For external APIs (AWS SMS, Massive, Finnhub), use fake/placeholder values — tests stub them.
- `scripts/data/users.json` is gitignored and must be created manually (copy from `scripts/data/sample-users.json` or create with a `test@jsolly.com` entry). Without it, `npm run db:gen-seed` still works but creates no test users.
- `supabase db reset` may emit a transient 502 during container restart — this is harmless. Run `npm run db:gen-types` separately if it fails mid-pipeline.
- `npm run check:ts` has a pre-existing TS error in `src/pages/api/auth/sms/send-verification.ts` (Type 'string | null' not assignable to type 'string'). This is in the existing codebase, not introduced by setup.
- Vitest tests require a running Supabase instance. Always `npm run db:start` + `npm run db:reset` before `npm test`.
- Playwright E2E tests need browsers installed first: `npx playwright install`.
