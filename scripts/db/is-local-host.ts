const LOCAL_HOSTS = new Set([
	"localhost",
	"127.0.0.1",
	"::1",
	"0.0.0.0",
	"host.docker.internal",
]);

function normalizeHost(input: string): string {
	let host = input.trim().toLowerCase();
	if (!host) return "";

	if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) {
		try {
			host = new URL(host).hostname.toLowerCase();
		} catch {
			// If it's not a valid URL, treat it as a raw host string.
		}
	}

	host = host.split("/")[0]?.split("?")[0]?.split("#")[0] ?? host;

	const atIndex = host.lastIndexOf("@");
	if (atIndex !== -1) host = host.slice(atIndex + 1);

	if (host.startsWith("[") && host.includes("]")) {
		host = host.slice(1, host.indexOf("]"));
	} else {
		const colonCount = host.split(":").length - 1;
		if (colonCount === 1) host = host.split(":")[0] ?? host;
	}

	if (host.endsWith(".")) host = host.slice(0, -1);

	return host;
}

export function isLocalHost(host: string): boolean {
	return LOCAL_HOSTS.has(normalizeHost(host));
}
