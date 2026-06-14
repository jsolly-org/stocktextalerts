import { isUnauthorizedResponse, redirectToSignIn } from "../auth/session-expired";

type TimezoneUpdate = {
	timezone?: string;
	market_scheduled_asset_price_next_send_at?: string | null;
	daily_digest_next_send_at?: string | null;
	asset_events_next_send_at?: string | null;
};

/**
 * Update the user's timezone and return any derived scheduling fields the server updated.
 *
 * Returns `null` on failure; redirects to sign-in when the session is unauthorized.
 *
 * An optional `signal` lets a caller abort the request (e.g. a save sequencer
 * superseding it). It is combined with the built-in 10s timeout, so whichever
 * fires first cancels the fetch.
 */
export async function updateProfileTimezone(
	nextTimezone: string,
	signal?: AbortSignal,
): Promise<TimezoneUpdate | null> {
	const formData = new FormData();
	formData.set("timezone", nextTimezone);

	const timeoutSignal = AbortSignal.timeout(10_000);
	const response = await fetch("/api/profile/timezone", {
		method: "POST",
		body: formData,
		credentials: "same-origin",
		headers: { Accept: "application/json" },
		signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
	});

	if (!response.ok) {
		if (isUnauthorizedResponse(response)) {
			redirectToSignIn();
			return null;
		}
		return null;
	}

	const payload = (await response.json()) as {
		ok: boolean;
		notificationPreferences?: TimezoneUpdate;
	};
	if (!payload.ok) {
		return null;
	}

	if (payload.notificationPreferences == null) {
		return null;
	}

	return payload.notificationPreferences;
}
