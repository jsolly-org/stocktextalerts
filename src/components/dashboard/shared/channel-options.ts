import {
	isTelegramChannelUsable,
	type TelegramEligibilityUser,
} from "../../../lib/messaging/telegram/eligibility";
import type { ChannelOption } from "../types";

/** Hover title for a disabled email channel option; undefined when email is enabled. */
export function getEmailChannelDisabledTitle(emailEnabled: boolean): string | undefined {
	if (emailEnabled) return undefined;
	return "Enable email in your notification channels to select this option.";
}

/** Hover title for a disabled Telegram channel option; undefined when Telegram is usable. */
export function getTelegramChannelDisabledTitle(user: TelegramEligibilityUser): string | undefined {
	if (isTelegramChannelUsable(user)) return undefined;
	if (user.telegram_chat_id == null) {
		return "Connect Telegram in your notification channels to select this option.";
	}
	return "Enable Telegram in your notification channels to select this option.";
}

/**
 * Build the email/Telegram `ChannelOption` factories shared by the daily
 * and market panels. Disabled state and hover titles come in as getters and
 * are read inside the callers' `computed()`s, so reactivity tracking is
 * preserved. (DailyAssetEventsFieldset keeps its own builder — its email
 * option's disabled logic deliberately omits the email-channel term.)
 */
export function createChannelOptionBuilders(deps: {
	emailDisabled: () => boolean;
	emailDisabledTitle: () => string | undefined;
	telegramDisabled: () => boolean;
	telegramDisabledTitle: () => string | undefined;
}) {
	return {
		emailOption: (selected: boolean): ChannelOption => ({
			value: "email",
			label: "Email",
			selected,
			disabled: deps.emailDisabled(),
			disabledTitle: deps.emailDisabledTitle(),
		}),
		telegramOption: (selected: boolean): ChannelOption => ({
			value: "telegram",
			label: "Telegram",
			selected,
			disabled: deps.telegramDisabled(),
			disabledTitle: deps.telegramDisabledTitle(),
		}),
	};
}
