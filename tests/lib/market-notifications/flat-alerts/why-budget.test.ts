import { DateTime } from "luxon";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../../../../src/lib/logging";
import {
	canInvokePriceMoveWhy,
	PRICE_MOVE_WHY_MAX_SENDS_PER_WINDOW,
	updatePriceMoveWhySendCounter,
} from "../../../../src/lib/market-notifications/flat-alerts/why-budget";

describe("canInvokePriceMoveWhy", () => {
	it("allows when no window has started", () => {
		expect(
			canInvokePriceMoveWhy(
				{ price_move_why_window_start: null, price_move_why_sends_in_window: 0 },
				DateTime.fromISO("2026-07-25T12:00:00Z"),
			),
		).toBe(true);
	});

	it("allows when the rolling window has expired", () => {
		expect(
			canInvokePriceMoveWhy(
				{
					price_move_why_window_start: "2026-07-24T11:00:00.000Z",
					price_move_why_sends_in_window: PRICE_MOVE_WHY_MAX_SENDS_PER_WINDOW,
				},
				DateTime.fromISO("2026-07-25T12:00:00Z"),
			),
		).toBe(true);
	});

	it("denies when the cap is reached inside the window", () => {
		expect(
			canInvokePriceMoveWhy(
				{
					price_move_why_window_start: "2026-07-25T01:00:00.000Z",
					price_move_why_sends_in_window: PRICE_MOVE_WHY_MAX_SENDS_PER_WINDOW,
				},
				DateTime.fromISO("2026-07-25T12:00:00Z"),
			),
		).toBe(false);
	});

	it("allows when under the cap inside the window", () => {
		expect(
			canInvokePriceMoveWhy(
				{
					price_move_why_window_start: "2026-07-25T01:00:00.000Z",
					price_move_why_sends_in_window: PRICE_MOVE_WHY_MAX_SENDS_PER_WINDOW - 1,
				},
				DateTime.fromISO("2026-07-25T12:00:00Z"),
			),
		).toBe(true);
	});
});

describe("updatePriceMoveWhySendCounter", () => {
	const logger = {
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
	} as unknown as Logger;

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("starts a new window when expired and only updates price_move_why_* columns", async () => {
		const update = vi.fn(() => ({
			eq: vi.fn(async () => ({ error: null })),
		}));
		const from = vi.fn(() => ({ update }));
		const supabase = { from } as never;
		const user = {
			price_move_why_window_start: "2026-07-24T01:00:00.000Z",
			price_move_why_sends_in_window: 19,
		};

		const now = DateTime.fromISO("2026-07-25T12:00:00.000Z", { setZone: true });
		await updatePriceMoveWhySendCounter(supabase, "user-1", user, now, logger);

		expect(from).toHaveBeenCalledWith("users");
		expect(update).toHaveBeenCalledWith({
			price_move_why_window_start: now.toISO(),
			price_move_why_sends_in_window: 1,
		});
		expect(user.price_move_why_sends_in_window).toBe(1);
	});

	it("increments within an active window", async () => {
		const update = vi.fn(() => ({
			eq: vi.fn(async () => ({ error: null })),
		}));
		const supabase = { from: vi.fn(() => ({ update })) } as never;
		const user = {
			price_move_why_window_start: "2026-07-25T01:00:00.000Z",
			price_move_why_sends_in_window: 3,
		};

		await updatePriceMoveWhySendCounter(
			supabase,
			"user-1",
			user,
			DateTime.fromISO("2026-07-25T12:00:00Z"),
			logger,
		);

		expect(update).toHaveBeenCalledWith({
			price_move_why_window_start: "2026-07-25T01:00:00.000Z",
			price_move_why_sends_in_window: 4,
		});
	});
});
