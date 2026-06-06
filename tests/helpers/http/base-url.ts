import { ensureHttpTestServer } from "./server";

let baseUrlPromise: Promise<string> | null = null;

/** Shared base URL for all api-http specs in the current Vitest worker. */
export function getHttpTestBase(): Promise<string> {
	if (!baseUrlPromise) {
		baseUrlPromise = ensureHttpTestServer();
	}
	return baseUrlPromise;
}
