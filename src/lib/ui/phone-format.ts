import { parsePhoneNumberFromString } from "libphonenumber-js";

export function formatPhoneForDisplay(
	phone: string | null | undefined,
	options?: {
		countryCode?: string | null | undefined;
		fallbackRegion?: import("libphonenumber-js").CountryCode;
	},
): string | null {
	if (!phone) {
		return null;
	}

	const trimmed = phone.trim();

	if (!trimmed) {
		return null;
	}

	const digitsOnly = trimmed.replace(/\D/g, "");
	const fallbackRegion = options?.fallbackRegion ?? "US";

	const attempts: Array<() => string | null> = [];

	if (options?.countryCode) {
		attempts.push(() => {
			const combined = `${options.countryCode as string}${digitsOnly}`;
			const parsed = parsePhoneNumberFromString(combined);
			return parsed ? parsed.formatNational() : null;
		});
	}

	attempts.push(() => {
		const parsed = parsePhoneNumberFromString(digitsOnly, fallbackRegion);
		return parsed ? parsed.formatNational() : null;
	});

	for (const attempt of attempts) {
		try {
			const formatted = attempt();
			if (formatted) {
				return formatted;
			}
		} catch {
			// ignore and try next strategy
		}
	}

	return trimmed;
}
