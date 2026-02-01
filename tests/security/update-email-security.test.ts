import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { POST } from "../../src/pages/api/auth/update-email";

const toRedirect = (url: string, status = 302) =>
	new Response(null, {
		status,
		headers: { Location: url },
	});

describe("Update email requires authentication.", () => {
	it("An unauthenticated request is redirected to sign-in with an error.", async () => {
		const request = new Request("http://localhost/api/auth/update-email", {
			method: "POST",
			body: new URLSearchParams({ email: "new@example.com" }),
		});

		const response = await POST({
			request,
			cookies: {
				get: () => undefined,
				set: () => {},
			},
			redirect: toRedirect,
		} as unknown as APIContext);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(
			"/auth/signin?error=unauthorized",
		);
	});
});
