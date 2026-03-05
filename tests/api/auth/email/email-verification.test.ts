import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { POST as emailResendPost } from "../../../../src/pages/api/auth/email/resend-verification";
import { createApiContext } from "../../../helpers/api-context";
import { adminClient } from "../../../helpers/test-env";
import { registerTestUserForCleanup } from "../../../helpers/test-user-cleanup";

describe("A user resends their email verification from the unconfirmed page.", () => {
	it("A user requests their verification email (first or resend) and sees a success confirmation.", async () => {
		const testEmail = `test-${randomUUID()}@resend.dev`;
		const { data, error } = await adminClient.auth.admin.createUser({
			email: testEmail,
			password: "TestPassword123!",
			email_confirm: false,
		});
		if (error || !data.user) {
			throw new Error(`Failed to create test auth user: ${error?.message}`);
		}
		const testUser = { id: data.user.id, email: testEmail };
		registerTestUserForCleanup(testUser.id);
		const request = new Request(
			"http://localhost/api/auth/email/resend-verification",
			{
				method: "POST",
				body: new URLSearchParams({
					email: `  ${testUser.email} `,
				}),
			},
		);

		{
			const response = await emailResendPost(createApiContext({ request }));

			expect(response.status).toBe(302);
			expect(response.headers.get("Location")).toBe(
				`/auth/unconfirmed?email=${encodeURIComponent(testUser.email)}&success=true`,
			);
		}
	});
});
