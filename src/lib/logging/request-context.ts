import { AsyncLocalStorage } from "node:async_hooks";
import { bindAmbientRequestId } from "./index";

const requestStore = new AsyncLocalStorage<{ requestId: string }>();

bindAmbientRequestId(() => requestStore.getStore()?.requestId);

/**
 * Run `fn` with `requestId` available to every logger call inside it (including async work).
 * Import from this module in Lambda handlers only — not in browser bundles.
 */
export function runWithRequestContext<T>(requestId: string, fn: () => T): T {
	return requestStore.run({ requestId }, fn);
}
