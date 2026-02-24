import { AsYouType, parsePhoneNumberFromString } from "libphonenumber-js";

/**
 * Format a phone number for display given a country code and national number.
 *
 * US numbers (`+1`) are formatted using `AsYouType`; other numbers are returned as-is with the
 * country code prefix.
 */
export function formatPhoneForDisplay(
	countryCode: string,
	nationalNumber: string,
): string {
	if (!countryCode || !nationalNumber) {
		return "";
	}
	if (countryCode === "+1" && /^\d{10}$/.test(nationalNumber)) {
		// US numbers (+1, 10 digits) use AsYouType; others show country code + national digits.
		const formattedNational = new AsYouType("US").input(nationalNumber);
		return `${countryCode} ${formattedNational}`;
	}
	return `${countryCode} ${nationalNumber}`;
}

/**
 * Format an E.164 phone string for display. Returns the raw string if parsing fails.
 */
export function formatPhoneFromE164(raw: string): string {
	if (!raw?.trim()) return "";
	const parsed = parsePhoneNumberFromString(raw);
	if (!parsed) return raw;
	return formatPhoneForDisplay(
		`+${parsed.countryCallingCode}`,
		String(parsed.nationalNumber),
	);
}
