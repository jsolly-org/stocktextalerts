import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { describe, expect, it } from "vitest";
import {
	packFormattedStrings,
	TELEGRAM_TEXT_MARGIN,
	TELEGRAM_TEXT_MAX_UTF16,
} from "../../../../src/lib/messaging/telegram/limits";

const budget = TELEGRAM_TEXT_MAX_UTF16 - TELEGRAM_TEXT_MARGIN;

describe("packFormattedStrings", () => {
	it("joins small parts into one message", () => {
		const chunks = packFormattedStrings([fmt`hello`, fmt`world`]);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.text).toBe("hello\n\nworld");
	});

	it("preserves entities when packing", () => {
		const chunks = packFormattedStrings([FormattedString.bold("hello"), fmt`world`]);
		expect(chunks).toHaveLength(1);
		const bold = chunks[0]?.entities.filter((e) => e.type === "bold") ?? [];
		expect(bold).toHaveLength(1);
		const start = bold[0]?.offset ?? 0;
		const end = start + (bold[0]?.length ?? 0);
		expect(chunks[0]?.text.slice(start, end)).toBe("hello");
	});

	it("splits adjacent parts that exceed the budget", () => {
		const chunks = packFormattedStrings([fmt`${"a".repeat(3000)}`, fmt`${"b".repeat(3000)}`]);
		expect(chunks.length).toBeGreaterThanOrEqual(2);
		for (const chunk of chunks) {
			expect(chunk.text.length).toBeLessThanOrEqual(budget);
		}
		const joined = chunks.map((c) => c.text).join("\n\n");
		expect(joined).toContain("a".repeat(3000));
		expect(joined).toContain("b".repeat(3000));
	});

	it("counts the blank-line separator toward the budget", () => {
		const chunks = packFormattedStrings([fmt`${"a".repeat(budget - 5)}`, fmt`${"b".repeat(4)}`]);
		expect(chunks).toHaveLength(2);
		expect(chunks[0]?.text).toBe("a".repeat(budget - 5));
		expect(chunks[1]?.text).toBe("b".repeat(4));
		for (const chunk of chunks) {
			expect(chunk.text.length).toBeLessThanOrEqual(budget);
		}
	});

	it("splits a single oversized part on blank lines", () => {
		const part = fmt`${"x".repeat(3000)}\n\n${"y".repeat(3000)}`;
		const chunks = packFormattedStrings([part]);
		expect(chunks.length).toBeGreaterThanOrEqual(2);
		for (const chunk of chunks) {
			expect(chunk.text.length).toBeLessThanOrEqual(budget);
		}
		expect(chunks.some((c) => c.text.includes("x".repeat(20)))).toBe(true);
		expect(chunks.some((c) => c.text.includes("y".repeat(20)))).toBe(true);
	});

	it("hard-slices a single line over the budget", () => {
		const part = fmt`${"z".repeat(budget + 50)}`;
		const chunks = packFormattedStrings([part]);
		expect(chunks.length).toBe(2);
		expect(chunks[0]?.text.length).toBe(budget);
		expect(chunks[1]?.text.length).toBe(50);
		expect(chunks[0]?.text).toBe("z".repeat(budget));
		expect(chunks[1]?.text).toBe("z".repeat(50));
	});

	it("keeps entity ranges valid after hard-slicing a formatted part", () => {
		const chunks = packFormattedStrings([FormattedString.bold("z".repeat(budget + 50))]);
		expect(chunks.length).toBe(2);
		for (const chunk of chunks) {
			expect(chunk.text.length).toBeLessThanOrEqual(budget);
			expect(chunk.entities.length).toBeGreaterThan(0);
			for (const entity of chunk.entities) {
				expect(entity.offset).toBeGreaterThanOrEqual(0);
				expect(entity.offset + entity.length).toBeLessThanOrEqual(chunk.text.length);
				expect(chunk.text.slice(entity.offset, entity.offset + entity.length).length).toBe(
					entity.length,
				);
			}
		}
	});

	it("returns no chunks for empty input", () => {
		expect(packFormattedStrings([])).toEqual([]);
		expect(packFormattedStrings([fmt``])).toEqual([]);
	});
});
