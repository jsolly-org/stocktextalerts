import { rootLogger } from "../logging";

export type CurrentPreferences = {
	email_notifications_enabled: boolean;
	sms_notifications_enabled: boolean;
	sms_opted_out: boolean;
	phone_verified: boolean;
	timezone: string;
	daily_digest_enabled: boolean;
	daily_digest_notification_time: number;
	next_send_at: string | null;
	dismiss_timezone_mismatch_prompts: boolean;
};

export async function fetchCurrentPreferences(): Promise<CurrentPreferences | null> {
	try {
		const response = await fetch("/api/preferences/current", {
			method: "GET",
			credentials: "same-origin",
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(10_000),
		});

		if (!response.ok) {
			return null;
		}

		const payload = (await response.json()) as {
			ok: boolean;
			preferences?: CurrentPreferences;
		};
		return payload.preferences ?? null;
	} catch (error) {
		rootLogger.warn("Failed to refresh preferences", {
			action: "refresh_preferences",
			error,
		});
		return null;
	}
}
