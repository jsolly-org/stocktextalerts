import { describe, expect, it } from "vitest";
import { BACKUP_TABLES } from "../../../src/lib/backup/constants";

describe("BACKUP_TABLES", () => {
	it("is exactly the four user-authored tables, schema-qualified", () => {
		expect(BACKUP_TABLES).toEqual([
			"public.users",
			"public.user_assets",
			"public.price_move_alert_thresholds",
			"public.scheduled_notifications",
		]);
	});
});
