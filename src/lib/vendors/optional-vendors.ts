import { rootLogger } from "../logging";
import {
	OPTIONAL_VENDOR_CIRCUIT_FAILURE_THRESHOLD,
	OPTIONAL_VENDOR_CIRCUIT_OPEN_MS,
} from "./constants";
import {
	type CircuitState,
	optionalVendorCircuits,
	optionalVendorSkipState,
} from "./optional-vendor-circuit-store";

/** Log category for optional vendor work skipped without paging. */
export const OPTIONAL_VENDOR_DEGRADED_CATEGORY = "optional_vendor_degraded";

type OptionalVendorSkipReason = "circuit_open" | "budget_exceeded" | "unavailable";

type OptionalVendorResult<T> =
	| { status: "ok"; value: T }
	| { status: "skipped"; reason: OptionalVendorSkipReason };

function recordOptionalVendorSkip(): void {
	optionalVendorSkipState.count += 1;
}

/** Count a skip outside `withOptionalVendorBudget` (e.g. circuit check before fetch). */
export function noteOptionalVendorSkip(): void {
	recordOptionalVendorSkip();
}

/** Optional vendor skips this scheduler invocation (resets after read). */
export function getAndResetOptionalVendorSkipCount(): number {
	const count = optionalVendorSkipState.count;
	optionalVendorSkipState.count = 0;
	return count;
}

function getCircuit(label: string): CircuitState {
	let state = optionalVendorCircuits.get(label);
	if (!state) {
		state = { failures: 0, openUntilMs: 0 };
		optionalVendorCircuits.set(label, state);
	}
	return state;
}

/** True when the in-process circuit is open for this optional vendor label. */
export function isOptionalVendorUnavailable(label: string): boolean {
	const state = getCircuit(label);
	return Date.now() < state.openUntilMs;
}

/** Record a successful optional vendor call; clears failure streak. */
export function recordOptionalVendorSuccess(label: string): void {
	const state = getCircuit(label);
	state.failures = 0;
	state.openUntilMs = 0;
}

/** Record a failed optional vendor call; may open the circuit. */
export function recordOptionalVendorFailure(label: string): void {
	const state = getCircuit(label);
	state.failures += 1;
	if (state.failures >= OPTIONAL_VENDOR_CIRCUIT_FAILURE_THRESHOLD) {
		state.openUntilMs = Date.now() + OPTIONAL_VENDOR_CIRCUIT_OPEN_MS;
	}
}

function logOptionalSkipped(label: string, reason: OptionalVendorSkipReason): void {
	recordOptionalVendorSkip();
	rootLogger.warn(`Optional vendor skipped: ${label}`, {
		category: OPTIONAL_VENDOR_DEGRADED_CATEGORY,
		vendorLabel: label,
		reason,
	});
}

/**
 * Run optional vendor work under a per-invocation time budget.
 * Opens the circuit after repeated failures elsewhere for the same label.
 */
export async function withOptionalVendorBudget<T>(
	label: string,
	budgetMs: number,
	fn: () => Promise<T>,
): Promise<OptionalVendorResult<T>> {
	if (isOptionalVendorUnavailable(label)) {
		logOptionalSkipped(label, "circuit_open");
		return { status: "skipped", reason: "circuit_open" };
	}

	const deadline = Date.now() + budgetMs;
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await Promise.race([
			fn().then((value) => ({ ok: true as const, value })),
			new Promise<{ ok: false }>((resolve) => {
				timeoutId = setTimeout(() => resolve({ ok: false }), budgetMs);
			}),
		]);
		if (!result.ok) {
			recordOptionalVendorFailure(label);
			logOptionalSkipped(label, "budget_exceeded");
			return { status: "skipped", reason: "budget_exceeded" };
		}
		recordOptionalVendorSuccess(label);
		if (Date.now() > deadline) {
			// fn returned just after budget; treat as success but don't penalize.
		}
		return { status: "ok", value: result.value };
	} catch (error) {
		recordOptionalVendorFailure(label);
		rootLogger.warn(`Optional vendor failed: ${label}`, {
			category: OPTIONAL_VENDOR_DEGRADED_CATEGORY,
			vendorLabel: label,
			error: error instanceof Error ? error.message : String(error),
		});
		return { status: "skipped", reason: "unavailable" };
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId);
	}
}
