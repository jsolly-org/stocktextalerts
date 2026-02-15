import { randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { POST } from "../../../src/pages/api/notification-preferences/update";
import { TEST_PASSWORD } from "../../helpers/constants";
import {
	adminClient,
	createAuthenticatedCookies,
} from "../../helpers/test-env";
import {
	createTestUser,
	generateUniquePhoneNumber,
} from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

describe("A signed-in opted-out user attempts to re-enable SMS options.", () => {
	it("When sms_opted_out is true, SMS include flags cannot be enabled.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: TEST_PASSWORD,
			confirmed: true,
			smsNotificationsEnabled: false,
			smsOptedOut: true,
			phoneVerified: true,
			phoneCountryCode: "+1",
			phoneNumber: generateUniquePhoneNumber(),
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			TEST_PASSWORD,
		);

		const formData = new FormData();
		formData.append("market_asset_price_alerts_include_sms", "true");

		const request = new Request(
			"http://localhost/api/notification-preferences/update",
			{
				method: "POST",
				body: formData,
				headers: { Accept: "application/json" },
			},
		);

		const response = await POST({
			request,
			cookies: {
				get: (name: string) => {
					const cookie = cookies.get(name);
					return cookie ? { value: cookie } : undefined;
				},
				set: () => {},
			},
		} as unknown as APIContext);

		expect(response.status).toBe(400);
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload.ok).toBe(false);
		expect(payload.message).toBe("sms_opted_out");

		const { data: updatedUser } = await adminClient
			.from("users")
			.select("market_asset_price_alerts_include_sms")
			.eq("id", testUser.id)
			.single();
		expect(updatedUser).not.toBeNull();
		if (!updatedUser) throw new Error("expected user row");
		expect(updatedUser.market_asset_price_alerts_include_sms).toBe(false);
	});
});
