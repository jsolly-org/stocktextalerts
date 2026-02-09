/**
 * Helper to return a normalized JSON `Response` with an HTTP status code.
 */
export function jsonResponse(
	status: number,
	payload: { ok: boolean; message: string } & Record<string, unknown>,
): Response {
	return Response.json(payload, { status });
}
