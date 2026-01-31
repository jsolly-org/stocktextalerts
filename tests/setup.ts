import { afterAll, afterEach, beforeAll, expect, vi } from "vitest";
import {
	adminClient,
	cleanupAllNonPreservedUsers,
	getRealStockSymbols,
	verifyDatabaseSchemaUpToDate,
	verifySupabaseAdminAccess,
} from "./utils";

export { adminClient };

export const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
export const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

let allowWarnings = false;
let allowErrors = false;

export function allowConsoleWarnings() {
	allowWarnings = true;
}

export function allowConsoleErrors() {
	allowErrors = true;
}

export function resetConsoleAssertions() {
	allowWarnings = false;
	allowErrors = false;
}

afterEach(() => {
	try {
		if (!allowWarnings) {
			expect(warnSpy.mock.calls, "Unexpected console.warn").toEqual([]);
		}
		if (!allowErrors) {
			expect(errorSpy.mock.calls, "Unexpected console.error").toEqual([]);
		}
	} finally {
		warnSpy.mockClear();
		errorSpy.mockClear();
		resetConsoleAssertions();
	}
});

afterAll(() => {
	warnSpy.mockRestore();
	errorSpy.mockRestore();
});

beforeAll(async () => {
	await cleanupAllNonPreservedUsers();
	await verifySupabaseAdminAccess();
	await verifyDatabaseSchemaUpToDate();
	// Preload stock data once for all tests (cached after first load)
	getRealStockSymbols(1);
});
