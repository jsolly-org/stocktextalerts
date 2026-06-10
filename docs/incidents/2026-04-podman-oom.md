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

Local pre-commit runs Vitest on the host by default. If you use Podman-backed containers for tests, keep the `podman-machine-default` VM at ≥ 6144 MB to avoid OOM kills.

See [docs/local-supabase.md](../local-supabase.md) and [docs/prepush-gate.md](../prepush-gate.md).
