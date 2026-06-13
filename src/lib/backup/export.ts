import { Client } from "pg";
import { to as copyTo } from "pg-copy-streams";
import { type BackupManifest, buildManifest } from "./manifest";
import { BACKUP_TABLES } from "./tables";

export type Snapshot = {
	tables: Record<string, string>;
	manifest: BackupManifest;
};

/**
 * Pick a `pg` SSL option for a connection string.
 *
 * - If the string carries an explicit `sslmode=` (e.g. the production pooler URL
 *   uses `sslmode=require`), return `undefined` and let `pg` honor it natively.
 * - Local Postgres (127.0.0.1 / localhost) does not support SSL, so disable it.
 * - Otherwise default to encrypted-without-CA-pinning for remote hosts.
 */
export function sslFor(
	connectionString: string,
): { rejectUnauthorized: boolean } | false | undefined {
	if (connectionString.includes("sslmode=")) return undefined;
	if (/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString)) return false;
	return { rejectUnauthorized: false };
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
		for (const table of BACKUP_TABLES) {
			const stream = client.query(copyTo(`COPY ${table} TO STDOUT`));
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
			}),
		};
	} finally {
		await client.end();
	}
}
