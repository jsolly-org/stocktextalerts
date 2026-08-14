import { DateTime } from "luxon";
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../../src/lib/logging";
import { maybeWakeAssetBuyerFromDailyDigest } from "../../../src/lib/schedule/asset-buyer-digest-wakeup";

function makeLogger(): Logger {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	} as unknown as Logger;
}

describe("maybeWakeAssetBuyerFromDailyDigest", () => {
	it("invokes once per session day in the 09:00 ET window even with no human digest users", async () => {
		const rpc = vi.fn(async () => ({ data: true, error: null }));
		const wakeup = vi.fn(async () => true);
		const now = DateTime.fromISO("2026-08-13T13:01:00.000Z"); // 09:01 EDT Thursday

		const result = await maybeWakeAssetBuyerFromDailyDigest({
			supabase: { rpc } as never,
			logger: makeLogger(),
			now,
			equitySession: "pre",
			wakeup,
		});

		expect(result).toBe("invoked");
		expect(rpc).toHaveBeenCalledWith("claim_asset_buyer_digest_wake", {
			p_et_date: "2026-08-13",
		});
		expect(wakeup).toHaveBeenCalledOnce();
	});

	it("skips weekends and holidays when the equity session is closed", async () => {
		const rpc = vi.fn();
		const wakeup = vi.fn(async () => true);
		const now = DateTime.fromISO("2026-08-15T13:01:00.000Z"); // Saturday 09:01 ET

		const result = await maybeWakeAssetBuyerFromDailyDigest({
			supabase: { rpc } as never,
			logger: makeLogger(),
			now,
			equitySession: "closed",
			wakeup,
		});

		expect(result).toBe("skipped");
		expect(rpc).not.toHaveBeenCalled();
		expect(wakeup).not.toHaveBeenCalled();
	});

	it("is idempotent in the same window after a successful claim", async () => {
		const rpc = vi
			.fn()
			.mockResolvedValueOnce({ data: true, error: null })
			.mockResolvedValueOnce({ data: false, error: null });
		const wakeup = vi.fn(async () => true);
		const now = DateTime.fromISO("2026-08-13T13:05:00.000Z");

		const first = await maybeWakeAssetBuyerFromDailyDigest({
			supabase: { rpc } as never,
			logger: makeLogger(),
			now,
			equitySession: "pre",
			wakeup,
		});
		const second = await maybeWakeAssetBuyerFromDailyDigest({
			supabase: { rpc } as never,
			logger: makeLogger(),
			now: now.plus({ minutes: 2 }),
			equitySession: "pre",
			wakeup,
		});

		expect(first).toBe("invoked");
		expect(second).toBe("skipped");
		expect(wakeup).toHaveBeenCalledOnce();
	});

	it("does not throw when the heartbeat invoke returns false; releases the claim and warns", async () => {
		const rpc = vi.fn(async (name: string) => ({
			data: name === "claim_asset_buyer_digest_wake",
			error: null,
		}));
		const wakeup = vi.fn(async () => false);
		const now = DateTime.fromISO("2026-08-13T13:01:00.000Z");
		const logger = makeLogger();

		const result = await maybeWakeAssetBuyerFromDailyDigest({
			supabase: { rpc } as never,
			logger,
			now,
			equitySession: "pre",
			wakeup,
		});

		expect(result).toBe("skipped");
		expect(rpc).toHaveBeenCalledWith("release_asset_buyer_digest_wake", {
			p_et_date: "2026-08-13",
		});
		expect(logger.warn).toHaveBeenCalled();
		expect(logger.error).not.toHaveBeenCalled();
	});

	it("releases the claim when the heartbeat invoke throws, then a later tick can claim again", async () => {
		const rpc = vi
			.fn()
			.mockResolvedValueOnce({ data: true, error: null })
			.mockResolvedValueOnce({ data: true, error: null })
			.mockResolvedValueOnce({ data: true, error: null });
		const wakeup = vi
			.fn()
			.mockRejectedValueOnce(new Error("lambda timeout"))
			.mockResolvedValueOnce(true);
		const now = DateTime.fromISO("2026-08-13T13:01:00.000Z");
		const logger = makeLogger();

		const first = await maybeWakeAssetBuyerFromDailyDigest({
			supabase: { rpc } as never,
			logger,
			now,
			equitySession: "pre",
			wakeup,
		});
		const second = await maybeWakeAssetBuyerFromDailyDigest({
			supabase: { rpc } as never,
			logger,
			now: now.plus({ minutes: 2 }),
			equitySession: "pre",
			wakeup,
		});

		expect(first).toBe("skipped");
		expect(second).toBe("invoked");
		expect(rpc).toHaveBeenNthCalledWith(2, "release_asset_buyer_digest_wake", {
			p_et_date: "2026-08-13",
		});
		expect(logger.warn).toHaveBeenCalled();
		expect(logger.error).not.toHaveBeenCalled();
	});

	it("warns and skips when the claim RPC errors", async () => {
		const rpc = vi.fn(async () => ({ data: null, error: { message: "db down" } }));
		const wakeup = vi.fn(async () => true);
		const now = DateTime.fromISO("2026-08-13T13:01:00.000Z");
		const logger = makeLogger();

		const result = await maybeWakeAssetBuyerFromDailyDigest({
			supabase: { rpc } as never,
			logger,
			now,
			equitySession: "pre",
			wakeup,
		});

		expect(result).toBe("skipped");
		expect(wakeup).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalled();
		expect(logger.error).not.toHaveBeenCalled();
	});

	it("skips outside the 09:00–09:30 ET window", async () => {
		const rpc = vi.fn();
		const wakeup = vi.fn(async () => true);
		const now = DateTime.fromISO("2026-08-13T14:00:00.000Z"); // 10:00 EDT

		const result = await maybeWakeAssetBuyerFromDailyDigest({
			supabase: { rpc } as never,
			logger: makeLogger(),
			now,
			equitySession: "regular",
			wakeup,
		});

		expect(result).toBe("skipped");
		expect(rpc).not.toHaveBeenCalled();
		expect(wakeup).not.toHaveBeenCalled();
	});
});
