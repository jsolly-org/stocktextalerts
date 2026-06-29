import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	isUnauthorizedResponse,
	redirectToSignIn,
} from "../../../../src/lib/auth/session/session-expired";

describe("Session-expired helpers guide users back to sign-in safely.", () => {
	const originalWindow = globalThis.window;

	beforeEach(() => {
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: {
				location: {
					pathname: "/dashboard",
					search: "?tab=alerts",
					origin: "http://localhost",
					href: "",
				},
			},
		});
	});

	afterEach(() => {
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: originalWindow,
		});
	});

	it("Redirects to sign-in and preserves the current return path.", () => {
		redirectToSignIn();

		expect(globalThis.window.location.href).toBe(
			"http://localhost/auth/signin?error=unauthorized&redirect=%2Fdashboard%3Ftab%3Dalerts",
		);
	});

	it("Omits redirect param when the user is already on the root path.", () => {
		globalThis.window.location.pathname = "/";
		globalThis.window.location.search = "";

		redirectToSignIn();

		expect(globalThis.window.location.href).toBe("http://localhost/auth/signin?error=unauthorized");
	});

	it("Treats 401 and 403 as unauthorized, and ignores other statuses.", () => {
		expect(isUnauthorizedResponse(new Response(null, { status: 401 }))).toBe(true);
		expect(isUnauthorizedResponse(new Response(null, { status: 403 }))).toBe(true);
		expect(isUnauthorizedResponse(new Response(null, { status: 200 }))).toBe(false);
		expect(isUnauthorizedResponse(new Response(null, { status: 422 }))).toBe(false);
	});
});
