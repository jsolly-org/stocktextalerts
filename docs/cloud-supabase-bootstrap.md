# Cursor Cloud — Supabase bootstrap (stocktextalerts)

App-local Docker and Supabase setup for Cursor Cloud VMs. Not part of the dotagents fleet subtree — safe across `update-agents-subtree.sh`.

| Piece | Location |
| --- | --- |
| Orchestrator | [`scripts/cloud-agent-install.sh`](../scripts/cloud-agent-install.sh) |
| Docker + Supabase helpers | [`scripts/cloud-install-supabase.sh`](../scripts/cloud-install-supabase.sh) |
| Playwright E2E hardening | [`scripts/cloud-install-playwright.sh`](../scripts/cloud-install-playwright.sh) |
| Generic cloud install (Node, SAM, yamllint) | [`.agents/scripts/cloud-install-lib.sh`](../.agents/scripts/cloud-install-lib.sh) (fleet) |

## What `cloud-agent-install.sh` does

After fleet helpers (`npm ci`, YAML lint, SAM), the app script:

1. Installs **Docker** (`docker.io`) and **jq** when missing.
2. Configures the engine for Cursor Cloud VMs: **iptables-legacy** (bridge networking between containers), **vfs** storage driver when `/etc/docker/daemon.json` is absent (overlay2 often fails here), then **restarts dockerd** when iptables or `daemon.json` changed so a pre-started systemd dockerd does not keep stale nft rules.
3. Settles Docker after restart, cleans stale Supabase containers/networks, then runs `supabase start` (with retries on transient network/name conflicts) using the same `-x …` excludes as CI.
4. Writes `.env.local` from `supabase status`, waits for Postgres health, then runs `db:reset` (with retries on transient EOF) and `npm run db:doctor` so `npm test` works on first agent turn.
5. **Last:** installs Playwright browsers for E2E via [`scripts/cloud-install-playwright.sh`](../scripts/cloud-install-playwright.sh). Supabase runs first so a Playwright hang does not block database setup.

| Env var | Default | Effect |
| --- | --- | --- |
| `CLOUD_INSTALL_DEBUG=1` | off | Full `bash -x` trace on the install script |
| `CLOUD_INSTALL_PLAYWRIGHT=0` | `1` | Skip Playwright browser install |
| `CLOUD_INSTALL_PLAYWRIGHT_STRICT=1` | off | Fail install when Playwright fails (default: warn and continue) |
| `CLOUD_INSTALL_PLAYWRIGHT_TIMEOUT_SECS` | `600` | Max seconds for Playwright install |
| `CLOUD_INSTALL_PLAYWRIGHT_STALE_SECS` | `900` | Kill stuck Playwright download processes when lock is older |

Install logs are prefixed with `cloud-install:` and grouped by **phase** (`cloud-agent-install.sh`). On any failure, the ERR trap prints **docker** and **supabase** diagnostics (socket perms, `docker info`, `supabase status`, matching containers).

Set `CLOUD_INSTALL_DEBUG=1` on the install command for a full `bash -x` trace (e.g. temporarily in `.cursor/environment.json`).

## Troubleshooting

If `supabase start` fails at **Initialising schema** with a Realtime `DBConnection.ConnectionError`, the VM likely started `dockerd` before **iptables-legacy** was set. Re-run the environment install (`bash scripts/cloud-agent-install.sh`) so `install_docker_for_supabase` forces a daemon restart after networking changes.

If install fails with `dockerd failed to restart/start` but the dumped `/tmp/dockerd.log` shows the daemon booted (`API listen on /var/run/docker.sock`), the real failure is client-side: `docker info` hits `permission denied` because the socket is `root:docker` `0660` and the agent user isn't in the `docker` group. `ensure_docker_client_access` adds the user to `docker` (new shells) and chmods the socket for the current session; wait loops also retry after each daemon restart. If it still fails, run `sudo chmod 666 /var/run/docker.sock` once, then `npm run db:start`. The diagnostics block (`user/groups`, `socket`, `docker info error`) printed on failure tells you which case you're in.

If `supabase start` fails for other reasons, check the automatic `--- supabase diagnostics ---` block (status + `docker ps` for `supabase*` containers) or re-run with `CLOUD_INSTALL_DEBUG=1`.

Environment install logs (Cursor VM boot): `/tmp/cursor/async-install/install-user.log` (exit code in `install-user.status`).

### `supabase start` fails with `/workspace/node_modules/.bin/supabase: No such file or directory`

Symptom:

```text
/workspace/scripts/cloud-install-supabase.sh: line 345: /workspace/node_modules/.bin/supabase: No such file or directory
cloud-install: Supabase — non-retryable start failure (exit 127)
```

Cause: the npm `supabase` package is a thin wrapper. Its registry tarball does **not** include the native CLI; npm downloads and links the real binary from GitHub during `postinstall`. If lifecycle scripts are skipped, dev dependencies are omitted, or the GitHub release download flakes, `npm ci` can finish without leaving a runnable `node_modules/.bin/supabase`.

Docker diagnostics may still look healthy in this case because Docker is not the failing layer. The install script now runs `supabase --version` immediately after `npm ci`, retries `npm rebuild supabase`, and fails before Docker work if the CLI cannot be repaired.

Manual recovery:

```bash
npm rebuild supabase --foreground-scripts --ignore-scripts=false
CLOUD_INSTALL_PLAYWRIGHT=0 bash scripts/cloud-agent-install.sh
```

### `supabase start` fails with missing Docker network or container name conflict

Symptom (often on first VM boot, in `install-user.log`):

```text
failed to set up container networking: network supabase_network_stocktextalerts not found
```

or on retry:

```text
The container name "/supabase_db_stocktextalerts" is already in use
```

Cause: a partial `supabase start` after a fresh `dockerd` restart — Postgres container or name left behind without the project bridge network, or cgroup errors on nested cloud VMs.

The install script now settles Docker, runs `supabase_clean_docker_state_for_cloud` before start, and retries transient failures. If install still fails:

```bash
source scripts/cloud-install-supabase.sh
supabase_clean_docker_state_for_cloud ./node_modules/.bin/supabase
supabase_start_for_cloud ./node_modules/.bin/supabase
# then write .env.local + db:reset, or:
bash scripts/cloud-agent-install.sh
```

### `db:reset` fails with `unexpected EOF` during install

Symptom: install log reaches `cloud-install: phase — db:reset + db:doctor`, then:

```text
failed to create migration table: unexpected EOF
```

Diagnostics often show `supabase_db_*` as `health: starting` with only a few seconds uptime — migrations ran while Postgres was still coming up after `supabase db reset` recreated the database.

The install script waits for Postgres health after `supabase start` and retries `db:reset` on transient EOF / not-ready errors. If install still fails:

```bash
npm run db:bootstrap
# or re-run the full install:
bash scripts/cloud-agent-install.sh
```

### Playwright install stalls at 100%

Symptom: install log stops after `Downloading Chrome for Testing … 100%` and never reaches `cloud-install: phase — Supabase start`. Older installs ran Playwright before Supabase; current order completes Supabase even when Playwright hangs.

Recovery:

```bash
pkill -f 'oopDownloadBrowserMain|playwright install' || true
rm -rf ~/.cache/ms-playwright/__dirlock
bash scripts/cloud-agent-install.sh
```

Do **not** run a second `npx playwright install` while `cloud-agent-install.sh` is still running — Playwright uses `~/.cache/ms-playwright/__dirlock` and the second install will fail with an active lockfile error.

If download completed but extraction stalled, see Playwright troubleshooting in [`.agents/docs/cloud-agents.md`](../.agents/docs/cloud-agents.md).

Fleet layout and subtree sync: [`.agents/docs/cloud-agents.md`](../.agents/docs/cloud-agents.md).
