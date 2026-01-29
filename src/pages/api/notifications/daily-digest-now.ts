import type { APIRoute } from "astro";
import { DateTime } from "luxon";
import { jsonResponse } from "../../../lib/api/json-response";
import { createUserService } from "../../../lib/db";
import {
	createSupabaseAdminClient,
	createSupabaseServerClient,
} from "../../../lib/db/supabase";
import { createLogger } from "../../../lib/logging";
import { createEmailSender } from "./email/utils";
import { processEmailUpdate, processSmsUpdate } from "./processing";
import { loadUserStocks, type UserStockRow } from "./shared";
import { shouldSendSms } from "./sms";
import {
	createSmsSender,
	createTwilioClient,
	readTwilioConfig,
} from "./sms/twilio-utils";

export const POST: APIRoute = async ({ cookies, request, locals }) => {
	const url = new URL(request.url);
	const logger = createLogger({
		requestId: locals?.requestId,
		path: url.pathname,
		method: request.method,
	});
	const supabase = createSupabaseServerClient();
	const users = createUserService(supabase, cookies);

	const authUser = await users.getCurrentUser();
	if (!authUser) {
		// Expected rejection (expired session, crawler, etc.); log at info so we don't inflate error metrics.
		logger.info("Manual daily digest send attempt without authenticated user", {
			reason: "unauthenticated",
			path: url.pathname,
		});
		return jsonResponse(401, {
			ok: false,
			message: "unauthorized",
			tone: "error",
		});
	}

	const supabaseAdmin = createSupabaseAdminClient();

	const { data: user, error: userError } = await supabaseAdmin
		.from("users")
		.select(
			`
				id,
				email,
				phone_country_code,
				phone_number,
				phone_verified,
				sms_opted_out,
				timezone,
				daily_digest_enabled,
				daily_digest_notification_time,
				next_send_at,
				email_notifications_enabled,
				sms_notifications_enabled
			`,
		)
		.eq("id", authUser.id)
		.maybeSingle();

	if (userError) {
		logger.error(
			"Failed to load user for manual daily digest send",
			{ userId: authUser.id },
			userError,
		);
		return jsonResponse(500, {
			ok: false,
			message: "server_error",
			tone: "error",
		});
	}

	if (!user) {
		logger.error("Manual daily digest send attempted but user not found", {
			userId: authUser.id,
		});
		return jsonResponse(404, {
			ok: false,
			message: "user_not_found",
			tone: "error",
		});
	}

	if (!user.daily_digest_enabled) {
		return jsonResponse(400, {
			ok: false,
			message: "daily_digest_disabled",
			tone: "error",
		});
	}

	const smsReady = shouldSendSms(user);
	if (!user.email_notifications_enabled && !smsReady) {
		return jsonResponse(400, {
			ok: false,
			message: "notifications_not_configured",
			tone: "error",
		});
	}

	try {
		const { data: rateLimitAllowed, error: rateLimitError } =
			await supabaseAdmin.rpc("check_rate_limit", {
				p_user_id: user.id,
				p_endpoint: "daily_digest_now",
				p_max_requests: 5,
				p_window_minutes: 60,
			});

		if (rateLimitError) {
			logger.error(
				"Rate limit check failed for manual daily digest send",
				{ userId: user.id },
				rateLimitError,
			);
			return jsonResponse(500, {
				ok: false,
				message: "daily_digest_send_failed",
				tone: "error",
			});
		}

		if (rateLimitAllowed === false) {
			logger.info("User rate-limited for manual daily digest send", {
				userId: user.id,
			});
			return jsonResponse(429, {
				ok: false,
				message: "daily_digest_rate_limited",
				tone: "error",
			});
		}

		if (rateLimitAllowed !== true) {
			logger.error(
				"Manual daily digest rate limit check returned unexpected value",
				{
					userId: user.id,
					rateLimitAllowed,
				},
			);
			return jsonResponse(500, {
				ok: false,
				message: "daily_digest_send_failed",
				tone: "error",
			});
		}

		let userStocks: UserStockRow[];
		try {
			userStocks = await loadUserStocks(supabaseAdmin, user.id);
		} catch (error) {
			logger.error(
				"Failed to load user stocks for manual daily digest",
				{ userId: user.id },
				error,
			);
			return jsonResponse(500, {
				ok: false,
				message: "daily_digest_send_failed",
				tone: "error",
			});
		}

		const stocksList =
			userStocks.length === 0
				? "You don't have any tracked stocks"
				: userStocks
						.map((stock) => `${stock.symbol} - ${stock.name}`)
						.join(", ");

		let anySent = false;
		let emailResult: { sent: boolean; errorCode?: string } | null = null;
		let smsResult: { sent: boolean; errorCode?: string } | null = null;

		if (user.email_notifications_enabled) {
			const sendEmail = createEmailSender();
			const minuteBucket = DateTime.utc().toFormat("yyyy-LL-dd'T'HH:mm");
			const idempotencyKey = `daily-digest-now/${user.id}/${minuteBucket}`;

			const result = await processEmailUpdate(
				supabaseAdmin,
				{ id: user.id, email: user.email },
				userStocks,
				stocksList,
				sendEmail,
				idempotencyKey,
			);
			emailResult = { sent: result.sent, errorCode: result.errorCode };

			if (!result.sent) {
				logger.error("Manual daily digest email send failed", {
					userId: user.id,
					error: result.error ?? "unknown",
					errorCode: result.errorCode,
				});
			} else {
				anySent = true;
			}
		}

		if (smsReady) {
			try {
				const twilioConfig = readTwilioConfig();
				const twilioClient = createTwilioClient(twilioConfig);
				const sendSms = createSmsSender(twilioClient, twilioConfig.phoneNumber);

				const result = await processSmsUpdate(
					supabaseAdmin,
					{
						id: user.id,
						phone_country_code: user.phone_country_code,
						phone_number: user.phone_number,
					},
					userStocks,
					stocksList,
					sendSms,
				);
				smsResult = { sent: result.sent, errorCode: result.errorCode };

				if (!result.sent) {
					logger.error("Manual daily digest SMS send failed", {
						userId: user.id,
						error: result.error ?? "unknown",
						errorCode: result.errorCode,
					});
				} else {
					anySent = true;
				}
			} catch (error) {
				logger.error(
					"Failed to initialize Twilio for manual daily digest send",
					{ userId: user.id },
					error,
				);
				smsResult = { sent: false, errorCode: "twilio_init_failed" };
			}
		}

		logger.info("Manual daily digest send summary", {
			userId: user.id,
			email: emailResult,
			sms: smsResult,
			anySent,
		});

		if (!anySent) {
			return jsonResponse(500, {
				ok: false,
				message: "daily_digest_send_failed",
				tone: "error",
			});
		}

		return jsonResponse(200, {
			ok: true,
			message: "daily_digest_sent",
			tone: "success",
		});
	} catch (error) {
		logger.error(
			"Unexpected error sending manual daily digest",
			{ userId: user.id },
			error,
		);
		return jsonResponse(500, {
			ok: false,
			message: "daily_digest_send_failed",
			tone: "error",
		});
	}
};
