import type { APIContext } from "astro";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../src/pages/api/auth/update-email";

const { getCurrentUserMock, updateUserMock } = vi.hoisted(() => {
	return {
		getCurrentUserMock: vi.fn(),
		updateUserMock: vi.fn(),
	};
});

vi.mock("../../src/lib/db", () => ({
	createUserService: () => ({
		getCurrentUser: getCurrentUserMock,
	}),
}));

vi.mock("../../src/lib/db/supabase", () => ({
	createSupabaseServerClient: () => ({
		auth: {
			updateUser: updateUserMock,
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

describe("POST /api/auth/update-email", () => {
	beforeEach(() => {
		getCurrentUserMock.mockReset();
		updateUserMock.mockReset();
	});

	it("redirects to signin when unauthenticated", async () => {
		getCurrentUserMock.mockResolvedValueOnce(null);

		const request = new Request("http://localhost/api/auth/update-email", {
			method: "POST",
			body: new URLSearchParams({ email: "new@example.com" }),
		});

		const response = await POST({
			request,
			redirect: toRedirect,
		} as APIContext);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(
			"/auth/signin?error=unauthorized",
		);
	});

	it("redirects to profile after successful request", async () => {
		getCurrentUserMock.mockResolvedValueOnce({
			id: "user-id",
		});
		updateUserMock.mockResolvedValueOnce({ error: null });

		const request = new Request("http://localhost/api/auth/update-email", {
			method: "POST",
			body: new URLSearchParams({ email: "  new@example.com " }),
		});

		const response = await POST({
			request,
			redirect: toRedirect,
		} as APIContext);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(
			"/profile?success=email_change_requested",
		);
		expect(updateUserMock).toHaveBeenCalledWith(
			{ email: "new@example.com" },
			{ emailRedirectTo: "http://localhost/auth/verified" },
		);
	});
});
