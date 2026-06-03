import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../../../src/pages/api/auth/email/register";
import { createApiContext } from "../../../helpers/api-context";
import { TEST_PASSWORD, TEST_REGISTRATION_SECRET } from "../../../helpers/constants";
import { adminClient } from "../../../helpers/test-env";
import { expectConsoleError } from "../../../setup";

vi.mock("../../../../src/lib/constants", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../../src/lib/constants")>();
	return { ...actual, REGISTRATION_ENABLED: true };
});

describe("A visitor must provide the registration password before an account is created.", () => {
	beforeEach(() => {
		vi.stubEnv("REGISTRATION_SECRET_PASSWORD", TEST_REGISTRATION_SECRET);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("The request is rejected when the registration password is wrong and no auth user is created.", async () => {
		const email = `test-wrong-secret-${randomUUID()}@example.com`;
		const request = new Request("http://localhost/api/auth/email/register", {
			method: "POST",
			body: new URLSearchParams({
				registration_password: "not-the-secret",
				email,
				password: TEST_PASSWORD,
				confirm: TEST_PASSWORD,
				timezone: "America/New_York",
			}),
		});

		const response = await POST(createApiContext({ request }));

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toContain(
			"/auth/register?error=invalid_registration_password",
		);

		const { data: users, error } = await adminClient.from("users").select("id").eq("email", email);
		expect(error).toBeNull();
		expect(users).toHaveLength(0);
	});

	it("The request is rejected when the registration secret env var is not configured.", async () => {
		expectConsoleError("Registration secret password is not configured");
		vi.unstubAllEnvs();
		const email = `test-no-secret-env-${randomUUID()}@example.com`;
		const request = new Request("http://localhost/api/auth/email/register", {
			method: "POST",
			body: new URLSearchParams({
				registration_password: TEST_REGISTRATION_SECRET,
				email,
				password: TEST_PASSWORD,
				confirm: TEST_PASSWORD,
				timezone: "America/New_York",
			}),
		});

		const response = await POST(createApiContext({ request }));

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toContain(
			"/auth/register?error=registration_unavailable",
		);

		const { data: users, error } = await adminClient.from("users").select("id").eq("email", email);
		expect(error).toBeNull();
		expect(users).toHaveLength(0);
	});
});
