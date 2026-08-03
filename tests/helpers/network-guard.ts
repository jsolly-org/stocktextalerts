/**
 * Blocks outbound requests to anything that is not the local stack.
 *
 * The rule this enforces: `tests/**\/*.live.test.ts` and the deployed
 * `stocktextalerts-live-provider-check` Lambda are the only things allowed to talk to a
 * third-party API. Everything else runs against a mock, a `MODE=test` module stub, or the
 * local Supabase/Mailpit stack.
 *
 * That rule was already the intent, but nothing enforced it, so it drifted: the dashboard
 * logo proxy and the icon probe called `fetch` directly instead of going through a vendor
 * module, and every E2E run made live calls to `api.massive.com` with the CI placeholder
 * key. A convention that only holds while everyone remembers it is not a guarantee. This
 * turns the next escape into an immediate, explicit test failure instead of silent traffic
 * that only shows up when the vendor is slow.
 *
 * Scope: `globalThis.fetch` (every vendor client and logo path) plus `request`/`get` on
 * `node:http` and `node:https`, which is what SDKs that predate fetch use. The AWS SDK is
 * the one that matters here, and it reads `node_https.request` off the namespace at call
 * time, so it sees the patch.
 *
 * Known gap, worth stating rather than pretending otherwise: a module that destructured
 * `import { request } from "node:http"` before the guard installed keeps the original
 * binding, because Node snapshots builtin named exports at import time. Namespace access
 * (`http.request(...)`, `require("node:http").request(...)`) is patched. Anything that
 * bypasses both and opens its own socket is out of scope; the local stack is reached over
 * fetch (Supabase, Mailpit) and raw TCP (`pg`), so neither is affected either way.
 */

import http from "node:http";
import https from "node:https";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

function isLocalHostname(hostname: string): boolean {
	return LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost");
}

function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

/** True for the local stack (Supabase, Mailpit, the test dev server) and relative URLs. */
function isLocalRequest(input: RequestInfo | URL): boolean {
	let hostname: string;
	try {
		hostname = new URL(requestUrl(input)).hostname;
	} catch {
		// Not absolute: a same-origin path, which cannot reach a third party.
		return true;
	}
	return isLocalHostname(hostname);
}

function blockedError(target: string, context: string): Error {
	return new Error(
		[
			`Blocked outbound request to ${target} from ${context}.`,
			"Tests must not reach third-party APIs. Fix one of these:",
			"  - mock the module in the spec (vi.mock / vi.spyOn),",
			"  - route the call through a vendor module that astro.config.ts aliases to a",
			"    MODE=test stub (src/lib/vendors/massive.ts, finnhub.ts, http.ts),",
			"  - or, if the point of the test IS the live provider, name it *.live.test.ts",
			"    (excluded from the default run; see vitest.config.ts).",
		].join("\n"),
	);
}

/** Strip the port and IPv6 brackets from an `options.host` style value. */
function normalizeHost(host: string): string {
	const unbracketed = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
	return (unbracketed ?? host).toLowerCase();
}

/**
 * Resolve the hostname a `http.request(...)` call will dial, or null when it defaults to
 * localhost. Node merges a url argument with an options argument, options winning.
 */
function nodeRequestHostname(args: unknown[]): string | null {
	let fromUrl: string | null = null;
	let options: { hostname?: unknown; host?: unknown } | null = null;

	for (const arg of args.slice(0, 2)) {
		if (typeof arg === "string") {
			try {
				fromUrl = new URL(arg).hostname;
			} catch {
				fromUrl = null;
			}
		} else if (arg instanceof URL) {
			fromUrl = arg.hostname;
		} else if (arg !== null && typeof arg === "object") {
			options = arg as { hostname?: unknown; host?: unknown };
		}
	}

	const explicit = options?.hostname ?? options?.host;
	if (typeof explicit === "string" && explicit.length > 0) {
		return normalizeHost(explicit);
	}
	return fromUrl;
}

type NodeRequestFn = (...args: unknown[]) => unknown;
type NodeHttpModule = typeof http | typeof https;

function patchNodeRequest(
	nodeModule: NodeHttpModule,
	key: "request" | "get",
	context: string,
): () => void {
	const original = nodeModule[key] as unknown as NodeRequestFn;

	const patched = ((...args: unknown[]) => {
		const hostname = nodeRequestHostname(args);
		// A null hostname means Node defaults to localhost, which is allowed.
		if (hostname !== null && !isLocalHostname(hostname)) {
			throw blockedError(hostname, context);
		}
		return original(...args);
	}) as unknown as NodeHttpModule[typeof key];

	nodeModule[key] = patched;

	return () => {
		if (nodeModule[key] === patched) {
			nodeModule[key] = original as unknown as NodeHttpModule[typeof key];
		}
	};
}

/**
 * Install the guard over `fetch` and the `node:http` / `node:https` request entry points.
 *
 * Returns the restore function. Specs that install their own `fetch` double (`vi.spyOn`,
 * `vi.stubGlobal`) replace the guard for their duration, which is fine: a double does not
 * reach the network either.
 */
export function installNetworkGuard(context: string): () => void {
	const originalFetch = globalThis.fetch;

	const guardedFetch: typeof globalThis.fetch = async (input, init) => {
		if (!isLocalRequest(input)) {
			throw blockedError(requestUrl(input), context);
		}
		return originalFetch(input, init);
	};

	globalThis.fetch = guardedFetch;

	const restoreNodeRequests = [
		patchNodeRequest(http, "request", context),
		patchNodeRequest(http, "get", context),
		patchNodeRequest(https, "request", context),
		patchNodeRequest(https, "get", context),
	];

	return () => {
		if (globalThis.fetch === guardedFetch) {
			globalThis.fetch = originalFetch;
		}
		for (const restore of restoreNodeRequests) {
			restore();
		}
	};
}
