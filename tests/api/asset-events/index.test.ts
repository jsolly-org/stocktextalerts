import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as runAssetEventsCron } from "../../../src/pages/api/asset-events/index";
import { createApiContext } from "../../helpers/api-context";
import { createCronRequest } from "../../helpers/cron";

const { fetchAndStoreAssetEventsMock } = vi.hoisted(() => ({
	fetchAndStoreAssetEventsMock: vi.fn(),
}));

vi.mock("../../../src/lib/asset-events/fetch", () => ({
	fetchAndStoreAssetEvents: fetchAndStoreAssetEventsMock,
}));

describe("A cron worker preloads upcoming asset events.", () => {
	const testCronSecret = "asset-events-test-secret";

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-14T12:00:00.000Z"));
		vi.stubEnv("CRON_SECRET", testCronSecret);
		fetchAndStoreAssetEventsMock.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it("Fetches and stores this week and next week event windows.", async () => {
		fetchAndStoreAssetEventsMock
			.mockResolvedValueOnce({ upserted: 4, failedProviders: [] })
			.mockResolvedValueOnce({ upserted: 3, failedProviders: [] });

		const response = await runAssetEventsCron(
			createApiContext({
				request: createCronRequest({
					path: "/api/asset-events",
					cronSecret: testCronSecret,
					method: "GET",
				}),
				locals: {
					requestId: "asset-events-cron-test",
				},
			}),
		);

		expect(response.status).toBe(200);
		expect(fetchAndStoreAssetEventsMock).toHaveBeenCalledTimes(2);
		expect(fetchAndStoreAssetEventsMock).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				weekStart: "2026-01-12",
				weekEnd: "2026-01-16",
			}),
		);
		expect(fetchAndStoreAssetEventsMock).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				weekStart: "2026-01-19",
				weekEnd: "2026-01-23",
			}),
		);

		const payload = (await response.json()) as {
			success: boolean;
			weeks: Array<{ upserted: number; failedProviders: string[] }>;
		};
		expect(payload.success).toBe(true);
		expect(payload.weeks).toHaveLength(2);
		expect(payload.weeks[0]?.upserted).toBe(4);
		expect(payload.weeks[1]?.upserted).toBe(3);
	});

	it("Marks the cron run as unsuccessful when any provider fails.", async () => {
		fetchAndStoreAssetEventsMock
			.mockResolvedValueOnce({ upserted: 2, failedProviders: [] })
			.mockResolvedValueOnce({
				upserted: 1,
				failedProviders: ["finnhub"],
			});

		const response = await runAssetEventsCron(
			createApiContext({
				request: createCronRequest({
					path: "/api/asset-events",
					cronSecret: testCronSecret,
					method: "GET",
				}),
			}),
		);

		expect(response.status).toBe(200);
		const payload = (await response.json()) as { success: boolean };
		expect(payload.success).toBe(false);
	});

	it("Rejects a cron request without the shared secret.", async () => {
		const response = await runAssetEventsCron(
			createApiContext({
				request: new Request("http://localhost/api/asset-events", {
					method: "GET",
				}),
			}),
		);

		expect(response.status).toBe(401);
	});
});
