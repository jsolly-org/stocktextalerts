import { parsePhoneNumberFromString } from "libphonenumber-js";
import { getSiteUrl } from "../../db/env";
import type { AppSupabaseClient } from "../../db/supabase";
import { rootLogger } from "../../logging";
import {
	createSmsClient,
	createSmsSender,
	readSmsConfig,
} from "./aws-sms-utils";

interface InboundSmsDependencies {
	supabase: AppSupabaseClient;
}

interface InboundSmsRequest {
	originationNumber: string;
	messageBody: string;
	destinationNumber: string;
}

interface InboundSmsResponse {
	status: number;
	body: string;
	contentType?: string;
}

/**
 * Apply a `users` table update and return an error response on failure.
 *
 * Returns `null` on success so callers can continue handling the inbound command.
 */
async function applyUserUpdate(
	supabase: AppSupabaseClient,
	userId: string,
	update: Record<string, unknown>,
	action: string,
): Promise<InboundSmsResponse | null> {
	const { error: updateError } = await supabase
		.from("users")
		.update(update)
		.eq("id", userId);

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

/**
 * Send a reply SMS back to the user via AWS End User Messaging.
 * Returns whether the reply was sent successfully so callers can handle failures.
 */
async function sendReply(to: string, message: string): Promise<boolean> {
	try {
		const config = readSmsConfig();
		const client = createSmsClient(config);
		const sender = createSmsSender(client, config.originationIdentity);
		const result = await sender({ to, body: message });
		return result.success;
	} catch (error) {
		rootLogger.error(
			"Failed to send inbound SMS reply",
			{ to: to.slice(-4).padStart(to.length, "*") },
			error,
		);
		return false;
	}
}

const STOP_ALL_RE = /\bSTOP\s*ALL\b|\bSTOPALL\b/;
const STOP_EMAIL_RE = /\bSTOP\s*EMAIL\b|\bSTOPEMAIL\b/;
const STOP_RE = /\b(STOP|UNSUBSCRIBE|CANCEL|END|QUIT|REVOKE|OPTOUT)\b/;
const START_RE = /\b(START|SUBSCRIBE|YES|UNSTOP)\b/;
const HELP_RE = /\b(HELP|INFO)\b/;

/**
 * Handle inbound SMS messages from AWS SNS two-way messaging.
 *
 * Looks up the user by phone number, and processes
 * STOP/START/HELP commands to update notification preferences and opt-out state.
 * Sends reply SMS via outbound API.
 */
export async function handleInboundSms(
	request: InboundSmsRequest,
	deps: InboundSmsDependencies,
): Promise<InboundSmsResponse> {
	const { supabase } = deps;

	const from = request.originationNumber;
	const body = request.messageBody?.trim().toUpperCase();

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
		rootLogger.error("Failed to parse phone number", { from });
		return {
			status: 400,
			body: "Invalid phone format",
		};
	}

	const { data: users, error } = await supabase
		.from("users")
		.select(
			"id, phone_verified, email_notifications_enabled, sms_notifications_enabled",
		)
		.eq("phone_country_code", countryCode)
		.eq("phone_number", phoneNumber);

	if (error) {
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
			body: "",
		};
	}

	if (users.length === 0) {
		return {
			status: 200,
			body: "",
		};
	}

	const userId = users[0].id;
	const phoneVerified = users[0].phone_verified;
	const emailNotificationsEnabled = users[0].email_notifications_enabled;
	const smsNotificationsEnabled = users[0].sms_notifications_enabled;
	const hasBothChannelsEnabled =
		emailNotificationsEnabled && smsNotificationsEnabled;
	const dashboardUrl = new URL("/dashboard", getSiteUrl()).toString();

	if (!phoneVerified) {
		await sendReply(
			from,
			"Phone number not verified. Please verify your phone number first.",
		);
		return {
			status: 200,
			body: "Phone number not verified",
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

		await sendReply(
			from,
			`You have been unsubscribed from SMS and email notifications. Manage notification-preferences at ${dashboardUrl}.`,
		);
		return {
			status: 200,
			body: "unsubscribed from SMS and email",
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

		await sendReply(from, stopEmailMessage);
		return {
			status: 200,
			body: "Email notifications are now off",
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

		await sendReply(from, stopSmsMessage);
		return {
			status: 200,
			body: "unsubscribed from SMS notifications",
		};
	}

	if (START_RE.test(body)) {
		const err = await applyUserUpdate(
			supabase,
			userId,
			{
				sms_opted_out: false,
			},
			"sms_start",
		);
		if (err) return err;

		await sendReply(
			from,
			`You can receive SMS again. Re-enable SMS notifications from your dashboard: ${dashboardUrl}.`,
		);
		return {
			status: 200,
			body: "Re-enable SMS notifications from your dashboard",
		};
	}

	if (HELP_RE.test(body)) {
		await sendReply(
			from,
			`StockTextDashboard: Reply STOP to unsubscribe from SMS, STOP EMAIL to unsubscribe from email, STOP ALL to unsubscribe from both. Manage settings at ${dashboardUrl}.`,
		);
		return {
			status: 200,
			body: "STOP ALL",
		};
	}

	await sendReply(from, "Unknown command. Reply HELP for options.");
	return {
		status: 200,
		body: "Unknown command",
	};
}
