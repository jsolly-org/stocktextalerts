import { AsYouType } from "libphonenumber-js";

/**
 * Formats a phone number for display (e.g. "+1 (279) 321-2870").
 * US numbers (+1, 10 national digits) are formatted with AsYouType; others are shown as country code + national digits.
 */
export function formatPhoneForDisplay(
	countryCode: string,
	nationalNumber: string,
): string {
	if (!countryCode || !nationalNumber) {
		return "";
	}
	if (countryCode === "+1" && /^\d{10}$/.test(nationalNumber)) {
		const formattedNational = new AsYouType("US").input(nationalNumber);
		return `${countryCode} ${formattedNational}`;
	}
	return `${countryCode} ${nationalNumber}`;
}
