/**
 * Authenticated email relay (Lambda Function URL). Vercel calls this to send
 * transactional email via SES when the web runtime cannot (e.g. approval emails).
 * Validates HMAC signatures, enforces idempotency, and restricts recipients to
 * admin addresses or the user's own registered email.
 */
import type {
	APIGatewayProxyEventV2,
	APIGatewayProxyStructuredResultV2,
	Context,
} from "aws-lambda";
import { parseAdminEmails } from "../../lib/auth/approval/admin";
import { readEnv, requireEnv } from "../../lib/db/env";
import { createSupabaseAdminClient } from "../../lib/db/supabase";
import { createLogger } from "../../lib/logging";
import { runLambda } from "../../lib/logging/request-context";
import { verifyEmailDispatchSignature } from "../../lib/messaging/email/dispatch-auth";
import {
	EMAIL_DISPATCH_SIGNATURE_HEADER,
	EMAIL_DISPATCH_TIMESTAMP_HEADER,
	type EmailDispatchRequest,
	type EmailDispatchResponse,
} from "../../lib/messaging/email/dispatch-contract";
import {
	claimEmailDispatchKey,
	releaseEmailDispatchKey,
} from "../../lib/messaging/email/dispatch-idempotency";
import { createEmailSender } from "../../lib/messaging/email/utils";

function jsonResponse(
	statusCode: number,
	body: EmailDispatchResponse,
): APIGatewayProxyStructuredResultV2 {
	return {
		statusCode,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	};
}

function getHeader(headers: APIGatewayProxyEventV2["headers"], name: string): string | undefined {
	const target = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === target) return value;
	}
	return undefined;
}

function getRawBody(event: APIGatewayProxyEventV2): string {
	if (!event.body) return "";
	return event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
}

function parseRequest(body: string): EmailDispatchRequest | null {
	try {
		const parsed: unknown = JSON.parse(body);
		if (typeof parsed !== "object" || parsed === null) return null;
		const request = parsed as Partial<EmailDispatchRequest>;
		if (
			typeof request.to !== "string" ||
			request.to.trim().length === 0 ||
			typeof request.subject !== "string" ||
			request.subject.trim().length === 0 ||
			typeof request.body !== "string" ||
			request.body.trim().length === 0
		) {
			return null;
		}
		return {
			to: request.to,
			subject: request.subject,
			body: request.body,
			...(typeof request.html === "string" ? { html: request.html } : {}),
			...(typeof request.idempotencyKey === "string"
				? { idempotencyKey: request.idempotencyKey }
				: {}),
			...(typeof request.userId === "string" ? { userId: request.userId } : {}),
		};
	} catch {
		return null;
	}
}

async function isAuthorizedRecipient(request: EmailDispatchRequest): Promise<boolean> {
	const adminRecipients = parseAdminEmails(readEnv("ADMIN_EMAILS"));
	if (adminRecipients.has(request.to.trim().toLowerCase())) return true;
	if (!request.userId) return false;

	const { data, error } = await createSupabaseAdminClient()
		.from("users")
		.select("id")
		.eq("id", request.userId)
		.eq("email", request.to)
		.maybeSingle();

	if (error) throw error;
	return Boolean(data);
}

export async function handler(
	event: APIGatewayProxyEventV2,
	context: Context,
): Promise<APIGatewayProxyStructuredResultV2> {
	return runLambda(context, async () => {
		const logger = createLogger({
			source: "lambda",
			function: "email-dispatch",
		});

		if (event.requestContext.http.method !== "POST") {
			return jsonResponse(405, {
				success: false,
				error: "Method not allowed",
				errorCode: "method_not_allowed",
			});
		}

		const rawBody = getRawBody(event);
		const timestamp = getHeader(event.headers, EMAIL_DISPATCH_TIMESTAMP_HEADER);
		const signature = getHeader(event.headers, EMAIL_DISPATCH_SIGNATURE_HEADER);
		const secret = requireEnv("EMAIL_DISPATCH_SECRET");
		const validSignature = verifyEmailDispatchSignature({
			body: rawBody,
			timestamp,
			signature,
			secret,
		});
		if (!validSignature) {
			logger.warn("Rejected email dispatch request with invalid signature", {
				action: "email_dispatch_auth",
			});
			return jsonResponse(401, {
				success: false,
				error: "Invalid signature",
				errorCode: "invalid_signature",
			});
		}

		const request = parseRequest(rawBody);
		if (!request) {
			logger.warn("Rejected email dispatch request with invalid payload", {
				action: "email_dispatch_parse",
			});
			return jsonResponse(400, {
				success: false,
				error: "Invalid email dispatch payload",
				errorCode: "invalid_payload",
			});
		}

		const dispatchKey = request.idempotencyKey ?? signature;
		if (!dispatchKey) {
			logger.warn("Rejected email dispatch request with no idempotency key or signature", {
				action: "email_dispatch_replay",
				userId: request.userId,
			});
			return jsonResponse(400, {
				success: false,
				error: "Missing idempotency key",
				errorCode: "missing_idempotency_key",
			});
		}

		// Build the sender BEFORE claiming the idempotency key. createEmailSender() reads
		// EMAIL_FROM at construction and throws if it's missing — a provably-not-sent failure.
		// Constructing it pre-claim means that throw never leaves a claim held (there's nothing
		// to release), keeping the release contract: a claim is made only once a send is possible.
		const sendEmail = createEmailSender();

		const supabase = createSupabaseAdminClient();
		const claim = await claimEmailDispatchKey(supabase, dispatchKey);
		if (claim === "duplicate") {
			logger.warn("Rejected replayed email dispatch request", {
				action: "email_dispatch_replay",
				userId: request.userId,
			});
			return jsonResponse(409, {
				success: false,
				error: "Duplicate email dispatch request",
				errorCode: "duplicate_request",
			});
		}

		// The key is now claimed. Release it ONLY on outcomes where the email provably did not
		// go out — both authorization-failure branches below return before the SES send. An
		// ambiguous SES *send* failure KEEPS the claim (SES can accept a message and still
		// surface an error, so re-sending risks a double-delivery); the claim's TTL lets a
		// genuine retry re-claim the key once the window lapses (see claim_email_dispatch_key).
		let releaseClaim = false;
		try {
			try {
				const authorizedRecipient = await isAuthorizedRecipient(request);
				if (!authorizedRecipient) {
					releaseClaim = true; // pre-send rejection — the email provably did not go out
					logger.warn("Rejected email dispatch request for unauthorized recipient", {
						action: "email_dispatch_authorization",
						userId: request.userId,
					});
					return jsonResponse(403, {
						success: false,
						error: "Unauthorized recipient",
						errorCode: "unauthorized_recipient",
					});
				}
			} catch (error) {
				releaseClaim = true; // pre-send failure — the email provably did not go out
				logger.error(
					"Failed to authorize email dispatch recipient",
					{ action: "email_dispatch_authorization", userId: request.userId },
					error,
				);
				return jsonResponse(500, {
					success: false,
					error: "Recipient authorization failed",
					errorCode: "authorization_failed",
				});
			}

			const result = await sendEmail(request);
			if (!result.success) {
				// Ambiguous: keep the claim (releaseClaim stays false) so a retry collapses to
				// "duplicate" until the TTL lapses, instead of risking a double-send.
				logger.error("Email dispatch delivery failed", {
					action: "email_dispatch_send",
					userId: request.userId,
					error: result.error,
					errorCode: result.errorCode,
				});
				return jsonResponse(502, result);
			}

			logger.info("Email dispatch delivered", {
				action: "email_dispatch_send",
				userId: request.userId,
			});
			return jsonResponse(200, result);
		} finally {
			if (releaseClaim) await releaseEmailDispatchKey(supabase, dispatchKey);
		}
	});
}
