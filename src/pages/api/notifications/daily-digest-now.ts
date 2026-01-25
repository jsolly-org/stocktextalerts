import type { APIRoute } from "astro";
import { DateTime } from "luxon";
import { createUserService } from "../../../lib/db";
import {
	createSupabaseAdminClient,
	createSupabaseServerClient,
} from "../../../lib/db/supabase";
import { createLogger } from "../../../lib/logging";
import { calculateNextSendAt } from "../../../lib/time/schedule";
import { createEmailSender } from "./email/utils";
import { processEmailUpdate, processSmsUpdate } from "./processing";
import { loadUserStocks, type UserStockRow } from "./shared";
import { shouldSendSms } from "./sms";
import {
	createSmsSender,
	createTwilioClient,
	readTwilioConfig,
} from "./sms/twilio-utils";

export const POST: APIRoute = async ({
	cookies,
	request,
	redirect,
	locals,
}) => {
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
		// Expected rejection (often bots); info to avoid inflating error metrics.
		logger.info("Manual daily digest send attempt without authenticated user", {
			reason: "unauthenticated",
		});
		return redirect("/signin?error=unauthorized");
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
		return redirect("/dashboard?error=server_error");
	}

	if (!user) {
		logger.error("Manual daily digest send attempted but user not found", {
			userId: authUser.id,
		});
		return redirect("/dashboard?error=user_not_found");
	}

	if (!user.daily_digest_enabled) {
		return redirect("/dashboard?error=daily_digest_disabled");
	}

	const smsReady = shouldSendSms(user);
	if (!user.email_notifications_enabled && !smsReady) {
		return redirect("/dashboard?error=notifications_not_configured");
	}

	try {
		const { data: rateLimitAllowed, error: rateLimitError } =
			await supabaseAdmin.rpc("check_rate_limit", {
				p_user_id: user.id,
				p_endpoint: "daily_digest_now",
				p_max_requests: 1,
				p_window_minutes: 60,
			});

		if (rateLimitError) {
			logger.error(
				"Rate limit check failed for manual daily digest send",
				{ userId: user.id },
				rateLimitError,
			);
			return redirect("/dashboard?error=daily_digest_send_failed");
		}

		if (rateLimitAllowed === false) {
			logger.info("User rate-limited for manual daily digest send", {
				userId: user.id,
			});
			return redirect("/dashboard?error=daily_digest_rate_limited");
		}

		if (rateLimitAllowed !== true) {
			logger.error(
				"Manual daily digest rate limit check returned unexpected value",
				{
					userId: user.id,
					rateLimitAllowed,
				},
			);
			return redirect("/dashboard?error=daily_digest_send_failed");
		}

		const skipNext = url.searchParams.get("skip_next") === "1";
		const originalNextSendAt = user.next_send_at;
		let advancedNextSendAtIso: string | null = null;

		if (skipNext && typeof originalNextSendAt === "string") {
			const dueAt = DateTime.fromISO(originalNextSendAt, { zone: "utc" });
			const advancedNextSendAt = calculateNextSendAt(
				user.daily_digest_notification_time,
				user.timezone,
				dueAt.plus({ seconds: 1 }),
			);
			if (!advancedNextSendAt) {
				logger.error("Failed to calculate advanced next_send_at", {
					userId: user.id,
					daily_digest_notification_time: user.daily_digest_notification_time,
					timezone: user.timezone,
				});
				return redirect("/dashboard?error=daily_digest_skip_failed");
			}

			advancedNextSendAtIso = advancedNextSendAt.toISO();
			if (!advancedNextSendAtIso) {
				logger.error("Failed to format advanced next_send_at ISO", {
					userId: user.id,
				});
				return redirect("/dashboard?error=daily_digest_skip_failed");
			}
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
			return redirect("/dashboard?error=daily_digest_send_failed");
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
			return redirect("/dashboard?error=daily_digest_send_failed");
		}

		if (advancedNextSendAtIso) {
			const { error: advanceError } = await supabaseAdmin
				.from("users")
				.update({ next_send_at: advancedNextSendAtIso })
				.eq("id", user.id);

			if (advanceError) {
				logger.warn("Failed to advance next_send_at for skip", {
					userId: user.id,
					advanceError,
				});
				return redirect(
					"/dashboard?success=daily_digest_sent&warning=skip_update_failed",
				);
			}
		}

		return redirect("/dashboard?success=daily_digest_sent");
	} catch (error) {
		logger.error(
			"Unexpected error sending manual daily digest",
			{ userId: user.id },
			error,
		);
		return redirect("/dashboard?error=daily_digest_send_failed");
	}
};
