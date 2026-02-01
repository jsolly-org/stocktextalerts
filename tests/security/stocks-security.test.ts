import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { POST } from "../../src/pages/api/stocks/update";

describe("A signed-in user updates their tracked stocks.", () => {
	it("A logged-out user cannot update tracked stocks.", async () => {
		const formData = new FormData();
		formData.append("tracked_stocks", JSON.stringify(["AAPL"]));

		const request = new Request("http://localhost/api/stocks/update", {
			method: "POST",
			body: formData,
		});

		const response = await POST({
			request,
			cookies: {
				get: () => undefined,
				set: () => {},
			},
		} as unknown as APIContext);

		expect(response.status).toBe(401);
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload.ok).toBe(false);
		expect(payload.message).toBe("unauthorized");
	});
});
