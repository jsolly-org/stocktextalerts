/**
 * Vitest tests for the staged notification delivery pipeline (deliver.ts).
 *
 * Covers: empty-result when no rows are due. Daily-digest staging delivery is
 * exercised via the daily-digest integration tests; market-type staging was
 * removed when scheduled-market delivery moved fully inline.
 */
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/time/market-calendar", () => ({
	getUsMarketClosureInfoForInstant: vi.fn().mockResolvedValue(null),
}));

import { createLogger } from "../../../src/lib/logging";
import { createEmailSender, type EmailSender } from "../../../src/lib/messaging/email/utils";
import {
	createSmsSenderProvider,
	type SmsSenderProvider,
} from "../../../src/lib/schedule/sms-sender";
import { deliverStagedNotifications } from "../../../src/lib/staged-notifications/deliver";
import { adminClient } from "../../helpers/test-env";

describe("deliverStagedNotifications", () => {
	const logger = createLogger({ path: "staged-deliver-test" });
	let sendEmail: EmailSender;
	let getSmsSender: SmsSenderProvider;
	// Fake timers are skipped when live email routing is on. nodemailer's
	// SMTP client uses setTimeout internally for connect timeouts and
	// rate limiting, and `vi.useFakeTimers()` freezes setTimeout — the
	// SMTP handshake never fires, and the test deadlocks. Previously this
	// gate was keyed on the (now-removed) live SES path; it's the same
	// fix for a different reason.
	const useFakeTimers = !process.env.EMAIL_SMTP_HOST;

	beforeEach(() => {
		if (useFakeTimers) {
			vi.useFakeTimers();
			vi.setSystemTime(DateTime.fromISO("2026-01-15T15:00:00.000Z").toJSDate());
		}
		vi.stubEnv("SMS_TEST_BEHAVIOR", "success");

		sendEmail = createEmailSender();
		getSmsSender = createSmsSenderProvider();
	});

	afterEach(() => {
		if (useFakeTimers) {
			vi.useRealTimers();
		}
		vi.unstubAllEnvs();
	});

	it("returns empty deliveredUserTypes when no staged rows are due", async () => {
		// Explicitly clear staged rows to avoid depending on cleanup order from prior tests.
		const { data: stagedRows } = await adminClient.from("staged_notifications").select("id");
		if (stagedRows && stagedRows.length > 0) {
			await adminClient
				.from("staged_notifications")
				.delete()
				.in(
					"id",
					stagedRows.map((r) => r.id),
				);
		}

		const result = await deliverStagedNotifications({
			supabase: adminClient,
			logger,
			currentTime: DateTime.utc(),
			sendEmail,
			getSmsSender,
		});

		expect(result.deliveredUserTypes.size).toBe(0);
		expect(result.stats.emailsSent).toBe(0);
		expect(result.stats.smsSent).toBe(0);
	});
});
