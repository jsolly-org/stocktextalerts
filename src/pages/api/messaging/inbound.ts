import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../../lib/db/supabase";
import { createLogger } from "../../../lib/logging";
import { handleInboundSms } from "../../../lib/messaging/sms/inbound-utils";

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
			snsMessage = JSON.parse(rawBody) as SnsMessage;
		} catch {
			logger.info("Inbound SMS request with invalid JSON body");
			return new Response("Invalid JSON", { status: 400 });
		}

		// Handle SNS subscription confirmation
		if (
			snsMessage.Type === "SubscriptionConfirmation" &&
			snsMessage.SubscribeURL
		) {
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
