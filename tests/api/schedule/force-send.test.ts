import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as runScheduleCron } from "../../../src/pages/api/schedule";
import { createApiContext } from "../../helpers/api-context";
import { createCronRequest } from "../../helpers/cron";
import { adminClient } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

describe("Manual cron force-send scenarios", () => {
	const testCronSecret = "schedule-force-test-secret";

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-14T15:00:00.000Z"));
		vi.stubEnv("CRON_SECRET", testCronSecret);
		vi.stubEnv("SCHEDULE_PASS_DELAY_MS", "0");
		vi.stubEnv("SMS_TEST_BEHAVIOR", "success");
		vi.stubEnv("LIVE_API_PROVIDERS", "");
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it("Ops can trigger a force run so a user with a future next send still gets today's market update.", async () => {
		const testUser = await createTestUser({
			timezone: "America/New_York",
			emailNotificationsEnabled: true,
			smsNotificationsEnabled: false,
			trackedAssets: ["AAPL"],
			marketScheduledAssetPriceIncludeEmail: true,
		});
		registerTestUserForCleanup(testUser.id);

		const futureNextSendAt = DateTime.utc().plus({ hours: 6 }).toISO();
		expect(futureNextSendAt).toBeTruthy();
		const { error: seedError } = await adminClient
			.from("users")
			.update({
				market_scheduled_asset_price_enabled: true,
				market_scheduled_asset_price_next_send_at: futureNextSendAt,
			})
			.eq("id", testUser.id);
		expect(seedError).toBeNull();

		const normalRun = await runScheduleCron(
			createApiContext({
				request: createCronRequest({
					path: "/api/schedule",
					cronSecret: testCronSecret,
					method: "POST",
				}),
			}),
		);
		expect(normalRun.status).toBe(200);

		const { data: logsBeforeForce, error: logsBeforeForceError } =
			await adminClient
				.from("notification_log")
				.select("id")
				.eq("user_id", testUser.id)
				.eq("type", "market")
				.eq("delivery_method", "email");
		expect(logsBeforeForceError).toBeNull();
		expect(logsBeforeForce ?? []).toHaveLength(0);

		const forceRun = await runScheduleCron(
			createApiContext({
				request: createCronRequest({
					path: "/api/schedule",
					cronSecret: testCronSecret,
					method: "POST",
					body: { force: true },
				}),
			}),
		);
		expect(forceRun.status).toBe(200);
		const forcePayload = (await forceRun.json()) as { success: boolean };
		expect(forcePayload.success).toBe(true);

		const { data: logsAfterForce, error: logsAfterForceError } =
			await adminClient
				.from("notification_log")
				.select("id,message")
				.eq("user_id", testUser.id)
				.eq("type", "market")
				.eq("delivery_method", "email");
		expect(logsAfterForceError).toBeNull();
		expect(logsAfterForce ?? []).toHaveLength(1);
		expect(logsAfterForce?.[0]?.message).toContain("AAPL");
	});
});
