import { describe, expect, it } from "vitest";
import { BACKUP_TABLES } from "../../../src/lib/backup/tables";

describe("BACKUP_TABLES", () => {
	it("is exactly the four user-authored tables, schema-qualified", () => {
		expect(BACKUP_TABLES).toEqual([
			"public.users",
			"public.user_assets",
			"public.price_targets",
			"public.scheduled_notifications",
		]);
	});
});
