import { describe, expect, it } from "vitest";
import { POST } from "../../../../src/pages/api/auth/email/resend-verification";
import { createApiContext } from "../../../helpers/api-context";

describe("A user resends their email verification from the unconfirmed page.", () => {
	it("If the form is incomplete, the user is asked to complete all fields.", async () => {
		const request = new Request(
			"http://localhost/api/auth/email/resend-verification",
			{
				method: "POST",
				body: new URLSearchParams({
					email: "",
				}),
			},
		);

		const response = await POST(createApiContext({ request }));

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(
			"/auth/unconfirmed?error=invalid_form",
		);
	});
});
