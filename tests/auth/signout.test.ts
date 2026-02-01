import type { APIContext } from "astro";
import { describe, expect, it, vi } from "vitest";
import { POST } from "../../src/pages/api/auth/signout";

describe("A signed-in user signs out of the app.", () => {
	it("The user is logged out, auth cookies are cleared, and they return to the home page.", async () => {
		const deleteSpy = vi.fn();
		const response = await POST({
			cookies: {
				delete: deleteSpy,
			},
			redirect: (url: string) =>
				new Response(null, {
					status: 302,
					headers: { Location: url },
				}),
		} as unknown as APIContext);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/");

		const deleted = deleteSpy.mock.calls.map(([name]) => name);
		expect(deleted).toEqual(["sb-access-token", "sb-refresh-token"]);
	});
});
