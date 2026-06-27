import { afterEach, describe, expect, it, vi } from "vitest";

vi.unmock("../../../../src/lib/messaging/email/dispatch-client");

import { verifyEmailDispatchSignature } from "../../../../src/lib/messaging/email/dispatch-auth";
import {
	EMAIL_DISPATCH_SIGNATURE_HEADER,
	EMAIL_DISPATCH_TIMESTAMP_HEADER,
} from "../../../../src/lib/messaging/email/dispatch-contract";
import { expectConsoleError } from "../../../setup";

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

	it("fails closed when dispatch env is missing.", async () => {
		expectConsoleError("Email dispatch is not configured");
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
	});
});
