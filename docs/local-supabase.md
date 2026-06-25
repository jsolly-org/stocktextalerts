# Local Supabase

Local Supabase runs in containers via **Podman** (not Docker Desktop). The `db:bootstrap` recipe owns the full first-run / "reset everything" flow.

## Bootstrap

Canonical bootstrap is `npm run db:bootstrap` — runs `db:link-worktree-data`, `db:start`, `db:reset`, then `db:doctor`. Reach for this (not ad-hoc psql) whenever the local stack looks wedged: ECONNREFUSED from `@supabase/auth-js`, `invalid_credentials` on a known-good password, empty `auth.users`, etc. `supabase start` can silently skip half the seed; `db:reset` re-runs `seed.sql` through a fresh session and is reliable. See [docs/incidents/2026-04-seed-regression.md](incidents/2026-04-seed-regression.md) for the regression that motivated this.

`npm test` auto-runs `db:doctor` via `pretest`; `npm run dev` runs it via `predev` (non-blocking — a failure prints a hint and still starts the dev server so frontend-only work isn't gated on Supabase being up). The pre-push gate calls `npm test`, so the `db:doctor` preflight runs there too.

After machine reinstalls, Podman upgrades, or Supabase CLI upgrades, run `scripts/ci/verify-local-supabase.sh` once to confirm the full bootstrap still works end-to-end (wraps `db:bootstrap` + `db:doctor`).

## One shared stack across worktrees

**All worktrees share ONE local Supabase stack** (default ports `54321`/`54322`/`54324`/`1025`,
project_id `stocktextalerts`). There is no per-worktree stack. Isolation between worktrees' DB
access is the **cross-worktree test lock** (`<git-common-dir>/test.lock`) — it's shared by every
worktree because they share one `.git/`. A second worktree that starts `npm test` while another is
running just waits for the lock (`✗ Tests are already running.` banner). See
`docs/plans/2026-06-21-shared-local-supabase-stack.md` for why (the 7.45 GiB swapless Podman VM
OOM-wedged once 2-3 isolated stacks ran at once).

**Provision a fresh worktree with one command: `npm run worktree:init`** — a real `npm ci` (never
symlink `node_modules` — a symlink resolves outside the worktree root and Vite's `server.fs.allow`
then 403s on `@astrojs/vue/dist/client.js`, breaking island hydration), then `db:bootstrap`. The
`.env.local` is *copied* (never symlinked) from the primary checkout by `.worktreeinclude`; since
every worktree shares the default ports, that verbatim copy is already correct — no port-patching.

**`db:reset` serializes via the lock.** Because it truncates and reseeds the *shared* DB, `db:reset`
acquires the same `test.lock` (`command: "reset"`) first, so it can't yank the database out from
under another worktree's running suite (and vice-versa). `db:start` is deliberately not locked.

**Schema drift across worktrees:** with one shared schema, a worktree on a different migration set
sees whatever the last `db:reset` applied. `db:doctor` (and vitest's `tests/setup.ts`) compare the
live `app_metadata.schema_version` to this branch's `EXPECTED_DB_SCHEMA_VERSION` and fail loud with
a `npm run db:reset` hint. Switch branches → if doctor flags drift, `npm run db:reset`.

**GoTrue (auth) email-config drift:** the Supabase CLI bakes `config.toml`'s email *subjects* into
the auth container as `GOTRUE_MAILER_SUBJECTS_*` env at `supabase start` time. `supabase db reset`
reseeds the DB but **never recreates the auth container** (same container id before and after), and a
plain `podman restart` keeps the stale baked env — so on the one shared, long-lived stack an auth
container started from an older `config.toml` keeps serving the *default* subjects ("Confirm Your
Signup" instead of "Confirm your email — StockTextAlerts") indefinitely. That silently fails exactly
the four email/auth E2E specs that assert on the subject (auth-onboarding confirmation + recovery,
profile-settings email change, registration-approval). The only CLI path that makes GoTrue re-read
`config.toml` is a full `supabase stop && supabase start` recreate (`supabase start` won't recreate a
single removed service while the stack is "already running"). So `db:reset` **auto-reconciles**:
`scripts/db/gotrue-config.ts` compares the container's baked subjects to `config.toml` and, *only when
they differ*, pays the ~35s stop+start before reseeding — the in-sync path stays cheap. `db:doctor`
(the pre-push gate's preflight) is the read-only tripwire: on positive drift it fails with the exact
mismatch and `npm run db:reset`, instead of surfacing as four cryptic Playwright failures.

**Migrating from the old per-worktree model:** existing worktrees still carry a `skip-worktree`'d
`config.toml` (project_id `stocktextalerts-wt-<slug>`, offset ports). Run the one-shot migration —
**dry-run first**, then `--apply`:

```bash
npm run db:collapse-worktree-stacks            # show the plan (changes nothing)
npm run db:collapse-worktree-stacks -- --apply # restore configs + tear down stocktextalerts-wt-* stacks
```

It restores each worktree's `config.toml`, removes `supabase/.worktree/`, repoints `.env.local` at
the shared ports in place, and force-removes every Podman container/volume containing
`stocktextalerts-wt-` (allowlist-only — the main `stocktextalerts` stack can never match). A worktree
that *skips* the migration isn't silently broken: `db:doctor` refuses to run with project_id !=
`stocktextalerts` and points you here.

**Single-stack recovery.** The one stack being down/wedged blocks every worktree. If `supabase start`
fails on a collation-version mismatch or `28P01 password authentication failed` (stale volume), do a
deliberate, *named* removal of the main volume (never a loop) then re-bootstrap:

```bash
podman volume rm -f supabase_db_stocktextalerts supabase_storage_stocktextalerts && npm run db:bootstrap
```

## Seed hardening

`seed.sql` is generated by `scripts/db/generate-seed.ts`:

- **Section order**: users (auth + profile) → assets → user tracked assets → verification. Users come first so a partial seed surfaces as "login broken" (obvious) rather than "user silently missing while assets succeed."
- Each per-user block is wrapped in `BEGIN`/`COMMIT` for per-user atomicity.
- The final `DO $$ … $$` block `RAISE EXCEPTION`s if any expected `auth.users` / `public.users` row, or any user's tracked assets, didn't land. This fails `supabase db reset` loudly instead of leaving a half-seeded stack.
- Do **not** add psql meta-commands (`\set`, `\if`, etc.) to the generated SQL — `supabase db reset` streams it over a raw Postgres connection, not through psql, and those are syntax errors.

## Podman setup

Docker Desktop is **not** used here — see [docs/incidents/2026-04-docker-uninstall.md](incidents/2026-04-docker-uninstall.md).

Start the engine once per boot:

```zsh
podman machine start          # first time: `podman machine init` then `podman machine start`
```

That's the only required step — the `db:*` scripts wire the Supabase CLI to it automatically (see
**Container engine wiring** below). The optional one-time `~/.zshrc` block below puts the `podman`
binary on `PATH` and exports `DOCKER_HOST` for **bare** `supabase` / `sam local invoke` calls you run
outside the npm scripts:

```zsh
export PATH="/opt/podman/bin:$PATH"
export DOCKER_HOST="unix://$(/opt/podman/bin/podman machine inspect podman-machine-default --format '{{.ConnectionInfo.PodmanSocket.Path}}' 2>/dev/null)"
```

The `DOCKER_HOST` value resolves at shell-startup time to the current Podman machine's socket — it's `/var/folders/.../T/podman/podman-machine-default-api.sock` and changes if the machine is recreated.

**Podman VM needs ≥ 6144 MB of memory** if you run Vitest inside a container. See [docs/incidents/2026-04-podman-oom.md](incidents/2026-04-podman-oom.md) for VM sizing notes. On Apple Silicon (applehv) the VM's CPU/memory can't be changed via `podman machine set` — recreate with `podman machine init` to resize.

### Container engine wiring

The Supabase CLI talks to the container engine through Go's Docker SDK, which reads `DOCKER_HOST`
(falling back to `/var/run/docker.sock`). That fallback is a trap on Podman: the machine's API socket
lives at an ephemeral `$TMPDIR` path that changes on every reboot/recreation, and the
`/var/run/docker.sock` docker-compat symlink isn't created automatically — when it does exist it can
point at a dead Docker Desktop path (the 2026-06-24 `db:bootstrap` failure: a stale symlink survived
the Docker uninstall while the Podman machine was healthy at its own socket).

So [`scripts/db/container-engine.ts`](../scripts/db/container-engine.ts) derives `DOCKER_HOST` at
runtime from `podman machine inspect` and sets it on `process.env` before any CLI call. `db:start`,
`db:reset`, `db:stop`, and `db:gen-types` (the last two via the
[`scripts/db/supabase.ts`](../scripts/db/supabase.ts) wrapper) all route through it, so local
Supabase boots on a fresh machine with **no manual env surgery**. An explicitly-set `DOCKER_HOST`
(e.g. the `~/.zshrc` export) is respected untouched. If no engine is reachable it fails loud with an
actionable hint pointing at `podman machine start`, instead of the misleading "Cannot connect to the
Docker daemon … install Docker Desktop" error the CLI emits by default.

`DOCKER_HOST` is the one Docker-named contract we keep — the Supabase CLI and `sam local invoke`
require that exact env var. Everywhere we control the vocabulary the code speaks in vendor-neutral
"container engine" terms; we shell out to `podman machine inspect` directly rather than indirecting
through `containers.conf`/`CONTAINER_HOST` because the fleet is Podman-only and the Supabase CLI
doesn't read the vendor-neutral chain anyway.

## Function & table privilege parity

Local `db:reset` used to apply `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON
TABLES/SEQUENCES/FUNCTIONS TO anon, authenticated, service_role` (from the
squashed baseline, which was a `pg_dump` of an already-widened **local** DB), so
**every** `public` object was accessible to **every** client role locally.
Hosted production has **zero** `public` default privileges and a narrow curated
grant set per table (verified by a 2026-06-10 read-only catalog audit), so an
object that forgot an explicit `GRANT` behaved differently in prod than in
tests. That gap shipped the duplicate-SMS incident: the delivery-state RPCs were
callable in tests but `service_role` could not call them in prod.

To keep local/CI honest about production grants:

- **`scripts/db/privilege-contract.ts`** is the explicit source of truth for
  which roles may `EXECUTE` each PostgREST-exposed (`.rpc(...)`) function.
- **`npm run check:db-privileges`** (runtime, needs a live local DB) fails on a
  missing `service_role` grant, accidental `anon`/`authenticated` exposure of a
  server-only RPC, broad default privileges on future functions, tables, or
  sequences, or an unclassified app-owned function. It runs automatically at
  the end of `db:reset` and in CI.
- **`npm run check:migration-grants`** (static, offline) fails when a migration
  creates a `public` function but never grants it `EXECUTE` — the cheap PR-time
  guard against the incident pattern.
- The `20260608180652_tighten_function_privileges` migration revokes the broad
  future-function defaults and normalizes every app-called RPC to its intended
  roles. The `20260610182813_tighten_table_privileges` migration completes the
  job: it empties the future-table/sequence defaults and normalizes every table,
  sequence, and trigger/check function to production's exact grant set.
- **`npm run audit:db-parity`** (read-only; needs `DATABASE_URL_PROD` in
  `.env.local`) dumps the full permission structure of local and production and
  diffs them, failing on any residual drift. A small accepted-noise allowlist
  (documented in `scripts/db/dump-permissions.ts`) covers what a postgres-run
  migration cannot change: `supabase_admin`-owned default ACLs in the local
  image, pg_trgm extension-function grants, and the `public` schema
  owner-layout difference. The prod connection validates TLS against the
  pinned Supabase CA at `scripts/db/supabase-prod-ca-2021.crt` (root expires
  2031-04-26); if validation suddenly fails, refresh the cert from Dashboard →
  Project Settings → Database → SSL Configuration.

**Rule for new RPCs:** every migration that creates a `public` function callable
via the Data API must include an explicit `GRANT EXECUTE ON FUNCTION ... TO
<role>` for each intended role (server-only RPCs → `service_role`;
session-scoped RPCs → `authenticated` and `service_role`). Add the function to
`privilege-contract.ts`. Note that `supabase db diff` does **not** surface
`ALTER DEFAULT PRIVILEGES`, so grants must be reviewed manually.

**Rule for new tables/sequences:** default privileges are now empty in both
environments, so a migration that creates a table or sequence without explicit
`GRANT`s yields an object **no client role can touch** — locally and in prod
alike, which means tests catch the omission immediately. Grant only what the
code needs (server-only tables → `service_role`; session-visible tables →
`authenticated` and/or `anon` as appropriate). Test fixtures that need writes
beyond production's grants (e.g. seeding `assets`) must use the direct `pg`
connection (`tests/helpers/asset-db.ts` pattern), not `adminClient`.

## Gotchas

- **Vector / Logflare analytics is disabled** in `supabase/config.toml` (`[analytics] enabled = false`). Supabase's `vector` container tries to read Docker logs from `/var/run/docker.sock` inside its own container, which Podman's Docker-compat shim doesn't plumb the same way — `supabase start` hangs on *"vector container is not ready: starting"* otherwise. We don't use the local analytics UI so this is a net win, not a workaround.
- **`supabase stop` may emit** `failed to prune volumes: "all" is an invalid volume filter`. It's a warning from Podman's Docker-compat shim not recognizing Docker's `all=true` volume filter; safe to ignore.
- **`podman` on PATH**: the `/opt/podman/bin` install location isn't in the default shell PATH. The `db:*` scripts resolve it themselves (`resolvePodmanBinary()` in `scripts/db/container-engine.ts` prefers `/opt/podman/bin/podman`), but bare `podman` / `supabase` calls in your shell need the `PATH` export above.

## Local container runtime

The live vendor-API health check runs as the `stocktextalerts-live-provider-check` Lambda (no local DB needed — it calls the provider APIs directly). Locally, the Supabase stack runs on Podman (the fleet's container engine — Docker Desktop is not used).

**SAM CLI (`sam local invoke`)** honors `DOCKER_HOST`, so `cd aws && npm run local:all` works under Podman with the same setup — set the `DOCKER_HOST` export above, since the SAM path doesn't go through the `db:*` scripts' auto-derivation.
