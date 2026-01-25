import { parsePhoneNumberFromString } from "libphonenumber-js";
import type { AppSupabaseClient } from "../../../../lib/db/supabase";
import { rootLogger } from "../../../../lib/logging";

export interface InboundSmsDependencies {
	authToken: string;
	validateRequest: (
		authToken: string,
		signature: string,
		url: string,
		params: Record<string, string | undefined>,
	) => boolean;
	supabase: AppSupabaseClient;
}

export interface InboundSmsRequest {
	url: string;
	signature: string;
	params: Record<string, string | undefined>;
}

export interface InboundSmsResponse {
	status: number;
	body: string;
	contentType?: string;
}

const STOP_RE = /\b(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT|REVOKE|OPTOUT)\b/;
const START_RE = /\b(START|SUBSCRIBE|YES|UNSTOP)\b/;
const HELP_RE = /\b(HELP|INFO)\b/;

export async function handleInboundSms(
	request: InboundSmsRequest,
	deps: InboundSmsDependencies,
): Promise<InboundSmsResponse> {
	const { authToken, validateRequest, supabase } = deps;

	if (!authToken) {
		rootLogger.error("Missing TWILIO_AUTH_TOKEN for webhook validation", {
			envVar: "TWILIO_AUTH_TOKEN",
		});
		return {
			status: 500,
			body: "Server misconfigured",
		};
	}

	const isValid = validateRequest(
		authToken,
		request.signature,
		request.url,
		request.params,
	);

	if (!isValid) {
		return {
			status: 403,
			body: "Invalid signature",
		};
	}

	const from = request.params.From;
	// Twilio can deliver `Body` as whitespace-only (e.g. "   "), which is truthy.
	// Trim first so whitespace-only messages hit the missing-parameter 400 path.
	const body = request.params.Body?.trim().toUpperCase();

	if (!from || !body) {
		return {
			status: 400,
			body: "Missing parameters",
		};
	}

	let countryCode: string;
	let phoneNumber: string;

	try {
		const parsed = parsePhoneNumberFromString(from);

		if (!parsed) {
			return {
				status: 400,
				body: "Invalid phone format",
			};
		}

		// Accept parseable E.164 inputs without strict validity checks to be lenient with inbound numbers.
		countryCode = `+${parsed.countryCallingCode}`;
		phoneNumber = parsed.nationalNumber;
	} catch {
		// PII masking (phone numbers) is handled automatically by the logger
		rootLogger.error("Failed to parse phone number", { from });
		return {
			status: 400,
			body: "Invalid phone format",
		};
	}

	const { data: users, error } = await supabase
		.from("users")
		.select("id, phone_verified")
		.eq("phone_country_code", countryCode)
		.eq("phone_number", phoneNumber);

	if (error) {
		// PII masking (phone numbers) is handled automatically by the logger
		rootLogger.error(
			"Inbound SMS user lookup failed",
			{
				countryCode,
				phoneNumber,
			},
			error,
		);
		return {
			status: 200,
			body: wrapInTwiml(""),
			contentType: "text/xml",
		};
	}

	if (users.length === 0) {
		return {
			status: 200,
			body: wrapInTwiml(""),
			contentType: "text/xml",
		};
	}

	const userId = users[0].id;
	const phoneVerified = users[0].phone_verified;

	if (!phoneVerified) {
		return {
			status: 200,
			body: wrapInTwiml(
				"Phone number not verified. Please verify your phone number first.",
			),
			contentType: "text/xml",
		};
	}

	if (STOP_RE.test(body)) {
		const { error: updateError } = await supabase
			.from("users")
			.update({ sms_opted_out: true })
			.eq("id", userId);

		if (updateError) {
			rootLogger.error(
				"Failed to opt out user",
				{ userId, action: "sms_opt_out" },
				updateError,
			);
			return {
				status: 500,
				body: "Failed to update preferences",
			};
		}

		return {
			status: 200,
			body: wrapInTwiml(
				"You have been unsubscribed from SMS notifications. Reply START to resume.",
			),
			contentType: "text/xml",
		};
	}

	if (START_RE.test(body)) {
		const { error: updateError } = await supabase
			.from("users")
			.update({ sms_opted_out: false })
			.eq("id", userId);

		if (updateError) {
			rootLogger.error(
				"Failed to opt in user",
				{ userId, action: "sms_opt_in" },
				updateError,
			);
			return {
				status: 500,
				body: "Failed to update preferences",
			};
		}

		return {
			status: 200,
			body: wrapInTwiml(
				"You have been subscribed to SMS notifications. Reply STOP to unsubscribe.",
			),
			contentType: "text/xml",
		};
	}

	if (HELP_RE.test(body)) {
		return {
			status: 200,
			body: wrapInTwiml(
				"StockTextDashboard: Reply STOP to unsubscribe, START to subscribe. Msg & data rates may apply. Help: reply HELP or visit your dashboard.",
			),
			contentType: "text/xml",
		};
	}

	return {
		status: 200,
		body: wrapInTwiml("Unknown command. Reply HELP for options."),
		contentType: "text/xml",
	};
}

function wrapInTwiml(message: string): string {
	const twiml = ['<?xml version="1.0" encoding="UTF-8"?>', "<Response>"];

	if (message) {
		const escapedMessage = escapeForXml(message);
		twiml.push(`\t<Message>${escapedMessage}</Message>`);
	}

	twiml.push("</Response>");

	return twiml.join("\n");
}

function escapeForXml(message: string): string {
	const replacements: Record<string, string> = {
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&apos;",
	};

	return message.replace(/[&<>"']/g, (character) => {
		return replacements[character];
	});
}
