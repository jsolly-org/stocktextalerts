import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gunzipSync } from "node:zlib";
import { Client } from "pg";
import { from as copyFrom } from "pg-copy-streams";
import { sslFor } from "../../src/lib/backup/export";
import type { BackupPayload } from "../../src/lib/backup/storage";
import { BACKUP_TABLES } from "../../src/lib/backup/constants";

/** True for a local/scratch target (loopback host). */
function isLocalTarget(connectionString: string): boolean {
	return /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString);
}

async function main() {
	const [, , file, targetUrl] = process.argv;
	if (!file || !targetUrl) throw new Error("usage: restore.ts <file.json.gz> <DATABASE_URL>");

	// This script TRUNCATEs before loading — pointing it at production wipes live
	// data. Default to refusing any non-local target; a real DR restore must opt in
	// explicitly with RESTORE_ALLOW_REMOTE=1 so a stray $DATABASE_URL can't nuke prod.
	if (!isLocalTarget(targetUrl) && process.env.RESTORE_ALLOW_REMOTE !== "1") {
		throw new Error(
			"refusing to restore into a non-local target (TRUNCATEs data); set RESTORE_ALLOW_REMOTE=1 to override",
		);
	}

	const payload = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8")) as BackupPayload;

	const client = new Client({ connectionString: targetUrl, ssl: sslFor(targetUrl) });
	await client.connect();
	try {
		// app_metadata is a key/value table: the schema version lives in `value`
		// keyed by `key = 'schema_version'`.
		const res = await client.query<{ value: string }>(
			"select value from public.app_metadata where key = 'schema_version' limit 1",
		);
		const target = res.rows[0]?.value;
		if (target !== payload.manifest.schema_version) {
			throw new Error(
				`schema mismatch: backup=${payload.manifest.schema_version} target=${target}`,
			);
		}

		await client.query("BEGIN");
		// Disable triggers + FK enforcement for the load so COPY FROM restores rows
		// byte-faithfully: no BEFORE INSERT trigger can rewrite or reject them, and
		// FK ordering can't bite. SET LOCAL auto-resets on COMMIT/ROLLBACK. Requires
		// the restore role to be privileged (postgres) — which a real restore is.
		await client.query("SET LOCAL session_replication_role = 'replica'");
		// Truncate child-first (reverse of the parent-first BACKUP_TABLES order).
		for (const table of [...BACKUP_TABLES].reverse()) {
			await client.query(`TRUNCATE ${table} CASCADE`);
		}
		// Load parent-first so FKs are satisfied as rows land. Verify each table
		// ingested exactly the manifest's row count — the design's completeness
		// check — and abort (rolling back) on any mismatch before COMMIT.
		for (const table of BACKUP_TABLES) {
			const text = payload.tables[table] ?? "";
			// Use the manifest's explicit column list so data aligns by name, not by
			// physical column order (which can differ between the source and the
			// restore target — e.g. a fresh-from-migrations or squash-baseline DB).
			const cols = payload.manifest.columns[table];
			if (!cols || cols.length === 0) {
				throw new Error(`manifest missing column list for ${table}`);
			}
			const colList = cols.map((c) => `"${c.replace(/"/g, '""')}"`).join(", ");
			const ingest = client.query(copyFrom(`COPY ${table} (${colList}) FROM STDIN`));
			await pipeline(Readable.from([text]), ingest);
			const expected = payload.manifest.row_counts[table] ?? 0;
			if (ingest.rowCount !== expected) {
				throw new Error(
					`row-count mismatch for ${table}: manifest=${expected} ingested=${ingest.rowCount}`,
				);
			}
		}
		await client.query("COMMIT");

		process.stdout.write(`restored ${file} -> ${target}\n`);
		process.stdout.write(`${JSON.stringify(payload.manifest.row_counts)}\n`);
	} catch (err) {
		// Never let a failed ROLLBACK mask the original error.
		await client.query("ROLLBACK").catch(() => {});
		throw err;
	} finally {
		await client.end();
	}
}

main().catch((err) => {
	process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
