import { describe, expect, it } from "vitest";
import { checkDatabaseHealth } from "../helpers/db-health-check";

describe("database health check", () => {
	it("Returns 200 with db ok when Supabase is reachable", async () => {
		const response = await checkDatabaseHealth();
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({ status: "ok", checks: { db: "ok" } });
	});
});
