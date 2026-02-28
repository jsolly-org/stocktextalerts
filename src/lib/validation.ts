/**
 * UUID format validation (RFC 4122 structure).
 * Use before DB lookups to reject malformed input and avoid injection edge cases.
 */
const UUID_REGEX =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidUuid(value: string | null | undefined): value is string {
	return typeof value === "string" && UUID_REGEX.test(value);
}
