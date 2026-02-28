import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchDailyDigestUser } from "../../../src/lib/daily-digest/dispatch";
import { expectConsoleError } from "../../setup";

vi.mock("../../../src/lib/db/env", () => ({
	getSiteUrl: () => "http://localhost:4321",
}));

describe("Daily digest fan-out dispatch", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("Returns downstream worker stats on successful dispatch.", async () => {
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					skipped: 0,
					logFailures: 0,
					emailsSent: 1,
					emailsFailed: 0,
					smsSent: 0,
					smsFailed: 0,
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		);

		const stats = await dispatchDailyDigestUser({
			userId: "00000000-0000-0000-0000-000000000123",
			currentTimeIso: "2026-01-14T15:00:00.000Z",
			cronSecret: "dispatch-test-secret",
			precompute: true,
			marketClosureInfo: { reason: "holiday", holidayName: "Presidents' Day" },
		});

		expect(stats).toEqual({
			skipped: 0,
			logFailures: 0,
			emailsSent: 1,
			emailsFailed: 0,
			smsSent: 0,
			smsFailed: 0,
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [requestUrl, requestInit] = fetchMock.mock.calls[0] ?? [];
		expect(requestUrl).toBe("http://localhost:4321/api/daily-digest");
		expect(requestInit).toEqual(
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Authorization: "Bearer dispatch-test-secret",
					"Content-Type": "application/json",
				}),
			}),
		);
	});

	it("Falls back to safe skipped stats when downstream returns non-OK.", async () => {
		expectConsoleError("Fan-out dispatch failed");
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }));

		const stats = await dispatchDailyDigestUser({
			userId: "00000000-0000-0000-0000-000000000123",
			currentTimeIso: "2026-01-14T15:00:00.000Z",
			cronSecret: "dispatch-test-secret",
		});

		expect(stats).toEqual({
			skipped: 1,
			logFailures: 0,
			emailsSent: 0,
			emailsFailed: 0,
			smsSent: 0,
			smsFailed: 0,
		});
	});

	it("Falls back to safe skipped stats when fetch throws.", async () => {
		expectConsoleError("Fan-out dispatch errored");
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockRejectedValueOnce(new Error("network failure"));

		const stats = await dispatchDailyDigestUser({
			userId: "00000000-0000-0000-0000-000000000123",
			currentTimeIso: "2026-01-14T15:00:00.000Z",
			cronSecret: "dispatch-test-secret",
		});

		expect(stats).toEqual({
			skipped: 1,
			logFailures: 0,
			emailsSent: 0,
			emailsFailed: 0,
			smsSent: 0,
			smsFailed: 0,
		});
	});
});
