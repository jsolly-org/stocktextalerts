export type TimezoneUpdatePreferences = {
	timezone?: string;
	next_send_at?: string | null;
};

export async function updateTimezonePreference(
	nextTimezone: string,
): Promise<TimezoneUpdatePreferences | null> {
	const formData = new FormData();
	formData.set("timezone", nextTimezone);

	const response = await fetch("/api/preferences/timezone", {
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
		preferences?: TimezoneUpdatePreferences;
	};
	if (!payload.ok) {
		return null;
	}

	return payload.preferences ?? {};
}
