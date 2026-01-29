import { loadRenderers } from "astro:container";
import { randomUUID } from "node:crypto";
import { getContainerRenderer as getVueRenderer } from "@astrojs/vue";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeAll, describe, expect, it } from "vitest";
import { createEmailUnsubscribeToken } from "../../src/lib/notifications/email-unsubscribe";
import EmailUnsubscribePage from "../../src/pages/email/unsubscribe.astro";
import { adminClient } from "../setup";
import { createTestUser } from "../utils";

describe("Email unsubscribe", () => {
	let renderers: Awaited<ReturnType<typeof loadRenderers>>;

	beforeAll(async () => {
		renderers = await loadRenderers([getVueRenderer()]);
	});

	it("disables email notifications without changing digest", async () => {
		const user = await createTestUser({
			email: `test-${randomUUID()}@resend.dev`,
			password: "TestPassword123!",
			confirmed: true,
			emailNotificationsEnabled: true,
			dailyDigestEnabled: true,
		});

		try {
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
				.select("email_notifications_enabled,daily_digest_enabled")
				.eq("id", user.id)
				.maybeSingle();

			expect(error).toBeNull();
			expect(updated?.email_notifications_enabled).toBe(false);
			expect(updated?.daily_digest_enabled).toBe(true);
		} finally {
			const cleanupErrors: string[] = [];
			const { error: userStocksError } = await adminClient
				.from("user_stocks")
				.delete()
				.eq("user_id", user.id);
			if (userStocksError) {
				cleanupErrors.push(
					`Failed to cleanup test user stocks (${user.id}): ${userStocksError.message}`,
				);
			}

			const { error: userRowError } = await adminClient
				.from("users")
				.delete()
				.eq("id", user.id);
			if (userRowError) {
				cleanupErrors.push(
					`Failed to cleanup test user (${user.id}): ${userRowError.message}`,
				);
			}

			const { error: authDeleteError } =
				await adminClient.auth.admin.deleteUser(user.id);
			if (authDeleteError) {
				cleanupErrors.push(
					`Failed to cleanup auth user (${user.id}): ${authDeleteError.message}`,
				);
			}

			expect(cleanupErrors, "Test user cleanup failed").toEqual([]);
		}
	});
});
