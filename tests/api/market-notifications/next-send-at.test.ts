import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../../src/pages/api/market-notifications/next-send-at";
import { createApiContext } from "../../helpers/api-context";
import { TEST_PASSWORD } from "../../helpers/constants";
import { createAuthenticatedCookies } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

vi.mock("../../../src/lib/time/market-scheduled-next-send", () => ({
	calculateNextMarketScheduledSendAtFromTimes: vi.fn().mockResolvedValue({
		nextSendAt: DateTime.fromISO("2026-02-16T14:30:00.000Z"),
		delayReasons: [],
		holidayName: undefined,
	}),
}));

describe("An authenticated user requests the next market notification send time.", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("The API returns the computed next send time for valid timezone and times.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: TEST_PASSWORD,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			TEST_PASSWORD,
		);

		const request = new Request(
			"http://localhost/api/market-notifications/next-send-at",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					timezone: "America/New_York",
					timeInputs: ["09:30"],
				}),
			},
		);

		const response = await POST(
			createApiContext({
				request,
				cookies,
			}),
		);

		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			ok: boolean;
			message: string;
			nextSendAtIso: string | null;
			delayReasons: unknown[];
			holidayName?: string;
		};
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("ok");
		// Compare as UTC millis so the assertion is timezone-representation-agnostic.
		const nextSendAtIso = payload.nextSendAtIso;
		expect(nextSendAtIso).not.toBeNull();
		expect(DateTime.fromISO(nextSendAtIso as string).toMillis()).toBe(
			DateTime.fromISO("2026-02-16T14:30:00.000Z").toMillis(),
		);
		expect(payload.delayReasons).toEqual([]);
	});
});
