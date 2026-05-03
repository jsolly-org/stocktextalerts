# 2026-04-11 — Migrated off Docker Desktop

## Reason

Docker Desktop ate ~40 GB of disk on the dev laptop. Migrated to **Podman** for the local Supabase container runtime.

## Outcome

Podman is now the documented container runtime for this project. CI continues to use Docker (Ubuntu runners ship with Docker preinstalled and we don't gain anything by switching).

See [docs/local-supabase.md](../local-supabase.md) for the Podman setup, `DOCKER_HOST` socket export, and gotchas (vector container disabled, `supabase stop` warning, PATH fix).
