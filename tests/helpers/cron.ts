/**
 * Build a cron-authenticated request for API route tests.
 */
export function createCronRequest(options: {
	path: string;
	cronSecret: string;
	method?: "GET" | "POST";
	body?: unknown;
}): Request {
	const method = options.method ?? "POST";
	const hasJsonBody =
		options.body !== undefined && method !== "GET" && method !== "HEAD";

	return new Request(`http://localhost${options.path}`, {
		method,
		headers: {
			Authorization: `Bearer ${options.cronSecret}`,
			...(hasJsonBody ? { "Content-Type": "application/json" } : {}),
		},
		...(hasJsonBody ? { body: JSON.stringify(options.body) } : {}),
	});
}
