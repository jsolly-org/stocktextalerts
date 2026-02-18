import type { APIContext } from "astro";

type CookieMap = Map<string, string>;

type CookieAdapterOptions = {
	cookies?: CookieMap;
	onDelete?: (name: string, options?: unknown) => void;
	onSet?: (name: string, value: string, options?: unknown) => void;
};

/**
 * Build an Astro-compatible cookie adapter backed by an in-memory Map.
 *
 * This keeps API route tests concise while preserving cookie behavior used by
 * auth/session handlers.
 */
export function createCookieAdapter(
	options: CookieAdapterOptions = {},
): APIContext["cookies"] {
	const cookieStore = options.cookies ?? new Map<string, string>();

	return {
		get(name: string) {
			const value = cookieStore.get(name);
			return value ? { value } : undefined;
		},
		has(name: string) {
			return cookieStore.has(name);
		},
		set(name: string, value: string, cookieOptions?: unknown) {
			cookieStore.set(name, value);
			options.onSet?.(name, value, cookieOptions);
		},
		delete(name: string, cookieOptions?: unknown) {
			cookieStore.delete(name);
			options.onDelete?.(name, cookieOptions);
		},
	} as unknown as APIContext["cookies"];
}

type ApiContextOptions = {
	request: Request;
	cookies?: CookieMap;
	locals?: Record<string, unknown>;
	redirect?: (path: string, status?: number) => Response;
	onDeleteCookie?: (name: string, options?: unknown) => void;
	onSetCookie?: (name: string, value: string, options?: unknown) => void;
};

/**
 * Build a minimal APIContext object for direct APIRoute invocation in tests.
 */
export function createApiContext(options: ApiContextOptions): APIContext {
	const request = options.request;
	const cookies = createCookieAdapter({
		cookies: options.cookies,
		onDelete: options.onDeleteCookie,
		onSet: options.onSetCookie,
	});
	const redirect =
		options.redirect ??
		((path: string, status = 302) =>
			new Response(null, {
				status,
				headers: { Location: path },
			}));

	return {
		request,
		cookies,
		locals: {
			requestId: "test-request-id",
			...(options.locals ?? {}),
		},
		redirect,
		url: new URL(request.url),
	} as unknown as APIContext;
}

/**
 * Build a form POST Request for API route tests.
 */
export function createFormPostRequest(
	path: string,
	formData: FormData,
): Request {
	return new Request(`http://localhost${path}`, {
		method: "POST",
		body: formData,
		headers: { Accept: "application/json" },
	});
}

/**
 * Build a JSON Request for API route tests.
 */
export function createJsonRequest(
	path: string,
	method: "POST" | "PUT" | "PATCH",
	body: unknown,
): Request {
	return new Request(`http://localhost${path}`, {
		method,
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify(body),
	});
}
