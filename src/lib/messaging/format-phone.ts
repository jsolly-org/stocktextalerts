import { AsYouType, parsePhoneNumberFromString } from "libphonenumber-js";

export function formatPhoneForDisplay(countryCode: string, nationalNumber: string): string {
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

export function formatPhoneFromE164(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	const parsed = parsePhoneNumberFromString(trimmed, { extract: false });
	if (!parsed) return trimmed;
	return formatPhoneForDisplay(`+${parsed.countryCallingCode}`, String(parsed.nationalNumber));
}
