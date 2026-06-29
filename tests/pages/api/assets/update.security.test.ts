import { describe, expect, it } from "vitest";
import { POST } from "../../../../src/pages/api/assets/update";
import { createApiContext } from "../../../helpers/api-context";

describe("A logged-out user cannot update tracked assets.", () => {
	it("A logged-out user cannot update tracked assets.", async () => {
		const formData = new FormData();
		formData.append("tracked_assets", JSON.stringify(["AAPL"]));

		const request = new Request("http://localhost/api/assets/update", {
			method: "POST",
			body: formData,
		});

		const response = await POST(createApiContext({ request }));

		expect(response.status).toBe(401);
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload.ok).toBe(false);
		expect(payload.message).toBe("unauthorized");
	});
});
