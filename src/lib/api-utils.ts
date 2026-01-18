/* =============
Redirect helper
============= */

export function redirect(url: string, status = 302): Response {
	return new Response(null, {
		status,
		headers: {
			Location: url,
		},
	});
}
