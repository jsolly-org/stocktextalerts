/**
 * scripts/db/supabase.ts — run the Supabase CLI with the local container engine wired up.
 *
 * The package.json scripts that shell out to `supabase` for engine-dependent local commands
 * (`db:stop`, `db:gen-types`) route through here so they get `DOCKER_HOST` derived from the
 * running Podman machine, exactly like `db:start` / `db:reset` do. Without it, a bare
 * `supabase stop` on a fresh machine dies with the misleading "Cannot connect to the Docker
 * daemon" error. stdio is inherited, so shell redirects on the calling line (e.g. db:gen-types'
 * `> database.types.ts`) still capture the CLI's stdout.
 */

import { spawnSync } from "node:child_process";

import { ensureContainerEngineEnv, resolveSupabaseCli } from "./container-engine";

ensureContainerEngineEnv();

const result = spawnSync(resolveSupabaseCli(), process.argv.slice(2), { stdio: "inherit" });
process.exit(result.status ?? 1);
