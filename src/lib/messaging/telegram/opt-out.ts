import type { AppSupabaseClient } from "../../db/supabase";
import { type Logger, rootLogger } from "../../logging";
import { createErrorForLogging } from "../../logging/errors";
import type { DeliveryResult } from "../../types";
import { updateUserDeliveryChannel } from "../delivery-channel";

/** Telegram Bot API error_code for "Forbidden: bot was blocked by the user" (and
 *  the related "user is deactivated" / "chat not found"). grammY surfaces it as
 *  `error_code`, which {@link import("./sender").sendViaBot} maps to `errorCode`. */
const TELEGRAM_FORBIDDEN_CODE = "403";

/**
 * Pause Telegram delivery after a verified outbound 403 ("bot was blocked
 * by the user"). If the account is currently routed to telegram, set
 * `delivery_channel` to disabled (same as `/stop`). No-ops on a successful send
 * or any non-403 failure, so callers can invoke it unconditionally after every
 * send. Best-effort: a failed write is logged, never thrown.
 */
export async function optOutIfBotBlocked(
	supabase: AppSupabaseClient,
	userId: string,
	result: DeliveryResult,
	logger: Logger = rootLogger,
): Promise<void> {
	if (result.success || result.errorCode !== TELEGRAM_FORBIDDEN_CODE) {
		return;
	}
	try {
		const { data, error: readError } = await supabase
			.from("users")
			.select("delivery_channel")
			.eq("id", userId)
			.maybeSingle();
		if (readError) {
			logger.error(
				"Failed to read delivery_channel after bot-blocked 403",
				{ userId },
				createErrorForLogging(readError),
			);
			return;
		}
		if (data?.delivery_channel !== "telegram") {
			return;
		}
		const { updated, error } = await updateUserDeliveryChannel({
			supabase,
			userId,
			channel: "disabled",
			casCurrent: "telegram",
		});
		if (error) {
			logger.error(
				"Failed to set delivery_channel=disabled after bot-blocked 403",
				{ userId },
				createErrorForLogging(error),
			);
			return;
		}
		if (!updated) {
			logger.info("Bot-blocked 403 opt-out no-op: concurrent channel change", { userId });
			return;
		}
		logger.info("Telegram delivery disabled after bot-blocked 403", { userId });
	} catch (error) {
		logger.error(
			"Bot-blocked 403 opt-out threw unexpectedly",
			{ userId },
			createErrorForLogging(error),
		);
	}
}
