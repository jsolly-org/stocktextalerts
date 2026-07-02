import type { ChannelOption } from "../types";

/**
 * Build the email/SMS/Telegram `ChannelOption` factories shared by the daily
 * and market panels. Disabled state and hover titles come in as getters and
 * are read inside the callers' `computed()`s, so reactivity tracking is
 * preserved. (DailyAssetEventsFieldset keeps its own builder — its email
 * option's disabled logic deliberately omits the email-channel term.)
 */
export function createChannelOptionBuilders(deps: {
	emailDisabled: () => boolean;
	emailDisabledTitle: () => string | undefined;
	smsDisabled: () => boolean;
	smsDisabledTitle: () => string | undefined;
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
		smsOption: (selected: boolean): ChannelOption => ({
			value: "sms",
			label: "SMS",
			selected,
			disabled: deps.smsDisabled(),
			disabledTitle: deps.smsDisabledTitle(),
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
