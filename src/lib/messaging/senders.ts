import { createEmailSender } from "./email/utils";
import { createLogoCache, type LogoCache } from "./logo-fetcher";
import { createTelegramSenderFactory, type TelegramSenderFactory } from "./telegram/sender-factory";
import type { EmailSender } from "./types";

/** Channel senders and logo cache created once per scheduler run or dispatch entry. */
export interface NotificationSenders {
	sendEmail: EmailSender;
	getTelegramSender: TelegramSenderFactory;
	logoCache: LogoCache;
}

/** Build email/Telegram senders and a shared logo cache for notification pipelines. */
export function createNotificationSenders(): NotificationSenders {
	return {
		sendEmail: createEmailSender(),
		getTelegramSender: createTelegramSenderFactory(),
		logoCache: createLogoCache(),
	};
}
