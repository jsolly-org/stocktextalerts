import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signEmailDispatchBody } from "../../src/lib/messaging/email/dispatch-auth";
import {
	EMAIL_DISPATCH_SIGNATURE_HEADER,
	EMAIL_DISPATCH_TIMESTAMP_HEADER,
	type EmailDispatchRequest,
} from "../../src/lib/messaging/email/dispatch-contract";
import type { EmailSender } from "../../src/lib/messaging/email/utils";
import { expectConsoleError } from "../setup";

const mockEmailSender = vi.hoisted(() =>
	vi.fn<EmailSender>(async () => ({
		success: true,
		messageSid: "ses-message",
	})),
);

const mockMaybeSingle = vi.hoisted(() =>
	vi.fn<() => Promise<{ data: { id: string } | null; error: null }>>(async () => ({
		data: { id: "user-1" },
		error: null,
	})),
);
const mockEq = vi.hoisted(() => {
	const query = {
		eq: vi.fn(() => query),
		maybeSingle: mockMaybeSingle,
	};
	return query.eq;
});
const mockSelect = vi.hoisted(() => vi.fn(() => ({ eq: mockEq, maybeSingle: mockMaybeSingle })));
const mockFrom = vi.hoisted(() => vi.fn(() => ({ select: mockSelect })));

vi.mock("../../src/lib/messaging/email/utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/lib/messaging/email/utils")>();
	return {
		...actual,
		createEmailSender: () => mockEmailSender,
	};
});

vi.mock("../../src/lib/db/supabase", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/lib/db/supabase")>();
	return {
		...actual,
		createSupabaseAdminClient: () => ({ from: mockFrom }),
	};
});

function makeEvent(
	request: EmailDispatchRequest,
	options: { method?: string; validSignature?: boolean; body?: string } = {},
): APIGatewayProxyEventV2 {
	const body = options.body ?? JSON.stringify(request);
	const timestamp = Date.now().toString();
	const signature = signEmailDispatchBody(
		body,
		timestamp,
		options.validSignature === false ? "wrong-secret" : "dispatch-secret",
	);
	return {
		version: "2.0",
		routeKey: "$default",
		rawPath: "/",
		rawQueryString: "",
		headers: {
			"content-type": "application/json",
			[EMAIL_DISPATCH_TIMESTAMP_HEADER]: timestamp,
			[EMAIL_DISPATCH_SIGNATURE_HEADER]: signature,
		},
		requestContext: {
			accountId: "123456789012",
			apiId: "function-url",
			domainName: "example.lambda-url.us-east-1.on.aws",
			domainPrefix: "example",
			http: {
				method: options.method ?? "POST",
				path: "/",
				protocol: "HTTP/1.1",
				sourceIp: "127.0.0.1",
				userAgent: "vitest",
			},
			requestId: "request-id",
			routeKey: "$default",
			stage: "$default",
			time: "01/Jan/2026:00:00:00 +0000",
			timeEpoch: Date.now(),
		},
		isBase64Encoded: false,
		body,
	} as APIGatewayProxyEventV2;
}

const context = { awsRequestId: "aws-request-id" } as Context;

describe("email-dispatch Lambda handler", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.clearAllMocks();
		mockMaybeSingle.mockResolvedValue({ data: { id: "user-1" }, error: null });
	});

	it("sends a signed email dispatch request.", async () => {
		vi.stubEnv("EMAIL_DISPATCH_SECRET", "dispatch-secret");
		const { handler } = await import("../../src/handlers/email-dispatch");

		const response = await handler(
			makeEvent({
				to: "new-user@example.com",
				subject: "Approved",
				body: "You are approved.",
				html: "<p>You are approved.</p>",
				userId: "user-1",
				idempotencyKey: "approved-user-1",
			}),
			context,
		);

		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.body ?? "{}")).toEqual({
			success: true,
			messageSid: "ses-message",
		});
		expect(mockEmailSender).toHaveBeenCalledWith(
			expect.objectContaining({
				to: "new-user@example.com",
				subject: "Approved",
				html: "<p>You are approved.</p>",
				userId: "user-1",
			}),
		);
	});

	it("rejects invalid signatures before sending.", async () => {
		vi.stubEnv("EMAIL_DISPATCH_SECRET", "dispatch-secret");
		const { handler } = await import("../../src/handlers/email-dispatch");

		const response = await handler(
			makeEvent(
				{ to: "new-user@example.com", subject: "Approved", body: "You are approved." },
				{ validSignature: false },
			),
			context,
		);

		expect(response.statusCode).toBe(401);
		expect(mockEmailSender).not.toHaveBeenCalled();
	});

	it("rejects malformed payloads.", async () => {
		vi.stubEnv("EMAIL_DISPATCH_SECRET", "dispatch-secret");
		const { handler } = await import("../../src/handlers/email-dispatch");

		const response = await handler(
			makeEvent(
				{ to: "new-user@example.com", subject: "Approved", body: "You are approved." },
				{ body: JSON.stringify({ to: "new-user@example.com" }) },
			),
			context,
		);

		expect(response.statusCode).toBe(400);
		expect(mockEmailSender).not.toHaveBeenCalled();
	});

	it("returns 405 for non-POST requests.", async () => {
		vi.stubEnv("EMAIL_DISPATCH_SECRET", "dispatch-secret");
		const { handler } = await import("../../src/handlers/email-dispatch");

		const response = await handler(
			makeEvent(
				{ to: "new-user@example.com", subject: "Approved", body: "You are approved." },
				{ method: "GET" },
			),
			context,
		);

		expect(response.statusCode).toBe(405);
		expect(mockEmailSender).not.toHaveBeenCalled();
	});

	it("returns 502 when SES delivery fails.", async () => {
		expectConsoleError("Email dispatch delivery failed");
		vi.stubEnv("EMAIL_DISPATCH_SECRET", "dispatch-secret");
		mockEmailSender.mockResolvedValueOnce({
			success: false,
			error: "SES down",
			errorCode: "ses_error",
		});
		const { handler } = await import("../../src/handlers/email-dispatch");

		const response = await handler(
			makeEvent({
				to: "new-user@example.com",
				subject: "Approved",
				body: "You are approved.",
				userId: "user-1",
				idempotencyKey: "ses-fails-user-1",
			}),
			context,
		);

		expect(response.statusCode).toBe(502);
		expect(JSON.parse(response.body ?? "{}")).toMatchObject({
			success: false,
			error: "SES down",
		});
	});

	it("rejects unauthorized recipients.", async () => {
		vi.stubEnv("EMAIL_DISPATCH_SECRET", "dispatch-secret");
		mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
		const { handler } = await import("../../src/handlers/email-dispatch");

		const response = await handler(
			makeEvent({
				to: "stranger@example.com",
				subject: "Approved",
				body: "You are approved.",
				userId: "user-1",
				idempotencyKey: "unauthorized-user-1",
			}),
			context,
		);

		expect(response.statusCode).toBe(403);
		expect(mockEmailSender).not.toHaveBeenCalled();
	});

	it("rejects duplicate idempotency keys in a warm runtime.", async () => {
		vi.stubEnv("EMAIL_DISPATCH_SECRET", "dispatch-secret");
		const { handler } = await import("../../src/handlers/email-dispatch");
		const request = {
			to: "new-user@example.com",
			subject: "Approved",
			body: "You are approved.",
			userId: "user-1",
			idempotencyKey: "duplicate-user-1",
		};

		const first = await handler(makeEvent(request), context);
		const second = await handler(makeEvent(request), context);

		expect(first.statusCode).toBe(200);
		expect(second.statusCode).toBe(409);
		expect(mockEmailSender).toHaveBeenCalledOnce();
	});
});
