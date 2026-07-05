import { describe, expect, it } from "vitest";
import { exportSnapshot } from "../../../src/lib/backup/export";
import { EXPECTED_DB_SCHEMA_VERSION } from "../../../src/lib/db/schema-version";

describe("exportSnapshot", () => {
	it("returns COPY text for every table plus a consistent manifest", async () => {
		const dbUrl = process.env.DATABASE_URL;
		if (!dbUrl) throw new Error("DATABASE_URL not set (start local Supabase)");

		const snap = await exportSnapshot({ connectionString: dbUrl });

		// One COPY payload per table.
		expect(Object.keys(snap.tables).sort()).toEqual([
			"public.price_move_alert_thresholds",
			"public.scheduled_notifications",
			"public.user_assets",
			"public.users",
		]);
		// Manifest row counts match the line count of each COPY payload.
		for (const [table, text] of Object.entries(snap.tables)) {
			const lines = text === "" ? 0 : text.split("\n").filter((l) => l.length > 0).length;
			expect(snap.manifest.row_counts[table]).toBe(lines);
		}
		expect(snap.manifest.schema_version).toBe(EXPECTED_DB_SCHEMA_VERSION);
		expect(snap.manifest.format).toBe("pg-copy-text-v2");
		// Every backed-up table carries an explicit, non-empty column list so the
		// restore aligns by name rather than physical column order.
		for (const table of Object.keys(snap.tables)) {
			expect(snap.manifest.columns[table]?.length ?? 0).toBeGreaterThan(0);
		}
	});
});
