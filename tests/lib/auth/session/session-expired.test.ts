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
					hash: "",
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

	it("Preserves hash fragments in the return path.", () => {
		globalThis.window.location.search = "";
		globalThis.window.location.hash = "#market-notifications";

		redirectToSignIn();

		expect(globalThis.window.location.href).toBe(
			"http://localhost/auth/signin?error=unauthorized&redirect=%2Fdashboard%23market-notifications",
		);
	});

	it("Preserves query strings and hash fragments together.", () => {
		globalThis.window.location.hash = "#daily-notifications";

		redirectToSignIn();

		expect(globalThis.window.location.href).toBe(
			"http://localhost/auth/signin?error=unauthorized&redirect=%2Fdashboard%3Ftab%3Dalerts%23daily-notifications",
		);
	});

	it("Omits redirect param when the user is already on the root path.", () => {
		globalThis.window.location.pathname = "/";
		globalThis.window.location.search = "";
		globalThis.window.location.hash = "";

		redirectToSignIn();

		expect(globalThis.window.location.href).toBe("http://localhost/auth/signin?error=unauthorized");
	});

	it("Preserves a root-path hash deep link.", () => {
		globalThis.window.location.pathname = "/";
		globalThis.window.location.search = "";
		globalThis.window.location.hash = "#section";

		redirectToSignIn();

		expect(globalThis.window.location.href).toBe(
			"http://localhost/auth/signin?error=unauthorized&redirect=%2F%23section",
		);
	});

	it("Treats 401 and 403 as unauthorized, and ignores other statuses.", () => {
		expect(isUnauthorizedResponse(new Response(null, { status: 401 }))).toBe(true);
		expect(isUnauthorizedResponse(new Response(null, { status: 403 }))).toBe(true);
		expect(isUnauthorizedResponse(new Response(null, { status: 200 }))).toBe(false);
		expect(isUnauthorizedResponse(new Response(null, { status: 422 }))).toBe(false);
	});
});
