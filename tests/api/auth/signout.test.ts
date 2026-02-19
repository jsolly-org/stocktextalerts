import { describe, expect, it, vi } from "vitest";
import { GET, POST } from "../../../src/pages/api/auth/signout";
import { createApiContext } from "../../helpers/api-context";

describe("A signed-in user signs out of the app.", () => {
	it("The user is logged out, auth cookies are cleared, and they return to the home page.", async () => {
		const deleteSpy = vi.fn();
		const response = await POST(
			createApiContext({
				request: new Request("http://localhost/api/auth/signout", {
					method: "POST",
				}),
				onDeleteCookie: (name) => {
					deleteSpy(name);
				},
			}),
		);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/");

		const deleted = deleteSpy.mock.calls.map(([name]) => name);
		expect(deleted).toEqual(["sb-access-token", "sb-refresh-token"]);
	});

	it("When next is a valid path, the user is redirected there after sign-out.", async () => {
		const deleteSpy = vi.fn();
		const response = await POST(
			createApiContext({
				request: new Request(
					"http://localhost/api/auth/signout?next=/dashboard",
					{
						method: "POST",
					},
				),
				onDeleteCookie: (name) => {
					deleteSpy(name);
				},
			}),
		);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/dashboard");

		const deleted = deleteSpy.mock.calls.map(([name]) => name);
		expect(deleted).toEqual(["sb-access-token", "sb-refresh-token"]);
	});

	it("The signout confirmation page escapes next links in HTML attributes.", async () => {
		const response = await GET(
			createApiContext({
				request: new Request(
					"http://localhost/api/auth/signout?next=/%22%3E%3Cimg%20src=x%20onerror=alert(1)%3E",
				),
			}),
		);

		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain(
			`href="/&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"`,
		);
		expect(html).not.toContain(`<img src=x onerror=alert(1)>`);
	});
});
