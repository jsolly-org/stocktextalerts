/**
 * scripts/db/doctor.ts — fast preflight for local Supabase bootstrap.
 *
 * Catches the two failure modes that cost us most dev time today:
 *   1. Supabase containers stopped → auth endpoint unreachable (ECONNREFUSED flood).
 *   2. Partial seed → `auth.users` row for a seeded user is missing so every
 *      test that expects the seed account to exist misbehaves in confusing ways.
 *
 * Historical note: we used to probe `/auth/v1/token` with `DEFAULT_PASSWORD`
 * to detect (2), but that check conflated three unrelated pieces of state
 * (`.env.local`, the generated `supabase/seed.sql`, and the live DB hash) and
 * kept false-negative-ing on benign drift (plaintext desync, `supabase db
 * reset` without regenerating, act restarting host containers). Nothing in
 * `pretest` / `pre-commit` actually depends on the seed user's login
 * succeeding — tests create throwaway users with their own passwords — so
 * doctor now checks row existence via SQL instead. Interactive dev login and
 * the a11y audit still surface password drift loudly at the point of use.
 *
 * Runs in ~300ms against a healthy local stack. Safe to wire into `predev` /
 * `pretest`.
 *
 * Exit codes:
 *   0 — healthy (or SUPABASE_URL points at a non-local project; we never probe prod)
 *   1 — unhealthy; prints an actionable hint pointing at `npm run db:bootstrap`
 *
 * Usage:
 *   npm run db:doctor
 *   # or: node --env-file-if-exists=.env.local ./node_modules/.bin/tsx scripts/db/doctor.ts
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

import { rootLogger } from "../../src/lib/logging";
import { isLocalHost } from "./is-local-host";
import {
	isLinkedWorktree,
	symlinkedNodeModulesMessage,
	unprovisionedWorktreeMessage,
	worktreeSupabaseProvisioned,
} from "./worktree";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..", "..");
const USERS_FILE = path.join(projectRoot, "scripts", "data", "users.json");

type SeedUserLite = { email?: unknown };

/** Short read-timeout guard for SQL too; wedged postgres shouldn't hang doctor. */
const DB_STATEMENT_TIMEOUT_MS = 3_000;

const HINT = [
  "",
  "💡 Local Supabase bootstrap looks broken.",
  "   Run:  npm run db:bootstrap",
  "   (equivalent to: npm run db:start && npm run db:reset && npm run db:doctor)",
  "",
].join("\n");

/** Short read-timeout guard; doctor must be fast even when the stack is wedged. */
async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), ms);
	try {
		return await fetch(url, { ...init, signal: ctrl.signal });
	} finally {
		clearTimeout(timer);
	}
}

function readSeedEmails(): string[] {
	if (!fs.existsSync(USERS_FILE)) return [];
	try {
		const parsed = JSON.parse(fs.readFileSync(USERS_FILE, "utf-8")) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map((entry) => {
				const email = (entry as SeedUserLite)?.email;
				if (typeof email !== "string") return null;
				const trimmed = email.trim().toLowerCase();
				return trimmed.length > 0 ? trimmed : null;
			})
			.filter((email): email is string => email !== null);
	} catch {
		return [];
	}
}

type SeedUserRow = {
	email: string;
	email_confirmed_at: Date | null;
	encrypted_password: string | null;
};

/**
 * Asserts each expected seed email has a fully-provisioned row in `auth.users`.
 *
 * "Fully-provisioned" means the row exists, its email is confirmed, and it
 * has a non-empty `encrypted_password`. This is the drift-resistant
 * equivalent of the old `/auth/v1/token` probe: it catches partial seeds
 * without coupling to the plaintext of `DEFAULT_PASSWORD`.
 */
async function checkSeedUsersExist(
	databaseUrl: string,
	expectedEmails: string[],
): Promise<{ ok: true } | { ok: false; reason: string; context: unknown }> {
	const client = new Client({
		connectionString: databaseUrl,
		// Cheap guard so a wedged db doesn't hang `pretest`.
		statement_timeout: DB_STATEMENT_TIMEOUT_MS,
		connectionTimeoutMillis: DB_STATEMENT_TIMEOUT_MS,
	});

	try {
		await client.connect();
	} catch (err) {
		return {
			ok: false,
			reason: "database_unreachable",
			context: {
				cause: err instanceof Error ? err.message : String(err),
			},
		};
	}

	try {
		const { rows } = await client.query<SeedUserRow>(
			`SELECT lower(email) AS email, email_confirmed_at, encrypted_password
			 FROM auth.users
			 WHERE lower(email) = ANY($1::text[])`,
			[expectedEmails],
		);

		const found = new Map(rows.map((row) => [row.email, row]));
		const missing = expectedEmails.filter((email) => !found.has(email));
		if (missing.length > 0) {
			return {
				ok: false,
				reason: "seed_users_missing",
				context: { missingEmails: missing },
			};
		}

		const unconfirmed: string[] = [];
		const passwordless: string[] = [];
		for (const email of expectedEmails) {
			const row = found.get(email);
			if (!row) continue;
			if (!row.email_confirmed_at) unconfirmed.push(email);
			if (!row.encrypted_password || row.encrypted_password.length === 0) {
				passwordless.push(email);
			}
		}

		if (unconfirmed.length > 0 || passwordless.length > 0) {
			return {
				ok: false,
				reason: "seed_users_incomplete",
				context: { unconfirmed, passwordless },
			};
		}

		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			reason: "auth_users_query_failed",
			context: {
				cause: err instanceof Error ? err.message : String(err),
			},
		};
	} finally {
		await client.end().catch(() => {
			// Swallow close errors; the caller already has its verdict.
		});
	}
}

async function main(): Promise<void> {
	// Worktree provisioning preflight — fail early with an actionable hint rather than letting a
	// symlinked node_modules or an unprovisioned worktree surface as a Vite 403 / confusing seed error.
	const nodeModules = path.join(projectRoot, "node_modules");
	const nodeModulesIsSymlink =
		fs.existsSync(nodeModules) && fs.lstatSync(nodeModules).isSymbolicLink();
	const provisioningError =
		symlinkedNodeModulesMessage(nodeModulesIsSymlink) ??
		unprovisionedWorktreeMessage(isLinkedWorktree(), worktreeSupabaseProvisioned());
	if (provisioningError !== null) {
		rootLogger.error("db:doctor — worktree not provisioned", { action: "db_doctor" });
		process.stderr.write(`${provisioningError}\n`);
		process.exitCode = 1;
		return;
	}

	const supabaseUrl = process.env.SUPABASE_URL;

	if (!supabaseUrl) {
		rootLogger.error("db:doctor — missing SUPABASE_URL in env", {
			action: "db_doctor",
		});
		process.stderr.write(HINT);
		process.exitCode = 1;
		return;
	}

	let host: string;
	try {
		host = new URL(supabaseUrl).hostname;
	} catch {
		rootLogger.error("db:doctor — SUPABASE_URL is not a valid URL", {
			action: "db_doctor",
			supabaseUrl,
		});
		process.stderr.write(HINT);
		process.exitCode = 1;
		return;
	}

	// Never probe production; doctor is a local-only preflight.
	if (!isLocalHost(host)) {
		rootLogger.info("db:doctor — SUPABASE_URL is non-local; skipping checks", {
			action: "db_doctor",
			host,
		});
		return;
	}

	// 1. Auth health — catches "containers stopped" instantly.
	const healthUrl = new URL("/auth/v1/health", supabaseUrl).toString();
	try {
		const res = await fetchWithTimeout(healthUrl, { method: "GET" }, 2_000);
		if (!res.ok) {
			rootLogger.error("db:doctor — auth health check failed", {
				action: "db_doctor",
				healthUrl,
				status: res.status,
			});
			process.stderr.write(HINT);
			process.exitCode = 1;
			return;
		}
	} catch (err) {
		const cause = err instanceof Error ? err.message : String(err);
		rootLogger.error("db:doctor — auth endpoint unreachable", {
			action: "db_doctor",
			healthUrl,
			cause,
		});
		process.stderr.write(HINT);
		process.exitCode = 1;
		return;
	}

	// 2. Seed-user existence — catches partial seeds where auth.users wasn't
	// populated. This is a drift-resistant replacement for the old
	// `/auth/v1/token` login probe; see the module header for rationale.
	const seedEmails = readSeedEmails();
	if (seedEmails.length === 0) {
		rootLogger.info("db:doctor — ok (health only; no seed users to check)", {
			action: "db_doctor",
			reason: "no_users_json",
		});
		return;
	}

	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		// Tests already require DATABASE_URL (tests/setup.ts), and `supabase
		// status` emits it, so missing-in-dev means .env.local is out of date.
		rootLogger.error("db:doctor — missing DATABASE_URL in env", {
			action: "db_doctor",
		});
		process.stderr.write(HINT);
		process.exitCode = 1;
		return;
	}

	const result = await checkSeedUsersExist(databaseUrl, seedEmails);
	if (!result.ok) {
		rootLogger.error("db:doctor — seed user check failed", {
			action: "db_doctor",
			reason: result.reason,
			context: result.context,
		});
		process.stderr.write(HINT);
		process.exitCode = 1;
		return;
	}

	rootLogger.info("db:doctor — ok (auth reachable; seed users present)", {
		action: "db_doctor",
		seedEmailsChecked: seedEmails.length,
	});
}

main().catch((err) => {
	rootLogger.error(
		"db:doctor — unexpected error",
		{ action: "db_doctor" },
		err,
	);
	process.stderr.write(HINT);
	process.exitCode = 1;
});
