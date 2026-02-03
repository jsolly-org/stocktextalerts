import { getContainerRenderer as getVueRenderer } from "@astrojs/vue";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { loadRenderers } from "astro/virtual-modules/container.js";
import { beforeAll, describe, expect, it } from "vitest";
import { createEmailUnsubscribeToken } from "../../src/lib/notifications/email-unsubscribe";
import EmailUnsubscribePage from "../../src/pages/email/unsubscribe.astro";
import { registerTestUserForCleanup } from "../setup";
import {
	adminClient,
	createTestEmail,
	createTestUser,
	generateUniquePhoneNumber,
} from "../shared-utils";

describe("A user clicks the email unsubscribe link.", () => {
	let renderers: Awaited<ReturnType<typeof loadRenderers>>;

	beforeAll(async () => {
		renderers = await loadRenderers([getVueRenderer()]);
	});

	it("Email notifications are disabled while daily digest remains enabled.", async () => {
		const user = await createTestUser({
			email: createTestEmail("test"),
			password: "TestPassword123!",
			confirmed: true,
			emailNotificationsEnabled: true,
			smsNotificationsEnabled: true,
			dailyDigestEnabled: true,
			phoneCountryCode: "+1",
			phoneNumber: generateUniquePhoneNumber(),
		});
		registerTestUserForCleanup(user.id);

		const token = createEmailUnsubscribeToken({
			userId: user.id,
			email: user.email,
		});
		const url = new URL("http://localhost/email/unsubscribe");
		url.searchParams.set("user", user.id);
		url.searchParams.set("token", token);

		const container = await AstroContainer.create({ renderers });
		const response = await container.renderToResponse(EmailUnsubscribePage, {
			request: new Request(url.toString()),
		});

		expect(response.status).toBe(200);

		const { data: updated, error } = await adminClient
			.from("users")
			.select(
				"email_notifications_enabled,daily_digest_enabled,sms_notifications_enabled",
			)
			.eq("id", user.id)
			.maybeSingle();

		expect(error).toBeNull();
		expect(updated?.email_notifications_enabled).toBe(false);
		expect(updated?.daily_digest_enabled).toBe(true);
		expect(updated?.sms_notifications_enabled).toBe(true);
	});

	it("Email unsubscribe can also disable SMS when requested.", async () => {
		const user = await createTestUser({
			email: createTestEmail("sms-unsub"),
			password: "TestPassword123!",
			confirmed: true,
			emailNotificationsEnabled: true,
			smsNotificationsEnabled: true,
			phoneCountryCode: "+1",
			phoneNumber: generateUniquePhoneNumber(),
		});
		registerTestUserForCleanup(user.id);

		const token = createEmailUnsubscribeToken({
			userId: user.id,
			email: user.email,
		});
		const url = new URL("http://localhost/email/unsubscribe");
		url.searchParams.set("user", user.id);
		url.searchParams.set("token", token);
		url.searchParams.set("sms", "true");

		const container = await AstroContainer.create({ renderers });
		const response = await container.renderToResponse(EmailUnsubscribePage, {
			request: new Request(url.toString()),
		});

		expect(response.status).toBe(200);

		const { data: updated, error } = await adminClient
			.from("users")
			.select("email_notifications_enabled,sms_notifications_enabled")
			.eq("id", user.id)
			.maybeSingle();

		expect(error).toBeNull();
		expect(updated?.email_notifications_enabled).toBe(false);
		expect(updated?.sms_notifications_enabled).toBe(false);
	});
});
