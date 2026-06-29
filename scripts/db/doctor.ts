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

import { EXPECTED_DB_SCHEMA_VERSION } from "../../src/lib/db/schema-version";
import { rootLogger } from "../../src/lib/logging";
import { detectGoTrueDrift, type TemplateMismatch } from "./gotrue-config";
import { isLocalHost } from "./is-local-host";
import { symlinkedNodeModulesMessage } from "./worktree";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..", "..");
const USERS_FILE = path.join(projectRoot, "scripts", "data", "users.json");
const CONFIG_FILE = path.join(projectRoot, "supabase", "config.toml");

/** The single shared local stack's project_id. A worktree whose config.toml says anything else
 * is still carrying a stale per-worktree isolated stack and must run the one-shot collapse. */
const SHARED_PROJECT_ID = "stocktextalerts";

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

/**
 * Actionable message when the running auth/kong containers can no longer serve the branded email
 * templates declared in config.toml (the kong /email route 404s, so GoTrue falls back to its default
 * templates and subjects). This is the drift that silently breaks the four email/auth E2E specs
 * (confirmation, recovery, email-change). `db:reset` auto-recreates the stack when drifted, so it is
 * the fix command. See scripts/db/gotrue-config.ts.
 */
function gotrueDriftHint(mismatches: TemplateMismatch[]): string {
  const detail = mismatches.map((m) => `     ${m.key}: ${m.detail}`);
  return [
    "",
    "✋ Local GoTrue (auth) can't serve the branded email templates in supabase/config.toml —",
    "   it's falling back to its default templates (wrong subjects), failing the email/auth E2E specs.",
    "   The running auth/kong containers were started from an older config; `db:reset` alone won't",
    "   recreate them.",
    ...detail,
    "   Recreate from config.toml:  npm run db:reset   (auto-restarts the stack when drifted)",
    "",
  ].join("\n");
}

/**
 * Refusal message when this worktree's supabase/config.toml still points at a per-worktree
 * isolated stack (project_id != "stocktextalerts"), else null. A skip-worktree'd config hides
 * the diff from `git status`, so this is the only place the staleness surfaces.
 */
function staleIsolatedStackMessage(): string | null {
	let projectId: string | null = null;
	try {
		const toml = fs.readFileSync(CONFIG_FILE, "utf8");
		// Accept either quote style — single-quoted is valid TOML and must not bypass this guard.
		projectId = toml.match(/^\s*project_id\s*=\s*["']([^"']+)["']/m)?.[1] ?? null;
	} catch {
		// No config.toml (or unreadable) — let the downstream SUPABASE_URL/health checks report it.
		return null;
	}
	if (projectId === null || projectId === SHARED_PROJECT_ID) return null;
	return [
		"",
		`✋ This worktree's supabase/config.toml has project_id "${projectId}", not "${SHARED_PROJECT_ID}".`,
		"   It is still carrying a stale per-worktree isolated Supabase stack (offset ports).",
		"   All worktrees now share ONE stack. Collapse this worktree onto it:",
		"     npm run db:collapse-worktree-stacks",
		"",
	].join("\n");
}

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

/**
 * Asserts the shared stack's applied schema matches THIS branch's EXPECTED_DB_SCHEMA_VERSION.
 *
 * With one stack shared across worktrees, a worktree on a different migration set sees whatever
 * the last `db:reset` applied. tests/setup.ts already enforces this for `npm test`, but doctor
 * runs ~2s earlier (pretest) and also covers `predev` and the playwright dev-server boot — so a
 * drifted schema fails here with an actionable hint instead of as a confusing mid-suite error.
 */
async function checkSchemaVersion(
	databaseUrl: string,
): Promise<{ ok: true } | { ok: false; actual: string | null }> {
	const client = new Client({
		connectionString: databaseUrl,
		statement_timeout: DB_STATEMENT_TIMEOUT_MS,
		connectionTimeoutMillis: DB_STATEMENT_TIMEOUT_MS,
	});
	// connect() inside the try so a connect failure still hits the finally and never leaks the
	// client. A missing app_metadata (42P01, schema not applied) and any other error both resolve
	// to "not ok" → the caller prints the actionable `npm run db:reset` hint.
	try {
		await client.connect();
		const { rows } = await client.query<{ value: string }>(
			"select value from public.app_metadata where key = 'schema_version'",
		);
		const actual = rows[0]?.value ?? null;
		return actual === EXPECTED_DB_SCHEMA_VERSION ? { ok: true } : { ok: false, actual };
	} catch {
		return { ok: false, actual: null };
	} finally {
		await client.end().catch(() => {});
	}
}

async function main(): Promise<void> {
	// Worktree provisioning preflight — fail early with an actionable hint rather than letting a
	// symlinked node_modules surface as a confusing Vite 403.
	const nodeModules = path.join(projectRoot, "node_modules");
	const nodeModulesIsSymlink =
		fs.existsSync(nodeModules) && fs.lstatSync(nodeModules).isSymbolicLink();
	const provisioningError = symlinkedNodeModulesMessage(nodeModulesIsSymlink);
	if (provisioningError !== null) {
		rootLogger.error("db:doctor — worktree not provisioned", { action: "db_doctor" });
		process.stderr.write(`${provisioningError}\n`);
		process.exitCode = 1;
		return;
	}

	// Self-enforcing migration guard. skip-worktree HIDES a stale config.toml diff, so a worktree
	// that never ran the collapse still carries project_id "stocktextalerts-wt-<slug>" + offset
	// ports and would silently spin its OWN isolated stack (the exact memory drain we removed).
	// Catch it loudly instead of letting it quietly reintroduce the problem.
	const staleStack = staleIsolatedStackMessage();
	if (staleStack !== null) {
		rootLogger.error("db:doctor — worktree still on a stale isolated stack", {
			action: "db_doctor",
		});
		process.stderr.write(`${staleStack}\n`);
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

	// 1b. GoTrue email-template drift — config.toml's branded templates are served through kong at
	// `/email/*.html` and wired into the auth container (now confirmed up by the health check above)
	// at `supabase start` time, and `supabase db reset` never recreates it. A stack started from an
	// older config keeps 404-ing that route, so GoTrue falls back to its default templates/subjects
	// and silently breaks the four email/auth E2E specs. Catch it here with a precise fix instead of
	// as cryptic Playwright failures. Only FAIL on positive drift; an un-probeable container (auth is
	// reachable, but podman couldn't read/exec it) is a probe gap, not drift — warn and continue so a
	// podman hiccup never false-fails the gate.
	const gotrue = detectGoTrueDrift(CONFIG_FILE);
	if (gotrue.status === "drifted") {
		rootLogger.error("db:doctor — GoTrue email config drifted from config.toml", {
			action: "db_doctor",
			mismatches: gotrue.mismatches,
		});
		process.stderr.write(gotrueDriftHint(gotrue.mismatches));
		process.exitCode = 1;
		return;
	}
	if (gotrue.status === "auth_unavailable") {
		rootLogger.warn("db:doctor — skipped GoTrue config check (auth container not inspectable)", {
			action: "db_doctor",
			reason: gotrue.reason,
		});
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

	// 3. Schema freshness — the #1 new failure mode of a shared stack: a worktree on a different
	// migration set than the one last reset. Fail loud with a `db:reset` hint.
	const schema = await checkSchemaVersion(databaseUrl);
	if (!schema.ok) {
		rootLogger.error("db:doctor — schema version drift on the shared stack", {
			action: "db_doctor",
			expected: EXPECTED_DB_SCHEMA_VERSION,
			actual: schema.actual,
		});
		process.stderr.write(
			[
				"",
				"✋ Shared local Supabase schema is out of date for this branch.",
				`   shared stack: ${schema.actual ?? "MISSING"}`,
				`   this branch expects: ${EXPECTED_DB_SCHEMA_VERSION}`,
				"   Re-apply this branch's migrations:  npm run db:reset",
				"",
			].join("\n"),
		);
		process.exitCode = 1;
		return;
	}

	rootLogger.info("db:doctor — ok (auth reachable; seed users present; schema current)", {
		action: "db_doctor",
		seedEmailsChecked: seedEmails.length,
		schemaVersion: EXPECTED_DB_SCHEMA_VERSION,
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
