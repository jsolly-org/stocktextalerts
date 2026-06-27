import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { TEST_PASSWORD } from "../helpers/constants";
import { postInboundSms } from "../helpers/e2e/twilio-inbound";
import { adminClient } from "../helpers/test-env";
import { cleanupTestUser, createTestUser, generateUniquePhoneNumber } from "../helpers/test-user";

test.describe("inbound SMS webhook", () => {
	test("TC-INBOUND-001: Inbound SMS keywords update user preferences", async ({ baseURL }) => {
		const inboundUser = await createTestUser({
			email: `inbound-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
			smsNotificationsEnabled: true,
			phoneCountryCode: "+1",
			phoneNumber: generateUniquePhoneNumber(),
			phoneVerified: true,
			marketScheduledAssetPriceIncludeSms: true,
		});

		try {
			const { data, error } = await adminClient
				.from("users")
				.select("phone_country_code,phone_number")
				.eq("id", inboundUser.id)
				.single();
			if (error) {
				throw new Error(`Failed to read inbound user phone: ${error.message}`);
			}
			const inboundUserPhone = `${data.phone_country_code}${data.phone_number}`;

			const authToken = process.env.TWILIO_AUTH_TOKEN ?? "stubaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

			const webhookOrigin = (baseURL ?? "http://localhost:4322").replace(/\/+$/, "");
			const signatureUrl = `${webhookOrigin}/api/messaging/inbound`;

			const helpResponse = await postInboundSms(signatureUrl, authToken, inboundUserPhone, "HELP");
			expect(helpResponse.status).toBe(200);
			await expect(helpResponse.text()).resolves.toContain("Reply STOP");

			const stopResponse = await postInboundSms(signatureUrl, authToken, inboundUserPhone, "STOP");
			expect(stopResponse.status).toBe(200);

			const { data: afterStop, error: stopError } = await adminClient
				.from("users")
				.select("sms_opted_out,sms_notifications_enabled")
				.eq("id", inboundUser.id)
				.single();
			if (stopError) {
				throw new Error(`Failed to validate STOP state: ${stopError.message}`);
			}
			expect(afterStop.sms_opted_out).toBe(true);
			expect(afterStop.sms_notifications_enabled).toBe(false);

			const startResponse = await postInboundSms(
				signatureUrl,
				authToken,
				inboundUserPhone,
				"START",
			);
			expect(startResponse.status).toBe(200);

			const { data: afterStart, error: startError } = await adminClient
				.from("users")
				.select("sms_opted_out,sms_notifications_enabled")
				.eq("id", inboundUser.id)
				.single();
			if (startError) {
				throw new Error(`Failed to validate START state: ${startError.message}`);
			}
			expect(afterStart.sms_opted_out).toBe(false);
			expect(afterStart.sms_notifications_enabled).toBe(true);
		} finally {
			await cleanupTestUser(inboundUser.id);
		}
	});
});
