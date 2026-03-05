import { describe, expect, it } from "vitest";
import { POST } from "../../../src/pages/api/market-notifications/next-send-at";
import { createApiContext } from "../../helpers/api-context";

describe("The next-send-at API requires authentication.", () => {
	it("Unauthenticated requests receive 401.", async () => {
		const request = new Request(
			"http://localhost/api/market-notifications/next-send-at",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					timezone: "America/New_York",
					timeInputs: ["09:30"],
				}),
			},
		);

		const response = await POST(createApiContext({ request }));

		expect(response.status).toBe(401);
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload.ok).toBe(false);
		expect(payload.message).toBe("unauthorized");
	});
});
