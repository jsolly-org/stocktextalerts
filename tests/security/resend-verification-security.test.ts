import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { POST } from "../../src/pages/api/auth/email/resend-verification";

const toRedirect = (url: string, status = 302) =>
	new Response(null, {
		status,
		headers: { Location: url },
	});

describe("A user resends their email verification from the unconfirmed page.", () => {
	it("If the form is incomplete, the user is asked to complete all fields.", async () => {
		const request = new Request(
			"http://localhost/api/auth/email/resend-verification",
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
		expect(response.headers.get("Location")).toBe(
			"/auth/unconfirmed?error=invalid_form",
		);
	});
});
