import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { POST } from "../../../../src/pages/api/notification-preferences/update";
import { createApiContext } from "../../../helpers/api-context";
import { adminClient, createAuthenticatedCookies } from "../../../helpers/test-env";
import { createTestUser } from "../../../helpers/test-user";
import { registerTestUserForCleanup } from "../../../helpers/test-user-cleanup";

describe("A signed-in user updates their account delivery channel.", () => {
	it("The user routes delivery to email.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: "TestPassword123!",
			confirmed: true,
			deliveryChannel: "disabled",
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(testUser.email, "TestPassword123!");

		const formData = new FormData();
		formData.append("delivery_channel", "email");

		const request = new Request("http://localhost/api/notification-preferences/update", {
			method: "POST",
			body: formData,
		});

		const response = await POST(createApiContext({ request, cookies }));

		expect(response.status).toBe(200);

		const { data: updatedUser } = await adminClient
			.from("users")
			.select("delivery_channel")
			.eq("id", testUser.id)
			.single();

		expect(updatedUser).not.toBeNull();
		if (!updatedUser) throw new Error("expected user row");
		expect(updatedUser.delivery_channel).toBe("email");
	});

	it("The user disables delivery.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: "TestPassword123!",
			confirmed: true,
			deliveryChannel: "email",
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(testUser.email, "TestPassword123!");

		const formData = new FormData();
		formData.append("delivery_channel", "disabled");

		const request = new Request("http://localhost/api/notification-preferences/update", {
			method: "POST",
			body: formData,
		});

		const response = await POST(createApiContext({ request, cookies }));

		expect(response.status).toBe(200);

		const { data: updatedUser } = await adminClient
			.from("users")
			.select("delivery_channel")
			.eq("id", testUser.id)
			.single();

		expect(updatedUser).not.toBeNull();
		if (!updatedUser) throw new Error("expected user row");
		expect(updatedUser.delivery_channel).toBe("disabled");
	});
});
