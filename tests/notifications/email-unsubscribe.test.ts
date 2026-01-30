import { loadRenderers } from "astro:container";
import { getContainerRenderer as getVueRenderer } from "@astrojs/vue";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeAll, describe, expect, it } from "vitest";
import { createEmailUnsubscribeToken } from "../../src/lib/notifications/email-unsubscribe";
import EmailUnsubscribePage from "../../src/pages/email/unsubscribe.astro";
import { adminClient } from "../setup";
import { cleanupTestUser, createTestEmail, createTestUser } from "../utils";

describe("Email unsubscribe", () => {
	let renderers: Awaited<ReturnType<typeof loadRenderers>>;

	beforeAll(async () => {
		renderers = await loadRenderers([getVueRenderer()]);
	});

	it("disables email notifications without changing digest", async () => {
		const user = await createTestUser({
			email: createTestEmail("test"),
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
			await cleanupTestUser(user.id);
		}
	});
});
