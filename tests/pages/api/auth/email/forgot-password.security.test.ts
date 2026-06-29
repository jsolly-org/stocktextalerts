import { describe, expect, it } from "vitest";
import { POST } from "../../../../../src/pages/api/auth/email/forgot-password";
import { createApiContext } from "../../../../helpers/api-context";

describe("A user requests a password reset email from the forgot password form.", () => {
	it("The request is rejected when the form is incomplete.", async () => {
		const request = new Request("http://localhost/api/auth/email/forgot-password", {
			method: "POST",
			body: new URLSearchParams({
				email: "",
			}),
		});

		const response = await POST(createApiContext({ request }));

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toContain("/auth/forgot?error=invalid_form");
	});
});
