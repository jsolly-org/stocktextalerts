import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	fetchCurrentNotificationPreferences,
	updateNotificationTimezonePreference,
} from "../../../src/lib/api/notification-preferences";
import { expectConsoleError } from "../../setup";

const { redirectToSignInMock } = vi.hoisted(() => ({
	redirectToSignInMock: vi.fn(),
}));

vi.mock("../../../src/lib/auth/session-expired", () => ({
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

	it("Returns updated timezone scheduling data on success.", async () => {
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					ok: true,
					notificationPreferences: {
						timezone: "America/Chicago",
						market_scheduled_asset_price_next_send_at:
							"2026-01-14T15:00:00.000Z",
					},
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		);

		const result =
			await updateNotificationTimezonePreference("America/Chicago");

		expect(result).toEqual({
			timezone: "America/Chicago",
			market_scheduled_asset_price_next_send_at: "2026-01-14T15:00:00.000Z",
		});
		expect(redirectToSignInMock).not.toHaveBeenCalled();
	});

	it("Redirects to sign-in when timezone update is unauthorized.", async () => {
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));

		const result =
			await updateNotificationTimezonePreference("America/Chicago");

		expect(result).toBeNull();
		expect(redirectToSignInMock).toHaveBeenCalledTimes(1);
	});
});
