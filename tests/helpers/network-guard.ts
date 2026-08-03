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
 * Scope: `globalThis.fetch`, which is what every vendor client in `src/lib/vendors` and
 * every logo path uses. The AWS SDK talks over `node:http` and is not covered, but it is
 * inert in tests anyway (SQS no-ops without `VENDOR_BACKFILL_QUEUE_URL`, SES is never
 * reached because `MODE=test` email routes to Mailpit over SMTP).
 */

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

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
	return LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost");
}

/**
 * Replace `globalThis.fetch` with a guard that rejects non-local requests.
 *
 * Returns the restore function. Specs that install their own `fetch` double (`vi.spyOn`,
 * `vi.stubGlobal`) replace the guard for their duration, which is fine: a double does not
 * reach the network either.
 */
export function installNetworkGuard(context: string): () => void {
	const original = globalThis.fetch;

	const guarded: typeof globalThis.fetch = async (input, init) => {
		if (!isLocalRequest(input)) {
			throw new Error(
				[
					`Blocked outbound request to ${requestUrl(input)} from ${context}.`,
					"Tests must not reach third-party APIs. Fix one of these:",
					"  - mock the module in the spec (vi.mock / vi.spyOn),",
					"  - route the call through a vendor module that astro.config.ts aliases to a",
					"    MODE=test stub (src/lib/vendors/massive.ts, finnhub.ts, http.ts),",
					"  - or, if the point of the test IS the live provider, name it *.live.test.ts",
					"    (excluded from the default run; see vitest.config.ts).",
				].join("\n"),
			);
		}
		return original(input, init);
	};

	globalThis.fetch = guarded;

	return () => {
		if (globalThis.fetch === guarded) {
			globalThis.fetch = original;
		}
	};
}
