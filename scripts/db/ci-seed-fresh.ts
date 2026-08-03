/**
 * scripts/db/ci-seed-fresh.ts: CI-only fast path that replaces `db:reset` on a
 * runner whose Supabase stack was just created by `supabase start`.
 *
 * `supabase start` already applies every file in supabase/migrations when it
 * creates the database. `db:reset` then drops that database and replays the
 * identical set a second time. The only thing the second pass adds on a cold
 * runner is the seed, because CI generates `supabase/seed.sql` after start (it
 * is gitignored, so `supabase start` has nothing to seed from). Measured on a
 * cold stack: `supabase db reset` ~13s locally / ~40s on a 4 vCPU ARM runner,
 * versus 0.3s to generate the seed and 0.3s to apply it. Six heavy shards pay
 * that replay on every run.
 *
 * So this script does exactly what the replay was for and nothing else:
 *   generate seed -> apply seed -> gen-types (opt-in) -> privilege + catalog checks.
 *
 * It refuses to run unless the database still looks exactly like a freshly
 * started one (every migration applied, nothing seeded) and exits
 * PRECONDITION_EXIT so ci-bootstrap.sh can fall back to a full `db:reset`.
 * Any later divergence (a migration that seeds assets, a CLI that stops
 * migrating on start, a reused runner) therefore degrades to today's behavior
 * instead of producing a half-built database.
 *
 * Not part of local DX: `db:reset` remains the only supported way to reseed a
 * long-lived local stack, which is never "freshly started".
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "pg";

import { rootLogger } from "../../src/lib/logging";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..", "..");
const MIGRATIONS_DIR = path.join(projectRoot, "supabase", "migrations");
const SEED_FILE = path.join(projectRoot, "supabase", "seed.sql");

/** Exit code that tells ci-bootstrap.sh to fall back to a full `db:reset`. */
const PRECONDITION_EXIT = 3;
/** Exit code for a misconfigured invocation (never falls back; fix the caller). */
const MISUSE_EXIT = 2;

function run(command: string, args: string[]): number {
	const result = spawnSync(command, args, {
		cwd: projectRoot,
		encoding: "utf8",
		stdio: "inherit",
	});
	return result.status ?? 1;
}

/** Migration versions on disk, i.e. the leading timestamp of each `<version>_<name>.sql`. */
function migrationVersionsOnDisk(): string[] {
	return fs
		.readdirSync(MIGRATIONS_DIR)
		.filter((file) => file.endsWith(".sql"))
		.map((file) => file.split("_")[0] ?? "")
		.filter((version) => version.length > 0);
}

type Freshness = { fresh: true } | { fresh: false; reason: string; detail: Record<string, unknown> };

/**
 * A stack is "freshly started" when `supabase start` has applied every migration on disk and
 * nothing has been seeded yet. Both halves matter: the first proves start still migrates (so
 * skipping the reset loses nothing), the second proves no earlier step already populated the DB.
 */
async function checkFreshlyStarted(client: Client): Promise<Freshness> {
	const applied = await client.query<{ version: string }>(
		"select version from supabase_migrations.schema_migrations",
	);
	const appliedVersions = new Set(applied.rows.map((row) => row.version));
	const missing = migrationVersionsOnDisk().filter((version) => !appliedVersions.has(version));
	if (missing.length > 0) {
		return {
			fresh: false,
			reason: "supabase start did not apply every migration on disk",
			detail: { missingCount: missing.length, firstMissing: missing[0] },
		};
	}

	const seeded = await client.query<{ assets: string; users: string }>(
		"select (select count(*) from public.assets) as assets, (select count(*) from auth.users) as users",
	);
	const assets = Number(seeded.rows[0]?.assets ?? "0");
	const users = Number(seeded.rows[0]?.users ?? "0");
	if (assets > 0 || users > 0) {
		return {
			fresh: false,
			reason: "database already holds rows, so this is not a freshly started stack",
			detail: { assets, users },
		};
	}

	return { fresh: true };
}

async function main(): Promise<void> {
	if (!process.env.CI) {
		rootLogger.error("db:ci-seed: refusing to run outside CI (use db:reset locally)", {
			action: "ci_seed_fresh_refused",
		});
		process.exit(MISUSE_EXIT);
	}

	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		rootLogger.error("db:ci-seed: DATABASE_URL is unset", { action: "ci_seed_fresh_refused" });
		process.exit(MISUSE_EXIT);
	}

	const client = new Client({ connectionString: databaseUrl });
	try {
		await client.connect();
	} catch (error) {
		rootLogger.warn("db:ci-seed: cannot reach the database; falling back to db:reset", {
			action: "ci_seed_fresh_fallback",
			cause: error instanceof Error ? error.message : String(error),
		});
		process.exit(PRECONDITION_EXIT);
	}

	let seedSql: string;
	try {
		const freshness = await checkFreshlyStarted(client);
		if (!freshness.fresh) {
			rootLogger.warn("db:ci-seed: preconditions not met; falling back to db:reset", {
				action: "ci_seed_fresh_fallback",
				reason: freshness.reason,
				...freshness.detail,
			});
			process.exit(PRECONDITION_EXIT);
		}

		// Regenerates supabase/seed.sql from scripts/data + the live stack, exactly as db:reset does.
		if (run("npm", ["run", "db:generate-seed"]) !== 0) {
			rootLogger.error("db:ci-seed: db:generate-seed failed", { action: "ci_seed_fresh_failed" });
			process.exit(1);
		}
		seedSql = fs.readFileSync(SEED_FILE, "utf8");

		// One simple-protocol call: the seed is a plain multi-statement script (no psql
		// meta-commands) and carries its own BEGIN/COMMIT blocks plus a completeness assertion,
		// so a partial apply raises instead of leaving a half-seeded database.
		await client.query(seedSql);
	} finally {
		await client.end();
	}

	rootLogger.info("db:ci-seed: seed applied to the freshly started stack (skipped db:reset)", {
		action: "ci_seed_fresh_applied",
		seedBytes: seedSql.length,
	});

	// Mirrors the tail of db:reset so the two paths are interchangeable.
	if (process.env.DB_RESET_SKIP_GEN_TYPES === "1") {
		rootLogger.info("db:ci-seed: skipping db:gen-types (DB_RESET_SKIP_GEN_TYPES=1)", {
			action: "ci_seed_fresh_skip_gen_types",
		});
	} else if (run("npm", ["run", "db:gen-types"]) !== 0) {
		process.exit(1);
	}

	if (run("npm", ["run", "check:db-privileges"]) !== 0) {
		process.exit(1);
	}

	if (run("npm", ["run", "check:option-catalog"]) !== 0) {
		process.exit(1);
	}
}

const invokedDirectly =
	process.argv[1] !== undefined &&
	pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
	main().catch((error: unknown) => {
		rootLogger.error("db:ci-seed: unexpected failure", {
			action: "ci_seed_fresh_failed",
			cause: error instanceof Error ? error.message : String(error),
		});
		process.exit(1);
	});
}
