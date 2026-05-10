import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateProfileTimezone } from "../../../src/lib/api/profile";

const { redirectToSignInMock } = vi.hoisted(() => ({
	redirectToSignInMock: vi.fn(),
}));

vi.mock("../../../src/lib/auth/session-expired", () => ({
	isUnauthorizedResponse: (response: Response) =>
		response.status === 401 || response.status === 403,
	redirectToSignIn: redirectToSignInMock,
}));

describe("Profile timezone client helper", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
		redirectToSignInMock.mockReset();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("Returns updated timezone scheduling data on success.", async () => {
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					ok: true,
					notificationPreferences: {
						timezone: "America/Chicago",
						market_scheduled_asset_price_next_send_at: "2026-01-14T15:00:00.000Z",
					},
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		);

		const result = await updateProfileTimezone("America/Chicago");

		expect(result).toEqual({
			timezone: "America/Chicago",
			market_scheduled_asset_price_next_send_at: "2026-01-14T15:00:00.000Z",
		});
		expect(redirectToSignInMock).not.toHaveBeenCalled();
	});

	it("Redirects to sign-in when timezone update is unauthorized.", async () => {
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));

		const result = await updateProfileTimezone("America/Chicago");

		expect(result).toBeNull();
		expect(redirectToSignInMock).toHaveBeenCalledTimes(1);
	});

	it("Returns null without redirecting when the server responds with 500.", async () => {
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ ok: false, message: "internal_error" }), {
				status: 500,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const result = await updateProfileTimezone("America/Chicago");

		expect(result).toBeNull();
		expect(redirectToSignInMock).not.toHaveBeenCalled();
	});
});
