type TimezoneUpdateNotificationPreferences = {
	timezone?: string;
	next_send_at?: string | null;
};

export async function updateNotificationTimezonePreference(
	nextTimezone: string,
): Promise<TimezoneUpdateNotificationPreferences | null> {
	const formData = new FormData();
	formData.set("timezone", nextTimezone);

	const response = await fetch("/api/notification-preferences/timezone", {
		method: "POST",
		body: formData,
		credentials: "same-origin",
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(10_000),
	});

	if (!response.ok) {
		return null;
	}

	const payload = (await response.json()) as {
		ok: boolean;
		notificationPreferences?: TimezoneUpdateNotificationPreferences;
	};
	if (!payload.ok) {
		return null;
	}

	if (payload.notificationPreferences == null) {
		return null;
	}

	return payload.notificationPreferences;
}
