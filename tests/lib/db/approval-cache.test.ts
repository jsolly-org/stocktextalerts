import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetApprovalCacheForTests,
	getApprovalCached,
} from "../../../src/lib/db/approval-cache";

describe("getApprovalCached", () => {
	beforeEach(() => __resetApprovalCacheForTests());

	it("A repeated lookup within the TTL hits cache and does not re-query", async () => {
		const lookup = vi.fn(async () => true);

		expect(await getApprovalCached("user-1", lookup, 1_000)).toBe(true);
		expect(await getApprovalCached("user-1", lookup, 1_500)).toBe(true);
		expect(lookup).toHaveBeenCalledTimes(1);
	});

	it("A lookup after the TTL expires re-queries", async () => {
		const lookup = vi.fn(async () => true);

		await getApprovalCached("user-1", lookup, 1_000);
		await getApprovalCached("user-1", lookup, 1_000 + 31_000);
		expect(lookup).toHaveBeenCalledTimes(2);
	});
});
