import type { AppSupabaseClient } from "../../db/supabase";
import { type Logger, rootLogger } from "../../logging";
import type { DeliveryResult } from "../types";

/** Telegram Bot API error_code for "Forbidden: bot was blocked by the user" (and
 *  the related "user is deactivated" / "chat not found"). grammY surfaces it as
 *  `error_code`, which {@link import("./sender").sendViaBot} maps to `errorCode`. */
const TELEGRAM_FORBIDDEN_CODE = "403";

/**
 * Mark a user opted out of Telegram after a verified outbound 403 ("bot was blocked
 * by the user"). This is the ONLY path that sets `telegram_opted_out` from delivery —
 * a real send result, never inbound message content (see eligibility.ts). No-ops on
 * a successful send or any non-403 failure, so callers can invoke it unconditionally
 * after every send. Best-effort: a failed opt-out write is logged, never thrown.
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
	const { error } = await supabase
		.from("users")
		.update({ telegram_opted_out: true })
		.eq("id", userId);
	if (error) {
		logger.error(
			"Failed to set telegram_opted_out after bot-blocked 403",
			{ userId },
			error instanceof Error ? error : new Error(String(error)),
		);
		return;
	}
	logger.info("Telegram user opted out after bot-blocked 403", { userId });
}
