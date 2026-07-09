/**
 * scripts/db/check-migration-grants.ts — static lint over migration SQL that
 * catches the "created a function but forgot to grant it" mistake at PR time,
 * before it reaches a DB. This is the cheap, offline complement to the runtime
 * `check:db-privileges` (which needs a live local DB).
 *
 * The duplicate-SMS incident shipped because a migration created delivery-state
 * RPCs and revoked them from `PUBLIC` but never granted `EXECUTE` to
 * `service_role`. Locally the broad default privileges hid it; in prod the
 * functions were callable by nobody.
 *
 * Rules (evaluated COLLECTIVELY across all non-baseline migrations, because the
 * grant for a function may legitimately live in a later migration than its
 * CREATE — though same-migration grants are strongly preferred):
 *
 *   ERROR   — a non-trigger `public` function is CREATEd but never granted
 *             EXECUTE in any non-baseline migration, and has no opt-out marker.
 *   ERROR   — an explicit `GRANT ... ON FUNCTION ... TO PUBLIC` (broad).
 *   ERROR   — `CREATE TABLE public.<t>` with no `ENABLE ROW LEVEL SECURITY`
 *             for that table anywhere in the migrations (RLS surface review).
 *
 * Opt-out marker (same set of files), for the rare intentional case:
 *   -- privilege-contract: no-grant <function_name>
 *
 * The squashed pg_dump baseline is skipped: it carries its own complete grant
 * block and squawk can't parse its IDENTITY/SEQUENCE syntax either.
 *
 * Exit codes: 0 — clean. 1 — one or more findings (missing grants, PUBLIC
 * grants, or tables without RLS). Soft warnings are not allowed — fail closed.
 *
 * Usage: npm run check:migration-grants
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { rootLogger } from "../../src/lib/logging";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..", "..");
const MIGRATIONS_DIR = path.join(projectRoot, "supabase", "migrations");

/** pg_dump-style squashed baseline — carries its own grant block; skip. */
const BASELINE_FILE = "20260509161208_migrate_market_times_to_et.sql";

const CREATE_FUNCTION_RE =
	/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;
const GRANT_ON_FUNCTION_RE =
	/GRANT\s+[^;]*?\bON\s+FUNCTION\s+(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?/gi;
const GRANT_FUNCTION_TO_PUBLIC_RE =
	/GRANT\b[^;]*\bON\s+FUNCTION\b[^;]*\bTO\b[^;]*\bPUBLIC\b/gi;
const CREATE_TABLE_RE =
	/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?/gi;
const ENABLE_RLS_RE =
	/ALTER\s+TABLE\s+(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi;
const NO_GRANT_MARKER_RE = /--\s*privilege-contract:\s*no-grant\s+([a-z_][a-z0-9_]*)/gi;

type Scan = {
	createdNonTrigger: Set<string>;
	granted: Set<string>;
	rlsEnabled: Set<string>;
	createdTables: Set<string>;
	noGrantMarkers: Set<string>;
	publicGrantFiles: Set<string>;
};

function matchAll(re: RegExp, text: string): RegExpExecArray[] {
	const out: RegExpExecArray[] = [];
	re.lastIndex = 0;
	let m: RegExpExecArray | null = re.exec(text);
	while (m !== null) {
		out.push(m);
		m = re.exec(text);
	}
	return out;
}

/**
 * A function whose header declares `RETURNS trigger` needs no EXECUTE grant.
 *
 * The slice is bounded to THIS function's definition (`createMatchIndex` up to
 * the start of the next function, capped) and the search is confined to the
 * header — up to the body delimiter (`AS` / `LANGUAGE` / `$$` / `BEGIN`). Both
 * bounds matter: an unbounded window bleeds into a neighbouring trigger
 * function's `RETURNS trigger` and misclassifies the (ungranted) RPC before it
 * as a trigger — silently skipping exactly the missing-grant mistake this lint
 * exists to catch.
 */
function isTriggerFunction(sql: string, createMatchIndex: number, defEndIndex: number): boolean {
	const slice = sql.slice(createMatchIndex, defEndIndex);
	const bodyStart = slice.search(/\bAS\b|\bLANGUAGE\b|\$\$|\bBEGIN\b/i);
	const header = bodyStart === -1 ? slice : slice.slice(0, bodyStart);
	return /\bRETURNS\s+trigger\b/i.test(header);
}

function scanFile(filePath: string, scan: Scan): void {
	const sql = fs.readFileSync(filePath, "utf-8");
	const fileName = path.basename(filePath);

	const createMatches = matchAll(CREATE_FUNCTION_RE, sql);
	for (let i = 0; i < createMatches.length; i++) {
		const m = createMatches[i];
		const name = m?.[1];
		if (!m || !name) continue;
		// Bound this function's definition to the next CREATE FUNCTION (capped),
		// so trigger detection never reads into a neighbouring function.
		const nextIndex = createMatches[i + 1]?.index ?? sql.length;
		const defEnd = Math.min(nextIndex, m.index + 4000);
		if (isTriggerFunction(sql, m.index, defEnd)) continue;
		scan.createdNonTrigger.add(name);
	}
	for (const m of matchAll(GRANT_ON_FUNCTION_RE, sql)) {
		if (m[1]) scan.granted.add(m[1]);
	}
	for (const m of matchAll(NO_GRANT_MARKER_RE, sql)) {
		if (m[1]) scan.noGrantMarkers.add(m[1]);
	}
	for (const m of matchAll(CREATE_TABLE_RE, sql)) {
		if (m[1]) scan.createdTables.add(m[1]);
	}
	for (const m of matchAll(ENABLE_RLS_RE, sql)) {
		if (m[1]) scan.rlsEnabled.add(m[1]);
	}
	if (matchAll(GRANT_FUNCTION_TO_PUBLIC_RE, sql).length > 0) {
		scan.publicGrantFiles.add(fileName);
	}
}

function main(): void {
	if (!fs.existsSync(MIGRATIONS_DIR)) {
		rootLogger.error("check:migration-grants — migrations dir not found", {
			action: "check_migration_grants",
			dir: MIGRATIONS_DIR,
		});
		process.exitCode = 1;
		return;
	}

	const files = fs
		.readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql") && f !== BASELINE_FILE)
		.sort()
		.map((f) => path.join(MIGRATIONS_DIR, f));

	const scan: Scan = {
		createdNonTrigger: new Set(),
		granted: new Set(),
		rlsEnabled: new Set(),
		createdTables: new Set(),
		noGrantMarkers: new Set(),
		publicGrantFiles: new Set(),
	};

	for (const file of files) {
		scanFile(file, scan);
	}

	const errors: string[] = [];

	for (const name of scan.createdNonTrigger) {
		if (scan.granted.has(name) || scan.noGrantMarkers.has(name)) continue;
		errors.push(
			`Function public.${name} is created in a migration but never granted EXECUTE. ` +
				`Add an explicit GRANT EXECUTE ON FUNCTION public.${name}(...) TO <role>; ` +
				`(server-only RPCs need service_role). If intentional, add the marker ` +
				`'-- privilege-contract: no-grant ${name}'.`,
		);
	}

	for (const fileName of scan.publicGrantFiles) {
		errors.push(
			`${fileName}: explicit GRANT ... ON FUNCTION ... TO PUBLIC. Prefer granting ` +
				`specific roles (service_role / authenticated) instead of PUBLIC.`,
		);
	}

	for (const table of scan.createdTables) {
		if (!scan.rlsEnabled.has(table)) {
			errors.push(
				`Table public.${table} is created without 'ALTER TABLE ... ENABLE ROW LEVEL ` +
					`SECURITY' in any migration. Confirm its API/RLS surface is intentional.`,
			);
		}
	}

	if (errors.length > 0) {
		rootLogger.error("check:migration-grants — privilege findings", {
			action: "check_migration_grants",
			errorCount: errors.length,
			errors,
		});
		process.exitCode = 1;
		return;
	}

	rootLogger.info("check:migration-grants — ok", {
		action: "check_migration_grants",
		migrationsScanned: files.length,
	});
}

try {
	main();
} catch (err) {
	rootLogger.error(
		"check:migration-grants — unexpected error",
		{ action: "check_migration_grants" },
		err instanceof Error ? err : new Error(String(err)),
	);
	process.exitCode = 1;
}
