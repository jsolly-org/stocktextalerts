/**
 * scripts/db/check-option-catalog.ts — drift check between the authored
 * notification-option catalog (NOTIFICATION_OPTION_MATRIX → the flat
 * NOTIFICATION_PREFERENCE_CATALOG in src/lib/constants.ts) and the
 * `notification_options` DB table that enforces the same taxonomy via FK.
 *
 * The code catalog is the single authored source; the table is its DB twin,
 * seeded by migration. This script fails loudly when the two diverge in either
 * direction, so adding/removing/renaming an option in code without the paired
 * migration (or vice versa) cannot pass db:reset — and therefore cannot pass CI.
 *
 * Read-only. Local-only by default (mirrors check:db-privileges); set
 * OPTION_CATALOG_CHECK_ALLOW_NONLOCAL=1 for a read-only remote audit.
 *
 * Exit codes: 0 — catalog and table match (or skipped on a non-local target).
 *             1 — drift found, or the DB was unreachable.
 *
 * Usage: npm run check:option-catalog
 */

import { Client } from "pg";

import { NOTIFICATION_PREFERENCE_CATALOG } from "../../src/lib/constants";
import { rootLogger } from "../../src/lib/logging";
import { isLocalHost } from "./is-local-host";
import { pgSsl } from "./pg-ssl";

const DB_STATEMENT_TIMEOUT_MS = 10_000;

function optionKey(row: { notification_type: string; content: string; channel: string }): string {
	return `${row.notification_type}|${row.content}|${row.channel}`;
}

/** Compare table rows to the code catalog. Exported for Vitest. */
export async function collectOptionCatalogDrift(client: Client): Promise<string[]> {
	const errors: string[] = [];

	const { rows } = await client.query<{
		notification_type: string;
		content: string;
		channel: string;
	}>("SELECT notification_type, content, channel FROM public.notification_options");

	const dbKeys = new Set(rows.map(optionKey));
	const codeKeys = new Set(NOTIFICATION_PREFERENCE_CATALOG.map(optionKey));

	for (const key of codeKeys) {
		if (!dbKeys.has(key)) {
			errors.push(
				`Catalog option (${key}) has no notification_options row — ` +
					`add an INSERT in a new migration.`,
			);
		}
	}
	for (const key of dbKeys) {
		if (!codeKeys.has(key)) {
			errors.push(
				`notification_options row (${key}) is not in NOTIFICATION_OPTION_MATRIX — ` +
					`remove it in a new migration or restore the matrix entry.`,
			);
		}
	}

	return errors;
}

async function main(): Promise<void> {
	const supabaseUrl = process.env.SUPABASE_URL;
	const databaseUrl = process.env.DATABASE_URL;

	if (!databaseUrl) {
		rootLogger.error("check:option-catalog — missing DATABASE_URL in env", {
			action: "check_option_catalog",
		});
		process.exitCode = 1;
		return;
	}

	const allowNonLocal = process.env.OPTION_CATALOG_CHECK_ALLOW_NONLOCAL === "1";
	if (supabaseUrl && !allowNonLocal) {
		let host: string;
		try {
			host = new URL(supabaseUrl).hostname;
		} catch {
			rootLogger.error("check:option-catalog — SUPABASE_URL is not a valid URL", {
				action: "check_option_catalog",
				supabaseUrl,
			});
			process.exitCode = 1;
			return;
		}
		if (!isLocalHost(host)) {
			rootLogger.info("check:option-catalog — SUPABASE_URL is non-local; skipping", {
				action: "check_option_catalog",
				host,
				hint: "set OPTION_CATALOG_CHECK_ALLOW_NONLOCAL=1 to run a read-only remote audit",
			});
			return;
		}
	}

	const client = new Client({
		connectionString: databaseUrl,
		statement_timeout: DB_STATEMENT_TIMEOUT_MS,
		connectionTimeoutMillis: DB_STATEMENT_TIMEOUT_MS,
		ssl: pgSsl(databaseUrl),
	});

	try {
		await client.connect();
	} catch (err) {
		rootLogger.error(
			"check:option-catalog — database unreachable",
			{ action: "check_option_catalog" },
			err,
		);
		process.exitCode = 1;
		return;
	}

	try {
		const errors = await collectOptionCatalogDrift(client);

		if (errors.length > 0) {
			rootLogger.error("check:option-catalog — catalog/table drift found", {
				action: "check_option_catalog",
				errors,
			});
			process.exitCode = 1;
			return;
		}

		rootLogger.info("check:option-catalog — notification_options matches the code catalog", {
			action: "check_option_catalog",
			optionCount: NOTIFICATION_PREFERENCE_CATALOG.length,
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
			"check:option-catalog — unexpected error",
			{ action: "check_option_catalog" },
			err,
		);
		process.exitCode = 1;
	});
}
