import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { POST } from "../../../../src/pages/api/notification-preferences/update";
import { createApiContext } from "../../../helpers/api-context";
import { adminClient, createAuthenticatedCookies } from "../../../helpers/test-env";
import { createTestUser } from "../../../helpers/test-user";
import { registerTestUserForCleanup } from "../../../helpers/test-user-cleanup";

describe("A signed-in user updates their Telegram delivery channel.", () => {
	it("The user routes delivery to Telegram when a chat is linked.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: "TestPassword123!",
			confirmed: true,
			deliveryChannel: "email",
		});
		registerTestUserForCleanup(testUser.id);

		const { error: linkError } = await adminClient
			.from("users")
			.update({
				telegram_chat_id: 8675309,
				telegram_linked_at: new Date().toISOString(),
				delivery_channel: "disabled" as const,
			})
			.eq("id", testUser.id);
		if (linkError) {
			throw new Error(`Failed to link telegram: ${linkError.message}`);
		}

		const cookies = await createAuthenticatedCookies(testUser.email, "TestPassword123!");

		const formData = new FormData();
		formData.append("delivery_channel", "telegram");

		const request = new Request("http://localhost/api/notification-preferences/update", {
			method: "POST",
			body: formData,
		});

		const response = await POST(createApiContext({ request, cookies }));

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			ok: boolean;
			notificationPreferences?: { delivery_channel?: string };
		};
		expect(body.ok).toBe(true);
		expect(body.notificationPreferences?.delivery_channel).toBe("telegram");

		const { data: updatedUser } = await adminClient
			.from("users")
			.select("delivery_channel,telegram_chat_id")
			.eq("id", testUser.id)
			.single();

		expect(updatedUser).not.toBeNull();
		if (!updatedUser) throw new Error("expected user row");
		expect(updatedUser.delivery_channel).toBe("telegram");
		expect(updatedUser.telegram_chat_id).toBe(8675309);
	});

	it("The user disables Telegram delivery without unlinking the chat.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: "TestPassword123!",
			confirmed: true,
			deliveryChannel: "email",
		});
		registerTestUserForCleanup(testUser.id);

		const { error: linkError } = await adminClient
			.from("users")
			.update({
				telegram_chat_id: 8675309,
				telegram_linked_at: new Date().toISOString(),
				delivery_channel: "telegram" as const,
			})
			.eq("id", testUser.id);
		if (linkError) {
			throw new Error(`Failed to link telegram: ${linkError.message}`);
		}

		const cookies = await createAuthenticatedCookies(testUser.email, "TestPassword123!");

		const formData = new FormData();
		formData.append("delivery_channel", "disabled");

		const request = new Request("http://localhost/api/notification-preferences/update", {
			method: "POST",
			body: formData,
		});

		const response = await POST(createApiContext({ request, cookies }));

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			ok: boolean;
			notificationPreferences?: { delivery_channel?: string };
		};
		expect(body.ok).toBe(true);
		expect(body.notificationPreferences?.delivery_channel).toBe("disabled");

		const { data: updatedUser } = await adminClient
			.from("users")
			.select("delivery_channel,telegram_chat_id")
			.eq("id", testUser.id)
			.single();

		expect(updatedUser).not.toBeNull();
		if (!updatedUser) throw new Error("expected user row");
		expect(updatedUser.delivery_channel).toBe("disabled");
		// Link is preserved — mute does not unlink.
		expect(updatedUser.telegram_chat_id).toBe(8675309);
	});

	it("Rejects routing to Telegram when no chat is linked.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: "TestPassword123!",
			confirmed: true,
			deliveryChannel: "email",
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(testUser.email, "TestPassword123!");

		const formData = new FormData();
		formData.append("delivery_channel", "telegram");

		const request = new Request("http://localhost/api/notification-preferences/update", {
			method: "POST",
			body: formData,
		});

		const response = await POST(createApiContext({ request, cookies }));

		expect(response.status).toBe(400);
	});
});
