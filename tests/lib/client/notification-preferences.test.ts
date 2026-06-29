import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCurrentNotificationPreferences } from "../../../src/lib/client/notification-preferences";
import { expectConsoleError } from "../../setup";

const { redirectToSignInMock } = vi.hoisted(() => ({
	redirectToSignInMock: vi.fn(),
}));

vi.mock("../../../src/lib/auth/session/session-expired", () => ({
	isUnauthorizedResponse: (response: Response) =>
		response.status === 401 || response.status === 403,
	redirectToSignIn: redirectToSignInMock,
}));

describe("Dashboard notification-preferences client helpers", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
		redirectToSignInMock.mockReset();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("Returns current notification preferences on a successful API response.", async () => {
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					ok: true,
					notificationPreferences: {
						timezone: "America/New_York",
						email_notifications_enabled: true,
					},
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		);

		const result = await fetchCurrentNotificationPreferences();

		expect(result).toEqual({
			timezone: "America/New_York",
			email_notifications_enabled: true,
		});
		expect(redirectToSignInMock).not.toHaveBeenCalled();
	});

	it("Redirects to sign-in when loading preferences returns unauthorized.", async () => {
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));

		const result = await fetchCurrentNotificationPreferences();

		expect(result).toBeNull();
		expect(redirectToSignInMock).toHaveBeenCalledTimes(1);
	});

	it("Returns null when loading preferences receives a non-OK response.", async () => {
		expectConsoleError(/^Failed to refresh notification-preferences/);
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ ok: false, message: "read_failed" }), {
				status: 500,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const result = await fetchCurrentNotificationPreferences();

		expect(result).toBeNull();
		expect(redirectToSignInMock).not.toHaveBeenCalled();
	});
});
