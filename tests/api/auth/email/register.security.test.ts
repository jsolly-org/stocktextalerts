import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MIN_PASSWORD_LENGTH } from "../../../../src/lib/auth-constants";
import { POST } from "../../../../src/pages/api/auth/email/register";
import { createApiContext } from "../../../helpers/api-context";

vi.mock("../../../../src/lib/auth-constants", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../../src/lib/auth-constants")>();
	return { ...actual, REGISTRATION_ENABLED: true };
});

describe("A visitor attempts to register with an invalid password.", () => {
	it("The request is rejected when the password is shorter than the minimum length.", async () => {
		const shortPassword = "a".repeat(MIN_PASSWORD_LENGTH - 1);
		const request = new Request("http://localhost/api/auth/email/register", {
			method: "POST",
			body: new URLSearchParams({
				email: `test-${randomUUID()}@example.com`,
				password: shortPassword,
				timezone: "America/New_York",
			}),
		});

		const response = await POST(createApiContext({ request }));

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toContain("/auth/register?error=weak_password");
	});
});
