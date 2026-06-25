/**
 * scripts/db/reset.ts — destructive reseed of the shared local Supabase stack.
 *
 * All worktrees share ONE local stack (default ports, project_id "stocktextalerts"); isolation
 * between worktrees' DB access is the cross-worktree test lock (<git-common-dir>/test.lock),
 * not a per-worktree stack. Because this truncates and reseeds the shared DB, it acquires that
 * same lock first — so a reset can't yank the database out from under another worktree's running
 * vitest/playwright suite (and vice-versa). See docs/plans/2026-06-21-shared-local-supabase-stack.md.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { rootLogger } from "../../src/lib/logging";
import { acquireTestLock, formatContentionMessage, TestLockHeldError } from "../../tests/lock";
import { ensureContainerEngineEnv, resolveSupabaseCli } from "./container-engine";
import { detectGoTrueDrift } from "./gotrue-config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..", "..");
const CONFIG_FILE = path.join(projectRoot, "supabase", "config.toml");
const supabaseExecutable = resolveSupabaseCli();

function run(command: string, args: string[]): number {
	const result = spawnSync(command, args, {
		cwd: projectRoot,
		encoding: "utf8",
		stdio: "inherit",
	});
	return result.status ?? 1;
}

/**
 * Reconcile the auth/kong containers' email-template serving with config.toml — but only when it
 * has drifted, so the common (in-sync) reset stays cheap. config.toml's branded templates are
 * mounted and served through kong at `supabase start` time and `supabase db reset` never recreates
 * those containers, so a stack started from an older config keeps 404-ing the template route — GoTrue
 * then falls back to its default templates/subjects and silently fails the four email/auth E2E specs.
 * A full stop+start is the ONLY CLI path that re-mounts the templates and re-registers the route (a
 * plain restart keeps the stale mount; `supabase start` won't recreate a single removed service
 * while the stack is "already running"). See scripts/db/gotrue-config.ts.
 *
 * NOTE: the stop+start bounces the WHOLE shared stack (Postgres, auth, Mailpit), not just auth — so
 * a concurrent `npm run dev` in another worktree (which doesn't hold the test.lock db:reset acquires)
 * drops its DB/auth connections and reconnects. It only fires on actual drift (rare, post-config
 * change) and is recoverable — an acceptable deepening of db:reset's existing shared-stack churn.
 */
function reconcileGoTrueIfDrifted(): void {
	const drift = detectGoTrueDrift(CONFIG_FILE);
	if (drift.status === "in_sync") return;

	if (drift.status === "drifted") {
		rootLogger.warn("db:reset — GoTrue email config drifted from config.toml; recreating auth", {
			action: "db_reset_reconcile_gotrue",
			mismatches: drift.mismatches,
		});
	} else {
		// auth_unavailable (container absent / un-inspectable): a stop+start recreates it from
		// config.toml. If the engine is genuinely unreachable, the start below fails loud.
		rootLogger.warn("db:reset — auth container not inspectable; recreating stack to reconcile", {
			action: "db_reset_reconcile_gotrue",
			reason: drift.reason,
		});
	}

	// stop may exit non-zero on a partial/absent stack — mirror start.ts and proceed to start anyway.
	run(supabaseExecutable, ["stop"]);
	if (run(supabaseExecutable, ["start"]) !== 0) {
		rootLogger.error("db:reset — failed to restart the stack while reconciling GoTrue config", {
			action: "db_reset_reconcile_gotrue",
		});
		process.exit(1);
	}
}

function main(): void {
	// Serialize against any running test suite on the shared stack. The lock auto-releases via the
	// exit/SIGINT/SIGTERM handlers lock.ts registers on acquire, so every process.exit below frees it.
	try {
		acquireTestLock("reset");
	} catch (err) {
		if (err instanceof TestLockHeldError) {
			process.stderr.write(formatContentionMessage(err));
			process.exit(1);
		}
		throw err;
	}

	// Wire DOCKER_HOST to the Podman machine socket before any CLI call. Setting it on process.env
	// here means every child spawn below (supabase status / db reset, and the npm-run children that
	// shell out to supabase) inherits it. Throws loud + actionable if no engine is reachable.
	ensureContainerEngineEnv();

	// Recreate the auth container from config.toml when (and only when) its email config has drifted,
	// before reseeding — otherwise `supabase db reset` leaves GoTrue serving stale email templates.
	reconcileGoTrueIfDrifted();

	const status = run(supabaseExecutable, ["status"]);
	if (status !== 0) {
		process.exit(status);
	}

	if (run("npm", ["run", "db:generate-seed"]) !== 0) {
		process.exit(1);
	}

	if (run(supabaseExecutable, ["db", "reset"]) !== 0) {
		process.exit(1);
	}

	if (run("npm", ["run", "db:gen-types"]) !== 0) {
		process.exit(1);
	}

	// Fail a fresh reset immediately on permission drift so missing service_role
	// grants / accidental client exposure surface here, not in production.
	if (run("npm", ["run", "check:db-privileges"]) !== 0) {
		process.exit(1);
	}
}

const invokedDirectly =
	process.argv[1] !== undefined &&
	pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
	main();
}
