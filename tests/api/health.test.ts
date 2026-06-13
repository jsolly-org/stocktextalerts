import { describe, expect, it } from "vitest";
import { GET } from "../../src/pages/api/health";

describe("GET /api/health", () => {
	it("Returns 200 with db ok when Supabase is reachable", async () => {
		const response = await GET();
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({ status: "ok", checks: { db: "ok" } });
	});
});
