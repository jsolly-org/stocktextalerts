import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gunzipSync } from "node:zlib";
import { Client } from "pg";
import { from as copyFrom } from "pg-copy-streams";
import { sslFor } from "../../src/lib/backup/export";
import type { BackupPayload } from "../../src/lib/backup/storage";
import { BACKUP_TABLES } from "../../src/lib/backup/tables";

async function main() {
	const [, , file, targetUrl] = process.argv;
	if (!file || !targetUrl) throw new Error("usage: restore.ts <file.json.gz> <DATABASE_URL>");

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
		// Truncate child-first (reverse of the parent-first BACKUP_TABLES order).
		for (const table of [...BACKUP_TABLES].reverse()) {
			await client.query(`TRUNCATE ${table} CASCADE`);
		}
		// Load parent-first so FKs are satisfied as rows land.
		for (const table of BACKUP_TABLES) {
			const text = payload.tables[table] ?? "";
			const ingest = client.query(copyFrom(`COPY ${table} FROM STDIN`));
			await pipeline(Readable.from([text]), ingest);
		}
		await client.query("COMMIT");

		process.stdout.write(`restored ${file} -> ${target}\n`);
		process.stdout.write(`${JSON.stringify(payload.manifest.row_counts)}\n`);
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		await client.end();
	}
}

main().catch((err) => {
	process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
