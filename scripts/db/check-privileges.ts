/**
 * scripts/db/check-privileges.ts — read-only verifier that local (and CI)
 * Supabase function grants match the explicit contract in
 * `privilege-contract.ts`, i.e. the same shape hosted production enforces.
 *
 * It fails on the three mistakes that caused (or could repeat) the duplicate-SMS
 * incident:
 *   1. A server-only RPC missing its `service_role` EXECUTE grant.
 *   2. A server-only RPC still executable by `anon` / `authenticated`.
 *   3. `public` default privileges that auto-grant EXECUTE on FUTURE functions
 *      to client roles (the local-only behavior that masked #1 and #2).
 * It also fails on any app-owned (`postgres`-owned, non-extension) function that
 * is in neither `RPC_PRIVILEGES`/`LEGACY_SERVER_ONLY` nor `INTERNAL_FUNCTIONS`,
 * forcing new RPCs to be classified.
 *
 * Table/sequence default-privilege drift is reported as a WARNING only; tables
 * have their own RLS/API-surface review and are out of scope here.
 *
 * This script only runs `SELECT` / catalog functions — it never mutates. It is
 * local-only by default (mirrors `db:doctor`); set
 * `PRIVILEGE_CHECK_ALLOW_NONLOCAL=1` to run it read-only against a remote DB
 * (e.g. a post-`db push` production audit).
 *
 * Exit codes: 0 — contract satisfied (or skipped on a non-local target).
 *             1 — violations found, or the DB was unreachable.
 *
 * Usage: npm run check:db-privileges
 */

import { Client } from "pg";

import { rootLogger } from "../../src/lib/logging";
import { isLocalHost } from "./is-local-host";
import {
	CLIENT_ROLES,
	ENFORCED_FUNCTIONS,
	executeRolesFor,
	INTERNAL_FUNCTIONS,
	type RoleName,
	type RpcPrivilege,
} from "./privilege-contract";

const DB_STATEMENT_TIMEOUT_MS = 10_000;

export type PrivilegeReport = {
	errors: string[];
	warnings: string[];
};

type CatalogFunction = {
	oid: number;
	signature: string;
};

type DefaultAclRow = {
	owner_role: string;
	objtype: string;
	grantee: string;
	priv: string;
};

/**
 * All app-owned (`postgres`-owned, NOT extension-provided) functions in
 * `public`, keyed by `proname(identity_args)`. Extension functions (pg_trgm,
 * etc.) are owned by `supabase_admin` and excluded — we neither own nor grant
 * them.
 */
async function loadAppFunctions(client: Client): Promise<Map<string, CatalogFunction>> {
	const { rows } = await client.query<{ oid: number; signature: string }>(`
		SELECT p.oid::int AS oid,
		       p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS signature
		FROM pg_proc p
		JOIN pg_namespace n ON n.oid = p.pronamespace
		WHERE n.nspname = 'public'
		  AND pg_get_userbyid(p.proowner) = 'postgres'
		  AND NOT EXISTS (
		    SELECT 1 FROM pg_depend d
		    WHERE d.objid = p.oid AND d.deptype = 'e'
		  )
	`);
	return new Map(rows.map((row) => [row.signature, { oid: row.oid, signature: row.signature }]));
}

async function roleHasExecute(client: Client, oid: number, role: RoleName): Promise<boolean> {
	const { rows } = await client.query<{ ok: boolean }>(
		`SELECT has_function_privilege($1, $2::oid, 'EXECUTE') AS ok`,
		[role, oid],
	);
	return rows[0]?.ok === true;
}

/** Verifies one enforced function exists and holds exactly its expected EXECUTE grants. */
async function checkFunction(
	client: Client,
	appFns: Map<string, CatalogFunction>,
	entry: RpcPrivilege,
	errors: string[],
): Promise<void> {
	const fn = appFns.get(entry.signature);
	if (!fn) {
		errors.push(
			`Contract function not found among app-owned public functions: ${entry.signature}. ` +
				`If the signature changed, update scripts/db/privilege-contract.ts.`,
		);
		return;
	}

	const expected = new Set<RoleName>(executeRolesFor(entry));
	for (const role of CLIENT_ROLES) {
		const has = await roleHasExecute(client, fn.oid, role);
		const shouldHave = expected.has(role);
		if (shouldHave && !has) {
			errors.push(
				`Missing EXECUTE: ${role} cannot execute ${entry.signature} ` +
					`(${entry.class}). Add an explicit GRANT EXECUTE ... TO ${role}.`,
			);
		} else if (!shouldHave && has) {
			errors.push(
				`Unexpected EXECUTE: ${role} can execute ${entry.signature} ` +
					`(${entry.class}). Revoke it; only [${executeRolesFor(entry).join(", ")}] are allowed.`,
			);
		}
	}
}

/** Flags any app-owned function that is in neither the RPC contract nor the internal allowlist. */
function checkForUnclassified(appFns: Map<string, CatalogFunction>, errors: string[]): void {
	const known = new Set<string>([
		...ENFORCED_FUNCTIONS.map((entry) => entry.signature),
		...INTERNAL_FUNCTIONS,
	]);
	for (const signature of appFns.keys()) {
		if (!known.has(signature)) {
			errors.push(
				`Unclassified app-owned function: ${signature}. Add it to RPC_PRIVILEGES ` +
					`(if called via .rpc) or INTERNAL_FUNCTIONS in scripts/db/privilege-contract.ts.`,
			);
		}
	}
}

/**
 * Checks `public` default privileges. Hard-fails when `postgres`-owned function
 * defaults grant EXECUTE to a client role (or PUBLIC) — that is the local-only
 * behavior that hid the incident. Table/sequence drift is a warning only.
 *
 * `supabase_admin`-owned defaults are intentionally ignored: app migrations
 * create functions as `postgres`, so only `postgres` defaults govern app
 * objects, and Supabase manages the `supabase_admin` defaults.
 */
async function checkDefaultPrivileges(
	client: Client,
	errors: string[],
	warnings: string[],
): Promise<void> {
	const { rows } = await client.query<DefaultAclRow>(`
		SELECT pg_get_userbyid(d.defaclrole) AS owner_role,
		       d.defaclobjtype AS objtype,
		       CASE WHEN (a).grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid((a).grantee) END AS grantee,
		       (a).privilege_type AS priv
		FROM pg_default_acl d
		JOIN pg_namespace n ON n.oid = d.defaclnamespace
		CROSS JOIN LATERAL aclexplode(d.defaclacl) AS a
		WHERE n.nspname = 'public'
	`);

	const clientGrantees = new Set<string>(["anon", "authenticated", "service_role", "PUBLIC"]);
	// Aggregate non-function drift into one grantee set per object kind so the
	// out-of-scope table/sequence warnings stay to two lines, not dozens.
	const tableGrantees = new Set<string>();
	const sequenceGrantees = new Set<string>();

	for (const row of rows) {
		if (row.owner_role !== "postgres") continue;
		if (!clientGrantees.has(row.grantee)) continue;

		if (row.objtype === "f" && row.priv === "EXECUTE") {
			errors.push(
				`Default privilege grants EXECUTE on FUTURE functions to ${row.grantee} ` +
					`(owner postgres). New RPCs must require explicit grants. Run the ` +
					`tighten-function-privileges migration / ALTER DEFAULT PRIVILEGES REVOKE.`,
			);
		} else if (row.objtype === "r") {
			tableGrantees.add(row.grantee);
		} else if (row.objtype === "S") {
			sequenceGrantees.add(row.grantee);
		}
	}

	if (tableGrantees.size > 0) {
		warnings.push(
			`Default privileges grant access on FUTURE tables to [${[...tableGrantees].sort().join(", ")}] ` +
				`(owner postgres). Out of scope for the function-grant check; tables have their own RLS/API review.`,
		);
	}
	if (sequenceGrantees.size > 0) {
		warnings.push(
			`Default privileges grant access on FUTURE sequences to [${[...sequenceGrantees].sort().join(", ")}] ` +
				`(owner postgres). Out of scope for the function-grant check; review separately.`,
		);
	}
}

/** Runs all checks against an already-connected client. Exported for Vitest. */
export async function collectPrivilegeViolations(client: Client): Promise<PrivilegeReport> {
	const errors: string[] = [];
	const warnings: string[] = [];

	const appFns = await loadAppFunctions(client);

	for (const entry of ENFORCED_FUNCTIONS) {
		await checkFunction(client, appFns, entry, errors);
	}
	checkForUnclassified(appFns, errors);
	await checkDefaultPrivileges(client, errors, warnings);

	return { errors, warnings };
}

async function main(): Promise<void> {
	const supabaseUrl = process.env.SUPABASE_URL;
	const databaseUrl = process.env.DATABASE_URL;

	if (!databaseUrl) {
		rootLogger.error("check:db-privileges — missing DATABASE_URL in env", {
			action: "check_db_privileges",
		});
		process.exitCode = 1;
		return;
	}

	const allowNonLocal = process.env.PRIVILEGE_CHECK_ALLOW_NONLOCAL === "1";
	if (supabaseUrl && !allowNonLocal) {
		let host: string;
		try {
			host = new URL(supabaseUrl).hostname;
		} catch {
			rootLogger.error("check:db-privileges — SUPABASE_URL is not a valid URL", {
				action: "check_db_privileges",
				supabaseUrl,
			});
			process.exitCode = 1;
			return;
		}
		if (!isLocalHost(host)) {
			rootLogger.info("check:db-privileges — SUPABASE_URL is non-local; skipping", {
				action: "check_db_privileges",
				host,
				hint: "set PRIVILEGE_CHECK_ALLOW_NONLOCAL=1 to run a read-only remote audit",
			});
			return;
		}
	}

	const client = new Client({
		connectionString: databaseUrl,
		statement_timeout: DB_STATEMENT_TIMEOUT_MS,
		connectionTimeoutMillis: DB_STATEMENT_TIMEOUT_MS,
	});

	try {
		await client.connect();
	} catch (err) {
		rootLogger.error(
			"check:db-privileges — database unreachable",
			{ action: "check_db_privileges" },
			err,
		);
		process.exitCode = 1;
		return;
	}

	try {
		const { errors, warnings } = await collectPrivilegeViolations(client);

		for (const warning of warnings) {
			rootLogger.warn("check:db-privileges — warning", {
				action: "check_db_privileges",
				warning,
			});
		}

		if (errors.length > 0) {
			rootLogger.error("check:db-privileges — contract violations found", {
				action: "check_db_privileges",
				errorCount: errors.length,
				errors,
			});
			process.exitCode = 1;
			return;
		}

		rootLogger.info("check:db-privileges — ok (function grants match contract)", {
			action: "check_db_privileges",
			enforcedFunctions: ENFORCED_FUNCTIONS.length,
			warningCount: warnings.length,
		});
	} finally {
		await client.end().catch(() => {
			// Verdict already recorded; ignore close errors.
		});
	}
}

// Only run as a CLI; importing for tests must not trigger a connection.
const isDirectRun =
	typeof process.argv[1] === "string" && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
	main().catch((err) => {
		rootLogger.error(
			"check:db-privileges — unexpected error",
			{ action: "check_db_privileges" },
			err,
		);
		process.exitCode = 1;
	});
}
