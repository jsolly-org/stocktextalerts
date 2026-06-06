import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { POST } from "../../../../src/pages/api/auth/email/register";
import { createApiContext } from "../../../helpers/api-context";
import { TEST_PASSWORD } from "../../../helpers/constants";

vi.mock("../../../../src/lib/constants", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../../src/lib/constants")>();
	return { ...actual, REGISTRATION_ENABLED: false };
});

describe("Registration is closed when the product flag is disabled.", () => {
	it("The register API redirects to sign-in with registration_closed.", async () => {
		const request = new Request("http://localhost/api/auth/email/register", {
			method: "POST",
			body: new URLSearchParams({
				email: `test-closed-${randomUUID()}@example.com`,
				password: TEST_PASSWORD,
			}),
		});

		const response = await POST(createApiContext({ request }));

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toContain("/auth/signin?error=registration_closed");
	});
});
