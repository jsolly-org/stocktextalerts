import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetApprovalCacheForTests,
	getApprovalCached,
} from "../../../src/lib/db/approval-cache";

describe("getApprovalCached", () => {
	beforeEach(() => __resetApprovalCacheForTests());

	it("An approved user is cached without expiry on the instance", async () => {
		const lookup = vi.fn(async () => true);

		expect(await getApprovalCached("user-1", lookup, 1_000)).toBe(true);
		expect(await getApprovalCached("user-1", lookup, 1_000 + 31_000)).toBe(true);
		expect(lookup).toHaveBeenCalledTimes(1);
	});

	it("An unapproved user re-queries after the TTL expires", async () => {
		const lookup = vi.fn(async () => false);

		await getApprovalCached("user-1", lookup, 1_000);
		await getApprovalCached("user-1", lookup, 1_000 + 31_000);
		expect(lookup).toHaveBeenCalledTimes(2);
	});

	it("An unapproved user hits cache within the TTL", async () => {
		const lookup = vi.fn(async () => false);

		expect(await getApprovalCached("user-1", lookup, 1_000)).toBe(false);
		expect(await getApprovalCached("user-1", lookup, 1_500)).toBe(false);
		expect(lookup).toHaveBeenCalledTimes(1);
	});

	it("A user promoted from unapproved to approved sticks after the next lookup", async () => {
		const lookup = vi
			.fn<() => Promise<boolean>>()
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true);

		expect(await getApprovalCached("user-1", lookup, 1_000)).toBe(false);
		expect(await getApprovalCached("user-1", lookup, 1_000 + 31_000)).toBe(true);
		expect(await getApprovalCached("user-1", lookup, 1_000 + 62_000)).toBe(true);
		expect(lookup).toHaveBeenCalledTimes(2);
	});
});
