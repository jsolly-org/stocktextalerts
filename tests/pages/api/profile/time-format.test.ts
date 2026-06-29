import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { POST as updateProfileTimeFormat } from "../../../../src/pages/api/profile/time-format";
import { createApiContext, createFormPostRequest } from "../../../helpers/api-context";
import { TEST_PASSWORD } from "../../../helpers/constants";
import { adminClient, createAuthenticatedCookies } from "../../../helpers/test-env";
import { createTestUser } from "../../../helpers/test-user";
import { registerTestUserForCleanup } from "../../../helpers/test-user-cleanup";

describe("A signed-in user updates profile time display format.", () => {
	it("Persists the 24-hour preference from the profile page.", async () => {
		const testUser = await createTestUser({
			email: `time-format-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const { error: seedError } = await adminClient
			.from("users")
			.update({ use_24_hour_time: false })
			.eq("id", testUser.id);
		expect(seedError).toBeNull();

		const cookies = await createAuthenticatedCookies(testUser.email, TEST_PASSWORD);

		const formData = new FormData();
		formData.append("use_24_hour_time", "on");

		const response = await updateProfileTimeFormat(
			createApiContext({
				request: createFormPostRequest("/api/profile/time-format", formData),
				cookies,
			}),
		);

		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			ok: boolean;
			message: string;
			use_24_hour_time: boolean;
		};
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("settings_updated");
		expect(payload.use_24_hour_time).toBe(true);

		const { data: updatedUser, error } = await adminClient
			.from("users")
			.select("use_24_hour_time")
			.eq("id", testUser.id)
			.single();
		expect(error).toBeNull();
		expect(updatedUser?.use_24_hour_time).toBe(true);
	});

	it("Treats a missing checkbox value as opting out of 24-hour time.", async () => {
		const testUser = await createTestUser({
			email: `time-format-empty-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);

		const { error: seedError } = await adminClient
			.from("users")
			.update({ use_24_hour_time: true })
			.eq("id", testUser.id);
		expect(seedError).toBeNull();

		const cookies = await createAuthenticatedCookies(testUser.email, TEST_PASSWORD);

		const response = await updateProfileTimeFormat(
			createApiContext({
				request: createFormPostRequest("/api/profile/time-format", new FormData()),
				cookies,
			}),
		);

		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			ok: boolean;
			message: string;
			use_24_hour_time: boolean;
		};
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("settings_updated");
		expect(payload.use_24_hour_time).toBe(false);

		const { data: updatedUser, error } = await adminClient
			.from("users")
			.select("use_24_hour_time")
			.eq("id", testUser.id)
			.single();
		expect(error).toBeNull();
		expect(updatedUser?.use_24_hour_time).toBe(false);
	});

	it("Rejects a logged-out profile time-format update request.", async () => {
		const formData = new FormData();
		formData.append("use_24_hour_time", "on");

		const response = await updateProfileTimeFormat(
			createApiContext({
				request: createFormPostRequest("/api/profile/time-format", formData),
			}),
		);

		expect(response.status).toBe(401);
		const payload = (await response.json()) as { ok: boolean; message: string };
		expect(payload.ok).toBe(false);
		expect(payload.message).toBe("unauthorized");
	});
});
