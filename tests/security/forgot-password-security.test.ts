import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { POST } from "../../src/pages/api/auth/email/forgot-password";
import { toRedirect } from "../shared-utils";

describe("A user requests a password reset email from the forgot password form.", () => {
	it("The request is rejected when the form is incomplete.", async () => {
		const request = new Request(
			"http://localhost/api/auth/email/forgot-password",
			{
				method: "POST",
				body: new URLSearchParams({
					email: "",
					captcha_token: "",
				}),
			},
		);

		const response = await POST({
			request,
			redirect: toRedirect,
		} as APIContext);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toContain(
			"/auth/forgot?error=invalid_form",
		);
	});
});
