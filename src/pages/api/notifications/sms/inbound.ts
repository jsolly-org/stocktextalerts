import type { APIRoute } from "astro";
import twilio from "twilio";
import { parseWithSchema } from "../../../../lib/forms/parsing";
import type { FormSchema } from "../../../../lib/forms/schema";
import { createSupabaseAdminClient } from "../../../../lib/supabase";
import { handleInboundSms } from "./inbound-utils";
import { readTwilioConfig } from "./twilio-utils";

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

export const POST: APIRoute = async ({ request }) => {
	try {
		const signatureHeader = request.headers.get("x-twilio-signature");

		if (!signatureHeader) {
			console.error("Inbound SMS request missing x-twilio-signature header");
			return new Response("Missing Twilio signature", { status: 401 });
		}

		const signature = signatureHeader;
		const formData = await request.formData();
		const parsed = parseWithSchema(formData, INBOUND_SMS_SCHEMA);

		if (!parsed.ok) {
			console.error("Inbound SMS rejected due to invalid form data", {
				errors: parsed.allErrors,
			});
			return new Response("Invalid form submission", { status: 400 });
		}

		const params = parsed.data as Record<string, string | undefined>;

		const supabase = createSupabaseAdminClient();
		const twilioConfig = readTwilioConfig();

		const result = await handleInboundSms(
			{
				url: request.url,
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
		console.error("SMS webhook error:", error);
		return new Response("Internal server error", { status: 500 });
	}
};
