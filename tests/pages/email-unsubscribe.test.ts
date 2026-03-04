import { getContainerRenderer as getVueRenderer } from "@astrojs/vue";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { loadRenderers } from "astro/virtual-modules/container.js";
import { beforeAll, describe, expect, it } from "vitest";
import { createEmailUnsubscribeToken } from "../../src/lib/messaging/email/unsubscribe";
import EmailUnsubscribePage from "../../src/pages/email/unsubscribe.astro";
import { adminClient } from "../helpers/test-env";
import {
	createTestEmail,
	createTestUser,
	generateUniquePhoneNumber,
} from "../helpers/test-user";
import { registerTestUserForCleanup } from "../helpers/test-user-cleanup";

describe("A user clicks the email unsubscribe link.", () => {
	let renderers: Awaited<ReturnType<typeof loadRenderers>>;

	beforeAll(async () => {
		renderers = await loadRenderers([getVueRenderer()]);
	});

	it("Email notifications are disabled while SMS remains enabled.", async () => {
		const user = await createTestUser({
			email: createTestEmail("test"),
			password: "TestPassword123!",
			confirmed: true,
			emailNotificationsEnabled: true,
			smsNotificationsEnabled: true,
			scheduledUpdatesEnabled: true,
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
				"email_notifications_enabled,market_scheduled_asset_price_include_sms",
			)
			.eq("id", user.id)
			.maybeSingle();

		expect(error).toBeNull();
		expect(updated?.email_notifications_enabled).toBe(false);
		expect(updated?.market_scheduled_asset_price_include_sms).toBe(true);
	});

	it("Invalid or expired unsubscribe token does not change user preferences.", async () => {
		const user = await createTestUser({
			email: createTestEmail("invalid-token"),
			password: "TestPassword123!",
			confirmed: true,
			emailNotificationsEnabled: true,
			smsNotificationsEnabled: false,
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
			.select(
				"email_notifications_enabled,market_scheduled_asset_price_include_sms",
			)
			.eq("id", user.id)
			.maybeSingle();

		expect(error).toBeNull();
		expect(updated?.email_notifications_enabled).toBe(false);
		expect(updated?.market_scheduled_asset_price_include_sms).toBe(false);
	});
});
