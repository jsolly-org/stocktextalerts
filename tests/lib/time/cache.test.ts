import { describe, expect, it, vi } from "vitest";
import type { AppSupabaseClient } from "../../../src/lib/db/supabase";

function createSupabaseTimezonesStub(options: {
	rows: Array<{
		value: string;
		label?: string;
		display_order?: number;
		active?: boolean;
	}>;
	delayMs?: number;
}) {
	let selectCount = 0;

	const delayMs = options.delayMs ?? 0;
	const rows = options.rows.map((row, index) => ({
		value: row.value,
		label: row.label ?? row.value,
		display_order: row.display_order ?? index,
		active: row.active ?? true,
	}));

	const supabase = {
		from: (table: string) => {
			if (table !== "timezones") {
				throw new Error(`Unexpected table: ${table}`);
			}

			return {
				select: (columns: string) => {
					if (columns !== "value,label,display_order,active") {
						throw new Error(`Unexpected columns: ${columns}`);
					}

					return {
						range: async (from: number, to: number) => {
							selectCount += 1;

							if (delayMs > 0) {
								await new Promise((resolve) => setTimeout(resolve, delayMs));
							}

							return { data: rows.slice(from, to + 1), error: null };
						},
					};
				},
			};
		},
	};

	return {
		supabase,
		getSelectCount: () => selectCount,
	};
}

describe("A user's detected timezone is resolved consistently.", () => {
	it("When resolving the same timezone twice, the same result is returned without extra lookups.", async () => {
		vi.resetModules();
		const { resolveTimezone } = await import("../../../src/lib/time/cache");

		const stub = createSupabaseTimezonesStub({
			rows: [{ value: "Etc/UTC" }],
		});

		const first = await resolveTimezone({
			supabase: stub.supabase as unknown as AppSupabaseClient,
			detectedTimezone: "Etc/UTC",
		});
		const second = await resolveTimezone({
			supabase: stub.supabase as unknown as AppSupabaseClient,
			detectedTimezone: "Etc/UTC",
		});

		expect(first).toBe("Etc/UTC");
		expect(second).toBe("Etc/UTC");
		expect(stub.getSelectCount()).toBe(1);
	});

	it("When resolving concurrently, the same lookup is shared.", async () => {
		vi.resetModules();
		const { resolveTimezone } = await import("../../../src/lib/time/cache");

		const stub = createSupabaseTimezonesStub({
			rows: [{ value: "Etc/UTC" }],
			delayMs: 20,
		});

		const [first, second] = await Promise.all([
			resolveTimezone({
				supabase: stub.supabase as unknown as AppSupabaseClient,
				detectedTimezone: "Etc/UTC",
			}),
			resolveTimezone({
				supabase: stub.supabase as unknown as AppSupabaseClient,
				detectedTimezone: "Etc/UTC",
			}),
		]);

		expect(first).toBe("Etc/UTC");
		expect(second).toBe("Etc/UTC");
		expect(stub.getSelectCount()).toBe(1);
	});
});

describe("A user sees available timezone options consistently.", () => {
	it("When requesting timezone options twice, the same list is returned without extra lookups.", async () => {
		vi.resetModules();
		const { getTimezoneOptions } = await import("../../../src/lib/time/cache");

		const stub = createSupabaseTimezonesStub({
			rows: [
				{ value: "America/New_York", display_order: 1, active: true },
				{ value: "Europe/London", display_order: 2, active: true },
				{ value: "Etc/UTC", display_order: 3, active: false },
			],
		});

		const first = await getTimezoneOptions(
			stub.supabase as unknown as AppSupabaseClient,
			{ includeValues: ["Etc/UTC"] },
		);
		const second = await getTimezoneOptions(
			stub.supabase as unknown as AppSupabaseClient,
			{ includeValues: ["Etc/UTC"] },
		);

		expect(first.map((tz) => tz.value)).toEqual([
			"Etc/UTC",
			"America/New_York",
			"Europe/London",
		]);
		expect(second.map((tz) => tz.value)).toEqual([
			"Etc/UTC",
			"America/New_York",
			"Europe/London",
		]);
		expect(stub.getSelectCount()).toBe(1);
	});

	it("When requesting timezone options concurrently, the same lookup is shared.", async () => {
		vi.resetModules();
		const { getTimezoneOptions } = await import("../../../src/lib/time/cache");

		const stub = createSupabaseTimezonesStub({
			rows: [
				{ value: "America/New_York", display_order: 1, active: true },
				{ value: "Europe/London", display_order: 2, active: true },
			],
			delayMs: 20,
		});

		const [first, second] = await Promise.all([
			getTimezoneOptions(stub.supabase as unknown as AppSupabaseClient),
			getTimezoneOptions(stub.supabase as unknown as AppSupabaseClient),
		]);

		expect(first.map((tz) => tz.value)).toEqual([
			"America/New_York",
			"Europe/London",
		]);
		expect(second.map((tz) => tz.value)).toEqual([
			"America/New_York",
			"Europe/London",
		]);
		expect(stub.getSelectCount()).toBe(1);
	});
});
