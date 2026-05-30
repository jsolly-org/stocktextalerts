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

## Troubleshooting

If `supabase start` fails at **Initialising schema** with a Realtime `DBConnection.ConnectionError`, the VM likely started `dockerd` before **iptables-legacy** was set. Re-run the environment install (`bash scripts/cloud-agent-install.sh`) so `install_docker_for_supabase` forces a daemon restart after networking changes.

Fleet layout and subtree sync: [`.agents/docs/cloud-agents.md`](../.agents/docs/cloud-agents.md).
