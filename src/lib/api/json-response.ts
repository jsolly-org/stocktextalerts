/**
 * Build a JSON Response with a normalized payload shape and HTTP status.
 *
 * @param status - HTTP status code (e.g. 200, 400, 401, 500)
 * @param payload - Object with ok, message, and optional extra fields (e.g. tone, notificationPreferences)
 * @returns Response suitable for Astro APIRoute handlers
 */
export function jsonResponse(
	status: number,
	payload: { ok: boolean; message: string } & Record<string, unknown>,
): Response {
	return Response.json(payload, { status });
}
