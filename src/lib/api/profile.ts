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
 */
export async function updateProfileTimezone(nextTimezone: string): Promise<TimezoneUpdate | null> {
	const formData = new FormData();
	formData.set("timezone", nextTimezone);

	const response = await fetch("/api/profile/timezone", {
		method: "POST",
		body: formData,
		credentials: "same-origin",
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(10_000),
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
