import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { POST as updateFormatPreferences } from "../../../src/pages/api/format-preferences/update";
import {
	createApiContext,
	createFormPostRequest,
} from "../../helpers/api-context";
import { TEST_PASSWORD } from "../../helpers/constants";
import {
	adminClient,
	createAuthenticatedCookies,
} from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

describe("A signed-in user updates format preferences from dashboard previews.", () => {
	it("Saves the show-sparklines toggle and returns the updated snapshot.", async () => {
		const testUser = await createTestUser({
			email: `format-pref-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			TEST_PASSWORD,
		);

		const formData = new FormData();
		formData.append("show_sparklines", "off");

		const response = await updateFormatPreferences(
			createApiContext({
				request: createFormPostRequest(
					"/api/format-preferences/update",
					formData,
				),
				cookies,
			}),
		);

		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			ok: boolean;
			message: string;
			formatPreferences: {
				show_sparklines: boolean;
			};
		};
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("settings_updated");
		expect(payload.formatPreferences.show_sparklines).toBe(false);

		const { data: updatedUser, error } = await adminClient
			.from("users")
			.select("show_sparklines")
			.eq("id", testUser.id)
			.single();
		expect(error).toBeNull();
		expect(updatedUser?.show_sparklines).toBe(false);
	});

	it("Rejects a logged-out format update request.", async () => {
		const formData = new FormData();
		formData.append("show_sparklines", "on");

		const response = await updateFormatPreferences(
			createApiContext({
				request: createFormPostRequest(
					"/api/format-preferences/update",
					formData,
				),
			}),
		);

		expect(response.status).toBe(401);
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload.ok).toBe(false);
		expect(payload.message).toBe("unauthorized");
	});
});
