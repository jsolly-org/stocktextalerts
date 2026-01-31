import type { APIContext } from "astro";
import { describe, expect, it, vi } from "vitest";
import { POST } from "../../src/pages/api/auth/email/resend-verification";

const resendMock = vi.fn();

vi.mock("../../src/lib/db/supabase", () => ({
	createSupabaseServerClient: () => ({
		auth: {
			resend: resendMock,
		},
	}),
}));

vi.mock("../../src/lib/db/env", () => ({
	getSiteUrl: () => "http://localhost",
}));

const toRedirect = (url: string, status = 302) =>
	new Response(null, {
		status,
		headers: { Location: url },
	});

describe("POST /api/auth/email/resend-verification", () => {
	it("redirects with success when resend succeeds", async () => {
		resendMock.mockResolvedValueOnce({ error: null });
		const request = new Request(
			"http://localhost/api/auth/email/resend-verification",
			{
				method: "POST",
				body: new URLSearchParams({
					email: "  test@example.com ",
					captcha_token: "test-captcha-token",
				}),
			},
		);

		const response = await POST({
			request,
			redirect: toRedirect,
		} as APIContext);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(
			"/auth/unconfirmed?email=test%40example.com&success=true",
		);
		expect(resendMock).toHaveBeenCalledWith({
			type: "signup",
			email: "test@example.com",
			options: {
				emailRedirectTo: "http://localhost/auth/verified",
				captchaToken: "test-captcha-token",
			},
		});
	});

	it("redirects with captcha_required when captcha fails", async () => {
		resendMock.mockResolvedValueOnce({
			error: {
				code: "captcha_failed",
				status: 400,
				message: "invalid captcha",
			},
		});
		const request = new Request(
			"http://localhost/api/auth/email/resend-verification",
			{
				method: "POST",
				body: new URLSearchParams({
					email: "test@example.com",
					captcha_token: "bad-captcha",
				}),
			},
		);

		const response = await POST({
			request,
			redirect: toRedirect,
		} as APIContext);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(
			"/auth/unconfirmed?email=test%40example.com&error=captcha_required",
		);
	});
});
