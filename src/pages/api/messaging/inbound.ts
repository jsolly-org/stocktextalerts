import type { APIRoute } from "astro";
import twilio from "twilio";
import { createSupabaseAdminClient } from "../../../lib/db/supabase";
import { parseWithSchema } from "../../../lib/forms/parse";
import type { FormSchema } from "../../../lib/forms/schema";
import { createLogger } from "../../../lib/logging";
import { handleInboundSms } from "../../../lib/messaging/sms/inbound-utils";
import { readTwilioConfig } from "../../../lib/messaging/sms/twilio-utils";

const MEDIA_SLOT_COUNT = 10;

function buildInboundSmsSchema(): FormSchema {
	const schema: FormSchema = {
		MessageSid: { type: "string", required: true },
		SmsSid: { type: "string" },
		SmsMessageSid: { type: "string" },
		AccountSid: { type: "string", required: true },
		MessagingServiceSid: { type: "string" },
		From: { type: "string", required: true, trim: true },
		FromCity: { type: "string" },
		FromState: { type: "string" },
		FromZip: { type: "string" },
		FromCountry: { type: "string" },
		To: { type: "string", required: true },
		ToCity: { type: "string" },
		ToState: { type: "string" },
		ToZip: { type: "string" },
		ToCountry: { type: "string" },
		Body: { type: "string", required: true, trim: true },
		NumSegments: { type: "string" },
		NumMedia: { type: "string" },
		ApiVersion: { type: "string" },
		SmsStatus: { type: "string" },
		ForwardedFrom: { type: "string" },
		CallerName: { type: "string" },
	};

	for (let index = 0; index < MEDIA_SLOT_COUNT; index += 1) {
		schema[`MediaUrl${index}`] = { type: "string" };
		schema[`MediaContentType${index}`] = { type: "string" };
	}

	return schema;
}

const INBOUND_SMS_SCHEMA = buildInboundSmsSchema();

function reconstructUrl(request: Request, url: URL): string {
	const forwardedProto = request.headers.get("x-forwarded-proto") ?? "";
	const forwardedHost = request.headers.get("x-forwarded-host") ?? "";

	// Trim to normalize whitespace in proxy headers (can contain spaces from multiple proxy chains)
	const protocol = forwardedProto.split(",")[0]?.trim() ?? "";
	const host = forwardedHost.split(",")[0]?.trim() ?? "";
	if (
		protocol.length > 0 &&
		host.length > 0 &&
		(protocol === "http" || protocol === "https")
	) {
		return `${protocol}://${host}${url.pathname}${url.search}`;
	}

	return request.url;
}

export const POST: APIRoute = async ({ request, locals }) => {
	const url = new URL(request.url);
	const logger = createLogger({
		requestId: locals?.requestId,
		path: url.pathname,
		method: request.method,
	});
	try {
		const signatureHeader = request.headers.get("x-twilio-signature");

		if (!signatureHeader) {
			// Expected rejection (probes, non-Twilio); info to avoid inflating error metrics.
			logger.info("Inbound SMS request missing x-twilio-signature header", {
				header: "x-twilio-signature",
			});
			return new Response("Missing Twilio signature", { status: 401 });
		}

		const signature = signatureHeader;
		const formData = await request.formData();
		const parsed = parseWithSchema(formData, INBOUND_SMS_SCHEMA);

		if (!parsed.ok) {
			// Expected rejection (malformed webhooks, etc.); info to avoid inflating error metrics.
			logger.info("Inbound SMS rejected due to invalid form data", {
				errors: parsed.allErrors,
			});
			return new Response("Invalid form submission", { status: 400 });
		}

		const params = parsed.data as Record<string, string | undefined>;

		const supabase = createSupabaseAdminClient();
		const twilioConfig = readTwilioConfig();

		const webhookUrl = reconstructUrl(request, url);

		const result = await handleInboundSms(
			{
				url: webhookUrl,
				signature,
				params,
			},
			{
				authToken: twilioConfig.authToken,
				validateRequest: twilio.validateRequest,
				supabase,
			},
		);

		const headers: Record<string, string> = {};
		if (result.contentType) {
			headers["Content-Type"] = result.contentType;
		}

		return new Response(result.body, {
			status: result.status,
			headers,
		});
	} catch (error) {
		logger.error("SMS webhook error", { action: "inbound_sms_webhook" }, error);
		return new Response("Internal server error", { status: 500 });
	}
};
