import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { POST } from "../../../../src/pages/api/auth/email/forgot-password";
import { createTestEmail, toRedirect } from "../../../helpers/shared-utils";

describe("A user requests a password reset email from the forgot password form.", () => {
	it("A reset email request is accepted and the user sees a success confirmation.", async () => {
		const email = createTestEmail("forgot-pw");

		const request = new Request(
			"http://localhost/api/auth/email/forgot-password",
			{
				method: "POST",
				body: new URLSearchParams({
					email,
				}),
			},
		);

		const response = await POST({
			request,
			redirect: toRedirect,
		} as APIContext);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/auth/forgot?success=true");
	});
});
