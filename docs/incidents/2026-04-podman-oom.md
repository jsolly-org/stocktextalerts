# 2026-04-19 — Vitest SIGKILL inside Podman VM

## Symptom

Vitest died inside the Podman VM with `SIGKILL` and **no test-level error** — the process simply vanished mid-suite. Local `npm test` outside the VM passed cleanly. Symptoms surfaced when running CI reproductions via Act.

## Root cause

The Podman VM was sized below what Vitest's worker pool needs to complete the suite. The in-VM OOM killer reaped the test runner before it could emit a structured failure, so the only signal was the bare `SIGKILL`.

## Resolution

Resize the VM to **≥ 6144 MB**:

```bash
podman machine stop podman-machine-default
podman machine set podman-machine-default --memory 6144
podman machine start podman-machine-default
```

`scripts/ci/run-local-actions.sh` now preflight-checks the `podman-machine-default` VM and fails loudly with the fix command if it's undersized. It also prunes stale `act-*` containers from prior runs that would otherwise keep the VM under memory pressure.

See [docs/local-supabase.md](../local-supabase.md) and [docs/ci-with-act.md](../ci-with-act.md).
