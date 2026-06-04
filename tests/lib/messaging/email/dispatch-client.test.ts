import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyEmailDispatchSignature } from "../../../../src/lib/messaging/email/dispatch-auth";
import {
	EMAIL_DISPATCH_SIGNATURE_HEADER,
	EMAIL_DISPATCH_TIMESTAMP_HEADER,
} from "../../../../src/lib/messaging/email/dispatch-contract";
import type { EmailSender } from "../../../../src/lib/messaging/email/utils";
import { expectConsoleError } from "../../../setup";

const mockEmailSender = vi.hoisted(() =>
	vi.fn<EmailSender>(async () => ({
		success: true,
		messageSid: "local-email",
	})),
);

vi.mock("../../../../src/lib/messaging/email/utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../../src/lib/messaging/email/utils")>();
	return {
		...actual,
		createEmailSender: () => mockEmailSender,
	};
});

describe("sendAppTransactionalEmail", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("posts signed email payloads to the configured dispatch URL.", async () => {
		vi.stubEnv("EMAIL_DISPATCH_URL", "https://dispatch.example.com/email");
		vi.stubEnv("EMAIL_DISPATCH_SECRET", "dispatch-secret");
		const fetchMock = vi.fn<typeof fetch>(async () => {
			return new Response(JSON.stringify({ success: true, messageSid: "lambda-message" }));
		});
		vi.stubGlobal("fetch", fetchMock);
		const { sendAppTransactionalEmail } = await import(
			"../../../../src/lib/messaging/email/dispatch-client"
		);
		const { createLogger } = await import("../../../../src/lib/logging");

		const result = await sendAppTransactionalEmail(
			{
				to: "admin@example.com",
				subject: "New signup",
				body: "A user signed up.",
				html: "<p>A user signed up.</p>",
				userId: "user-1",
				idempotencyKey: "registration-admin-user-1",
			},
			createLogger({ path: "/test", method: "POST" }),
		);

		expect(result).toEqual({ success: true, messageSid: "lambda-message" });
		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://dispatch.example.com/email");
		expect(init?.method).toBe("POST");
		const headers = new Headers(init?.headers);
		const timestamp = headers.get(EMAIL_DISPATCH_TIMESTAMP_HEADER);
		const signature = headers.get(EMAIL_DISPATCH_SIGNATURE_HEADER);
		const body = init?.body;
		expect(typeof body).toBe("string");
		expect(JSON.parse(body as string)).toMatchObject({
			html: "<p>A user signed up.</p>",
		});
		expect(
			verifyEmailDispatchSignature({
				body: body as string,
				timestamp,
				signature,
				secret: "dispatch-secret",
				now: Number(timestamp),
			}),
		).toBe(true);
	});

	it("falls back to the local email sender outside production when dispatch env is missing.", async () => {
		const { sendAppTransactionalEmail } = await import(
			"../../../../src/lib/messaging/email/dispatch-client"
		);
		const { createLogger } = await import("../../../../src/lib/logging");

		const result = await sendAppTransactionalEmail(
			{ to: "admin@example.com", subject: "Local", body: "Local fallback" },
			createLogger({ path: "/test", method: "POST" }),
		);

		expect(result).toEqual({ success: true, messageSid: "local-email" });
		expect(mockEmailSender).toHaveBeenCalledOnce();
	});

	it("fails closed in production when dispatch env is missing.", async () => {
		expectConsoleError("Email dispatch is not configured");
		vi.stubEnv("NODE_ENV", "production");
		const { sendAppTransactionalEmail } = await import(
			"../../../../src/lib/messaging/email/dispatch-client"
		);
		const { createLogger } = await import("../../../../src/lib/logging");

		const result = await sendAppTransactionalEmail(
			{ to: "admin@example.com", subject: "Prod", body: "No dispatch configured" },
			createLogger({ path: "/test", method: "POST" }),
		);

		expect(result).toMatchObject({
			success: false,
			errorCode: "email_dispatch_not_configured",
		});
		expect(mockEmailSender).not.toHaveBeenCalled();
	});
});
