import { getContainerRenderer as getVueRenderer } from "@astrojs/vue/container-renderer";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { loadRenderers } from "astro/virtual-modules/container.js";
import { beforeAll, describe, expect, it } from "vitest";
import { createEmailUnsubscribeToken } from "../../src/lib/messaging/email/unsubscribe";
import EmailUnsubscribePage from "../../src/pages/unsubscribe.astro";
import { adminClient } from "../helpers/test-env";
import { createTestEmail, createTestUser } from "../helpers/test-user";
import { registerTestUserForCleanup } from "../helpers/test-user-cleanup";

describe("A user clicks the email unsubscribe link.", () => {
	let renderers: Awaited<ReturnType<typeof loadRenderers>>;

	beforeAll(async () => {
		renderers = await loadRenderers([getVueRenderer()]);
	});

	it("Delivery is disabled when the unsubscribe link is clicked.", async () => {
		const user = await createTestUser({
			email: createTestEmail("test"),
			password: "TestPassword123!",
			confirmed: true,
			deliveryChannel: "email",
		});
		registerTestUserForCleanup(user.id);

		const token = createEmailUnsubscribeToken({
			userId: user.id,
			email: user.email,
		});
		const url = new URL("http://localhost/unsubscribe");
		url.searchParams.set("user", user.id);
		url.searchParams.set("token", token);

		const container = await AstroContainer.create({ renderers });
		const response = await container.renderToResponse(EmailUnsubscribePage, {
			request: new Request(url.toString()),
		});

		expect(response.status).toBe(200);

		const { data: updated, error } = await adminClient
			.from("users")
			.select("delivery_channel")
			.eq("id", user.id)
			.maybeSingle();

		expect(error).toBeNull();
		expect(updated?.delivery_channel).toBe("disabled");
	});

	it("Invalid or expired unsubscribe token does not change user preferences.", async () => {
		const user = await createTestUser({
			email: createTestEmail("invalid-token"),
			password: "TestPassword123!",
			confirmed: true,
			deliveryChannel: "email",
		});
		registerTestUserForCleanup(user.id);

		const url = new URL("http://localhost/unsubscribe");
		url.searchParams.set("user", user.id);
		url.searchParams.set("token", "invalid-token-value");

		const container = await AstroContainer.create({ renderers });
		const response = await container.renderToResponse(EmailUnsubscribePage, {
			request: new Request(url.toString()),
		});

		expect(response.status).toBe(200);

		const { data: updated, error } = await adminClient
			.from("users")
			.select("delivery_channel")
			.eq("id", user.id)
			.maybeSingle();

		expect(error).toBeNull();
		expect(updated?.delivery_channel).toBe("email");
	});

	it("does not mute Telegram delivery when the email unsubscribe link is clicked", async () => {
		const user = await createTestUser({
			email: createTestEmail("telegram-unsub"),
			password: "TestPassword123!",
			confirmed: true,
			deliveryChannel: "email",
		});
		registerTestUserForCleanup(user.id);

		const { error: routeError } = await adminClient
			.from("users")
			.update({
				delivery_channel: "telegram",
				telegram_chat_id: 991234570,
			})
			.eq("id", user.id);
		expect(routeError).toBeNull();

		const token = createEmailUnsubscribeToken({
			userId: user.id,
			email: user.email,
		});
		const url = new URL("http://localhost/unsubscribe");
		url.searchParams.set("user", user.id);
		url.searchParams.set("token", token);

		const container = await AstroContainer.create({ renderers });
		const response = await container.renderToResponse(EmailUnsubscribePage, {
			request: new Request(url.toString()),
		});

		expect(response.status).toBe(200);

		const { data: updated, error } = await adminClient
			.from("users")
			.select("delivery_channel")
			.eq("id", user.id)
			.maybeSingle();

		expect(error).toBeNull();
		expect(updated?.delivery_channel).toBe("telegram");
	});

	it("leaves an already-disabled account unchanged", async () => {
		const user = await createTestUser({
			email: createTestEmail("disabled-unsub"),
			password: "TestPassword123!",
			confirmed: true,
			deliveryChannel: "disabled",
		});
		registerTestUserForCleanup(user.id);

		const token = createEmailUnsubscribeToken({
			userId: user.id,
			email: user.email,
		});
		const url = new URL("http://localhost/unsubscribe");
		url.searchParams.set("user", user.id);
		url.searchParams.set("token", token);

		const container = await AstroContainer.create({ renderers });
		const response = await container.renderToResponse(EmailUnsubscribePage, {
			request: new Request(url.toString()),
		});

		expect(response.status).toBe(200);

		const { data: updated, error } = await adminClient
			.from("users")
			.select("delivery_channel")
			.eq("id", user.id)
			.maybeSingle();

		expect(error).toBeNull();
		expect(updated?.delivery_channel).toBe("disabled");
	});
});
