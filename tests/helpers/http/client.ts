type CookieJar = Map<string, string>;

type FormPostOptions = {
	path: string;
	fields: Record<string, string>;
	cookies?: CookieJar;
	origin?: string;
};

function cookieHeader(jar: CookieJar): string {
	return Array.from(jar.entries())
		.map(([name, value]) => `${name}=${value}`)
		.join("; ");
}

/** Merge Set-Cookie headers from a fetch response into a cookie jar. */
function absorbSetCookies(jar: CookieJar, response: Response): CookieJar {
	const merged = new Map(jar);
	const setCookies =
		typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
	for (const setCookie of setCookies) {
		const pair = setCookie.split(";")[0];
		if (!pair) continue;
		const separator = pair.indexOf("=");
		if (separator <= 0) continue;
		const name = pair.slice(0, separator).trim();
		const value = pair.slice(separator + 1).trim();
		merged.set(name, value);
	}
	return merged;
}

/** POST application/x-www-form-urlencoded data like a browser form submit. */
export async function postForm(
	baseUrl: string,
	options: FormPostOptions,
): Promise<{ response: Response; cookies: CookieJar }> {
	const jar = new Map(options.cookies ?? []);
	const origin = options.origin ?? baseUrl;
	const response = await fetch(`${baseUrl}${options.path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Origin: origin,
			...(jar.size > 0 ? { Cookie: cookieHeader(jar) } : {}),
		},
		body: new URLSearchParams(options.fields),
		redirect: "manual",
	});
	return {
		response,
		cookies: absorbSetCookies(jar, response),
	};
}

export function locationPath(response: Response): string | null {
	const location = response.headers.get("Location");
	if (!location) return null;
	return location.startsWith("http")
		? new URL(location).pathname + new URL(location).search
		: location;
}
