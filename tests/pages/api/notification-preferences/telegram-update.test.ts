import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { POST } from "../../../../src/pages/api/notification-preferences/update";
import { createApiContext } from "../../../helpers/api-context";
import { adminClient, createAuthenticatedCookies } from "../../../helpers/test-env";
import { createTestUser } from "../../../helpers/test-user";
import { registerTestUserForCleanup } from "../../../helpers/test-user-cleanup";

describe("A signed-in user updates their Telegram notification preference.", () => {
	it("The user enables Telegram notifications (clears telegram_opted_out).", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: "TestPassword123!",
			confirmed: true,
			emailNotificationsEnabled: true,
		});
		registerTestUserForCleanup(testUser.id);

		const { error: linkError } = await adminClient
			.from("users")
			.update({
				telegram_chat_id: 8675309,
				telegram_linked_at: new Date().toISOString(),
				telegram_opted_out: true,
			})
			.eq("id", testUser.id);
		if (linkError) {
			throw new Error(`Failed to link telegram: ${linkError.message}`);
		}

		const cookies = await createAuthenticatedCookies(testUser.email, "TestPassword123!");

		const formData = new FormData();
		formData.append("telegram_notifications_enabled", "true");

		const request = new Request("http://localhost/api/notification-preferences/update", {
			method: "POST",
			body: formData,
		});

		const response = await POST(createApiContext({ request, cookies }));

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			ok: boolean;
			notificationPreferences?: { telegram_notifications_enabled?: boolean };
		};
		expect(body.ok).toBe(true);
		expect(body.notificationPreferences?.telegram_notifications_enabled).toBe(true);

		const { data: updatedUser } = await adminClient
			.from("users")
			.select("telegram_opted_out,telegram_chat_id")
			.eq("id", testUser.id)
			.single();

		expect(updatedUser).not.toBeNull();
		if (!updatedUser) throw new Error("expected user row");
		expect(updatedUser.telegram_opted_out).toBe(false);
		expect(updatedUser.telegram_chat_id).toBe(8675309);
	});

	it("The user disables Telegram notifications (sets telegram_opted_out).", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: "TestPassword123!",
			confirmed: true,
			emailNotificationsEnabled: true,
		});
		registerTestUserForCleanup(testUser.id);

		const { error: linkError } = await adminClient
			.from("users")
			.update({
				telegram_chat_id: 8675309,
				telegram_linked_at: new Date().toISOString(),
				telegram_opted_out: false,
			})
			.eq("id", testUser.id);
		if (linkError) {
			throw new Error(`Failed to link telegram: ${linkError.message}`);
		}

		const cookies = await createAuthenticatedCookies(testUser.email, "TestPassword123!");

		const formData = new FormData();
		formData.append("telegram_notifications_enabled", "false");

		const request = new Request("http://localhost/api/notification-preferences/update", {
			method: "POST",
			body: formData,
		});

		const response = await POST(createApiContext({ request, cookies }));

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			ok: boolean;
			notificationPreferences?: { telegram_notifications_enabled?: boolean };
		};
		expect(body.ok).toBe(true);
		expect(body.notificationPreferences?.telegram_notifications_enabled).toBe(false);

		const { data: updatedUser } = await adminClient
			.from("users")
			.select("telegram_opted_out,telegram_chat_id")
			.eq("id", testUser.id)
			.single();

		expect(updatedUser).not.toBeNull();
		if (!updatedUser) throw new Error("expected user row");
		expect(updatedUser.telegram_opted_out).toBe(true);
		// Link is preserved — mute does not unlink.
		expect(updatedUser.telegram_chat_id).toBe(8675309);
	});
});
