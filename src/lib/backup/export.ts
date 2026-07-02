import { Client } from "pg";
import { to as copyTo } from "pg-copy-streams";
import { BACKUP_TABLES } from "./constants";
import { type BackupManifest, buildManifest } from "./manifest";

type Snapshot = {
	tables: Record<string, string>;
	manifest: BackupManifest;
};

/**
 * Pick a `pg` SSL option for a connection string.
 *
 * - Local Postgres (127.0.0.1 / localhost) does not support SSL, so disable it.
 * - Remote (the Supabase pooler) → encrypted without CA verification. The pooler
 *   presents a cert not in Node's trust store, so verifying it fails with
 *   "self-signed certificate in certificate chain". We deliberately do NOT defer
 *   to a `sslmode=` in the string: node-postgres's native `sslmode=require` still
 *   verifies the chain and breaks against the pooler. (Verified against the real
 *   deployed Lambda — this branch is why the first prod invoke failed.)
 */
export function sslFor(connectionString: string): { rejectUnauthorized: boolean } | false {
	if (/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString)) return false;
	return { rejectUnauthorized: false };
}

/** Double-quote a SQL identifier so reserved/mixed-case column names are safe. */
function quoteIdent(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

/** Drain a COPY-to-STDOUT stream into a UTF-8 string. */
function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		stream.on("data", (c: Buffer) => chunks.push(c));
		stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		stream.on("error", reject);
	});
}

/** COPY text format terminates every row with a newline; embedded newlines are
 * escaped, so counting '\n' bytes is an exact row count. */
function countRows(copyText: string): number {
	if (copyText.length === 0) return 0;
	let count = 0;
	for (let i = 0; i < copyText.length; i++) if (copyText.charCodeAt(i) === 10) count++;
	return count;
}

export async function exportSnapshot(opts: { connectionString: string }): Promise<Snapshot> {
	const client = new Client({
		connectionString: opts.connectionString,
		ssl: sslFor(opts.connectionString),
	});
	await client.connect();
	try {
		// One snapshot across all tables → no torn FK rows.
		await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");

		// app_metadata is a key/value table: the schema version lives in `value`
		// keyed by `key = 'schema_version'`.
		const schemaRes = await client.query<{ value: string }>(
			"select value from public.app_metadata where key = 'schema_version' limit 1",
		);
		const schemaVersion = schemaRes.rows[0]?.value ?? "unknown";

		const tables: Record<string, string> = {};
		const rowCounts: Record<string, number> = {};
		const columns: Record<string, string[]> = {};
		for (const table of BACKUP_TABLES) {
			const [schema, name] = table.split(".");
			// Explicit, name-ordered column list (excluding generated columns, which
			// COPY can't accept on restore). COPY without a column list aligns by
			// physical position, which silently corrupts a restore into a DB whose
			// column order differs from the source (e.g. a fresh-from-migrations or
			// squash-baseline DB). pg_dump emits explicit column lists for exactly
			// this reason; we store them in the manifest so restore aligns by name.
			const colRes = await client.query<{ column_name: string }>(
				`select column_name from information_schema.columns
				 where table_schema = $1 and table_name = $2 and is_generated = 'NEVER'
				 order by ordinal_position`,
				[schema, name],
			);
			const cols = colRes.rows.map((r) => r.column_name);
			columns[table] = cols;
			const colList = cols.map(quoteIdent).join(", ");
			const stream = client.query(copyTo(`COPY ${table} (${colList}) TO STDOUT`));
			const text = await streamToString(stream);
			tables[table] = text;
			rowCounts[table] = countRows(text);
		}

		await client.query("COMMIT");

		return {
			tables,
			manifest: buildManifest({
				takenAt: new Date().toISOString(),
				schemaVersion,
				rowCounts,
				columns,
			}),
		};
	} finally {
		await client.end();
	}
}
