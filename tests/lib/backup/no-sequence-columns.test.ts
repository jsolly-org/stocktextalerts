import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { BACKUP_TABLES } from "../../../src/lib/backup/tables";

/**
 * Guard: the COPY-based backup is DATA-ONLY and does NOT restore sequence
 * high-water marks. Restoring a sequence/identity/serial-backed table would
 * therefore leave the sequence at its old value and the next INSERT would
 * collide on the PK (verified by deep research against Postgres docs). Our 4
 * tables use UUID/natural-key PKs today, so there are no sequences to restore.
 *
 * This test fails loud if a future table added to BACKUP_TABLES introduces a
 * sequence-backed column — forcing whoever adds it to implement setval() on
 * restore (or pick a non-sequence key) rather than shipping silently-broken
 * restores. See docs/plans/2026-06-13-backup-hardening.md (P1.2).
 */
describe("backup tables have no sequence-backed columns", () => {
	it("none of BACKUP_TABLES use identity/serial/nextval defaults", async () => {
		const dbUrl = process.env.DATABASE_URL;
		if (!dbUrl) throw new Error("DATABASE_URL not set (start local Supabase)");

		const names = BACKUP_TABLES.map((t) => t.replace(/^public\./, ""));
		const client = new Client({ connectionString: dbUrl });
		await client.connect();
		try {
			const { rows } = await client.query<{ table_name: string; column_name: string }>(
				`select table_name, column_name
				 from information_schema.columns
				 where table_schema = 'public'
				   and table_name = any($1)
				   and (is_identity = 'YES' or column_default like 'nextval(%')
				 order by table_name, column_name`,
				[names],
			);
			expect(rows).toEqual([]);
		} finally {
			await client.end();
		}
	});
});
