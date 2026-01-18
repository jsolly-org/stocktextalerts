import type { APIRoute } from "astro";
import {
	isSmsRequiresPhoneError,
	isStocksLimitError,
	isStocksRequiredError,
} from "../../../lib/database-errors";
import { coerceWithSchema } from "../../../lib/forms/coercion";
import type { FormSchema } from "../../../lib/forms/schema";
import { omitUndefined } from "../../../lib/forms/utils";
import { createSupabaseServerClient } from "../../../lib/supabase";
import { createUserService } from "../../../lib/users";
import { calculateNextSendAt } from "../notifications/shared";

interface PreferencesDependencies {
	createSupabaseServerClient: typeof createSupabaseServerClient;
	createUserService: typeof createUserService;
}

const defaultDependencies: PreferencesDependencies = {
	createSupabaseServerClient,
	createUserService,
};

export function createPreferencesHandler(
	overrides: Partial<PreferencesDependencies> = {},
): APIRoute {
	const dependencies = { ...defaultDependencies, ...overrides };

	return async ({ request, cookies, redirect }) => {
		const supabase = dependencies.createSupabaseServerClient();
		const userService = dependencies.createUserService(supabase, cookies);

		const user = await userService.getCurrentUser();
		if (!user) {
			console.error("Preferences update attempt without authenticated user");
			return redirect("/signin?error=unauthorized");
		}

		const formData = await request.formData();

		const shape = {
			email_notifications_enabled: { type: "boolean" },
			sms_notifications_enabled: { type: "boolean" },
			timezone: { type: "timezone" },
			daily_digest_enabled: { type: "boolean" },
			daily_digest_notification_time: { type: "time" },
			tracked_stocks: { type: "json_string_array", required: true },
		} as const satisfies FormSchema;

		const parsed = coerceWithSchema(formData, shape);

		if (!parsed.ok) {
			console.error("Preferences update rejected due to invalid form", {
				errors: parsed.allErrors,
			});
			return redirect("/dashboard?error=invalid_form");
		}

		const { tracked_stocks: trackedSymbols, ...preferenceData } = parsed.data;

		const safePreferenceUpdates: Parameters<typeof userService.update>[1] =
			omitUndefined({
				timezone: preferenceData.timezone,
				daily_digest_notification_time:
					preferenceData.daily_digest_notification_time,
				...(formData.has("email_notifications_enabled")
					? {
							email_notifications_enabled:
								preferenceData.email_notifications_enabled ?? false,
						}
					: {}),
				...(formData.has("sms_notifications_enabled")
					? {
							sms_notifications_enabled:
								preferenceData.sms_notifications_enabled ?? false,
						}
					: {}),
				...(formData.has("daily_digest_enabled")
					? {
							daily_digest_enabled:
								preferenceData.daily_digest_enabled ?? false,
						}
					: {}),
			});

		const dbUser = await userService.getById(user.id);
		if (!dbUser) {
			console.error("User not found", { userId: user.id });
			return redirect("/signin?error=user_not_found");
		}

		const timezoneChanged =
			safePreferenceUpdates.timezone !== undefined &&
			safePreferenceUpdates.timezone !== dbUser.timezone;
		const timeChanged =
			safePreferenceUpdates.daily_digest_notification_time !== undefined &&
			safePreferenceUpdates.daily_digest_notification_time !==
				dbUser.daily_digest_notification_time;
		const enabledChanged =
			safePreferenceUpdates.daily_digest_enabled !== undefined &&
			safePreferenceUpdates.daily_digest_enabled !==
				dbUser.daily_digest_enabled;

		const finalTimezone = safePreferenceUpdates.timezone ?? dbUser.timezone;
		const finalTime =
			safePreferenceUpdates.daily_digest_notification_time ??
			dbUser.daily_digest_notification_time;
		const finalEnabled =
			safePreferenceUpdates.daily_digest_enabled ?? dbUser.daily_digest_enabled;

		if (
			(timezoneChanged || timeChanged || enabledChanged) &&
			finalEnabled &&
			finalTimezone &&
			typeof finalTime === "number"
		) {
			const nextSendAt = calculateNextSendAt(
				finalTime,
				finalTimezone,
				() => new Date(),
			);
			if (nextSendAt) {
				safePreferenceUpdates.next_send_at = nextSendAt.toISOString();
			} else {
				console.warn("calculateNextSendAt returned null for valid inputs", {
					userId: user.id,
					finalTime,
					finalTimezone,
				});
				safePreferenceUpdates.next_send_at = null;
			}
		} else if (enabledChanged && !finalEnabled) {
			safePreferenceUpdates.next_send_at = null;
		}

		try {
			const finalEmailNotificationsEnabled =
				safePreferenceUpdates.email_notifications_enabled ??
				dbUser.email_notifications_enabled ??
				false;
			const finalSmsNotificationsEnabled =
				safePreferenceUpdates.sms_notifications_enabled ??
				dbUser.sms_notifications_enabled ??
				false;
			const finalDailyDigestEnabled =
				safePreferenceUpdates.daily_digest_enabled ??
				dbUser.daily_digest_enabled;
			const finalDailyDigestNotificationTime =
				safePreferenceUpdates.daily_digest_notification_time ??
				dbUser.daily_digest_notification_time;

			const finalNextSendAt = Object.hasOwn(
				safePreferenceUpdates,
				"next_send_at",
			)
				? (safePreferenceUpdates.next_send_at ?? null)
				: (dbUser.next_send_at ?? null);

			const { error } = await supabase.rpc(
				"update_user_preferences_and_stocks",
				{
					p_user_id: user.id,
					p_symbols: trackedSymbols,
					p_email_notifications_enabled: finalEmailNotificationsEnabled,
					p_sms_notifications_enabled: finalSmsNotificationsEnabled,
					p_timezone: finalTimezone,
					p_daily_digest_enabled: finalDailyDigestEnabled,
					p_daily_digest_notification_time: finalDailyDigestNotificationTime,
					p_next_send_at: finalNextSendAt,
				} as unknown as Parameters<
					typeof supabase.rpc<"update_user_preferences_and_stocks">
				>[1],
			);

			if (error) {
				throw error;
			}
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);

			console.error("Failed to update user preferences/tracked stocks", {
				userId: user.id,
				preferences: safePreferenceUpdates,
				symbols: trackedSymbols,
				error: errorMessage,
			});

			if (isSmsRequiresPhoneError(errorMessage)) {
				return redirect("/dashboard?error=phone_not_set");
			}

			if (isStocksLimitError(errorMessage)) {
				return redirect("/dashboard?error=stocks_limit");
			}

			if (isStocksRequiredError(errorMessage)) {
				return redirect("/dashboard?error=invalid_form");
			}

			return redirect("/dashboard?error=update_failed");
		}

		return redirect("/dashboard?success=settings_updated");
	};
}

export const POST = createPreferencesHandler();
