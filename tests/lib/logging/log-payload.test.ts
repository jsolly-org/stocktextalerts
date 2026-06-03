import { afterEach, describe, expect, it } from "vitest";
import { payloadLogFields, preparePayloadForLog } from "../../../src/lib/logging/log-payload";

describe("preparePayloadForLog", () => {
	const originalEnv = process.env.LOG_MASK_PII;

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.LOG_MASK_PII;
		} else {
			process.env.LOG_MASK_PII = originalEnv;
		}
	});

	it("returns full mode for small objects", () => {
		const prepared = preparePayloadForLog({ symbol: "AAPL", change: 1 });
		expect(prepared.mode).toBe("full");
		if (prepared.mode === "full") {
			expect(prepared.value).toEqual({ symbol: "AAPL", change: 1 });
		}
	});

	it("returns preview mode for large strings", () => {
		const prepared = preparePayloadForLog("x".repeat(10_000), { maxFullBytes: 100 });
		expect(prepared.mode).toBe("preview");
		if (prepared.mode === "preview") {
			expect(prepared.preview.length).toBeLessThan(10_000);
			expect(prepared.omittedBytes).toBeGreaterThan(0);
		}
	});

	it("redacts sensitive keys in nested objects", () => {
		const prepared = preparePayloadForLog({ api_key: "secret", ok: true });
		expect(prepared.mode).toBe("full");
		if (prepared.mode === "full") {
			expect(prepared.value).toEqual({ api_key: "[REDACTED]", ok: true });
		}
	});

	it("maps payloadLogFields for preview mode", () => {
		const prepared = preparePayloadForLog("x".repeat(10_000), { maxFullBytes: 50 });
		const fields = payloadLogFields(prepared, "proposedRows");
		expect(fields.proposedRowsMode).toBe("preview");
		expect(fields.truncated).toBe(true);
		expect(typeof fields.proposedRowsPreview).toBe("string");
	});
});
