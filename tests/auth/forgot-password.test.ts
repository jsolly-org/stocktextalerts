import type { APIContext } from "astro";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../src/pages/api/auth/email/forgot-password";

const { resetPasswordForEmailMock } = vi.hoisted(() => {
	return {
		resetPasswordForEmailMock: vi.fn(),
	};
});

vi.mock("../../src/lib/db/supabase", () => ({
	createSupabaseServerClient: () => ({
		auth: {
			resetPasswordForEmail: resetPasswordForEmailMock,
		},
	}),
}));

const toRedirect = (url: string, status = 302) =>
	new Response(null, {
		status,
		headers: { Location: url },
	});

describe("POST /api/auth/email/forgot-password", () => {
	beforeEach(() => {
		resetPasswordForEmailMock.mockReset();
	});
	it("redirects with invalid_form when form validation fails", async () => {
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
		expect(resetPasswordForEmailMock).not.toHaveBeenCalled();
	});

	it("redirects with rate_limit when Supabase returns 429", async () => {
		resetPasswordForEmailMock.mockResolvedValueOnce({
			error: {
				status: 429,
				code: "over_request_rate_limit",
				message: "Rate limit exceeded",
			},
		});

		const request = new Request(
			"http://localhost/api/auth/email/forgot-password",
			{
				method: "POST",
				body: new URLSearchParams({
					email: "rate-limit@resend.dev",
					captcha_token: "test-captcha-token",
				}),
			},
		);

		const response = await POST({
			request,
			redirect: toRedirect,
		} as APIContext);

		expect(response.status).toBe(302);
		const location = response.headers.get("Location");
		expect(location).toContain("/auth/forgot?error=rate_limit");
		expect(location).toContain("seconds=60");
	});

	it("redirects with success when request is accepted", async () => {
		resetPasswordForEmailMock.mockResolvedValueOnce({ error: null });

		const request = new Request(
			"http://localhost/api/auth/email/forgot-password",
			{
				method: "POST",
				body: new URLSearchParams({
					email: "success@resend.dev",
					captcha_token: "test-captcha-token",
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
