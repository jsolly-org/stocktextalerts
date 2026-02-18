import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as runDailyDigestUser } from "../../../src/pages/api/daily-digest/index";
import { createApiContext } from "../../helpers/api-context";
import { TEST_PASSWORD } from "../../helpers/constants";
import { createCronRequest } from "../../helpers/cron";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

const { processDailyDigestUserMock } = vi.hoisted(() => ({
	processDailyDigestUserMock: vi.fn(),
}));

vi.mock("../../../src/lib/daily-digest/process", () => ({
	processDailyDigestUser: processDailyDigestUserMock,
}));

describe("A cron fan-out worker runs daily digest processing per user.", () => {
	const testCronSecret = "daily-digest-test-secret";

	beforeEach(() => {
		vi.stubEnv("CRON_SECRET", testCronSecret);
		processDailyDigestUserMock.mockReset();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("Processes a valid user request and returns delivery stats.", async () => {
		const testUser = await createTestUser({
			email: `daily-digest-${randomUUID()}@resend.dev`,
			password: TEST_PASSWORD,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		processDailyDigestUserMock.mockResolvedValueOnce({
			skipped: 0,
			logFailures: 0,
			emailsSent: 1,
			emailsFailed: 0,
			smsSent: 0,
			smsFailed: 0,
		});

		const response = await runDailyDigestUser(
			createApiContext({
				request: createCronRequest({
					path: "/api/daily-digest",
					cronSecret: testCronSecret,
					method: "POST",
					body: {
						userId: testUser.id,
						currentTimeIso: "2026-01-14T15:00:00.000Z",
						precompute: true,
					},
				}),
			}),
		);

		expect(response.status).toBe(200);
		expect(processDailyDigestUserMock).toHaveBeenCalledTimes(1);
		expect(processDailyDigestUserMock).toHaveBeenCalledWith(
			expect.objectContaining({
				stageOnly: true,
			}),
		);

		const payload = (await response.json()) as {
			skipped: number;
			logFailures: number;
			emailsSent: number;
			emailsFailed: number;
			smsSent: number;
			smsFailed: number;
		};
		expect(payload).toEqual({
			skipped: 0,
			logFailures: 0,
			emailsSent: 1,
			emailsFailed: 0,
			smsSent: 0,
			smsFailed: 0,
		});
	});

	it("Returns a no-op stats payload when the user id does not exist.", async () => {
		const response = await runDailyDigestUser(
			createApiContext({
				request: createCronRequest({
					path: "/api/daily-digest",
					cronSecret: testCronSecret,
					method: "POST",
					body: {
						userId: "00000000-0000-0000-0000-000000000999",
						currentTimeIso: "2026-01-14T15:00:00.000Z",
					},
				}),
			}),
		);

		expect(response.status).toBe(200);
		expect(processDailyDigestUserMock).not.toHaveBeenCalled();

		const payload = (await response.json()) as {
			skipped: number;
			logFailures: number;
			emailsSent: number;
			emailsFailed: number;
			smsSent: number;
			smsFailed: number;
		};
		expect(payload).toEqual({
			skipped: 1,
			logFailures: 0,
			emailsSent: 0,
			emailsFailed: 0,
			smsSent: 0,
			smsFailed: 0,
		});
	});

	it("Rejects malformed cron payloads missing required fields.", async () => {
		const response = await runDailyDigestUser(
			createApiContext({
				request: createCronRequest({
					path: "/api/daily-digest",
					cronSecret: testCronSecret,
					method: "POST",
					body: {
						userId: "123",
					},
				}),
			}),
		);

		expect(response.status).toBe(400);
		expect(processDailyDigestUserMock).not.toHaveBeenCalled();
	});

	it("Rejects requests missing the cron secret.", async () => {
		const response = await runDailyDigestUser(
			createApiContext({
				request: new Request("http://localhost/api/daily-digest", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						userId: "00000000-0000-0000-0000-000000000000",
						currentTimeIso: "2026-01-14T15:00:00.000Z",
					}),
				}),
			}),
		);

		expect(response.status).toBe(401);
		expect(processDailyDigestUserMock).not.toHaveBeenCalled();
	});
});
