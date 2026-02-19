export function jsonResponse(
	status: number,
	payload: { ok: boolean; message: string } & Record<string, unknown>,
): Response {
	return Response.json(payload, { status });
}
