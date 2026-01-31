import type { APIContext } from "astro";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../src/pages/api/auth/update-password";
import { allowConsoleErrors } from "../setup";

const { updateUserByIdMock, verifySupabaseOtpMock } = vi.hoisted(() => {
	return {
		updateUserByIdMock: vi.fn(),
		verifySupabaseOtpMock: vi.fn(),
	};
});

vi.mock("../../src/lib/auth/supabase-otp", () => ({
	verifySupabaseOtp: verifySupabaseOtpMock,
}));

vi.mock("../../src/lib/db/supabase", () => ({
	createSupabaseServerClient: () => ({}),
	createSupabaseAdminClient: () => ({
		auth: {
			admin: {
				updateUserById: updateUserByIdMock,
			},
		},
	}),
}));

const toRedirect = (url: string, status = 302) =>
	new Response(null, {
		status,
		headers: { Location: url },
	});

const TEST_PASSWORD = "NewPassword123!";

describe("POST /api/auth/update-password", () => {
	beforeEach(() => {
		updateUserByIdMock.mockReset();
		verifySupabaseOtpMock.mockReset();
	});
	it("redirects with invalid_form when form validation fails", async () => {
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
		} as APIContext);

		expect(response.status).toBe(303);
		const location = response.headers.get("Location");
		expect(location).toContain("/auth/recover?");
		expect(location).toContain("error=invalid_form");
		expect(location).toContain("type=recovery");
	});

	it("redirects with password_mismatch when passwords do not match", async () => {
		const request = new Request("http://localhost/api/auth/update-password", {
			method: "POST",
			body: new URLSearchParams({
				password: "Mismatch123!",
				confirm: "Different123!",
				token_hash: "token_hash_value",
			}),
		});

		const response = await POST({
			request,
			redirect: toRedirect,
		} as APIContext);

		expect(response.status).toBe(303);
		const location = response.headers.get("Location");
		expect(location).toContain("error=password_mismatch");
		expect(location).toContain("token_hash=token_hash_value");
	});

	it("redirects with expired when token is expired", async () => {
		verifySupabaseOtpMock.mockResolvedValueOnce({
			data: { user: null },
			error: { code: "otp_expired", message: "expired" },
		});

		const request = new Request("http://localhost/api/auth/update-password", {
			method: "POST",
			body: new URLSearchParams({
				password: TEST_PASSWORD,
				confirm: TEST_PASSWORD,
				token_hash: "expired_token_hash",
			}),
		});

		const response = await POST({
			request,
			redirect: toRedirect,
		} as APIContext);

		expect(response.status).toBe(303);
		const location = response.headers.get("Location");
		expect(location).toContain("error=expired");
		expect(location).toContain("token_hash=expired_token_hash");
	});

	it("redirects with weak_password when Supabase rejects update", async () => {
		allowConsoleErrors();
		verifySupabaseOtpMock.mockResolvedValueOnce({
			data: { user: { id: "user-id" } },
			error: null,
		});
		updateUserByIdMock.mockResolvedValueOnce({
			error: { code: "weak_password", message: "weak password" },
		});

		const request = new Request("http://localhost/api/auth/update-password", {
			method: "POST",
			body: new URLSearchParams({
				password: TEST_PASSWORD,
				confirm: TEST_PASSWORD,
				token_hash: "token_hash_value",
			}),
		});

		const response = await POST({
			request,
			redirect: toRedirect,
		} as APIContext);

		expect(response.status).toBe(303);
		const location = response.headers.get("Location");
		expect(location).toContain("error=weak_password");
		expect(location).toContain("type=recovery");
		expect(location).not.toContain("token_hash=");
	});

	it("redirects to signin after successful reset", async () => {
		verifySupabaseOtpMock.mockResolvedValueOnce({
			data: { user: { id: "user-id" } },
			error: null,
		});
		updateUserByIdMock.mockResolvedValueOnce({ error: null });

		const request = new Request("http://localhost/api/auth/update-password", {
			method: "POST",
			body: new URLSearchParams({
				password: TEST_PASSWORD,
				confirm: TEST_PASSWORD,
				token_hash: "valid_token_hash",
			}),
		});

		const response = await POST({
			request,
			redirect: toRedirect,
		} as APIContext);

		expect(response.status).toBe(303);
		expect(response.headers.get("Location")).toBe(
			"/auth/signin?success=password_reset",
		);
	});
});
