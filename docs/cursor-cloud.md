# Cursor Cloud VM

Use this runbook for service startup and non-obvious wiring in a fresh Cursor Cloud session.

## Automated provisioning

`.cursor/environment.json` runs:

| Hook | Script | Purpose |
| --- | --- | --- |
| `install` (update) | `.cursor/install-cloud-skills.sh` then `.cursor/cloud-agent-install.sh` then `.cursor/aws-oidc-login.sh` | Public skills package; Docker CE + fuse-overlayfs + iptables-legacy; Node 24 via nvm; `npm ci`; `.env.local` + `users.json` bootstrap; Cursor OIDC → `agent-readonly` |
| `start` | `.cursor/aws-oidc-login.sh` then `.cursor/cloud-agent-start.sh` | Refresh `agent-readonly` via OIDC (`credential_process`); start `dockerd` (PID 1 is `tini`, not systemd), `npm run db:start`, sync Supabase keys into `.env.local`, and `db:reset` once if `db:doctor` fails |

After a successful `install`, Cursor checkpoints a snapshot so later agents skip the heavy apt/npm work. `start` still runs every boot.

If a session somehow lacks Docker (stale snapshot, install skipped), re-run:

```bash
bash .cursor/cloud-agent-install.sh
bash .cursor/aws-oidc-login.sh
bash .cursor/cloud-agent-start.sh
```

## Runtime facts

- **Container engine:** this VM uses Docker, not Podman. `~/.bashrc` (written by install) exports `DOCKER_HOST=unix:///var/run/docker.sock` and prepends Node 24 so `/exec-daemon/node` (v22) cannot win. Do not unset `DOCKER_HOST`.
- **Docker daemon:** `cloud-agent-start.sh` starts `dockerd` and `chmod 666`s the socket when needed. `docker info` should report `Storage Driver: fuse-overlayfs`.
- **Docker 29 + fuse-overlayfs:** `/etc/docker/daemon.json` sets `"storage-driver": "fuse-overlayfs"` and `"features": { "containerd-snapshotter": false }` — Docker 29 defaults to the containerd snapshotter, which ignores fuse-overlayfs on this kernel.
- **Apt clock skew:** Cloud VMs sometimes disagree with mirror `Valid-Until`. Install uses `Acquire::Check-Valid-Until=false`.
- **Apt conffiles:** the Cloud base image may already ship `/etc/fuse.conf` with `user_allow_other`. `DEBIAN_FRONTEND=noninteractive` alone does **not** suppress dpkg conffile prompts, so install also passes `Dpkg::Options` `--force-confdef` / `--force-confold` (keeps the existing fuse.conf). A mid-install failure can leave `fuse3` / `fuse-overlayfs` half-configured (`install ok unpacked`); re-running `cloud-agent-install.sh` runs `dpkg --configure -a` to repair before continuing.
- **Node:** `.npmrc` requires Node 24.x. Install resolves `~/.nvm/versions/node/v24.*/bin` after `nvm install 24` (do not hardcode a patch — nvm tracks latest 24.x). Always use a login shell (`bash -lc '…'`) or an interactive terminal so `~/.bashrc` prefers that Node 24 bin over `/exec-daemon/node` (v22).
- **Expected warning:** under Docker, `db:doctor` may report `auth container not inspectable (podman ENOENT)`. That only skips the Podman-specific GoTrue inspection; auth is healthy when the final `ok` line prints.

## Local files and services

Install/start create these gitignored files when missing:

- `.env.local` with local stubs, `EMAIL_SMTP_HOST=localhost`, generated `DEFAULT_PASSWORD`, and Supabase keys synced from `supabase status` after DB start
- `scripts/data/users.json`, copied from `scripts/data/sample-users.json`
- `supabase/seed.sql`, generated when `db:reset` runs

Manual bring-up (if `start` did not run):

```bash
bash .cursor/cloud-agent-start.sh
# or:
sudo dockerd > /tmp/dockerd.log 2>&1 &
npm run db:start
npm run db:generate-seed && npm run db:reset   # first run or re-seed
npm run dev
```

Astro runs at <http://localhost:4321>; Mailpit runs at <http://127.0.0.1:54324>.

For a quick authenticated smoke, sign in at `/auth/signin` with `DEFAULT_USER` and `DEFAULT_PASSWORD` from `.env.local`. The seeded `dev@example.com` user is pre-confirmed and pre-approved, so it lands on `/dashboard` without Mailpit or admin approval. Use the **Watchlist** search to exercise `POST /api/assets/update`.

## Local test suites

GitHub CI remains canonical, but the VM supports explicit local runs:

- Use `npm run test:local` for Vitest and `npm run test:e2e:local` for Playwright. The wrappers opt in and run preflight; bare `npm test` is blocked.
- Preflight reuses `DOCKER_HOST`; make sure `dockerd` and the Supabase stack are running first (`cloud-agent-start.sh` or `db:start`).
- The cloud image includes Playwright's Chromium headless shell and OS dependencies.
- E2E stops Astro's dev lock and starts its own server on port 4322. Restart `npm run dev` afterward if needed.
- `Upstream icon fetch failed … status 401` is expected with the placeholder `MASSIVE_API_KEY`.
- Repeated E2E runs can hit the `registration-approval` / GoTrue email rate limit. Recover with `docker restart supabase_auth_stocktextalerts`.

For lock behavior, ports, and test authoring rules, see [Testing](../tests/README.md) and the canonical [local-tests skill](../.claude/skills/local-tests/SKILL.md).
