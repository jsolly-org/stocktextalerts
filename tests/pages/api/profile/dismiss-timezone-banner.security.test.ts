import { describe, expect, it } from "vitest";
import { POST as POSTDismissBanner } from "../../../../src/pages/api/profile/dismiss-timezone-banner";
import { createApiContext } from "../../../helpers/api-context";

describe("A user requests to dismiss the timezone mismatch banner.", () => {
	it("The request is rejected when the user is not authenticated.", async () => {
		const request = new Request("http://localhost/api/profile/dismiss-timezone-banner", {
			method: "POST",
		});

		const response = await POSTDismissBanner(createApiContext({ request }));

		expect(response.status).toBe(401);
		const json = await response.json();
		expect(json.ok).toBe(false);
		expect(json.message).toBe("unauthorized");
	});
});
