import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { POST as POSTDismissBanner } from "../../../src/pages/api/notification-preferences/dismiss-timezone-banner";

describe("A user requests to dismiss the timezone mismatch banner.", () => {
	it("The request is rejected when the user is not authenticated.", async () => {
		const request = new Request(
			"http://localhost/api/notification-preferences/dismiss-timezone-banner",
			{
				method: "POST",
			},
		);

		const response = await POSTDismissBanner({
			request,
			cookies: {
				get: () => undefined,
				set: () => {},
			},
		} as unknown as APIContext);

		expect(response.status).toBe(401);
		const json = await response.json();
		expect(json.ok).toBe(false);
		expect(json.message).toBe("unauthorized");
	});
});
