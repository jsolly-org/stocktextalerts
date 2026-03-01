import type { APIRoute } from "astro";
import MessageValidator from "sns-validator";
import { createSupabaseAdminClient } from "../../../lib/db/supabase";
import { createLogger } from "../../../lib/logging";
import { handleInboundSms } from "../../../lib/messaging/sms/inbound-utils";

const snsValidator = new MessageValidator();

interface SnsMessage {
	Type: string;
	MessageId: string;
	TopicArn: string;
	Message: string;
	Timestamp: string;
	SignatureVersion: string;
	Signature: string;
	SigningCertURL: string;
	SubscribeURL?: string;
}

/** Validate SNS message signature before processing; returns the parsed message or throws. */
function validateSnsMessage(rawBody: string): Promise<SnsMessage> {
	return new Promise((resolve, reject) => {
		let parsed: SnsMessage;
		try {
			parsed = JSON.parse(rawBody) as SnsMessage;
		} catch {
			reject(new Error("Invalid JSON"));
			return;
		}
		snsValidator.validate(
			parsed as unknown as Record<string, unknown>,
			(err: Error | null, _validated: Record<string, unknown>) => {
				if (err) reject(err);
				else resolve(parsed);
			},
		);
	});
}

interface SnsSmsTwoWayPayload {
	originationNumber: string;
	messageBody: string;
	destinationNumber: string;
	messageKeyword: string;
}

/**
 * POST /api/messaging/inbound
 *
 * Handles inbound SMS messages via AWS SNS two-way messaging notifications.
 * Accepts JSON POST with SNS notification format.
 */
export const POST: APIRoute = async ({ request, locals }) => {
	const url = new URL(request.url);
	const logger = createLogger({
		requestId: locals?.requestId,
		path: url.pathname,
		method: request.method,
	});
	try {
		const contentType = request.headers.get("content-type") ?? "";
		if (
			!contentType.includes("application/json") &&
			!contentType.includes("text/plain")
		) {
			logger.info("Inbound SMS request with unexpected content-type", {
				contentType,
			});
			return new Response("Unsupported content type", { status: 400 });
		}

		const rawBody = await request.text();
		let snsMessage: SnsMessage;
		try {
			snsMessage = await validateSnsMessage(rawBody);
		} catch (err) {
			const isJson = err instanceof Error && err.message === "Invalid JSON";
			logger.info(
				isJson
					? "Inbound SMS request with invalid JSON body"
					: "SNS message signature validation failed",
				isJson ? undefined : { error: err },
			);
			return new Response(isJson ? "Invalid JSON" : "Invalid signature", {
				status: isJson ? 400 : 403,
			});
		}

		// Handle SNS subscription confirmation (only after signature validation)
		if (
			snsMessage.Type === "SubscriptionConfirmation" &&
			snsMessage.SubscribeURL
		) {
			const subscribeUrl = new URL(snsMessage.SubscribeURL);
			if (!subscribeUrl.hostname.endsWith(".amazonaws.com")) {
				logger.warn("Rejecting non-AWS SubscribeURL", {
					hostname: subscribeUrl.hostname,
				});
				return new Response("Invalid SubscribeURL", { status: 400 });
			}
			logger.info("Confirming SNS subscription", {
				topicArn: snsMessage.TopicArn,
			});
			try {
				await fetch(snsMessage.SubscribeURL);
				return new Response("Subscription confirmed", { status: 200 });
			} catch (error) {
				logger.error(
					"Failed to confirm SNS subscription",
					{
						topicArn: snsMessage.TopicArn,
					},
					error,
				);
				return new Response("Subscription confirmation failed", {
					status: 500,
				});
			}
		}

		// Only process Notification type
		if (snsMessage.Type !== "Notification") {
			logger.info("Ignoring non-notification SNS message", {
				type: snsMessage.Type,
			});
			return new Response("OK", { status: 200 });
		}

		// Parse the inner SMS payload from the SNS message
		let smsPayload: SnsSmsTwoWayPayload;
		try {
			smsPayload = JSON.parse(snsMessage.Message) as SnsSmsTwoWayPayload;
		} catch {
			logger.info("Inbound SMS notification with invalid inner message JSON");
			return new Response("Invalid SMS payload", { status: 400 });
		}

		if (!smsPayload.originationNumber || !smsPayload.messageBody) {
			logger.info("Inbound SMS notification missing required fields", {
				hasOriginationNumber: Boolean(smsPayload.originationNumber),
				hasMessageBody: Boolean(smsPayload.messageBody),
			});
			return new Response("Missing required fields", { status: 400 });
		}

		const supabase = createSupabaseAdminClient();

		const result = await handleInboundSms(
			{
				originationNumber: smsPayload.originationNumber,
				messageBody: smsPayload.messageBody,
				destinationNumber: smsPayload.destinationNumber,
			},
			{ supabase },
		);

		return new Response(result.body, {
			status: result.status,
		});
	} catch (error) {
		logger.error("SMS webhook error", { action: "inbound_sms_webhook" }, error);
		return new Response("Internal server error", { status: 500 });
	}
};
