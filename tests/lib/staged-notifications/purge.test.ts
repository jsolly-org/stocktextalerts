import { describe, expect, it, vi } from "vitest";
import { purgeStaleStaged } from "../../../src/lib/staged-notifications/db";

describe("purgeStaleStaged", () => {
	it("only deletes rows whose retry time has passed", async () => {
		const deleteMock = vi.fn(() => ({
			lt: vi.fn(function lt(this: unknown) {
				return this;
			}),
			lte: vi.fn(function lte(this: unknown) {
				return this;
			}),
			select: vi.fn(async () => ({ data: [{ id: "stale-1" }], error: null })),
		}));

		const supabase = {
			from: vi.fn(() => ({
				delete: deleteMock,
			})),
		} as never;

		const purged = await purgeStaleStaged(supabase, 5);

		expect(purged).toBe(1);
		expect(deleteMock).toHaveBeenCalledOnce();
		const chain = deleteMock.mock.results[0]?.value;
		expect(chain.lte).toHaveBeenCalledWith("scheduled_for", expect.any(String));
	});
});
