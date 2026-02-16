import type { APIContext } from "astro";
import { describe, expect, it, vi } from "vitest";
import { GET, POST } from "../../../src/pages/api/auth/signout";

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

	it("When next is a valid path, the user is redirected there after sign-out.", async () => {
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
			url: new URL("https://example.com/api/auth/signout?next=/dashboard"),
		} as unknown as APIContext);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/dashboard");

		const deleted = deleteSpy.mock.calls.map(([name]) => name);
		expect(deleted).toEqual(["sb-access-token", "sb-refresh-token"]);
	});

	it("The signout confirmation page escapes next links in HTML attributes.", async () => {
		const response = await GET({
			url: new URL(
				"https://example.com/api/auth/signout?next=/%22%3E%3Cimg%20src=x%20onerror=alert(1)%3E",
			),
		} as unknown as APIContext);

		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain(
			`href="/&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"`,
		);
		expect(html).not.toContain(`<img src=x onerror=alert(1)>`);
	});
});
