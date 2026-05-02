import { parsePhoneNumberFromString } from "libphonenumber-js";
import { getSiteUrl } from "../../db/env";
import type { Database } from "../../db/generated/database.types";
import type { AppSupabaseClient } from "../../db/supabase";
import { rootLogger } from "../../logging";
import { wrapInTwiml } from "./twiml";

type UsersUpdate = Database["public"]["Tables"]["users"]["Update"];

interface InboundSmsDependencies {
	authToken: string;
	validateRequest: (
		authToken: string,
		signature: string,
		url: string,
		params: Record<string, string>,
	) => boolean;
	supabase: AppSupabaseClient;
}

interface InboundSmsRequest {
	url: string;
	signature: string;
	params: Record<string, string>;
}

interface InboundSmsResponse {
	status: number;
	body: string;
	contentType?: string;
}

/**
 * Apply a `users` table update and return a Twilio-friendly error response on failure.
 *
 * Returns `null` on success so callers can continue handling the inbound command.
 */
async function applyUserUpdate(
	supabase: AppSupabaseClient,
	userId: string,
	update: UsersUpdate,
	action: string,
): Promise<InboundSmsResponse | null> {
	const { error: updateError } = await supabase.from("users").update(update).eq("id", userId);

	if (updateError) {
		rootLogger.error(
			"Failed to update user notification preferences",
			{ userId, action, updateFields: Object.keys(update) },
			updateError,
		);
		return {
			status: 500,
			body: "Failed to update notification-preferences",
		};
	}
	return null;
}

const STOP_ALL_RE = /\bSTOP\s*ALL\b|\bSTOPALL\b/;
const STOP_EMAIL_RE = /\bSTOP\s*EMAIL\b|\bSTOPEMAIL\b/;
const STOP_RE = /\b(STOP|UNSUBSCRIBE|CANCEL|END|QUIT|REVOKE|OPTOUT)\b/;
const START_RE = /\b(START|SUBSCRIBE|YES|UNSTOP)\b/;
const HELP_RE = /\b(HELP|INFO)\b/;

/**
 * Handle inbound Twilio SMS webhooks.
 *
 * Validates the request signature, looks up the user by phone number, and processes
 * STOP/START/HELP commands to update notification preferences and opt-out state.
 */
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

	const isValid = validateRequest(authToken, request.signature, request.url, request.params);

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
		.select("id, phone_verified, email_notifications_enabled, sms_notifications_enabled")
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
	const emailNotificationsEnabled = users[0].email_notifications_enabled;
	const smsNotificationsEnabled = users[0].sms_notifications_enabled;
	// Use pre-update channel state for STOP copy; reflects prior SMS enablement.
	const hasBothChannelsEnabled = emailNotificationsEnabled && smsNotificationsEnabled;
	const dashboardUrl = new URL("/dashboard", getSiteUrl()).toString();

	if (!phoneVerified) {
		return {
			status: 200,
			body: wrapInTwiml("Phone number not verified. Please verify your phone number first."),
			contentType: "text/xml",
		};
	}

	if (STOP_ALL_RE.test(body)) {
		const err = await applyUserUpdate(
			supabase,
			userId,
			{
				sms_opted_out: true,
				sms_notifications_enabled: false,
				email_notifications_enabled: false,
			},
			"sms_stop_all",
		);
		if (err) return err;

		return {
			status: 200,
			body: wrapInTwiml(
				`You have been unsubscribed from SMS and email notifications. Manage notification-preferences at ${dashboardUrl}.`,
			),
			contentType: "text/xml",
		};
	}

	if (STOP_EMAIL_RE.test(body)) {
		const err = await applyUserUpdate(
			supabase,
			userId,
			{
				email_notifications_enabled: false,
			},
			"sms_stop_email",
		);
		if (err) return err;

		const stopEmailMessage = hasBothChannelsEnabled
			? `Email notifications are now off. To stop SMS too, reply STOP ALL or visit ${dashboardUrl}.`
			: `Email notifications are now off. Manage notification-preferences at ${dashboardUrl}.`;

		return {
			status: 200,
			body: wrapInTwiml(stopEmailMessage),
			contentType: "text/xml",
		};
	}

	if (STOP_RE.test(body)) {
		const err = await applyUserUpdate(
			supabase,
			userId,
			{
				sms_opted_out: true,
				sms_notifications_enabled: false,
			},
			"sms_opt_out",
		);
		if (err) return err;

		const stopSmsMessage = hasBothChannelsEnabled
			? `You have been unsubscribed from SMS notifications. To stop email too, reply STOP EMAIL or visit ${dashboardUrl}.`
			: `You have been unsubscribed from SMS notifications. Manage notification-preferences at ${dashboardUrl}.`;

		return {
			status: 200,
			body: wrapInTwiml(stopSmsMessage),
			contentType: "text/xml",
		};
	}

	if (START_RE.test(body)) {
		const err = await applyUserUpdate(
			supabase,
			userId,
			{
				sms_opted_out: false,
				sms_notifications_enabled: true,
			},
			"sms_start",
		);
		if (err) return err;

		return {
			status: 200,
			body: wrapInTwiml(
				`SMS notifications are now on. Manage notification-preferences at ${dashboardUrl}.`,
			),
			contentType: "text/xml",
		};
	}

	if (HELP_RE.test(body)) {
		return {
			status: 200,
			body: wrapInTwiml(
				`StockTextDashboard: Reply STOP to unsubscribe from SMS, STOP EMAIL to unsubscribe from email, STOP ALL to unsubscribe from both. Manage settings at ${dashboardUrl}.`,
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
