import { randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { POST as POSTDismissBanner } from "../../../src/pages/api/notification-preferences/dismiss-timezone-banner";
import { POST as POSTTimezone } from "../../../src/pages/api/notification-preferences/timezone";
import { TEST_PASSWORD } from "../../helpers/constants";
import {
	adminClient,
	createAuthenticatedCookies,
} from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

describe("A signed-in user dismisses the timezone mismatch banner.", () => {
	it("The banner dismissal is saved so it no longer appears.", async () => {
		const testUser = await createTestUser({
			email: `test-dismiss-banner-${randomUUID()}@resend.dev`,
			password: TEST_PASSWORD,
			confirmed: true,
			timezone: "America/New_York",
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			TEST_PASSWORD,
		);

		const request = new Request(
			"http://localhost/api/notification-preferences/dismiss-timezone-banner",
			{
				method: "POST",
			},
		);

		const response = await POSTDismissBanner({
			request,
			cookies: {
				get: (name: string) => {
					const cookie = cookies.get(name);
					return cookie ? { value: cookie } : undefined;
				},
				set: () => {},
			},
		} as unknown as APIContext);

		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json.ok).toBe(true);
		expect(json.message).toBe("timezone_banner_dismissed");

		const { data: updatedUser, error } = await adminClient
			.from("users")
			.select("dismiss_timezone_mismatch_prompts")
			.eq("id", testUser.id)
			.single();

		expect(error).toBeNull();
		expect(updatedUser).not.toBeNull();
		expect(updatedUser.dismiss_timezone_mismatch_prompts).toBe(true);
	});
});

describe("A signed-in user updates their timezone.", () => {
	it("The new timezone is saved and the user sees a confirmation.", async () => {
		const testUser = await createTestUser({
			email: `test-timezone-${randomUUID()}@resend.dev`,
			password: TEST_PASSWORD,
			confirmed: true,
			timezone: "America/New_York",
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			TEST_PASSWORD,
		);

		const formData = new FormData();
		formData.append("timezone", "Etc/UTC");

		const request = new Request(
			"http://localhost/api/notification-preferences/timezone",
			{
				method: "POST",
				body: formData,
			},
		);

		const response = await POSTTimezone({
			request,
			cookies: {
				get: (name: string) => {
					const cookie = cookies.get(name);
					return cookie ? { value: cookie } : undefined;
				},
				set: () => {},
			},
		} as unknown as APIContext);

		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json.ok).toBe(true);
		expect(json.message).toBe("timezone_updated");
		expect(json.notificationPreferences.timezone).toBe("Etc/UTC");

		const { data: updatedUser, error } = await adminClient
			.from("users")
			.select("timezone")
			.eq("id", testUser.id)
			.single();

		expect(error).toBeNull();
		expect(updatedUser).not.toBeNull();
		expect(updatedUser.timezone).toBe("Etc/UTC");
	});

	it("Changing timezone recomputes next_send_at for scheduled updates so delivery aligns with user's local time.", async () => {
		const testUser = await createTestUser({
			email: `test-tz-next-${randomUUID()}@resend.dev`,
			password: TEST_PASSWORD,
			confirmed: true,
			timezone: "America/New_York",
			scheduledUpdateTimes: [9 * 60], // 09:00 local
			trackedAssets: ["AAPL"],
		});
		registerTestUserForCleanup(testUser.id);

		const { data: beforeTz } = await adminClient
			.from("users")
			.select(
				"timezone,market_scheduled_asset_price_next_send_at,market_scheduled_asset_price_times",
			)
			.eq("id", testUser.id)
			.single();
		expect(beforeTz?.market_scheduled_asset_price_next_send_at).toBeTruthy();
		const nextSendAtBefore =
			beforeTz?.market_scheduled_asset_price_next_send_at;

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			TEST_PASSWORD,
		);

		const formData = new FormData();
		formData.append("timezone", "America/Los_Angeles");

		const request = new Request(
			"http://localhost/api/notification-preferences/timezone",
			{
				method: "POST",
				body: formData,
			},
		);

		const response = await POSTTimezone({
			request,
			cookies: {
				get: (name: string) => {
					const cookie = cookies.get(name);
					return cookie ? { value: cookie } : undefined;
				},
				set: () => {},
			},
		} as unknown as APIContext);

		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json.ok).toBe(true);
		expect(json.notificationPreferences.timezone).toBe("America/Los_Angeles");
		expect(
			json.notificationPreferences.market_scheduled_asset_price_next_send_at,
		).toBeTruthy();

		// 9am Eastern and 9am Pacific are 3 hours apart in UTC — next_send_at must change
		const nextSendAtAfter =
			json.notificationPreferences.market_scheduled_asset_price_next_send_at;
		expect(nextSendAtAfter).not.toBe(nextSendAtBefore);

		const { data: updatedUser } = await adminClient
			.from("users")
			.select("timezone,market_scheduled_asset_price_next_send_at")
			.eq("id", testUser.id)
			.single();
		expect(updatedUser?.timezone).toBe("America/Los_Angeles");
		expect(updatedUser?.market_scheduled_asset_price_next_send_at).toBe(
			nextSendAtAfter,
		);
	});
});
