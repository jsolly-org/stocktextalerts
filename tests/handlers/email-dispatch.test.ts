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

// Durable idempotency lives in `email_dispatch_idempotency`; the handler claims via the
// `claim_email_dispatch_key` RPC (which re-claims an EXPIRED key) and releases via DELETE.
// This fake tracks live claims in-memory: a second claim of a live key returns false
// (duplicate), and a DELETE frees the key for a re-claim.
const idempotencyKeys = vi.hoisted(() => new Set<string>());
const mockRpc = vi.hoisted(() =>
	vi.fn(async (fn: string, args: { p_key: string }) => {
		if (fn !== "claim_email_dispatch_key") return { data: null, error: null };
		if (idempotencyKeys.has(args.p_key)) return { data: false, error: null };
		idempotencyKeys.add(args.p_key);
		return { data: true, error: null };
	}),
);
const mockIdempotencyTable = vi.hoisted(() => ({
	delete: vi.fn(() => ({
		eq: vi.fn(async (_column: string, value: string) => {
			idempotencyKeys.delete(value);
			return { error: null };
		}),
	})),
}));
const mockFrom = vi.hoisted(() =>
	vi.fn((table: string) =>
		table === "email_dispatch_idempotency" ? mockIdempotencyTable : { select: mockSelect },
	),
);

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
		createSupabaseAdminClient: () => ({ from: mockFrom, rpc: mockRpc }),
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
		idempotencyKeys.clear();
		mockMaybeSingle.mockResolvedValue({ data: { id: "user-1" }, error: null });
	});

	it("sends a signed email dispatch request.", async () => {
		vi.stubEnv("EMAIL_DISPATCH_SECRET", "dispatch-secret");
		const { handler } = await import("../../src/handlers/delivery/email-dispatch");

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
		const { handler } = await import("../../src/handlers/delivery/email-dispatch");

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
		const { handler } = await import("../../src/handlers/delivery/email-dispatch");

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
		const { handler } = await import("../../src/handlers/delivery/email-dispatch");

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
		const { handler } = await import("../../src/handlers/delivery/email-dispatch");

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
		const { handler } = await import("../../src/handlers/delivery/email-dispatch");

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
		const { handler } = await import("../../src/handlers/delivery/email-dispatch");
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

	it("keeps the idempotency claim when SES delivery fails so an immediate retry cannot double-send.", async () => {
		expectConsoleError("Email dispatch delivery failed");
		vi.stubEnv("EMAIL_DISPATCH_SECRET", "dispatch-secret");
		const request = {
			to: "new-user@example.com",
			subject: "Approved",
			body: "You are approved.",
			userId: "user-1",
			idempotencyKey: "daily-digest/user-1/2026-06-13/540/email",
		};
		const { handler } = await import("../../src/handlers/delivery/email-dispatch");

		// First attempt: SES errors -> 502. The outcome is AMBIGUOUS (SES may have accepted the
		// message before erroring), so the claim is KEPT rather than released.
		mockEmailSender.mockResolvedValueOnce({
			success: false,
			error: "SES down",
			errorCode: "ses_error",
		});
		const failed = await handler(makeEvent(request), context);
		expect(failed.statusCode).toBe(502);

		// An immediate retry of the SAME deterministic key is blocked as a duplicate (409) — no
		// second send — until the claim's TTL lapses, at which point claim_email_dispatch_key
		// re-claims it. This is the guard against double-delivery.
		const retried = await handler(makeEvent(request), context);
		expect(retried.statusCode).toBe(409);
		expect(mockEmailSender).toHaveBeenCalledOnce();
	});

	it("releases the idempotency key when the recipient is unauthorized so a fixed retry can send.", async () => {
		vi.stubEnv("EMAIL_DISPATCH_SECRET", "dispatch-secret");
		const request = {
			to: "new-user@example.com",
			subject: "Approved",
			body: "You are approved.",
			userId: "user-1",
			idempotencyKey: "user-approved-user-1",
		};
		const { handler } = await import("../../src/handlers/delivery/email-dispatch");

		// First attempt: authorization lookup misses -> 403, key released.
		mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
		const forbidden = await handler(makeEvent(request), context);
		expect(forbidden.statusCode).toBe(403);
		expect(mockEmailSender).not.toHaveBeenCalled();

		// Retry once the user exists must re-claim and deliver.
		const retried = await handler(makeEvent(request), context);
		expect(retried.statusCode).toBe(200);
		expect(mockEmailSender).toHaveBeenCalledOnce();
	});
});
