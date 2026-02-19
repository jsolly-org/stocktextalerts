import { describe, expect, it } from "vitest";
import type { FormSchema } from "../../../src/lib/forms/schema";
import { processFields } from "../../../src/lib/forms/validate";

describe("json_string_array security limits", () => {
	const SCHEMA = {
		arr: { type: "json_string_array" as const },
	} satisfies FormSchema;

	it("rejects arrays exceeding default max length (100)", () => {
		const arr = Array.from({ length: 101 }, (_, i) => `item${i}`);
		const { errors } = processFields(
			["arr"],
			{ arr: JSON.stringify(arr) },
			SCHEMA,
		);
		expect(errors).toHaveLength(1);
		expect(errors[0].reason).toBe("json_array_too_long");
	});

	it("rejects raw string exceeding 50KB", () => {
		const arr = Array.from({ length: 2000 }, () => "x".repeat(30));
		const raw = JSON.stringify(arr);
		expect(raw.length).toBeGreaterThan(50_000);
		const { errors } = processFields(["arr"], { arr: raw }, SCHEMA);
		expect(errors).toHaveLength(1);
		expect(errors[0].reason).toBe("json_array_too_large");
	});

	it("accepts array within limits", () => {
		const arr = ["AAPL", "MSFT", "GOOG"];
		const { errors, output } = processFields(
			["arr"],
			{ arr: JSON.stringify(arr) },
			SCHEMA,
		);
		expect(errors).toHaveLength(0);
		expect(output.arr).toEqual(arr);
	});
});
