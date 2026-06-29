import { describe, expect, it } from "vitest";
import { POST } from "../../../../src/pages/api/auth/account-management/update-password";
import { createApiContext } from "../../../helpers/api-context";

describe("A user submits the password recovery form.", () => {
	it("The request is rejected when the form is incomplete.", async () => {
		const request = new Request("http://localhost/api/auth/account-management/update-password", {
			method: "POST",
			body: new URLSearchParams({
				password: "",
				token_hash: "",
			}),
		});

		const response = await POST(createApiContext({ request }));

		expect(response.status).toBe(303);
		const location = response.headers.get("Location");
		expect(location).toContain("/auth/recover?");
		expect(location).toContain("error=invalid_form");
		expect(location).toContain("type=recovery");
	});
});
