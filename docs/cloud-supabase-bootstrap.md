# Cursor Cloud — Supabase bootstrap (stocktextalerts)

App-local Docker and Supabase setup for Cursor Cloud VMs. Not part of the dotagents fleet subtree — safe across `update-agents-subtree.sh`.

| Piece | Location |
| --- | --- |
| Orchestrator | [`scripts/cloud-agent-install.sh`](../scripts/cloud-agent-install.sh) |
| Docker + Supabase helpers | [`scripts/cloud-install-supabase.sh`](../scripts/cloud-install-supabase.sh) |
| Generic cloud install (Node, SAM, yamllint) | [`.agents/scripts/cloud-install-lib.sh`](../.agents/scripts/cloud-install-lib.sh) (fleet) |

## What `cloud-agent-install.sh` does (Supabase steps)

After fleet helpers (`npm ci`, YAML/Actionlint, SAM), the app script:

1. Installs **Docker** (`docker.io`) and **jq** when missing.
2. Configures the engine for Cursor Cloud VMs: **iptables-legacy** (bridge networking between containers), **vfs** storage driver when `/etc/docker/daemon.json` is absent (overlay2 often fails here), then **restarts dockerd** when iptables or `daemon.json` changed so a pre-started systemd dockerd does not keep stale nft rules.
3. Runs `supabase start` with the same `-x …` excludes as CI (no studio/realtime sidecars in the long-running stack).
4. Writes `.env.local` from `supabase status`, then `npm run db:reset` and `npm run db:doctor` so `npm test` works on first agent turn.

Install logs are prefixed with `cloud-install:` and grouped by **phase** (`cloud-agent-install.sh`). On any failure, the ERR trap prints **docker** and **supabase** diagnostics (socket perms, `docker info`, `supabase status`, matching containers).

Set `CLOUD_INSTALL_DEBUG=1` on the install command for a full `bash -x` trace (e.g. temporarily in `.cursor/environment.json`).

## Troubleshooting

If `supabase start` fails at **Initialising schema** with a Realtime `DBConnection.ConnectionError`, the VM likely started `dockerd` before **iptables-legacy** was set. Re-run the environment install (`bash scripts/cloud-agent-install.sh`) so `install_docker_for_supabase` forces a daemon restart after networking changes.

If install fails with `dockerd failed to restart/start` but the dumped `/tmp/dockerd.log` shows the daemon booted (`API listen on /var/run/docker.sock`), the real failure is client-side: `docker info` hits `permission denied` because the socket is `root:docker` `0660` and the agent user isn't in the `docker` group. `ensure_docker_client_access` adds the user to `docker` (new shells) and chmods the socket for the current session; wait loops also retry after each daemon restart. If it still fails, run `sudo chmod 666 /var/run/docker.sock` once, then `npm run db:start`. The diagnostics block (`user/groups`, `socket`, `docker info error`) printed on failure tells you which case you're in.

If `supabase start` fails for other reasons, check the automatic `--- supabase diagnostics ---` block (status + `docker ps` for `supabase*` containers) or re-run with `CLOUD_INSTALL_DEBUG=1`.

Fleet layout and subtree sync: [`.agents/docs/cloud-agents.md`](../.agents/docs/cloud-agents.md).
