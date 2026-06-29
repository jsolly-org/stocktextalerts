import { getContainerRenderer as getVueRenderer } from "@astrojs/vue/container-renderer";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { loadRenderers } from "astro/virtual-modules/container.js";
import { beforeAll, describe, expect, it } from "vitest";
import { createEmailUnsubscribeToken } from "../../src/lib/messaging/email/unsubscribe";
import EmailUnsubscribePage from "../../src/pages/email/unsubscribe.astro";
import { adminClient } from "../helpers/test-env";
import { createTestEmail, createTestUser, generateUniquePhoneNumber } from "../helpers/test-user";
import { registerTestUserForCleanup } from "../helpers/test-user-cleanup";

describe("A user clicks the email unsubscribe link.", () => {
	let renderers: Awaited<ReturnType<typeof loadRenderers>>;

	beforeAll(async () => {
		renderers = await loadRenderers([getVueRenderer()]);
	});

	// The scheduled-price SMS facet now lives in notification_preferences
	// (the dropped users.market_scheduled_asset_price_include_sms column).
	async function readScheduledSmsEnabled(userId: string): Promise<boolean | null> {
		const { data } = await adminClient
			.from("notification_preferences")
			.select("enabled")
			.eq("user_id", userId)
			.eq("notification_type", "market_scheduled_asset_price")
			.eq("content", "")
			.eq("channel", "sms")
			.maybeSingle();
		return data?.enabled ?? null;
	}

	it("Email notifications are disabled while SMS remains enabled.", async () => {
		const user = await createTestUser({
			email: createTestEmail("test"),
			password: "TestPassword123!",
			confirmed: true,
			emailNotificationsEnabled: true,
			smsNotificationsEnabled: true,
			phoneVerified: true,
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
			.select("email_notifications_enabled")
			.eq("id", user.id)
			.maybeSingle();

		expect(error).toBeNull();
		expect(updated?.email_notifications_enabled).toBe(false);
		expect(await readScheduledSmsEnabled(user.id)).toBe(true);
	});

	it("Invalid or expired unsubscribe token does not change user preferences.", async () => {
		const user = await createTestUser({
			email: createTestEmail("invalid-token"),
			password: "TestPassword123!",
			confirmed: true,
			emailNotificationsEnabled: true,
			smsNotificationsEnabled: true,
			phoneCountryCode: "+1",
			phoneNumber: generateUniquePhoneNumber(),
			marketScheduledAssetPriceIncludeSms: true,
		});
		registerTestUserForCleanup(user.id);

		const url = new URL("http://localhost/email/unsubscribe");
		url.searchParams.set("user", user.id);
		url.searchParams.set("token", "invalid-token-value");

		const container = await AstroContainer.create({ renderers });
		const response = await container.renderToResponse(EmailUnsubscribePage, {
			request: new Request(url.toString()),
		});

		expect(response.status).toBe(200);

		const { data: updated, error } = await adminClient
			.from("users")
			.select("email_notifications_enabled")
			.eq("id", user.id)
			.maybeSingle();

		expect(error).toBeNull();
		expect(updated?.email_notifications_enabled).toBe(true);
		expect(await readScheduledSmsEnabled(user.id)).toBe(true);
	});

	it("SMS opt-out is not offered when phone is not verified.", async () => {
		const user = await createTestUser({
			email: createTestEmail("no-phone-verified"),
			password: "TestPassword123!",
			confirmed: true,
			emailNotificationsEnabled: true,
			smsNotificationsEnabled: true,
			phoneVerified: false,
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
		const html = await response.text();
		expect(html).not.toContain("Also unsubscribe from SMS");
	});

	it("Email unsubscribe can also disable SMS when requested.", async () => {
		const user = await createTestUser({
			email: createTestEmail("sms-unsub"),
			password: "TestPassword123!",
			confirmed: true,
			emailNotificationsEnabled: true,
			smsNotificationsEnabled: true,
			phoneVerified: true,
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
			.select("email_notifications_enabled")
			.eq("id", user.id)
			.maybeSingle();

		expect(error).toBeNull();
		expect(updated?.email_notifications_enabled).toBe(false);
		expect(await readScheduledSmsEnabled(user.id)).toBe(false);
	});
});
