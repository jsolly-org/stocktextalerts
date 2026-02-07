import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { POST } from "../../../src/pages/api/auth/update-password";
import { toRedirect } from "../../helpers/shared-utils";

describe("A user submits the password recovery form.", () => {
	it("The request is rejected when the form is incomplete.", async () => {
		const request = new Request("http://localhost/api/auth/update-password", {
			method: "POST",
			body: new URLSearchParams({
				password: "",
				confirm: "",
				token_hash: "",
			}),
		});

		const response = await POST({
			request,
			redirect: toRedirect,
		} as unknown as APIContext);

		expect(response.status).toBe(303);
		const location = response.headers.get("Location");
		expect(location).toContain("/auth/recover?");
		expect(location).toContain("error=invalid_form");
		expect(location).toContain("type=recovery");
	});
});
